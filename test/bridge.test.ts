/**
 * End-to-end-ish tests of the V4 core: a real UDP MAVLink stream is fed to the
 * DroneLink, Aurora is a stubbed fetch, and the independence rules are pinned.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as dgram from "dgram";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MavLinkProtocolV2, minimal, common } from "node-mavlink";
import { Bridge } from "../src/core/bridge";

const TEST_PORT = 14599; // dedicated test port — never collides with dev sim

function makeBridge(fetchFn: typeof fetch, ports = [TEST_PORT]): Bridge {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  return new Bridge({ dataDir: dir, ports, fetchFn });
}

function sendMavlink(port: number, build: () => Parameters<MavLinkProtocolV2["serialize"]>[0][]): Promise<void> {
  const protocol = new MavLinkProtocolV2(1, 1);
  const sock = dgram.createSocket("udp4");
  let seq = 0;
  return new Promise((resolve) => {
    const msgs = build();
    let sent = 0;
    for (const m of msgs) {
      sock.send(protocol.serialize(m, seq++ & 0xff), port, "127.0.0.1", () => {
        sent += 1;
        if (sent === msgs.length) { sock.close(); resolve(); }
      });
    }
  });
}

function heartbeat(armed = false) {
  const hb = new minimal.Heartbeat();
  hb.type = 2; hb.autopilot = 3;
  hb.baseMode = 81 | (armed ? 128 : 0);
  hb.customMode = 5; hb.systemStatus = 4; hb.mavlinkVersion = 3;
  return hb;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

let bridge: Bridge | null = null;
afterEach(() => { bridge?.shutdown(); bridge = null; });

describe("drone acquisition (independent of Aurora)", () => {
  it("locks onto the first valid heartbeat and decodes vehicle state honestly", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(150);
    expect(bridge.store.state.drone.status).toBe("searching");

    await sendMavlink(TEST_PORT, () => {
      const gps = new common.GpsRawInt();
      gps.fixType = 3; gps.satellitesVisible = 12;
      gps.lat = 247136000; gps.lon = 466753000;
      const pos = new common.GlobalPositionInt();
      pos.lat = 247136000; pos.lon = 466753000;
      pos.alt = 612000; pos.relativeAlt = 40000; pos.vz = -50; pos.hdg = 9000;
      return [heartbeat(), gps, pos];
    });
    await sleep(300);

    const d = bridge.store.state.drone;
    expect(d.status).toBe("connected");
    expect(d.activePort).toBe(TEST_PORT);
    expect(d.sourceIp).toBe("127.0.0.1");
    expect(d.vehicle.sysId).toBe(1);
    expect(d.vehicle.vehicleType).toBe("Quadrotor");
    expect(d.vehicle.autopilot).toBe("ArduPilot");
    expect(d.vehicle.flightMode).toBe("LOITER");
    expect(d.vehicle.armed).toBe(false);
    expect(d.vehicle.lat).toBeCloseTo(24.7136, 4);
    expect(d.vehicle.relativeAltM).toBeCloseTo(40, 3);
    expect(d.vehicle.headingDeg).toBeCloseTo(90, 3);
    // never-seen values stay null, not 0
    expect(d.vehicle.batteryPercent).toBeNull();
    expect(d.vehicle.airspeedMs).toBeNull();
  });

  it("filters MAVLink sentinel values instead of displaying them", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(100);
    await sendMavlink(TEST_PORT, () => {
      const sys = new common.SysStatus();
      sys.voltageBattery = 65535; // sentinel
      sys.batteryRemaining = -1;  // sentinel
      const gps = new common.GpsRawInt();
      gps.fixType = 0; gps.satellitesVisible = 255; // sentinel
      return [heartbeat(), sys, gps];
    });
    await sleep(300);
    const v = bridge.store.state.drone.vehicle;
    expect(v.batteryPercent).toBeNull();
    expect(v.batteryVoltage).toBeNull();
    expect(v.satellites).toBeNull();
    expect(v.gpsFix).toBe("No GPS");
  });

  it("connects to the drone with Aurora completely unavailable", async () => {
    const failingFetch: typeof fetch = async () => { throw new Error("network down"); };
    bridge = makeBridge(failingFetch);
    bridge.autoStart(); // unpaired → aurora stays not_paired, drone searches
    await sleep(100);
    await sendMavlink(TEST_PORT, () => [heartbeat()]);
    await sleep(300);
    expect(bridge.store.state.drone.status).toBe("connected");
    expect(bridge.store.state.aurora.status).toBe("not_paired");
  });
});

describe("aurora link (independent of drone)", () => {
  it("pairs successfully and losing the drone does not change aurora state", async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/controllers/claim")) {
        return new Response(JSON.stringify({
          token: "acd.7.secret", deviceId: 7, aircraftId: 3, expectedSysId: 1,
          telemetryUrl: "https://aurora.test/api/controllers/telemetry",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    bridge = makeBridge(fetchStub);
    const result = await bridge.aurora.pair({ serverUrl: "https://aurora.test", pairingString: "7-ABC123" });
    expect(result.ok).toBe(true);
    expect(bridge.store.state.aurora.paired).toBe(true);
    expect(bridge.store.state.aurora.status).toBe("connected");
    // drone was never started — aurora unaffected
    expect(bridge.store.state.drone.status).toBe("disconnected");
  });

  it("maps vehicle state to the wire contract: lng not lon, unknowns omitted", () => {
    bridge = makeBridge(okFetch);
    const frame = bridge.aurora.buildFrame({
      sysId: 1, compId: 1, vehicleType: "Quadrotor", autopilot: "ArduPilot",
      flightMode: "LOITER", armed: true, batteryPercent: 80, batteryVoltage: 24.6,
      satellites: 14, gpsFix: "3D fix", lat: 24.7, lon: 46.6, altitudeM: 612,
      relativeAltM: 40, airspeedMs: null, groundspeedMs: 5.8, headingDeg: 90,
      verticalSpeedMs: 0.5,
    });
    expect(frame).not.toBeNull();
    expect(frame!.lng).toBe(46.6);
    expect(frame).not.toHaveProperty("lon");
    expect(frame).not.toHaveProperty("airspeed"); // unknown → omitted, never 0
    expect(frame).not.toHaveProperty("flightMode"); // deliberately not sent
    expect(frame!.altitude).toBe(40); // relative preferred
    expect(frame!.armed).toBe(true);
  });

  it("returns null frame when there is no vehicle — never fabricates", () => {
    bridge = makeBridge(okFetch);
    expect(bridge.aurora.buildFrame(bridge.store.state.drone.vehicle)).toBeNull();
  });

  it("401 clears the pairing, sets REVOKED, and leaves the drone link running", async () => {
    let claimed = false;
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/claim")) {
        claimed = true;
        return new Response(JSON.stringify({
          token: "acd.7.dead", deviceId: 7, aircraftId: 3, expectedSysId: 1,
          telemetryUrl: "https://aurora.test/api/controllers/telemetry",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    };
    bridge = makeBridge(fetchStub);
    bridge.drone.start();
    await sleep(100);
    await sendMavlink(TEST_PORT, () => [heartbeat()]);
    await sleep(300);
    await bridge.aurora.pair({ serverUrl: "https://aurora.test", pairingString: "7-X" });
    expect(claimed).toBe(true);
    bridge.aurora.startForwarding();
    await sleep(1300); // one forward tick hits the 401
    expect(bridge.store.state.aurora.status).toBe("revoked");
    expect(bridge.store.state.aurora.paired).toBe(false);
    expect(bridge.tokens.isPaired).toBe(false);
    expect(bridge.store.state.drone.status).toBe("connected"); // untouched
  });

  it("offline mode stops forwarding but never the drone", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(100);
    await sendMavlink(TEST_PORT, () => [heartbeat()]);
    await sleep(300);
    bridge.aurora.setOfflineMode(true);
    expect(bridge.store.state.aurora.offlineMode).toBe(true);
    expect(bridge.store.state.aurora.forwarding).toBe(false);
    expect(bridge.store.state.drone.status).toBe("connected");
  });
});

describe("lock & watchdog integrity", () => {
  it("ignores GCS heartbeats and a second source cannot steal the lock", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(100);
    // GCS heartbeat (type 6) first — must NOT lock.
    await sendMavlink(TEST_PORT, () => {
      const gcs = new minimal.Heartbeat();
      gcs.type = 6; gcs.autopilot = 8; gcs.baseMode = 0; gcs.systemStatus = 4; gcs.mavlinkVersion = 3;
      return [gcs];
    });
    await sleep(200);
    expect(bridge.store.state.drone.status).toBe("searching");

    // Real vehicle locks from its own socket …
    await sendMavlink(TEST_PORT, () => [heartbeat()]);
    await sleep(200);
    const lockedSrcPort = bridge.store.state.drone.sourcePort;
    expect(bridge.store.state.drone.status).toBe("connected");

    // … then a DIFFERENT source (new socket = new source port) sends telemetry — rejected.
    await sendMavlink(TEST_PORT, () => {
      const pos = new common.GlobalPositionInt();
      pos.lat = 100000000; pos.lon = 100000000; pos.alt = 1000; pos.relativeAlt = 999000;
      return [pos];
    });
    await sleep(200);
    expect(bridge.store.state.drone.vehicle.relativeAltM).toBeNull();
    expect(bridge.store.state.drone.sourcePort).toBe(lockedSrcPort);
  });

  it("stale heartbeat wipes the ENTIRE vehicle state — nothing stale survives", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(100);
    await sendMavlink(TEST_PORT, () => {
      const pos = new common.GlobalPositionInt();
      pos.lat = 247136000; pos.lon = 466753000; pos.alt = 612000; pos.relativeAlt = 40000;
      return [heartbeat(true), pos];
    });
    await sleep(300);
    expect(bridge.store.state.drone.vehicle.lat).not.toBeNull();
    // no more heartbeats → watchdog (5s) fires
    await sleep(6200);
    const d = bridge.store.state.drone;
    expect(d.status).toBe("searching");
    expect(d.vehicle.lat).toBeNull();
    expect(d.vehicle.armed).toBeNull();
    expect(d.activePort).toBeNull();
    expect(d.streamsRequested).toBe(false);
  }, 10000);
});

describe("multi-component integrity", () => {
  it("a camera component sharing the sysId cannot fake telemetry or corrupt vehicle state", async () => {
    bridge = makeBridge(okFetch);
    bridge.drone.start();
    await sleep(100);
    // Autopilot (compId 1) locks; then a "camera" (compId 100) on the SAME
    // socket/sysId sends position data — must be ignored for vehicle state.
    const protocol1 = new MavLinkProtocolV2(1, 1);
    const protocol100 = new MavLinkProtocolV2(1, 100);
    const sock = dgram.createSocket("udp4");
    const sendVia = (proto: MavLinkProtocolV2, msg: Parameters<MavLinkProtocolV2["serialize"]>[0], seq: number) =>
      new Promise<void>((r) => sock.send(proto.serialize(msg, seq), TEST_PORT, "127.0.0.1", () => r()));
    try {
      await sendVia(protocol1, heartbeat(), 0);
      await sleep(250);
      expect(bridge.store.state.drone.status).toBe("connected");
      const camPos = new common.GlobalPositionInt();
      camPos.lat = 100000000; camPos.lon = 100000000; camPos.relativeAlt = 999000;
      await sendVia(protocol100, camPos, 0);
      // Interleave more autopilot heartbeats with camera packets — dropped
      // counter must stay 0 (per-component seq tracking).
      await sendVia(protocol1, heartbeat(), 1);
      await sendVia(protocol100, camPos, 1);
      await sendVia(protocol1, heartbeat(), 2);
      await sleep(1300); // let a monitor tick run
      const d = bridge.store.state.drone;
      expect(d.vehicle.relativeAltM).toBeNull(); // camera position ignored
      expect(d.phase).not.toBe("telemetry_active"); // camera can't fake telemetry
      expect(d.monitor.droppedPackets).toBe(0); // interleaving ≠ loss
    } finally {
      sock.close();
    }
  });
});

describe("control server security", () => {
  it("rejects API and WS access without the capability token", async () => {
    const { startControlServer } = await import("../src/server/controlServer");
    bridge = makeBridge(okFetch);
    const { server, port, authToken } = await startControlServer(bridge, path.join(process.cwd(), "ui"));
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(noAuth.status).toBe(401);
      const csrf = await fetch(`http://127.0.0.1:${port}/api/aurora/unpair`, { method: "POST" });
      expect(csrf.status).toBe(401);
      const withAuth = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "X-Bridge-Auth": authToken },
      });
      expect(withAuth.status).toBe(200);
      // DNS-rebinding style Host header is refused even with a token.
      // (fetch strips custom Host, so use a raw HTTP request.)
      const http = await import("http");
      const rebindStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/api/state", method: "GET",
            headers: { "X-Bridge-Auth": authToken, Host: "evil.example" } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
        req.end();
      });
      expect(rebindStatus).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe("diagnostics", () => {
  it("every test reports PASS/FAIL with a concrete reason", async () => {
    const failingFetch: typeof fetch = async () => { throw new Error("no network"); };
    bridge = makeBridge(failingFetch);
    const results = await bridge.diagnostics.runAll();
    expect(results.length).toBe(12);
    for (const r of results) {
      expect(typeof r.pass).toBe("boolean");
      expect(r.detail.length).toBeGreaterThan(5);
    }
    const drone = results.find((r) => r.id === "drone")!;
    expect(drone.pass).toBe(false);
    expect(drone.detail).toContain("CONNECT");
    const auth = results.find((r) => r.id === "auth")!;
    expect(auth.detail).toContain("Not paired");
  });

  it("diagnostics zip redacts the token", async () => {
    const fetchStub: typeof fetch = async (input) => {
      if (String(input).endsWith("/claim")) {
        return new Response(JSON.stringify({
          token: "acd.9.supersecretvalue", deviceId: 9, aircraftId: 1, expectedSysId: 1,
          telemetryUrl: "https://aurora.test/api/controllers/telemetry",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    bridge = makeBridge(fetchStub);
    await bridge.aurora.pair({ serverUrl: "https://aurora.test", pairingString: "9-Z" });
    const out = path.join(bridge.dataDir, "diag.zip");
    bridge.diagnostics.exportZip(out);
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(out);
    const config = zip.readAsText("config.json");
    expect(config).toContain("<redacted>");
    expect(config).not.toContain("supersecretvalue");
    expect(zip.getEntry("system_information.txt")).not.toBeNull();
  });
});
