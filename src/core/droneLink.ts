/**
 * Drone side of the bridge: MAVLink acquisition over UDP.
 *
 * Behaves like a lightweight ground station: binds every common MAVLink UDP
 * port, waits for the first valid HEARTBEAT, locks onto that (port, source,
 * sysId) tuple, requests telemetry streams itself (no other GCS required),
 * and keeps live vehicle state. Completely independent of Aurora — this
 * module has zero knowledge of pairing, tokens, or the cloud.
 *
 * Source attribution: each (port, source ip:port) pair gets its OWN framing
 * pipeline, so a partial frame from one sender can never be attributed to
 * another (interleaved-datagram race). Telemetry is only consumed from the
 * locked (port, sourceIp, sourcePort, sysId) tuple.
 */
import * as dgram from "dgram";
import {
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  MavLinkProtocolV2,
  MavLinkPacket,
} from "node-mavlink";
import { minimal, common, ardupilotmega } from "node-mavlink";
import { PassThrough } from "stream";
import type { BridgeStore, VehicleState, HealthVerdict, MavlinkHealth } from "./state";
import { EMPTY_VEHICLE, WAITING_HEALTH, EMPTY_MONITOR } from "./state";
import type { BridgeLog } from "./log";
import type { NetworkMonitor } from "./network";
import type { ActiveClientConfig } from "./udpSettings";

export const DEFAULT_UDP_PORTS = [14540, 14550, 14551, 14552, 14555, 5760];

const HEARTBEAT_TIMEOUT_MS = 5000;
const MAX_SOURCES_PER_PORT = 16; // bound pipeline map against random-blast senders

// MAVLink sentinel values that mean "no data" — must never be shown or forwarded.
const U16_MAX = 65535;
const SATS_UNKNOWN = 255;

const MAV_TYPE_NAMES: Record<number, string> = {
  1: "Fixed wing", 2: "Quadrotor", 13: "Hexarotor", 14: "Octorotor",
  15: "Tricopter", 4: "Helicopter", 10: "Ground rover", 12: "Submarine",
  19: "VTOL Tailsitter", 20: "VTOL Tiltrotor", 21: "VTOL",
};
const AUTOPILOT_NAMES: Record<number, string> = { 3: "ArduPilot", 12: "PX4" };
const GPS_FIX_NAMES: Record<number, string> = {
  0: "No GPS", 1: "No fix", 2: "2D fix", 3: "3D fix", 4: "DGPS", 5: "RTK float", 6: "RTK fixed",
};
// ArduPilot Copter custom modes (most relevant subset).
const COPTER_MODES: Record<number, string> = {
  0: "STABILIZE", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED", 5: "LOITER", 6: "RTL",
  7: "CIRCLE", 9: "LAND", 16: "POSHOLD", 17: "BRAKE", 20: "GUIDED_NOGPS", 21: "SMART_RTL",
};
const PLANE_MODES: Record<number, string> = {
  0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 5: "FBWA", 6: "FBWB", 7: "CRUISE",
  10: "AUTO", 11: "RTL", 12: "LOITER", 15: "GUIDED", 19: "QLOITER", 20: "QLAND", 21: "QRTL",
};

function decodeFlightMode(mavType: number | null, baseMode: number, customMode: number): string {
  const custom = (baseMode & 1) !== 0; // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  if (!custom) return `mode ${baseMode}`;
  const table = mavType === 1 ? PLANE_MODES : COPTER_MODES;
  return table[customMode] ?? `custom mode ${customMode}`;
}

interface Source {
  address: string;
  port: number;
}

interface SourcePipeline {
  pass: PassThrough;
}

interface PortRuntime {
  port: number;
  socket: dgram.Socket | null;
  pipelines: Map<string, SourcePipeline>;
}

export class DroneLink {
  private runtimes: PortRuntime[] = [];
  private running = false;
  private packetTimes: number[] = [];
  private watchdog: NodeJS.Timeout | null = null;
  private seq = 0;
  private protocol = new MavLinkProtocolV2(255, 190); // GCS-style identity
  /** locked vehicle tuple — the only accepted telemetry source.
   *  compId is the AUTOPILOT component from the accepted vehicle heartbeat:
   *  a camera/gimbal/companion sharing the sysId must not drive vehicle
   *  state, health, or the phase machine. */
  private lock: { port: number; source: Source; sysId: number; compId: number } | null = null;

