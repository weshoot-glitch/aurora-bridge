/**
 * Aurora side of the bridge: pairing + telemetry forwarding over HTTPS.
 *
 * Completely independent of the drone link — pairing/auth failures never stop
 * MAVLink acquisition, and losing the drone never disconnects Aurora.
 *
 * Wire contract (artifacts/api-server/src/routes/controllers.ts):
 *  - POST /api/controllers/claim {deviceId, code, deviceInfo} → {token, telemetryUrl, aircraftId, expectedSysId}
 *  - POST /api/controllers/telemetry  Bearer token; field is `lng` NOT `lon`;
 *    missing fields are OMITTED (never zeros). 401/403 → clear token, REVOKED.
 *  - POST /api/controllers/telemetry/batch {frames:[{capturedAt, lat, lng, ...}]} for offline catch-up.
 *  - POST /api/controllers/health {state, appVersion, queuedFrames}
 */
import * as os from "os";
import type { BridgeStore, VehicleState } from "./state";
import type { BridgeLog } from "./log";
import { TokenStore } from "./tokenStore";
import {
  freshStages, classifyHttpFailure, classifyException, type AuroraStageId,
} from "./handshake";

const APP_VERSION = "4.2.1";
const HANDSHAKE_TIMEOUT_MS = 10000;
const FORWARD_INTERVAL_MS = 1000;
const HEALTH_INTERVAL_MS = 30000;
const MAX_QUEUE = 900; // ~15 min of 1 Hz frames buffered while Aurora is unreachable

interface QueuedFrame {
  capturedAt: string;
  body: Record<string, unknown>;
}

export interface ClaimInput {
  serverUrl: string;
  pairingString?: string;
  deviceId?: number;
  code?: string;
}

