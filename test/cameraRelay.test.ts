/**
 * Camera / Video Relay tests — stub fetch + stub ffmpeg (a node script that
 * emits fake -progress lines and HLS segments). No real ffmpeg in the repl.
 *
 * Pins the binding contract:
 *  - state ladder happy path to `live` with REAL evidence (frames + 2xx PUTs)
 *  - no frames ⇒ `no_frames`, never `live`
 *  - ethernet-loss sim (RTSP probe fails mid-relay) ⇒ relay stops, backoff, recover
 *  - 401 ⇒ relay stop
 *  - telemetry independence (camera failure never changes drone/aurora state)
 *  - redaction: RTSP sourceUrl + publish key never appear in log lines
 *  - media facts omitted when unknown (never 0)
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Bridge } from "../src/core/bridge";
import { redactCameraText } from "../src/core/cameraRelay";

const STUB = path.join(__dirname, "fixtures", "stub-ffmpeg.mjs");
const RTSP = "rtsp://192.168.144.25:8554/main.264";
const PUBLISH = "https://aurora.test/api/video/ingest/stream42/SECRETKEY123";

beforeAll(() => {
  // Make the stub directly spawnable on POSIX (shebang + exec bit).
  try { fs.chmodSync(STUB, 0o755); } catch { /* windows: spawn via node instead */ }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StubOpts {
  assigned?: boolean;
  healthStatus?: number;
  assignmentStatus?: number;
  ingestStatus?: number;
  statusStatus?: number;
}

function makeFetch(opts: StubOpts = {}, log?: { calls: string[] }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log?.calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/health")) {
      return new Response("ok", { status: opts.healthStatus ?? 200 });
    }
    if (url.endsWith("/api/controllers/camera-assignment")) {
      const status = opts.assignmentStatus ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ error: "x" }), { status });
      if (opts.assigned === false) return new Response(JSON.stringify({ assigned: false }), { status: 200 });
      return new Response(JSON.stringify({
        assigned: true,
        camera: {
          orgDeviceId: 5, displayName: "Nose Camera",
          catalog: { manufacturer: "SIYI", model: "A8 Mini" },
          sourceProtocol: "rtsp", sourceUrl: RTSP,
        },
        ingest: { publishUrl: PUBLISH },
      }), { status: 200 });
    }
    if (url.includes("/api/controllers/camera-status")) {
      return new Response(JSON.stringify({ ok: true }), { status: opts.statusStatus ?? 200 });
    }
    if (url.includes("/api/video/ingest/")) {
      return new Response("", { status: opts.ingestStatus ?? 200 });
    }
    // telemetry/health etc.
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

function makeBridge(fetchFn: typeof fetch, probeReachable: () => boolean, stubMode = "frames"): Bridge {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-test-"));
  process.env.STUB_MODE = stubMode;
  const bridge = new Bridge({
    dataDir: dir,
    ports: [14611],
    fetchFn,
    camera: {
      ffmpegPath: STUB,
      workDir: path.join(dir, "hls"),
      probeTcp: async () => probeReachable(),
    },
  });
  // Pretend we are paired + Aurora connected (camera gate depends on this).
  bridge.tokens.save({
    token: "cam.tok.secret", telemetryUrl: "https://aurora.test/api/controllers/telemetry",
    serverUrl: "https://aurora.test", aircraftId: 3, expectedSysId: 1, deviceId: 7,
  });
  bridge.store.update((s) => { s.aurora.status = "connected"; s.aurora.paired = true; });
  return bridge;
}

let bridge: Bridge | null = null;
afterEach(() => { bridge?.camera.stop(); bridge?.shutdown(); bridge = null; });

describe("camera relay state ladder", () => {
  it("reaches LIVE with real evidence (frames advancing + segments PUT 2xx)", async () => {
    let reachable = true;
    bridge = makeBridge(makeFetch(), () => reachable, "frames");
    bridge.camera.start();
    // wait for gate → pipeline → frames → segment PUT → live
    for (let i = 0; i < 60 && bridge.store.state.camera.state !== "live"; i++) await sleep(150);
    const c = bridge.store.state.camera;
    expect(c.state).toBe("live");
    expect(c.assigned).toBe(true);
    expect(c.framesReceived).toBeGreaterThan(0);
    expect(c.relayConnected).toBe(true);
    expect(c.lastFrameAt).not.toBeNull();
    // media facts that the stub reported are present; unknown ones stay null.
    expect(c.media.fps).toBe(30);
    expect(c.media.bitrateKbps).toBe(2500);
    expect(c.media.width).toBeNull();   // stub never emits resolution → omitted, never 0
    expect(c.media.height).toBeNull();
  }, 15000);

  it("no frames ⇒ no_frames, never live", async () => {
    bridge = makeBridge(makeFetch(), () => true, "noframes");
    bridge.camera.start();
    // relay connects but frames never advance → no_frames after the watchdog
    for (let i = 0; i < 120 && bridge.store.state.camera.state !== "no_frames"; i++) await sleep(150);
    const c = bridge.store.state.camera;
    expect(c.state).toBe("no_frames");
    expect(c.framesReceived).toBe(0);
    // never falsely live
    expect(["live", "video_detected"]).not.toContain(c.state);
  }, 20000);

  it("no camera assigned ⇒ stays configured, pipeline never starts", async () => {
    bridge = makeBridge(makeFetch({ assigned: false }), () => true);
    bridge.camera.start();
    await sleep(1000);
    const c = bridge.store.state.camera;
    expect(c.assigned).toBe(false);
    expect(["configured", "stopped"]).toContain(c.state);
  });
});