  /* --- packet monitor + health tracking (locked source only) --- */
  private heartbeatTimes: number[] = [];
  /** MAVLink seq counters are PER COMPONENT — one shared counter would report
   *  huge fake loss whenever a camera/companion interleaves with the autopilot. */
  private lastSeqByComp = new Map<number, number>();
  private dropped = 0;
  private telemetrySeen = false;
  /** last-seen wall clocks per health signal */
  private signalSeen: Record<keyof Omit<MavlinkHealth, "heartbeat" | "packetRate">, number | null> = {
    gps: null, battery: null, attitude: null, globalPosition: null, ekf: null, missionCurrent: null,
  };
  /* TIMESYNC latency probe */
  private timesyncSentAt: number | null = null;
  private timesyncTs1: bigint | null = null;
  private lastLatencyMs: number | null = null;
  private timesyncTick = 0;

  /* --- active UDP-client transport (UniRC7-style radios) --- */
  private activeRuntime: PortRuntime | null = null;
  /** Wire-trace counters for the active UDP client (debug logging only). */
  private txTraceCount = 0;
  private rxTraceCount = 0;
  private probeTick = 0;
  private announcedProbing = false;

  constructor(
    private store: BridgeStore,
    private log: BridgeLog,
    private ports: number[] = DEFAULT_UDP_PORTS,
    private network: NetworkMonitor | null = null,
    private activeClient: ActiveClientConfig | null = null,
  ) {}

  /** CONNECT: bind all ports and start searching. Never touches Aurora state. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.update((s) => {
      s.drone.status = "searching";
      s.drone.phase = "searching";
      s.drone.scanning = true;
    });
    this.log.log("drone", "Searching local network for the drone...");
    this.log.log("drone", `Listening on UDP ports ${this.ports.join(", ")}.`);
    for (const port of this.ports) this.bindPort(port);
    if (this.activeClient?.enabled) this.bindActiveClient(this.activeClient);
    this.watchdog = setInterval(() => this.tick(), 1000);
  }

  /**
   * Active UDP client: bind a LOCAL client port (never the radio's own port),
   * then send an outbound GCS heartbeat to remoteHost:remotePort so the radio
   * learns our return address. Incoming datagrams flow through the exact same
   * per-source framing pipelines as the passive ports — parsing, locking and
   * health are completely unchanged.
   */
  private bindActiveClient(cfg: ActiveClientConfig): void {
    // Never share a port with a passive listener — two UDP sockets on one
    // port with reuseAddr get platform-dependent delivery (silent flakiness).
    if (this.ports.includes(cfg.localPort)) {
      const msg = `Local client port ${cfg.localPort} clashes with a passive listen port — active client not started. Choose a different local port.`;
      this.store.update((s) => {
        if (s.drone.activeClient) { s.drone.activeClient.bound = false; s.drone.activeClient.bindError = msg; }
      });
      this.log.log("drone", msg, "error");
      return;
    }
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const runtime: PortRuntime = { port: cfg.localPort, socket, pipelines: new Map() };
    this.runtimes.push(runtime);
    this.activeRuntime = runtime;
    this.announcedProbing = false;

    socket.on("message", (msg, rinfo) => {
      if (!this.running || this.activeRuntime !== runtime) return; // stopped/replaced — inert
      const fromRemote = rinfo.address === cfg.remoteHost && rinfo.port === cfg.remotePort;
      // Wire-level RX trace: first byte should be 0xFD (MAVLink2). Log the first
      // datagrams verbosely, then thin out so a live stream doesn't flood the log.
      this.rxTraceCount += 1;
      if (this.rxTraceCount <= 20 || this.rxTraceCount % 200 === 0) {
        const b0 = msg.length > 0 ? `0x${msg[0].toString(16).toUpperCase().padStart(2, "0")}` : "empty";
        this.log.log("drone", `UDP RX #${this.rxTraceCount} from ${rinfo.address}:${rinfo.port} — ${msg.length} bytes, first byte ${b0}${b0 === "0xFD" ? " (MAVLink2)" : ""}.`);
      }
      this.store.update((s) => {
        if (s.drone.activeClient) {
          if (fromRemote) s.drone.activeClient.lastReplyAt = Date.now();
        }
      });
      this.network?.reportSender(rinfo.address, cfg.localPort, false);
      const source: Source = { address: rinfo.address, port: rinfo.port };
      const pipeline = this.pipelineFor(runtime, source);
      pipeline?.pass.write(msg);
    });
    socket.on("error", (err) => {
      try { socket.close(); } catch { /* noop */ }
      runtime.socket = null;
      if (!this.running || this.activeRuntime !== runtime) return; // stopped/replaced — inert
      this.activeRuntime = null;
      this.store.update((s) => {
        if (s.drone.activeClient) { s.drone.activeClient.bound = false; s.drone.activeClient.bindError = err.message; }
      });
      this.log.log("drone", `UDP client ${cfg.localPort}: ${err.message} — will retry in 5 s.`, "warn");
    });
    socket.bind(cfg.localPort, () => {
      if (!this.running || this.activeRuntime !== runtime) return; // stopped/replaced — inert
      this.store.update((s) => {
        if (s.drone.activeClient) { s.drone.activeClient.bound = true; s.drone.activeClient.bindError = null; }
      });
      let bound = `${cfg.localPort}`;
      try { const a = socket.address(); bound = `${a.address}:${a.port}`; } catch { /* noop */ }
      this.log.log("drone", `UDP client mode: socket bound on ${bound} → destination ${cfg.remoteHost}:${cfg.remotePort}. Sending outbound heartbeat to establish the return path.`);
      this.sendProbe(cfg); // FIRST datagram is ours — this is what makes UniRC7-style radios answer
    });
  }

