/**
 * Active UDP-client mode (UniRC7-style radios): the radio NEVER sends first —
 * it only replies to the peer that contacted it. These tests run a fake radio
 * that stays silent until it receives our outbound heartbeat, then streams
 * MAVLink back to the sender's address — exactly the UniRC7 contract.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as dgram from "dgram";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser, minimal, common } from "node-mavlink";
import { PassThrough } from "stream";
import { Bridge } from "../src/core/bridge";
import { validateActiveClient } from "../src/core/udpSettings";

const RADIO_PORT = 19857; // fake radio's fixed port (19856-style)
const LOCAL_PORT = 14581;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function heartbeat() {
  const hb = new minimal.Heartbeat();
  hb.type = 2; hb.autopilot = 3;
  hb.baseMode = 81; hb.customMode = 5; hb.systemStatus = 4; hb.mavlinkVersion = 3;
  return hb;
}

/** Fake UniRC7: silent until poked, then streams heartbeats to the poker. */
function makeRadio() {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const protocol = new MavLinkProtocolV2(1, 1);
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;
  let peer: { address: string; port: number } | null = null;
  let muted = false; // simulated network drop: ignores everything
  const received: { msgid: number }[] = [];
  // parse what the bridge sends US (proves outbound raw MAVLink arrives)
  const pass = new PassThrough();
  pass.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser())
    .on("data", (p: { header: { msgid: number } }) => received.push({ msgid: p.header.msgid }));

  sock.on("message", (msg, rinfo) => {
    if (muted) return;
    pass.write(msg);
    peer = { address: rinfo.address, port: rinfo.port }; // reply ONLY to whoever contacted us
    if (!timer) {
      timer = setInterval(() => {
        if (peer) sock.send(protocol.serialize(heartbeat(), seq++ & 0xff), peer.port, peer.address);
      }, 200);
    }
  });
  return {
    received,
    start: () => new Promise<void>((r) => sock.bind(RADIO_PORT, "127.0.0.1", r)),
    goSilent: () => { muted = true; if (timer) clearInterval(timer); timer = null; peer = null; },
    comeBack: () => { muted = false; },
    stop: () => { if (timer) clearInterval(timer); try { sock.close(); } catch { /* noop */ } },
  };
}

let bridge: Bridge | null = null;
let radio: ReturnType<typeof makeRadio> | null = null;
afterEach(() => { bridge?.shutdown(); bridge = null; radio?.stop(); radio = null; });

function makeBridge(): Bridge {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-udpc-"));
  return new Bridge({
    dataDir: dir, ports: [], fetchFn: okFetch,
    activeClient: { enabled: true, remoteHost: "127.0.0.1", remotePort: RADIO_PORT, localPort: LOCAL_PORT },
  });
}