/** Strip query strings from URLs and mask secret-bearing JSON fields before logging. */
export function redactForLog(text: string): string {
  return text
    .replace(/([?&](?:token|auth|code|key|signature)[^=]*=)[^&\s"']+/gi, "$1***")
    .replace(/("(?:token|deviceCode|userCode|userCodeDisplay|pairingString|code|authorization)"\s*:\s*")[^"]*(")/gi, "$1***$2");
}

export class AuroraLink {
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private queue: QueuedFrame[] = [];
  private sending = false;
  /** bumped on stop/offline/unpair/re-pair — any in-flight handshake from an older generation must not touch state */
  private generation = 0;

  constructor(
    private store: BridgeStore,
    private log: BridgeLog,
    private tokens: TokenStore,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.syncPairedState();
  }

  private syncPairedState(): void {
    const meta = this.tokens.meta;
    this.store.update((s) => {
      s.aurora.paired = this.tokens.isPaired;
      s.aurora.tokenStoredPlaintext = this.tokens.isPlaintext;
      s.aurora.serverUrl = meta?.serverUrl ?? null;
      s.aurora.aircraftId = meta?.aircraftId ?? null;
      s.aurora.expectedSysId = meta?.expectedSysId ?? null;
      if (!this.tokens.isPaired) s.aurora.status = "not_paired";
      else if (s.aurora.status === "not_paired") s.aurora.status = "connecting";
    });
  }

  /** LOGIN: claim a one-time pairing code. Drone link is untouched throughout. */
  async pair(input: ClaimInput): Promise<{ ok: true } | { ok: false; error: string }> {
    const base = input.serverUrl.replace(/\/+$/, "");
    let body: Record<string, unknown>;
    if (input.pairingString) body = { pairingString: input.pairingString.trim() };
    else body = { deviceId: input.deviceId, code: input.code };
    body.deviceInfo = {
      platform: process.platform === "win32" ? "windows" : process.platform,
      model: os.hostname().slice(0, 128),
      osVersion: os.release().slice(0, 64),
      appVersion: APP_VERSION,
    };
    try {
      const res = await this.loggedFetch("pair/claim", `${base}/api/controllers/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = res.json as { error?: string } | null;
        const msg = detail?.error ?? classifyHttpFailure(res.status);
        this.log.log("aurora", `Pairing failed: ${msg}`, "error");
        return { ok: false, error: msg };
      }
      const data = res.json as {
        token: string; telemetryUrl: string; deviceId?: number;
        aircraftId?: number; expectedSysId?: number;
      };
      const telemetryUrl = data.telemetryUrl.startsWith("http")
        ? data.telemetryUrl
        : `${base}${data.telemetryUrl}`;
      this.tokens.save({
        token: data.token,
        telemetryUrl,
        serverUrl: base,
        aircraftId: data.aircraftId ?? null,
        expectedSysId: data.expectedSysId ?? null,
        deviceId: data.deviceId ?? null,
      });
      this.syncPairedState();
      this.store.update((s) => { s.aurora.status = "connected"; s.aurora.lastError = null; });
      this.log.log("aurora", "Authentication successful. Device paired.");
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      this.log.log("aurora", `Pairing failed: ${msg}`, "error");
      return { ok: false, error: msg };
    }
  }

  // ── Sign-in registration (device-authorization flow) ─────────────────────
  // The Bridge asks Aurora for a short approval code; the operator — already
  // signed into Aurora in their browser — approves it there. No codes copied.
  private signIn: { serverUrl: string; deviceCode: string } | null = null;

  async signInStart(serverUrl: string): Promise<
    { ok: true; userCode: string; userCodeDisplay: string; verifyUrl: string; expiresAt: string } | { ok: false; error: string }
  > {
    const base = serverUrl.replace(/\/+$/, "");
    try {
      const res = await this.loggedFetch("signin/start", `${base}/api/controllers/signin/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceInfo: {
            hostname: os.hostname().slice(0, 128),
            platform: process.platform === "win32" ? "windows" : process.platform,
            appVersion: APP_VERSION,
          },
        }),
      });
      if (!res.ok) return { ok: false, error: classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null) };
      const data = res.json as {
        deviceCode: string; userCode: string; userCodeDisplay: string; verifyPath: string; expiresAt: string;
      };
      this.signIn = { serverUrl: base, deviceCode: data.deviceCode };
      this.log.log("aurora", `Sign-in started — approval code ${data.userCodeDisplay}.`);
      return {
        ok: true,
        userCode: data.userCode,
        userCodeDisplay: data.userCodeDisplay,
        verifyUrl: `${base}${data.verifyPath}`,
        expiresAt: data.expiresAt,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Poll the pending sign-in. On approval, stores the token exactly like pair(). */
  async signInPoll(): Promise<{ status: "idle" | "pending" | "approved" | "denied" | "expired" | "error"; error?: string }> {
    if (!this.signIn) return { status: "idle" };
    const { serverUrl, deviceCode } = this.signIn;
    try {
      // fileOnly: polls every 3 s — full trace goes to bridge.log without flooding the UI.
      const res = await this.loggedFetch("signin/poll", `${serverUrl}/api/controllers/signin/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      }, { fileOnly: true });
      if (res.status === 404) { this.signIn = null; return { status: "expired" }; }
      if (!res.ok) return { status: "error", error: classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null) };
      const data = res.json as {
        status: string; token?: string; telemetryUrl?: string; deviceId?: number;
        aircraftId?: number; expectedSysId?: number | null;
      };
      if (data.status === "pending") return { status: "pending" };
      if (data.status === "denied") { this.signIn = null; return { status: "denied" }; }
      if (data.status === "expired") { this.signIn = null; return { status: "expired" }; }
      if (data.status === "approved" && data.token && data.telemetryUrl) {
        const telemetryUrl = data.telemetryUrl.startsWith("http") ? data.telemetryUrl : `${serverUrl}${data.telemetryUrl}`;
        this.tokens.save({
          token: data.token,
          telemetryUrl,
          serverUrl,
          aircraftId: data.aircraftId ?? null,
          expectedSysId: data.expectedSysId ?? null,
          deviceId: data.deviceId ?? null,
        });
        this.signIn = null;
        this.syncPairedState();
        this.store.update((s) => { s.aurora.status = "connected"; s.aurora.lastError = null; });
        this.log.log("aurora", "Sign-in approved. Device registered.");
        if (!this.store.state.aurora.offlineMode) this.startForwarding();
        return { status: "approved" };
      }
      return { status: "error", error: "unexpected response" };
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }
  }

  unpair(): void {
    this.stopForwarding();
    this.tokens.clear();
    this.syncPairedState();
    this.log.log("aurora", "Pairing removed.");
  }

  setOfflineMode(offline: boolean): void {
    this.store.update((s) => {
      s.aurora.offlineMode = offline;
      if (offline) s.aurora.status = this.tokens.isPaired ? "offline_mode" : "not_paired";
    });
    if (offline) {
      this.stopForwarding();
      this.log.log("aurora", "Offline Mode ON — Aurora is ignored; drone link keeps running.");
    } else {
      this.log.log("aurora", "Offline Mode OFF.");
      if (this.tokens.isPaired) this.startForwarding();
    }
  }

  // ── Handshake stage machine ───────────────────────────────────────────────
  private setStage(id: AuroraStageId, status: "pending" | "active" | "done" | "failed", detail: string | null = null): void {
    this.store.update((s) => {
      const st = s.aurora.stages.find((x) => x.id === id);
      if (st) { st.status = status; st.detail = detail; }
    });
  }

  /** A stage failed: freeze the ladder, surface the exact reason, log it. */
  private failStage(id: AuroraStageId, reason: string): void {
    this.store.update((s) => {
      const st = s.aurora.stages.find((x) => x.id === id);
      if (st) { st.status = "failed"; st.detail = reason; }
      s.aurora.failureReason = reason;
      if (s.aurora.status !== "revoked") s.aurora.status = "error";
      s.aurora.lastError = reason;
    });
    const label = this.store.state.aurora.stages.find((x) => x.id === id)?.label ?? id;
    this.log.log("aurora", `FAILED at stage "${label}": ${reason}`, "error");
  }

  /**
   * fetch with a timeout + full wire trace to bridge.log/connection.log:
   * method, URL, status code and response body for EVERY request.
   * The Authorization header is never logged.
   */
  private async loggedFetch(
    tag: string, url: string, init: RequestInit, opts?: { fileOnly?: boolean; timeoutMs?: number },
  ): Promise<{ status: number; ok: boolean; text: string; json: unknown }> {
    const fileOnly = opts?.fileOnly ?? false;
    this.log.log("aurora", `[${tag}] → ${init.method ?? "GET"} ${redactForLog(url)}`, "info", { fileOnly });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body — logged raw below */ }
      this.log.log(
        "aurora",
        `[${tag}] ← HTTP ${res.status} ${redactForLog(text.slice(0, 300)) || "(empty body)"}`,
        res.ok ? "info" : "error",
        { fileOnly: fileOnly && res.ok },
      );
      return { status: res.status, ok: res.ok, text, json };
    } catch (err) {
      this.log.log("aurora", `[${tag}] ✗ ${classifyException(err)} (${(err as Error).message})`, "error");
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /** Start the 1 Hz forwarding loop. No-op unless paired and not offline. */
  startForwarding(): void {
    if (this.timer) return;
    if (this.store.state.aurora.offlineMode) return;
    if (!this.tokens.isPaired) {
      // Not signed in: fail the first stage with the exact reason — never blank.
      this.store.update((s) => {
        s.aurora.status = "not_paired";
        s.aurora.stages = freshStages();
        const st = s.aurora.stages.find((x) => x.id === "signed_in");
        if (st) { st.status = "failed"; st.detail = "Not signed in to Aurora — sign in or enter a pairing code."; }
        s.aurora.failureReason = "Not signed in to Aurora — sign in or enter a pairing code.";
      });
      return;
    }
    this.store.update((s) => { s.aurora.status = "connecting"; s.aurora.forwarding = true; });
    this.timer = setInterval(() => { void this.forwardTick(); }, FORWARD_INTERVAL_MS);
    this.healthTimer = setInterval(() => { void this.sendHealth(); }, HEALTH_INTERVAL_MS);
    void this.runHandshake(); // prove every stage of the link immediately, even with no drone yet
  }

  /**
   * The visible Aurora handshake. Every stage either completes or fails with
   * a specific reason — the UI never shows a bare "CONNECTING".
   */
  private async runHandshake(): Promise<void> {
    const gen = this.generation;
    const live = () => gen === this.generation; // false once stop/offline/unpair/re-pair happened
    this.store.update((s) => { s.aurora.stages = freshStages(); s.aurora.failureReason = null; });
    this.log.log("aurora", "Aurora handshake started.");

    // 1) Sign-in approved — do we hold a cloud token at all?
    this.setStage("signed_in", "active");
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token) { this.failStage("signed_in", "Cloud authentication missing or expired — sign in to Aurora again."); return; }
    this.setStage("signed_in", "done");

    // 2) Device registered — token metadata must include the telemetry endpoint.
    this.setStage("device_registered", "active");
    if (!meta?.telemetryUrl) { this.failStage("device_registered", "Device registration incomplete — no telemetry endpoint stored. Sign in again."); return; }
    this.setStage("device_registered", "done", meta.deviceId !== null ? `device #${meta.deviceId}` : null);

    // 3) Aircraft verified — binding recorded at approval time.
    this.setStage("aircraft_verified", "active");
    this.setStage("aircraft_verified", "done",
      meta.aircraftId !== null
        ? `aircraft #${meta.aircraftId} (cloud pairing record — not live telemetry)${meta.expectedSysId !== null ? `, expected SysID ${meta.expectedSysId}` : ""}`
        : "no specific aircraft bound — server routes by SysID");

    // 4) Contact Aurora Cloud — a real authenticated HTTPS round-trip.
    this.setStage("reach", "active", "sending health check…");
    const healthUrl = meta.telemetryUrl.replace(/\/telemetry$/, "/health");
    let result: { status: number; ok: boolean; json: unknown };
    try {
      result = await this.loggedFetch("handshake/health", healthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: this.queue.length > 0 ? "buffering" : "ok", appVersion: APP_VERSION, queuedFrames: this.queue.length }),
      });
    } catch (err) {
      if (live()) this.failStage("reach", classifyException(err));
      return;
    }
    if (!live()) return; // operator stopped/unpaired while the request was in flight
    if (result.status === 401 || result.status === 403) {
      this.failStage("reach", classifyHttpFailure(result.status, (result.json as { error?: string } | null)?.error ?? null));
      this.handleRevoked(result.status);
      return;
    }
    if (!result.ok) {
      this.failStage("reach", classifyHttpFailure(result.status, (result.json as { error?: string } | null)?.error ?? null));
      return;
    }
    this.setStage("reach", "done", `HTTP ${result.status}`);

    // 5) Session — Aurora accepted an authenticated report from this device.
    this.setStage("session", "done");
    this.store.update((s) => {
      s.aurora.status = "connected";
      s.aurora.lastError = null;
      s.aurora.failureReason = null;
    });
    this.log.log("aurora", "Aurora link established — cloud accepted this device's credentials.");

    // 6) Stream — completes on the first telemetry frame Aurora accepts.
    const drone = this.store.state.drone;
    this.setStage("stream", "active",
      drone.status === "connected" ? "sending first telemetry frame…" : "waiting for drone telemetry (link is up; no drone data yet)");
  }

  stopForwarding(opts?: { preserveStages?: boolean }): void {
    this.generation += 1; // any in-flight handshake result is now stale and must be discarded
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
    this.store.update((s) => {
      s.aurora.forwarding = false;
      if (!opts?.preserveStages) {
        // deliberate operator stop — clear the ladder; a revocation keeps the
        // failed stage visible so the reason is never wiped from the screen
        s.aurora.stages = freshStages();
        s.aurora.failureReason = null;
      }
    });
  }

  /** Build a telemetry body from vehicle state — omit unknowns, never fabricate. */
  buildFrame(v: VehicleState): Record<string, unknown> | null {
    if (v.sysId === null) return null; // no vehicle — nothing to forward
    const body: Record<string, unknown> = { sysId: v.sysId };
    if (v.lat !== null && v.lon !== null) {
      body.lat = v.lat;
      body.lng = v.lon; // wire field is `lng`
    }
    if (v.relativeAltM !== null) body.altitude = v.relativeAltM;
    else if (v.altitudeM !== null) body.altitude = v.altitudeM;
    if (v.airspeedMs !== null) body.airspeed = v.airspeedMs;
    if (v.groundspeedMs !== null) body.groundspeed = v.groundspeedMs;
    if (v.headingDeg !== null) body.heading = v.headingDeg;
    if (v.batteryPercent !== null) body.batteryPercent = v.batteryPercent;
    if (v.satellites !== null) body.satellites = v.satellites;
    if (v.verticalSpeedMs !== null) body.verticalSpeed = v.verticalSpeedMs;
    if (v.armed !== null) body.armed = v.armed;
    return body;
  }

  private async forwardTick(): Promise<void> {
    if (this.sending) return;
    const drone = this.store.state.drone;
    if (drone.status !== "connected") return; // nothing live to send; queue only holds real frames
    const body = this.buildFrame(drone.vehicle);
    if (!body) return;
    this.sending = true;
    try {
      await this.postFrame(body);
    } finally {
      this.sending = false;
    }
  }

  private async postFrame(body: Record<string, unknown>): Promise<void> {
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) return;
    try {
      // Full wire trace to bridge.log; per-frame successes are file-only so the
      // UI log window is not flooded at 1 Hz. Failures always surface in the UI.
      const res = await this.loggedFetch("telemetry", meta.telemetryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }, { fileOnly: true });
      if (res.status === 401 || res.status === 403) {
        this.failStage("stream", classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null));
        this.handleRevoked(res.status);
        return;
      }
      if (!res.ok) {
        this.enqueue(body);
        const reason = classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null);
        this.failStage("stream", reason);
        this.noteError(reason);
        return;
      }
      const data = res.json as { ok?: boolean; warning?: string } | null;
      if (data?.ok === false) {
        // Server accepted the request but refused routing (e.g. unexpected sysId).
        const reason = `Telemetry subscription rejected — ${data.warning ?? "frame not routed by the server"}`;
        this.store.update((s) => {
          s.aurora.framesRejected += 1;
          s.aurora.status = "connected"; // link itself is alive — the frame was refused
          s.aurora.lastError = reason;
          s.aurora.failureReason = reason; // degraded, never "all systems go"
        });
        this.setStage("stream", "failed", reason);
        this.log.log("aurora", `Telemetry frame rejected by server: ${data.warning ?? "not routed"}`, "warn");
        return;
      }
      this.store.update((s) => {
        s.aurora.framesForwarded += 1;
        s.aurora.lastForwardAt = Date.now();
        s.aurora.status = "connected";
        s.aurora.lastError = null;
        s.aurora.failureReason = null;
      });
      const st = this.store.state.aurora.stages.find((x) => x.id === "stream");
      if (st && st.status !== "done") {
        this.setStage("stream", "done", `HTTP ${res.status} — frame acknowledged`);
        this.log.log("aurora", "Telemetry session established. Aurora Connected.");
      }
      if (this.queue.length > 0) await this.flushQueue(token, meta.telemetryUrl);
    } catch (err) {
      this.enqueue(body);
      const reason = classifyException(err);
      this.failStage("stream", reason);
      this.noteError(reason);
    }
  }

  private enqueue(body: Record<string, unknown>): void {
    // Only queue frames with a real position — the batch endpoint requires lat+lng.
    if (typeof body.lat !== "number" || typeof body.lng !== "number") return;
    this.queue.push({ capturedAt: new Date().toISOString(), body });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.store.update((s) => { s.aurora.queuedFrames = this.queue.length; });
  }

  private async flushQueue(token: string, telemetryUrl: string): Promise<void> {
    const batchUrl = telemetryUrl.replace(/\/telemetry$/, "/telemetry/batch");
    const frames = this.queue.splice(0, 500).map((q) => ({ capturedAt: q.capturedAt, ...q.body }));
    try {
      const res = await this.loggedFetch("telemetry/batch", batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ frames }),
      }, { fileOnly: true });
      if (res.status === 401 || res.status === 403) {
        this.failStage("stream", classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null));
        this.handleRevoked(res.status);
        return;
      }
      if (!res.ok) {
        // Batch not accepted — drop rather than loop forever; live path still works.
        this.log.log("aurora", `Buffered catch-up rejected (HTTP ${res.status}) — dropped ${frames.length} frames.`, "warn");
      } else {
        this.log.log("aurora", `Caught up ${frames.length} buffered frames.`);
      }
    } catch {
      // Still offline — put them back (within cap).
      this.queue.unshift(...frames.map((f) => {
        const { capturedAt, ...body } = f;
        return { capturedAt: String(capturedAt), body };
      }));
      if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE;
    }
    this.store.update((s) => { s.aurora.queuedFrames = this.queue.length; });
  }

  private async sendHealth(): Promise<void> {
    const gen = this.generation;
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) return;
    // A failed handshake self-heals: every 30 s health tick re-runs the full
    // staged handshake so recovery (or the persisting failure) stays visible.
    if (this.store.state.aurora.failureReason !== null || this.store.state.aurora.status === "connecting") {
      await this.runHandshake();
      return;
    }
    const state = this.queue.length > 0 ? "buffering" : "ok";
    try {
      const res = await this.loggedFetch("health", meta.telemetryUrl.replace(/\/telemetry$/, "/health"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state, appVersion: APP_VERSION, queuedFrames: this.queue.length }),
      }, { fileOnly: true });
      if (gen !== this.generation) return; // stopped/unpaired while in flight — discard
      if (res.status === 401 || res.status === 403) {
        this.failStage("session", classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null));
        this.handleRevoked(res.status);
        return;
      }
      if (!res.ok) {
        // NO silent failures: a bad health response is surfaced immediately.
        this.failStage("session", classifyHttpFailure(res.status, (res.json as { error?: string } | null)?.error ?? null));
        return;
      }
      // Keeps "Drone Offline / Aurora Connected" honest: the link itself is
      // proven alive by the health ping even when there is no telemetry.
      this.store.update((s) => {
        if (s.aurora.status === "connecting" || s.aurora.status === "error") {
          s.aurora.status = "connected";
          s.aurora.lastError = null;
        }
      });
    } catch (err) {
      // NO silent failures: health exceptions are classified and displayed.
      if (gen === this.generation) this.failStage("session", classifyException(err));
    }
  }

  private handleRevoked(status: number): void {
    this.stopForwarding({ preserveStages: true });
    this.tokens.clear();
    this.queue = [];
    this.store.update((s) => {
      s.aurora.status = "revoked";
      s.aurora.paired = false;
      s.aurora.queuedFrames = 0;
      s.aurora.lastError = status === 403 ? "Device access revoked by Aurora" : "Token rejected — re-pair required";
      s.aurora.failureReason = s.aurora.failureReason ?? classifyHttpFailure(status);
    });
    this.log.log("aurora", "Aurora rejected this device's token. Pairing cleared — re-pair to resume forwarding. Drone link unaffected.", "error");
  }

  private noteError(msg: string): void {
    this.store.update((s) => {
      s.aurora.forwardErrors += 1;
      s.aurora.status = "error";
      s.aurora.lastError = msg;
    });
  }
}