  /** Outbound GCS heartbeat — establishes and refreshes the radio's return path. */
  private sendProbe(cfg: ActiveClientConfig): void {
    const socket = this.activeRuntime?.socket;
    if (!socket) return;
    try {
      const hb = new minimal.Heartbeat();
      hb.type = 6 as never; // MAV_TYPE_GCS — we identify honestly as a ground station
      hb.autopilot = 8 as never; // MAV_AUTOPILOT_INVALID (GCS convention)
      hb.systemStatus = 4 as never; // MAV_STATE_ACTIVE
      const buf = this.protocol.serialize(hb, this.seq++ & 0xff);
      // Wire-level TX trace: the send callback proves the datagram actually left
      // the socket. First probes logged verbosely, then thinned (1 Hz keep-alive).
      const n = (this.txTraceCount += 1);
      socket.send(buf, cfg.remotePort, cfg.remoteHost, (err) => {
        if (err) {
          this.log.log("drone", `UDP TX #${n} → ${cfg.remoteHost}:${cfg.remotePort} FAILED to leave the socket: ${err.message}`, "warn");
        } else if (n <= 5 || n % 30 === 0) {
          this.log.log("drone", `UDP TX #${n} → ${cfg.remoteHost}:${cfg.remotePort} (${buf.length}-byte GCS heartbeat) left the socket.`);
        }
      });
      this.store.update((s) => {
        if (s.drone.activeClient) {
          s.drone.activeClient.probesSent += 1;
          s.drone.activeClient.lastProbeAt = Date.now();
        }
      });
    } catch (err) {
      this.log.log("drone", `UDP client heartbeat failed: ${(err as Error).message}`, "warn");
    }
  }