describe("camera relay resilience", () => {
  it("ethernet loss (probe fails mid-relay) stops relay, then recovers automatically", async () => {
    let reachable = true;
    bridge = makeBridge(makeFetch(), () => reachable, "frames");
    bridge.camera.start();
    for (let i = 0; i < 60 && bridge.store.state.camera.state !== "live"; i++) await sleep(150);
    expect(bridge.store.state.camera.state).toBe("live");

    // Simulate ethernet unplug: RTSP host becomes unreachable.
    reachable = false;
    for (let i = 0; i < 40 && bridge.store.state.camera.state === "live"; i++) await sleep(150);
    expect(["camera_unreachable"]).toContain(bridge.store.state.camera.state);
    // media facts wiped — nothing stale shown as current
    expect(bridge.store.state.camera.framesReceived).toBe(0);

    // Reconnect ethernet: backoff retry restores live without reconfiguration.
    reachable = true;
    for (let i = 0; i < 120 && bridge.store.state.camera.state !== "live"; i++) await sleep(150);
    expect(bridge.store.state.camera.state).toBe("live");
  }, 40000);

  it("401 from cloud stops the relay", async () => {
    bridge = makeBridge(makeFetch({ ingestStatus: 401 }), () => true, "frames");
    bridge.camera.start();
    // pipeline starts, first PUT hits 401 → relay stops
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (bridge.store.state.camera.state === "stopped") break;
    }
    // camera relay must have stopped the pipeline (not live)
    expect(bridge.store.state.camera.state).not.toBe("live");
  }, 15000);
});

describe("camera independence + honesty", () => {
  it("camera failure never alters drone or aurora state", async () => {
    // ffmpeg crashes immediately (RTSP drop) — drone/aurora untouched.
    bridge = makeBridge(makeFetch(), () => true, "crash");
    const droneBefore = JSON.stringify(bridge.store.state.drone);
    const auroraStatusBefore = bridge.store.state.aurora.status;
    bridge.camera.start();
    await sleep(2000);
    expect(bridge.store.state.aurora.status).toBe(auroraStatusBefore);
    expect(JSON.stringify(bridge.store.state.drone)).toBe(droneBefore);
    // camera itself reflects a failure/backoff state, not a fake success
    expect(["relay_disconnected", "rtsp_failed", "reachable", "video_detected", "camera_unreachable", "stopped"])
      .toContain(bridge.store.state.camera.state);
  }, 10000);

  it("redaction: RTSP sourceUrl and publish key never appear in log lines", async () => {
    bridge = makeBridge(makeFetch(), () => true, "frames");
    bridge.camera.start();
    for (let i = 0; i < 40 && bridge.store.state.camera.state !== "live"; i++) await sleep(150);
    // Read the on-disk camera log (what ships in diagnostics).
    const logPath = path.join(bridge.dataDir, "logs", "camera.log");
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const inMemory = bridge.log.lines.filter((l) => l.category === "camera").map((l) => l.message).join("\n");
    expect(text + inMemory).not.toContain("192.168.144.25");
    expect(text + inMemory).not.toContain("main.264");
    expect(text + inMemory).not.toContain("SECRETKEY123");
    expect(text + inMemory).not.toContain("cam.tok.secret");
  }, 15000);

  it("redactCameraText strips rtsp URLs and the ingest path key", () => {
    expect(redactCameraText(`connect ${RTSP}`)).not.toContain("192.168.144.25");
    expect(redactCameraText(`PUT ${PUBLISH}/seg0.ts`)).not.toContain("SECRETKEY123");
    expect(redactCameraText(`{"sourceUrl":"${RTSP}"}`)).not.toContain("main.264");
  });
});
