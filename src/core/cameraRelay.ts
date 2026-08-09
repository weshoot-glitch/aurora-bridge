/**
 * Camera / Video Relay — an INDEPENDENT Bridge capability (like droneLink /
 * auroraLink). MAVLink/telemetry code is untouched; a camera failure must NEVER
 * alter drone or telemetry state (pinned by test). The relay only reads the
 * device token via TokenStore and posts camera status to Aurora Cloud.
 *
 * Data path (per docs/camera-video-relay-design.md, binding contract):
 *   RTSP source (aircraft-side, Bridge-only)
 *     → ffmpeg → low-latency HLS (short segments, copy codec when H.264)
 *     → PUT playlist/segments to the assignment's publishUrl (raw body)
 *
 * Wire contract (Aurora Core, device-token auth via requireControllerToken —
 * org/aircraft identity comes from the token, never the body):
 *   GET  /api/controllers/camera-assignment
 *        → { assigned, camera?: {orgDeviceId, displayName, catalog:{manufacturer,model},
 *            sourceProtocol, sourceUrl}, ingest?: { publishUrl } }
 *   POST /api/controllers/camera-status
 *        → { state, detail?, media?: {width,height,fps,codec,bitrateKbps,lastFrameAt} }
 *
 * Auto-run gate (ALL required): Aurora link authenticated + assignment.assigned
 * + RTSP host reachable (TCP probe) + cloud reachable. Any lost ⇒ safe stop then
 * reconnect with bounded jittered exponential backoff.
 *
 * SECRETS: the RTSP sourceUrl and the publishUrl path key are redacted in ALL
 * logs and diagnostics — never printed.
 */
import * as os from "os";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import type { BridgeStore, CameraMedia } from "./state";
import type { CameraState } from "./state";
import type { BridgeLog } from "./log";
import type { TokenStore } from "./tokenStore";
import { classifyHttpFailure, classifyException } from "./handshake";

const APP_VERSION = "4.3.0";
const ASSIGNMENT_POLL_MS = 30000;
const HEARTBEAT_MS = 10000;      // status heartbeat while relaying (contract: ≤10s)
const RTSP_PROBE_TIMEOUT_MS = 5000;
const CLOUD_PROBE_TIMEOUT_MS = 8000;
const NO_FRAMES_TIMEOUT_MS = 12000; // ffmpeg running but no advancing frames ⇒ no_frames
const HTTP_TIMEOUT_MS = 10000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

/** Redaction for camera logs: strips the RTSP sourceUrl and the publishUrl path
 *  key so neither ever lands in a log line or diagnostics bundle. Extends the
 *  existing query-string/JSON-field redaction used by auroraLink. */