describe("active UDP client (UniRC7 contract)", () => {
  it("sends the FIRST datagram, establishes the return path, and locks the vehicle", async () => {
    radio = makeRadio();
    await radio.start();
    bridge = makeBridge();
    bridge.drone.start();
    await sleep(1200);

    const d = bridge.store.state.drone;
    expect(d.activeClient?.bound).toBe(true);
    expect(d.activeClient!.probesSent).toBeGreaterThan(0); // we spoke first
    // our outbound datagram was a real, parseable MAVLink GCS heartbeat
    expect(radio!.received.some((m) => m.msgid === minimal.Heartbeat.MSG_ID)).toBe(true);
    // return path worked: radio's stream locked as the vehicle
    expect(d.status).toBe("connected");
    expect(d.sourceIp).toBe("127.0.0.1");
    expect(d.sourcePort).toBe(RADIO_PORT);
    expect(d.activeClient!.lastReplyAt).not.toBeNull();
    // bidirectional: on lock we sent a stream request through the same socket
    await sleep(300);
    expect(radio!.received.some((m) => m.msgid === common.RequestDataStream.MSG_ID)).toBe(true);
  });

  it("reconnects after the radio network drops — probes never stop", async () => {
    radio = makeRadio();
    await radio.start();
    bridge = makeBridge();
    bridge.drone.start();
    await sleep(1200);
    expect(bridge.store.state.drone.status).toBe("connected");

    radio.goSilent(); // simulated network drop
    await sleep(6500); // > 5 s heartbeat timeout → honest stale reset
    expect(bridge.store.state.drone.status).toBe("searching");
    const probesAtDrop = bridge.store.state.drone.activeClient!.probesSent;

    await sleep(1500); // probes must continue while disconnected
    expect(bridge.store.state.drone.activeClient!.probesSent).toBeGreaterThan(probesAtDrop);
    // radio comes back (it answers the next probe it hears)
    radio!.comeBack();
    await sleep(1500);
    expect(bridge.store.state.drone.status).toBe("connected");
  }, 20000);

  it("binds ONLY the configured local port — never the remote target port", async () => {
    // Instrument dgram: record EVERY port the bridge's sockets bind. This is a
    // direct proof — no reliance on EADDRINUSE semantics (SO_REUSEADDR can let
    // a wrong second bind of the radio's port silently succeed on some OSes).
    const boundPorts: number[] = [];
    const realBind = dgram.Socket.prototype.bind;
    (dgram.Socket.prototype as { bind: unknown }).bind = function (this: dgram.Socket, ...bindArgs: unknown[]) {
      if (typeof bindArgs[0] === "number") boundPorts.push(bindArgs[0]);
      return (realBind as (...a: unknown[]) => dgram.Socket).apply(this, bindArgs);
    };

    try {
      radio = makeRadio(); // the radio's OWN bind of RADIO_PORT is the only one allowed
      await radio.start();
      bridge = makeBridge();
      bridge.drone.start();
      await sleep(1200);

      const ac = bridge.store.state.drone.activeClient!;
      expect(ac.bound).toBe(true);
      expect(ac.bindError).toBeNull();
      expect(bridge.store.state.drone.status).toBe("connected");
      expect(ac.lastRxSourcePort).toBe(RADIO_PORT); // replies come from the radio's port…
      expect(ac.lastRxSourceIp).toBe("127.0.0.1");
      expect(ac.packetsReceived).toBeGreaterThan(0);
      expect(ac.sysId).toBe(1); // detected MAVLink ids surfaced for diagnostics
      expect(ac.compId).toBe(1);
      // Direct bind-call proof: LOCAL_PORT was bound by the bridge, and the
      // remote target port was bound exactly ONCE — by the fake radio itself.
      expect(boundPorts).toContain(LOCAL_PORT);
      expect(boundPorts.filter((p) => p === RADIO_PORT)).toHaveLength(1);
    } finally {
      (dgram.Socket.prototype as { bind: unknown }).bind = realBind;
    }
  });

  it("passive listener bind failure names the LOCAL port in state", async () => {
    const squatter = dgram.createSocket({ type: "udp4" });
    await new Promise<void>((r) => squatter.bind(LOCAL_PORT + 1, "0.0.0.0", r));
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-udpc-"));
      bridge = new Bridge({ dataDir: dir, ports: [LOCAL_PORT + 1], fetchFn: okFetch, activeClient: null });
      bridge.drone.start();
      await sleep(600);
      const p = bridge.store.state.drone.ports.find((x) => x.port === LOCAL_PORT + 1)!;
      expect(p.bound).toBe(false);
      expect(p.bindError).toContain(`Local UDP bind failed on port ${LOCAL_PORT + 1}`);
    } finally {
      try { squatter.close(); } catch { /* noop */ }
    }
  });

  it("reports a bind failure against the LOCAL port, never the remote target port", async () => {
    // Occupy the local port first so the bridge's bind fails with EADDRINUSE.
    const squatter = dgram.createSocket({ type: "udp4" });
    await new Promise<void>((r) => squatter.bind(LOCAL_PORT, "0.0.0.0", r));
    try {
      bridge = makeBridge();
      bridge.drone.start();
      await sleep(600);
      const ac = bridge.store.state.drone.activeClient!;
      expect(ac.bound).toBe(false);
      expect(ac.bindError).toContain(`Local UDP bind failed on port ${LOCAL_PORT}`);
      expect(ac.bindError).not.toContain(String(RADIO_PORT)); // remote target port never blamed
    } finally {
      try { squatter.close(); } catch { /* noop */ }
    }
  });

  it("rejects a local port equal to the remote port", () => {
    const v = validateActiveClient({ enabled: true, remoteHost: "192.168.144.20", remotePort: 19856, localPort: 19856 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/must not equal/);
    const good = validateActiveClient({ enabled: true, remoteHost: "192.168.144.20", remotePort: 19856, localPort: 14580 });
    expect(good.ok).toBe(true);
  });
});