  /** DISCONNECT: close everything, reset drone state honestly. */
  stop(): void {
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const r of this.runtimes) {
      try { r.socket?.close(); } catch { /* already closed */ }
      for (const p of r.pipelines.values()) p.pass.destroy();
      r.pipelines.clear();
    }
    this.runtimes = [];
    this.activeRuntime = null;
    this.announcedProbing = false;
    this.packetTimes = [];
    this.lock = null;
    this.resetMonitors();
    this.store.update((s) => {
      s.drone.status = "disconnected";
      s.drone.phase = "idle";
      s.drone.scanning = false;
      s.drone.activePort = null;
      s.drone.sourceIp = null;
      s.drone.sourcePort = null;
      s.drone.packetsPerSecond = null;
      s.drone.lastHeartbeatAt = null;
      s.drone.lastPacketAt = null;
      s.drone.streamsRequested = false;
      s.drone.vehicle = { ...EMPTY_VEHICLE };
      s.drone.health = { ...WAITING_HEALTH };
      s.drone.monitor = { ...EMPTY_MONITOR };
      for (const p of s.drone.ports) {
        p.bound = false; p.bindError = null; p.heartbeatSeen = false;
      }
      if (s.drone.activeClient) {
        s.drone.activeClient.bound = false;
        s.drone.activeClient.bindError = null;
      }
    });
    this.log.log("drone", "Drone link stopped.");
  }

  private resetMonitors(): void {
    this.heartbeatTimes = [];
    this.lastSeqByComp.clear();
    this.dropped = 0;
    this.telemetrySeen = false;
    for (const k of Object.keys(this.signalSeen) as (keyof typeof this.signalSeen)[]) {
      this.signalSeen[k] = null;
    }
    this.timesyncSentAt = null;
    this.timesyncTs1 = null;
    this.lastLatencyMs = null;
  }

  private bindPort(port: number): void {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const runtime: PortRuntime = { port, socket, pipelines: new Map() };
    this.runtimes.push(runtime);

    socket.on("message", (msg, rinfo) => {
      if (!this.running) return; // stopped — a queued datagram must not mutate state
      this.store.update((s) => {
        const p = s.drone.ports.find((x) => x.port === port);
        if (p) {
          p.packetsSeen += 1;
          p.lastSourceIp = rinfo.address;
          p.lastSourcePort = rinfo.port;
        }
      });
      this.network?.reportSender(rinfo.address, port, false);
      const source: Source = { address: rinfo.address, port: rinfo.port };
      const pipeline = this.pipelineFor(runtime, source);
      pipeline?.pass.write(msg);
    });
    socket.on("error", (err) => {
      try { socket.close(); } catch { /* noop */ }
      runtime.socket = null;
      if (!this.running) return; // stopped — inert
      this.store.update((s) => {
        const p = s.drone.ports.find((x) => x.port === port);
        if (p) { p.bound = false; p.bindError = err.message; }
      });
      this.log.log("drone", `UDP ${port}: ${err.message}`, "warn");
    });
    socket.bind(port, () => {
      if (!this.running) return; // stopped before bind completed — inert
      this.store.update((s) => {
        const p = s.drone.ports.find((x) => x.port === port);
        if (p) { p.bound = true; p.bindError = null; }
      });
    });
  }

  /** One framing pipeline per (port, source) — sound source attribution. */
  private pipelineFor(runtime: PortRuntime, source: Source): SourcePipeline | null {
    const key = `${source.address}:${source.port}`;
    let pipeline = runtime.pipelines.get(key);
    if (pipeline) return pipeline;
    if (runtime.pipelines.size >= MAX_SOURCES_PER_PORT) return null;
    const pass = new PassThrough();
    const parser = pass
      .pipe(new MavLinkPacketSplitter())
      .pipe(new MavLinkPacketParser());
    parser.on("data", (packet: MavLinkPacket) => this.onPacket(runtime.port, packet, source));
    parser.on("error", () => { /* malformed frame — splitter already skips */ });
    pipeline = { pass };
    runtime.pipelines.set(key, pipeline);
    return pipeline;
  }

  private isLockedSource(port: number, source: Source, sysId: number): boolean {
    return this.lock !== null
      && this.lock.port === port
      && this.lock.sysId === sysId
      && this.lock.source.address === source.address
      && this.lock.source.port === source.port;
  }

  private onPacket(port: number, packet: MavLinkPacket, source: Source): void {
    const now = Date.now();
    this.packetTimes.push(now);
    const { header } = packet;
    this.network?.reportSender(source.address, port, true);

    if (header.msgid === minimal.Heartbeat.MSG_ID) {
      const hb = packet.protocol.data(packet.payload, minimal.Heartbeat);
      // Ignore GCS heartbeats (MAV_TYPE_GCS = 6) — we want the vehicle.
      if (hb.type === 6) return;
      this.onHeartbeat(port, header.sysid, header.compid, hb, source, now);
    }

    // Only consume telemetry from the locked (port, source, sysId) tuple.
    if (!this.isLockedSource(port, source, header.sysid)) return;

    // Dropped-packet detection: MAVLink seq counters are independent PER
    // COMPONENT, so track each compid separately or interleaving streams
    // (autopilot + camera + companion) would count as fake loss.
    const prevSeq = this.lastSeqByComp.get(header.compid);
    if (prevSeq !== undefined) {
      const gap = (header.seq - prevSeq - 1 + 256) % 256;
      if (gap > 0 && gap < 128) this.dropped += gap; // large "gaps" = reorder noise, ignore
    }
    this.lastSeqByComp.set(header.compid, header.seq);

    // Vehicle state / health / phase are driven ONLY by the locked autopilot
    // component — a camera sharing the sysId must not fake "telemetry active".
    if (header.compid !== this.lock!.compId) return;

    if (header.msgid !== minimal.Heartbeat.MSG_ID) this.telemetrySeen = true;

    this.store.update((s) => { s.drone.lastPacketAt = now; });
    const patch: Partial<VehicleState> = {};

    if (header.msgid === common.SysStatus.MSG_ID) {
      const m = packet.protocol.data(packet.payload, common.SysStatus);
      if (m.batteryRemaining >= 0) patch.batteryPercent = m.batteryRemaining;
      if (m.voltageBattery !== U16_MAX) patch.batteryVoltage = m.voltageBattery / 1000;
      this.signalSeen.battery = now;
    } else if (header.msgid === common.GpsRawInt.MSG_ID) {
      const m = packet.protocol.data(packet.payload, common.GpsRawInt);
      if (m.satellitesVisible !== SATS_UNKNOWN) patch.satellites = m.satellitesVisible;
      patch.gpsFix = GPS_FIX_NAMES[m.fixType] ?? `fix ${m.fixType}`;
      this.signalSeen.gps = now;
    } else if (header.msgid === common.Attitude.MSG_ID) {
      this.signalSeen.attitude = now;
    } else if (header.msgid === ardupilotmega.EkfStatusReport.MSG_ID) {
      this.signalSeen.ekf = now;
    } else if (header.msgid === common.MissionCurrent.MSG_ID) {
      this.signalSeen.missionCurrent = now;
    } else if (header.msgid === common.TimeSync.MSG_ID) {
      const m = packet.protocol.data(packet.payload, common.TimeSync);
      // Reply to OUR probe: tc1 filled in, ts1 echoes what we sent.
      if (this.timesyncSentAt !== null && this.timesyncTs1 !== null && BigInt(m.ts1) === this.timesyncTs1 && BigInt(m.tc1) !== 0n) {
        this.lastLatencyMs = Math.max(0, Math.round((now - this.timesyncSentAt) / 2));
        this.timesyncSentAt = null;
        this.timesyncTs1 = null;
      }
    } else if (header.msgid === common.GlobalPositionInt.MSG_ID) {
      const m = packet.protocol.data(packet.payload, common.GlobalPositionInt);
      // 0,0 with no GPS fix is a common power-up artifact — don't plot it.
      if (m.lat !== 0 || m.lon !== 0) {
        patch.lat = m.lat / 1e7;
        patch.lon = m.lon / 1e7;
      }
      patch.altitudeM = m.alt / 1000;
      patch.relativeAltM = m.relativeAlt / 1000;
      patch.verticalSpeedMs = -m.vz / 100; // vz is cm/s downward
      if (m.hdg !== U16_MAX) patch.headingDeg = m.hdg / 100;
      this.signalSeen.globalPosition = now;
    } else if (header.msgid === common.VfrHud.MSG_ID) {
      const m = packet.protocol.data(packet.payload, common.VfrHud);
      patch.airspeedMs = m.airspeed;
      patch.groundspeedMs = m.groundspeed;
    }

    if (Object.keys(patch).length > 0) {
      this.store.update((s) => { s.drone.vehicle = { ...s.drone.vehicle, ...patch }; });
    }
  }

  private onHeartbeat(
    port: number,
    sysid: number,
    compid: number,
    hb: InstanceType<typeof minimal.Heartbeat>,
    source: Source,
    now: number,
  ): void {
    const firstLock = this.lock === null;
    if (!firstLock && !this.isLockedSource(port, source, sysid)) return; // stay locked

    if (firstLock) {
      this.lock = { port, source, sysId: sysid, compId: compid };
      this.heartbeatTimes = [];
    } else if (compid !== this.lock!.compId) {
      return; // heartbeat from a non-autopilot component sharing the sysId
    }
    this.heartbeatTimes.push(now);
    this.store.update((s) => {
      const p = s.drone.ports.find((x) => x.port === port);
      if (p) p.heartbeatSeen = true;
      s.drone.status = "connected";
      if (s.drone.phase === "searching") s.drone.phase = "heartbeat_found";
      s.drone.activePort = port;
      s.drone.sourceIp = source.address;
      s.drone.sourcePort = source.port;
      s.drone.lastHeartbeatAt = now;
      s.drone.lastPacketAt = now;
      if (firstLock) s.drone.vehicle = { ...EMPTY_VEHICLE }; // fresh vehicle — no stale carry-over
      s.drone.vehicle.sysId = sysid;
      s.drone.vehicle.compId = compid;
      s.drone.vehicle.vehicleType = MAV_TYPE_NAMES[hb.type] ?? `type ${hb.type}`;
      s.drone.vehicle.autopilot = AUTOPILOT_NAMES[hb.autopilot] ?? `autopilot ${hb.autopilot}`;
      s.drone.vehicle.armed = (hb.baseMode & 128) !== 0; // MAV_MODE_FLAG_SAFETY_ARMED
      s.drone.vehicle.flightMode = decodeFlightMode(hb.type, hb.baseMode, Number(hb.customMode));
    });

    if (firstLock) {
      this.log.log("drone", `Drone discovered at ${source.address} (UDP ${port}).`);
      this.log.log("drone", "Heartbeat received. Vehicle connected.");
      this.store.update((s) => { s.drone.phase = "vehicle_connected"; });
      if (this.network) {
        const same = this.network.sameSubnet(source.address);
        if (same === false) {
          this.log.log("network", `Note: drone ${source.address} is not on the PC's subnet — traffic is being routed; direct WiFi is more reliable.`, "warn");
        }
      }
      this.requestStreams(port, source, sysid, compid);
    }
  }

  /** TIMESYNC round-trip probe → honest latency figure (null if unanswered). */
  private sendTimesync(): void {
    if (!this.lock) return;
    const runtime = this.runtimes.find((r) => r.port === this.lock!.port);
    if (!runtime?.socket) return;
    try {
      const ts = new common.TimeSync();
      const ts1 = BigInt(Date.now()) * 1000000n;
      ts.tc1 = 0n as never;
      ts.ts1 = ts1 as never;
      const buf = this.protocol.serialize(ts, this.seq++ & 0xff);
      this.timesyncSentAt = Date.now();
      this.timesyncTs1 = ts1;
      runtime.socket.send(buf, this.lock.source.port, this.lock.source.address);
    } catch { /* latency stays null — never fabricated */ }
  }

  /** Ask the autopilot for telemetry streams — no other GCS needed. */
  private requestStreams(port: number, source: Source, sysid: number, compid: number): void {
    const runtime = this.runtimes.find((r) => r.port === port);
    if (!runtime?.socket) return;
    try {
      const req = new common.RequestDataStream();
      req.targetSystem = sysid;
      req.targetComponent = compid;
      req.reqStreamId = 0; // MAV_DATA_STREAM_ALL
      req.reqMessageRate = 4;
      req.startStop = 1;
      const buf = this.protocol.serialize(req, this.seq++ & 0xff);
      runtime.socket.send(buf, source.port, source.address);
      this.store.update((s) => { s.drone.streamsRequested = true; });
      this.log.log("drone", "Requested telemetry streams (4 Hz).");
    } catch (err) {
      this.log.log("drone", `Stream request failed: ${(err as Error).message}`, "warn");
    }
  }

  private tick(): void {
    const now = Date.now();
    this.packetTimes = this.packetTimes.filter((t) => now - t <= 3000);
    this.heartbeatTimes = this.heartbeatTimes.filter((t) => now - t <= 5000);
    const rate = this.packetTimes.length > 0 ? Math.round((this.packetTimes.length / 3) * 10) / 10 : null;
    const hbRate = this.heartbeatTimes.length > 0 ? Math.round((this.heartbeatTimes.length / 5) * 10) / 10 : null;
    const st = this.store.state.drone;
    const stale = st.lastHeartbeatAt !== null && now - st.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
    const connected = st.status === "connected" && !stale;

    if (connected && this.lock && ++this.timesyncTick % 5 === 0) this.sendTimesync();

    // Active UDP client: keep the return path alive with a 1 Hz outbound GCS
    // heartbeat. This is also the RECONNECT mechanism — if the radio's network
    // drops, the lock goes stale (handled below) and these ongoing probes make
    // the radio resume sending to us the moment it is reachable again.
    // Socket-level failure recovery: if the active socket died (interface
    // error), retry the bind every 5 s so a returning network heals itself.
    if (this.activeClient?.enabled && !this.activeRuntime && this.probeTick % 5 === 0) {
      this.probeTick += 1;
      this.bindActiveClient(this.activeClient);
    }
    if (this.activeClient?.enabled && this.activeRuntime?.socket) {
      this.probeTick += 1;
      this.sendProbe(this.activeClient);
      const ac = this.store.state.drone.activeClient;
      const answered = ac?.lastReplyAt !== null && ac?.lastReplyAt !== undefined;
      if (!answered && !this.announcedProbing && this.probeTick >= 10) {
        this.announcedProbing = true;
        this.log.log("drone", `UDP client: no reply from ${this.activeClient.remoteHost}:${this.activeClient.remotePort} after 10 s — still sending heartbeats. Check the controller is on and this PC is on its network.`, "warn");
      }
      if (answered) this.announcedProbing = false;
    }

    // Per-signal health: WAITING until first seen, PASS while fresh, FAILED once stale.
    const verdict = (lastSeen: number | null): HealthVerdict => {
      if (!connected) return "waiting";
      if (lastSeen === null) return "waiting";
      return now - lastSeen <= 10000 ? "pass" : "failed";
    };

    this.store.update((s) => {
      s.drone.packetsPerSecond = connected ? rate : null;
      s.drone.monitor.packetsPerSecond = connected ? rate : null;
      s.drone.monitor.heartbeatRateHz = connected ? hbRate : null;
      s.drone.monitor.droppedPackets = this.dropped;
      s.drone.monitor.latencyMs = connected ? this.lastLatencyMs : null;
      s.drone.monitor.lastPacketAt = s.drone.lastPacketAt;
      s.drone.health = {
        heartbeat: connected ? "pass" : s.drone.scanning ? "waiting" : "failed",
        packetRate: connected ? (rate !== null && rate >= 1 ? "pass" : "failed") : "waiting",
        gps: verdict(this.signalSeen.gps),
        battery: verdict(this.signalSeen.battery),
        attitude: verdict(this.signalSeen.attitude),
        globalPosition: verdict(this.signalSeen.globalPosition),
        ekf: verdict(this.signalSeen.ekf),
        missionCurrent: verdict(this.signalSeen.missionCurrent),
      };
      if (connected && this.telemetrySeen && s.drone.phase === "vehicle_connected") {
        s.drone.phase = "telemetry_active";
      }
      if (stale && s.drone.status === "connected") {
        // Full honest reset — no stale position/battery may survive as "live".
        s.drone.status = "searching";
        s.drone.phase = "searching";
        s.drone.activePort = null;
        s.drone.sourceIp = null;
        s.drone.sourcePort = null;
        s.drone.streamsRequested = false;
        s.drone.packetsPerSecond = null;
        s.drone.lastHeartbeatAt = null;
        s.drone.lastPacketAt = null;
        s.drone.vehicle = { ...EMPTY_VEHICLE };
        s.drone.health = { ...WAITING_HEALTH };
        s.drone.monitor = { ...EMPTY_MONITOR, droppedPackets: this.dropped };
      }
    });
    if (stale) {
      this.lock = null; // allow re-lock (possibly a different port/source)
      this.resetMonitors();
      // Auto-reconnect: sockets stay bound; the next heartbeat re-locks automatically.
      this.log.log("drone", "No MAVLink packets received — heartbeat lost. Still listening; the drone will reconnect automatically.", "warn");
    }

    const firstTelemetry = connected && this.telemetrySeen;
    if (firstTelemetry && !this.announcedTelemetry) {
      this.announcedTelemetry = true;
      this.log.log("drone", "Receiving telemetry.");
    }
    if (!connected) this.announcedTelemetry = false;
  }
  private announcedTelemetry = false;
}