export function redactCameraText(text: string): string {
  return text
    // rtsp:// URLs (with optional userinfo) → scheme + *** ; never leak host/path
    .replace(/rtsp:\/\/[^\s"'<>]+/gi, "rtsp://***")
    // publishUrl path key: the segment after /ingest/:streamId/ up to the file
    .replace(/(\/api\/video\/ingest\/[^/]+\/)[^/]+(\/)/gi, "$1***$2")
    // generic secret query params (mirrors auroraLink.redactForLog)
    .replace(/([?&](?:token|auth|code|key|signature)[^=]*=)[^&\s"']+/gi, "$1***")
    .replace(/("(?:sourceUrl|publishUrl|token|key)"\s*:\s*")[^"]*(")/gi, "$1***$2");
}

interface Assignment {
  assigned: boolean;
  camera: {
    orgDeviceId: number | null;
    displayName: string | null;
    manufacturer: string | null;
    model: string | null;
    sourceProtocol: string | null;
    sourceUrl: string;
  } | null;
  publishUrl: string | null;
}

/** How the ffmpeg binary was resolved — surfaced honestly in diagnostics. */
type FfmpegSource = "bundled" | "path" | "setting" | "missing";

export interface CameraRelayOptions {
  /** override ffmpeg spawn command (tests inject the stub executable) */
  ffmpegPath?: string | null;
  /** working dir for generated HLS segments; defaults to a temp dir */
  workDir?: string;
  /** injectable TCP probe (tests) — resolves reachable true/false */
  probeTcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export class CameraRelay {
  private assignmentTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private gateTimer: NodeJS.Timeout | null = null;
  private noFrameTimer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  /** bumped on every stop/unpair/gate-loss — stale async completions (child
   *  exit, probe results, HTTP replies) from an older run must not resurrect
   *  state. Mirrors auroraLink/droneLink generation guards. */
  private generation = 0;
  private running = false;         // relay pipeline is meant to be up
  private assignment: Assignment | null = null;
  private backoffAttempt = 0;
  private lastReportedState: CameraState | null = null;
  private lastReportAt = 0;
  private framesAtLastCheck = -1;
  private ffmpegSource: FfmpegSource = "missing";
  private readonly workDir: string;
  private readonly probeTcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;

  constructor(
    private store: BridgeStore,
    private log: BridgeLog,
    private tokens: TokenStore,
    private fetchFn: typeof fetch = fetch,
    private opts: CameraRelayOptions = {},
  ) {
    this.workDir = opts.workDir ?? path.join(os.tmpdir(), `aurora-camera-${process.pid}`);
    this.probeTcp = opts.probeTcp ?? defaultProbeTcp;
    const resolved = this.resolveFfmpeg();
    this.ffmpegSource = resolved.source;
    this.store.update((s) => {
      s.camera.ffmpegAvailable = resolved.source !== "missing";
      s.camera.ffmpegSource = resolved.source;
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start the camera capability: begin polling the assignment + gate loop.
   *  No-op if unpaired. Never touches drone/telemetry state. */
  start(): void {
    if (this.assignmentTimer) return;
    this.log.log("camera", "Camera relay capability started.");
    void this.pollAssignment();          // immediate on link-up
    this.assignmentTimer = setInterval(() => { void this.pollAssignment(); }, ASSIGNMENT_POLL_MS);
    this.gateTimer = setInterval(() => { void this.evaluateGate(); }, 3000);
  }

  /** Full stop: kill ffmpeg, clear timers, WIPE all live media facts so nothing
   *  stale is ever shown as current. Bumps generation to invalidate in-flight
   *  async completions. */
  stop(reason = "stopped"): void {
    this.generation += 1;
    this.running = false;
    if (this.assignmentTimer) clearInterval(this.assignmentTimer);
    if (this.gateTimer) clearInterval(this.gateTimer);
    this.assignmentTimer = null;
    this.gateTimer = null;
    this.stopPipeline("stopped");
    this.assignment = null;
    this.wipeMedia();
    this.setState("stopped", reason === "stopped" ? null : reason, { report: false });
    this.log.log("camera", "Camera relay capability stopped.");
  }

  /** Stop just the ffmpeg pipeline + relay timers (a gate loss / restart),
   *  leaving assignment polling running. */
  private stopPipeline(newState: CameraState, detail: string | null = null): void {
    this.generation += 1; // any child-exit / http completion is now stale
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.noFrameTimer) clearInterval(this.noFrameTimer);
    this.heartbeatTimer = null;
    this.noFrameTimer = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.wipeMedia();
    if (newState !== "stopped" || detail !== null) this.setState(newState, detail);
  }

  private wipeMedia(): void {
    this.store.update((s) => {
      s.camera.media = { ...EMPTY_MEDIA };
      s.camera.framesReceived = 0;
      s.camera.lastFrameAt = null;
      s.camera.rtspReachable = null;
      s.camera.relayConnected = false;
    });
    this.framesAtLastCheck = -1;
  }

  // ── Assignment polling ──────────────────────────────────────────────────────

  private async pollAssignment(): Promise<void> {
    const gen = this.generation;
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) {
      this.assignment = null;
      return; // not paired — nothing to poll; drone/telemetry untouched
    }
    const base = meta.serverUrl.replace(/\/+$/, "");
    const url = `${base}/api/controllers/camera-assignment`;
    try {
      const res = await this.loggedFetch("camera-assignment", url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (gen !== this.generation) return; // stopped/unpaired while in flight
      if (res.status === 401 || res.status === 403) {
        this.handleRevoked(res.status);
        return;
      }
      if (!res.ok) {
        this.log.log("camera", `Assignment poll failed: ${classifyHttpFailure(res.status)}`, "warn");
        return;
      }
      const data = res.json as {
        assigned?: boolean;
        camera?: {
          orgDeviceId?: number; displayName?: string;
          catalog?: { manufacturer?: string; model?: string };
          sourceProtocol?: string; sourceUrl?: string;
        };
        ingest?: { publishUrl?: string };
      } | null;
      if (!data || data.assigned !== true || !data.camera?.sourceUrl || !data.ingest?.publishUrl) {
        this.assignment = { assigned: false, camera: null, publishUrl: null };
        this.store.update((s) => {
          s.camera.assigned = false;
          s.camera.displayName = data?.camera?.displayName ?? null;
          s.camera.manufacturer = data?.camera?.catalog?.manufacturer ?? null;
          s.camera.model = data?.camera?.catalog?.model ?? null;
        });
        return;
      }
      this.assignment = {
        assigned: true,
        camera: {
          orgDeviceId: data.camera.orgDeviceId ?? null,
          displayName: data.camera.displayName ?? null,
          manufacturer: data.camera.catalog?.manufacturer ?? null,
          model: data.camera.catalog?.model ?? null,
          sourceProtocol: data.camera.sourceProtocol ?? null,
          sourceUrl: data.camera.sourceUrl,
        },
        publishUrl: data.ingest.publishUrl,
      };
      this.store.update((s) => {
        s.camera.assigned = true;
        s.camera.orgDeviceId = this.assignment!.camera!.orgDeviceId;
        s.camera.displayName = this.assignment!.camera!.displayName;
        s.camera.manufacturer = this.assignment!.camera!.manufacturer;
        s.camera.model = this.assignment!.camera!.model;
        s.camera.sourceProtocol = this.assignment!.camera!.sourceProtocol;
      });
      if (this.state === "stopped" || this.state === "configured") this.setState("configured");
      void this.evaluateGate();
    } catch (err) {
      if (gen === this.generation) this.log.log("camera", `Assignment poll error: ${classifyException(err)}`, "warn");
    }
  }

  // ── Auto-run gate ────────────────────────────────────────────────────────────

  /** Evaluate all four gate conditions. Starts the pipeline when all pass;
   *  triggers a safe-stop + backoff when a condition is lost mid-relay. */
  private async evaluateGate(): Promise<void> {
    const gen = this.generation;
    const auroraAuthed = this.store.state.aurora.status === "connected" && this.tokens.isPaired;
    const assigned = this.assignment?.assigned === true && !!this.assignment.camera && !!this.assignment.publishUrl;

    if (!auroraAuthed) {
      if (this.running) this.safeStop("cloud_unavailable", "Aurora link not authenticated");
      return;
    }
    if (!assigned) {
      if (this.running) this.safeStop("stopped", "No camera assigned");
      else if (this.state !== "stopped" && this.state !== "configured") this.setState("configured");
      return;
    }
    if (!this.store.state.camera.ffmpegAvailable) {
      // Honest state — never a fake "live". ffmpeg simply is not installed.
      this.setState("configured", "ffmpeg not available");
      return;
    }

    const { host, port } = parseRtsp(this.assignment!.camera!.sourceUrl);
    const rtspReachable = host ? await this.probeTcp(host, port, RTSP_PROBE_TIMEOUT_MS) : false;
    if (gen !== this.generation) return;
    this.store.update((s) => { s.camera.rtspReachable = rtspReachable; });
    if (!rtspReachable) {
      if (this.running) this.safeStop("camera_unreachable", "RTSP host unreachable");
      else this.setState("camera_unreachable", "RTSP host unreachable");
      return;
    }

    const cloudReachable = await this.probeCloud();
    if (gen !== this.generation) return;
    if (!cloudReachable) {
      if (this.running) this.safeStop("cloud_unavailable", "Aurora cloud unreachable");
      else this.setState("cloud_unavailable", "Aurora cloud unreachable");
      return;
    }

    // All gate conditions pass.
    if (!this.running) {
      if (this.state !== "reachable" && this.state !== "video_detected" && this.state !== "relay_connected" && this.state !== "live") {
        this.setState("reachable");
      }
      this.startPipeline();
    }
  }

  /** A running relay lost a gate condition: kill the pipeline, report the honest
   *  failure state, and schedule a bounded jittered exponential backoff retry. */
  private safeStop(state: CameraState, detail: string): void {
    this.log.log("camera", `Relay stopping — ${detail}. Reconnecting with backoff.`, "warn");
    this.stopPipeline(state, detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.backoffAttempt = Math.min(this.backoffAttempt + 1, 10);
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.backoffAttempt - 1), BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * base * 0.3);
    const delay = base + jitter;
    const gen = this.generation;
    setTimeout(() => {
      if (gen !== this.generation) return; // a real stop/unpair happened — abandon
      void this.evaluateGate();
    }, delay);
  }

  // ── ffmpeg pipeline ──────────────────────────────────────────────────────────

  private startPipeline(): void {
    if (this.running) return;
    const asg = this.assignment;
    if (!asg?.camera || !asg.publishUrl) return;
    const bin = this.resolveFfmpeg();
    if (bin.source === "missing" || !bin.path) {
      this.setState("configured", "ffmpeg not available");
      return;
    }
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.backoffAttempt = 0;

    try { fs.mkdirSync(this.workDir, { recursive: true }); } catch { /* best effort */ }
    const playlistPath = path.join(this.workDir, "index.m3u8");

    // Low-latency HLS: 2s segments, small list, TCP RTSP. The SIYI A8 Mini
    // already delivers H.264 over RTSP, so we copy the video codec (no re-encode
    // → lowest latency + CPU). -progress pipe:1 emits machine-readable
    // frame/fps/bitrate facts we parse for REAL evidence (never URL-exists).
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", asg.camera.sourceUrl,
      "-c:v", "copy",
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "5",
      "-hls_flags", "delete_segments+omit_endlist",
      "-hls_segment_type", "mpegts",
      "-progress", "pipe:1",
      playlistPath,
    ];

    this.log.log("camera", `Starting ffmpeg relay (${bin.source}) → HLS → cloud ingest.`);
    let child: ChildProcess;
    try {
      // Test stubs are node scripts; Windows cannot exec .mjs/.js directly,
      // so run those through the current node binary. Real ffmpeg is a
      // native executable and takes the direct path.
      if (/\.(mjs|js)$/i.test(bin.path)) {
        child = spawn(process.execPath, [bin.path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      } else {
        child = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (err) {
      this.running = false;
      this.safeStop("rtsp_failed", `Could not launch ffmpeg: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    this.setState("relay_connected");
    this.framesAtLastCheck = -1;

    child.stdout?.on("data", (buf: Buffer) => {
      if (gen !== this.generation) return; // stale child
      this.parseProgress(buf.toString("utf8"), gen);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (gen !== this.generation) return;
      const line = buf.toString("utf8").trim();
      if (line) this.log.log("camera", `ffmpeg: ${redactCameraText(line).slice(0, 200)}`, "warn", { fileOnly: true });
    });
    child.on("error", (err) => {
      if (gen !== this.generation) return;
      this.safeStop("rtsp_failed", `ffmpeg error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (gen !== this.generation) return; // superseded by a newer run — ignore
      this.child = null;
      if (this.running) {
        this.safeStop("relay_disconnected", `ffmpeg exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""})`);
      }
    });

    // Publisher: watch the work dir and PUT playlist + new segments to the cloud.
    this.startPublisher(gen, asg.publishUrl);

    // No-frames watchdog: ffmpeg is up (relay_connected) but if the frame
    // counter never advances within the window, report no_frames — NEVER live.
    setTimeout(() => {
      if (gen !== this.generation) return;
      if (this.store.state.camera.framesReceived <= 0) {
        this.setState("no_frames", "No video frames from RTSP source");
      }
    }, NO_FRAMES_TIMEOUT_MS);

    // Status heartbeat while relaying (contract: ≤10s).
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.generation) return;
      void this.reportStatus(this.state, this.store.state.camera.media, true);
    }, HEARTBEAT_MS);
  }

  /** Parse ffmpeg -progress key=value output for REAL media facts. Frame count
   *  advancing is the evidence that promotes to video_detected/live. Unknown
   *  fields are omitted (never 0). */
  private parseProgress(chunk: string, gen: number): void {
    for (const line of chunk.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === "frame") {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) {
          this.store.update((s) => {
            s.camera.framesReceived = n;
            s.camera.lastFrameAt = Date.now();
          });
          // Real frames arriving ⇒ video_detected (evidence, not URL-exists).
          if (this.state === "relay_connected" || this.state === "reachable" || this.state === "no_frames") {
            this.setState("video_detected");
          }
        }
      } else if (key === "fps") {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) this.store.update((s) => { s.camera.media.fps = Math.round(n); });
      } else if (key === "bitrate") {
        const m = val.match(/([\d.]+)\s*kbits\/s/i);
        if (m) this.store.update((s) => { s.camera.media.bitrateKbps = Math.round(Number(m[1])); });
      }
    }
    void gen;
  }

  /** Watch the HLS work dir and PUT the playlist + every new segment to the
   *  cloud ingest publishUrl (raw body). A 2xx PUT of a segment is the REAL
   *  evidence that promotes video_detected → live. DELETE is a no-op / ignored. */
  private startPublisher(gen: number, publishUrl: string): void {
    const publishedSegments = new Set<string>();
    const tick = async (): Promise<void> => {
      if (gen !== this.generation) return;
      let files: string[];
      try { files = fs.readdirSync(this.workDir); } catch { return; }
      const playlist = files.find((f) => f.endsWith(".m3u8"));
      const segments = files.filter((f) => f.endsWith(".ts") && !publishedSegments.has(f)).sort();
      for (const seg of segments) {
        publishedSegments.add(seg);
        let body: Buffer;
        try { body = fs.readFileSync(path.join(this.workDir, seg)); } catch { continue; }
        const ok = await this.putFile(publishUrl, seg, body, gen);
        if (gen !== this.generation) return;
        if (ok) {
          // A segment actually accepted by the relay (2xx) — this is LIVE evidence.
          this.store.update((s) => {
            s.camera.relayConnected = true;
            s.camera.lastFrameAt = Date.now();
          });
          if (this.state === "video_detected" || this.state === "relay_connected") {
            this.setState("live");
          }
        }
      }
      if (playlist) {
        let body: Buffer;
        try { body = fs.readFileSync(path.join(this.workDir, playlist)); } catch { body = Buffer.alloc(0); }
        if (body.length > 0) await this.putFile(publishUrl, playlist, body, gen);
      }
    };
    const loop = setInterval(() => { if (gen === this.generation) void tick(); else clearInterval(loop); }, 1000);
  }

  private async putFile(publishUrl: string, file: string, body: Buffer, gen: number): Promise<boolean> {
    const token = this.tokens.token;
    if (!token) return false;
    // publishUrl is path-keyed (…/:streamId/:key/); append the file name.
    const target = publishUrl.replace(/\/+$/, "") + "/" + encodeURIComponent(file);
    try {
      const res = await this.loggedFetch("ingest", target, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${token}` },
        body: body as unknown as BodyInit,
      }, { fileOnly: true });
      if (gen !== this.generation) return false;
      if (res.status === 401 || res.status === 403) {
        this.handleRevoked(res.status);
        return false;
      }
      return res.ok;
    } catch (err) {
      if (gen === this.generation) {
        this.log.log("camera", `Segment PUT failed: ${classifyException(err)}`, "warn", { fileOnly: true });
      }
      return false;
    }
  }

  // ── Status reporting ─────────────────────────────────────────────────────────

  /** POST /api/controllers/camera-status on every state change + heartbeat. */
  private async reportStatus(state: CameraState, media: CameraMedia, force = false): Promise<void> {
    const gen = this.generation;
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) return;
    // Throttle: skip identical non-forced reports fired within 1s.
    const now = Date.now();
    if (!force && state === this.lastReportedState && now - this.lastReportAt < 1000) return;
    this.lastReportedState = state;
    this.lastReportAt = now;

    const body: Record<string, unknown> = { state };
    const detail = this.store.state.camera.detail;
    if (detail) body.detail = detail;
    const m: Record<string, unknown> = {};
    if (media.width !== null) m.width = media.width;
    if (media.height !== null) m.height = media.height;
    if (media.fps !== null) m.fps = media.fps;
    if (media.codec !== null) m.codec = media.codec;
    if (media.bitrateKbps !== null) m.bitrateKbps = media.bitrateKbps;
    const lastFrameAt = this.store.state.camera.lastFrameAt;
    if (lastFrameAt !== null) m.lastFrameAt = new Date(lastFrameAt).toISOString();
    if (Object.keys(m).length > 0) body.media = m;

    const base = meta.serverUrl.replace(/\/+$/, "");
    try {
      const res = await this.loggedFetch("camera-status", `${base}/api/controllers/camera-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }, { fileOnly: true });
      if (gen !== this.generation) return;
      if (res.status === 401 || res.status === 403) this.handleRevoked(res.status);
    } catch (err) {
      if (gen === this.generation) this.log.log("camera", `Status report error: ${classifyException(err)}`, "warn", { fileOnly: true });
    }
  }

  // ── Probes + helpers ─────────────────────────────────────────────────────────

  private async probeCloud(): Promise<boolean> {
    const meta = this.tokens.meta;
    if (!meta) return false;
    const base = meta.serverUrl.replace(/\/+$/, "");
    try {
      const res = await this.fetchFn(`${base}/api/health`, { signal: AbortSignal.timeout(CLOUD_PROBE_TIMEOUT_MS) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  private resolveFfmpeg(): { path: string | null; source: FfmpegSource } {
    // 1) explicit test/setting override
    if (this.opts.ffmpegPath) return { path: this.opts.ffmpegPath, source: "setting" };
    // 2) bundled via electron-builder extraResources (win: resources/ffmpeg/ffmpeg.exe)
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
      const bundled = path.join(resourcesPath, "ffmpeg", exe);
      if (fs.existsSync(bundled)) return { path: bundled, source: "bundled" };
    }
    // 3) PATH fallback (dev)
    const onPath = ffmpegOnPath();
    if (onPath) return { path: onPath, source: "path" };
    return { path: null, source: "missing" };
  }

  private get state(): CameraState {
    return this.store.state.camera.state;
  }

  private setState(state: CameraState, detail: string | null = null, opts?: { report?: boolean }): void {
    const prev = this.store.state.camera.state;
    this.store.update((s) => {
      s.camera.state = state;
      s.camera.detail = detail;
    });
    if (prev !== state) {
      this.log.log("camera", `Camera state → ${state}${detail ? ` (${redactCameraText(detail)})` : ""}`,
        FAILURE_STATES.has(state) ? "warn" : "info");
    }
    if (opts?.report === false) return;
    if (prev !== state) void this.reportStatus(state, this.store.state.camera.media);
  }

  private handleRevoked(status: number): void {
    this.stopPipeline("stopped");
    this.log.log("camera", "Aurora rejected the device token for camera — relay stopped. Telemetry unaffected.", "error");
    // Delegate token clearing / REVOKED to the aurora link's own path via state:
    // camera does not own the pairing; it stops and lets auroraLink handle revocation.
    void status;
  }

  /**
   * fetch with a timeout + wire trace to the camera log. The Authorization
   * header is never logged, and the RTSP sourceUrl / publishUrl path key are
   * redacted from every logged URL and body.
   */
  private async loggedFetch(
    tag: string, url: string, init: RequestInit, opts?: { fileOnly?: boolean; timeoutMs?: number },
  ): Promise<{ status: number; ok: boolean; text: string; json: unknown }> {
    const fileOnly = opts?.fileOnly ?? false;
    this.log.log("camera", `[${tag}] → ${init.method ?? "GET"} ${redactCameraText(url)}`, "info", { fileOnly });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      this.log.log(
        "camera",
        `[${tag}] ← HTTP ${res.status} ${redactCameraText(text.slice(0, 200)) || "(empty)"}`,
        res.ok ? "info" : "warn",
        { fileOnly: fileOnly && res.ok },
      );
      return { status: res.status, ok: res.ok, text, json };
    } catch (err) {
      this.log.log("camera", `[${tag}] ✗ ${classifyException(err)}`, "warn", { fileOnly });
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

const FAILURE_STATES = new Set<CameraState>([
  "camera_unreachable", "rtsp_failed", "no_frames", "relay_disconnected", "cloud_unavailable",
]);

export const EMPTY_MEDIA: CameraMedia = {
  width: null, height: null, fps: null, codec: null, bitrateKbps: null,
};

/** Parse an rtsp:// URL into host + port (default 554). Never logged raw. */
function parseRtsp(url: string): { host: string | null; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || null, port: u.port ? Number(u.port) : 554 };
  } catch {
    const m = url.match(/rtsp:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/i);
    return m ? { host: m[1], port: m[2] ? Number(m[2]) : 554 } : { host: null, port: 554 };
  }
}

/** Default TCP reachability probe: open a socket to host:port with a timeout. */
function defaultProbeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

/** Find ffmpeg on PATH synchronously (dev fallback). */
function ffmpegOnPath(): string | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* skip */ }
  }
  return null;
}

export { APP_VERSION as CAMERA_APP_VERSION };
