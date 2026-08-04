/**
 * Active UDP-client mode (UniRC7-style radios): the radio NEVER sends first —
 * it only replies to the peer that contacted it. These tests run a fake radio
 * that stays silent until it receives our outbound heartbeat, then streams
 * MAVLink back to the sender's address — exactly the UniRC7 contract.
 */
import { describe, it, expect, afterEach } from "vitest";
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

  it("rejects a local port equal to the remote port", () => {
    const v = validateActiveClient({ enabled: true, remoteHost: "192.168.144.20", remotePort: 19856, localPort: 19856 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/must not equal/);
    const good = validateActiveClient({ enabled: true, remoteHost: "192.168.144.20", remotePort: 19856, localPort: 14580 });
    expect(good.ok).toBe(true);
  });
});
