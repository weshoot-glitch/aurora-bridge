/**
 * Aurora Bridge V4 — central state model.
 *
 * The load-bearing V4 rule: DRONE state and AURORA state are completely
 * independent. Nothing in this file (or anywhere else) lets one side's
 * failure change the other side's status.
 *
 * Honesty contract (same as the rest of Aurora): unknown values are `null`,
 * rendered as "—" — never fabricated, never defaulted to 0.
 */

export type DroneStatus = "searching" | "connected" | "disconnected";
export type AuroraStatus =
  | "not_paired"
  | "offline_mode"
  | "connecting"
  | "connected"
  | "error"
  | "revoked";

export interface PortState {
  port: number;
  bound: boolean;
  bindError: string | null;
  packetsSeen: number;
  heartbeatSeen: boolean;
  lastSourceIp: string | null;
  lastSourcePort: number | null;
}

export interface VehicleState {
  sysId: number | null;
  compId: number | null;
  vehicleType: string | null; // decoded MAV_TYPE name
  autopilot: string | null;
  flightMode: string | null; // decoded ArduPilot mode, or "custom mode N"
  armed: boolean | null;
  batteryPercent: number | null;
  batteryVoltage: number | null;
  satellites: number | null;
  gpsFix: string | null;
  lat: number | null;
  lon: number | null; // internal name; mapped to `lng` ON THE WIRE only
  altitudeM: number | null;
  relativeAltM: number | null;
  airspeedMs: number | null;
  groundspeedMs: number | null;
  headingDeg: number | null;
  verticalSpeedMs: number | null;
}

/** Visible connection state machine — never a generic "Retrying". */
export type DronePhase =
  | "idle"
  | "searching"
  | "heartbeat_found"
  | "vehicle_connected"
  | "telemetry_active";

/** Per-signal MAVLink health: WAITING until first seen, PASS while fresh, FAILED when stale. */
export type HealthVerdict = "pass" | "waiting" | "failed";
export interface MavlinkHealth {
  heartbeat: HealthVerdict;
  packetRate: HealthVerdict;
  gps: HealthVerdict;
  battery: HealthVerdict;
  attitude: HealthVerdict;
  globalPosition: HealthVerdict;
  ekf: HealthVerdict;
  missionCurrent: HealthVerdict;
}

export interface PacketMonitor {
  packetsPerSecond: number | null;
  droppedPackets: number; // MAVLink sequence gaps on the locked source
  heartbeatRateHz: number | null;
  /** round-trip/2 from TIMESYNC; null when the autopilot doesn't answer */
  latencyMs: number | null;
  lastPacketAt: number | null;
}

/** A device seen sending MAVLink-shaped UDP traffic — passive discovery. */
export interface DiscoveredDevice {
  ip: string;
  port: number; // UDP port it was seen on
  protocol: "UDP";
  mavlink: boolean; // true once a valid MAVLink frame parsed from it
  lastSeenAt: number;
}

export interface NetworkState {
  pcIp: string | null;
  subnet: string | null;
  gateway: string | null;
  adapter: string | null;
  connectionType: string | null; // "WiFi" | "Ethernet" | adapter-derived, null if unknown
  discovered: DiscoveredDevice[];
}

/** Live view of the active UDP-client transport (UniRC7-style radios). */
export interface ActiveClientState {
  enabled: boolean;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  bound: boolean;
  bindError: string | null;
  probesSent: number;
  lastProbeAt: number | null;
  /** last packet received FROM the configured remote — proof of return path */
  lastReplyAt: number | null;
  /** total datagrams received on the client socket (any source) */
  packetsReceived: number;
  /** last datagram received on the client socket (any source) */
  lastRxAt: number | null;
  lastRxSourceIp: string | null;
  lastRxSourcePort: number | null;
  /** MAVLink system/component id detected on the client socket */
  sysId: number | null;
  compId: number | null;
}

export interface DroneLinkState {
  status: DroneStatus;
  phase: DronePhase;
  /** true while sockets are bound and scanning */
  scanning: boolean;
  ports: PortState[];
  /** null when active-client mode is disabled */
  activeClient: ActiveClientState | null;
  /** port + source the bridge locked onto after first valid heartbeat */
  activePort: number | null;
  sourceIp: number extends never ? never : string | null;
  sourcePort: number | null;
  packetsPerSecond: number | null;
  lastHeartbeatAt: number | null;
  lastPacketAt: number | null;
  streamsRequested: boolean;
  vehicle: VehicleState;
  health: MavlinkHealth;
  monitor: PacketMonitor;
}

import type { AuroraStage } from "./handshake";
import { freshStages } from "./handshake";

export interface AuroraLinkState {
  status: AuroraStatus;
  /** step-by-step handshake — the UI renders THIS, never a bare "CONNECTING" */
  stages: AuroraStage[];
  /** set the instant any stage fails; cleared only when a retry succeeds */
  failureReason: string | null;
  /** operator-controlled: when true the bridge does not talk to Aurora at all */
  offlineMode: boolean;
  paired: boolean;
  serverUrl: string | null;
  aircraftId: number | null;
  expectedSysId: number | null;
  /** organisation is not in the pairing response; shown only if server provides it later */
  organisation: string | null;
  forwarding: boolean;
  framesForwarded: number;
  framesRejected: number;
  forwardErrors: number;
  queuedFrames: number;
  lastForwardAt: number | null;
  lastError: string | null;
  /** true when the token had to be stored without OS-level encryption */
  tokenStoredPlaintext: boolean;
}

/**
 * Camera / Video Relay state — an INDEPENDENT capability. A camera failure
 * never alters drone or aurora state (pinned by test). States mirror the
 * binding contract; media facts are null when unknown (never 0), and `live`
 * requires REAL evidence (frames advancing / segments PUT with 2xx).
 */
export type CameraState =
  | "configured"
  | "reachable"
  | "video_detected"
  | "relay_connected"
  | "live"
  | "camera_unreachable"
  | "rtsp_failed"
  | "no_frames"
  | "relay_disconnected"
  | "cloud_unavailable"
  | "stopped";

export interface CameraMedia {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  bitrateKbps: number | null;
}

export interface CameraLinkState {
  state: CameraState;
  /** specific reason on a failure/honest state — never generic, may be null */
  detail: string | null;
  assigned: boolean;
  orgDeviceId: number | null;
  displayName: string | null;
  manufacturer: string | null;
  model: string | null;
  sourceProtocol: string | null;
  /** TCP reachability of the RTSP host — null until first probed */
  rtspReachable: boolean | null;
  /** relay has had at least one segment accepted by the cloud (2xx) */
  relayConnected: boolean;
  framesReceived: number;
  lastFrameAt: number | null;
  media: CameraMedia;
  /** true when an ffmpeg binary was resolved (bundled / PATH / setting) */
  ffmpegAvailable: boolean;
  ffmpegSource: "bundled" | "path" | "setting" | "missing";
}

export interface LogLine {
  ts: number;
  level: "info" | "warn" | "error";
  category: "drone" | "aurora" | "system" | "network" | "camera";
  message: string;
}

export const EMPTY_VEHICLE: VehicleState = {
  sysId: null, compId: null, vehicleType: null, autopilot: null,
  flightMode: null, armed: null, batteryPercent: null, batteryVoltage: null,
  satellites: null, gpsFix: null, lat: null, lon: null, altitudeM: null,
  relativeAltM: null, airspeedMs: null, groundspeedMs: null, headingDeg: null,
  verticalSpeedMs: null,
};

export const WAITING_HEALTH: MavlinkHealth = {
  heartbeat: "waiting", packetRate: "waiting", gps: "waiting", battery: "waiting",
  attitude: "waiting", globalPosition: "waiting", ekf: "waiting", missionCurrent: "waiting",
};

export const EMPTY_MONITOR: PacketMonitor = {
  packetsPerSecond: null, droppedPackets: 0, heartbeatRateHz: null,
  latencyMs: null, lastPacketAt: null,
};

export const EMPTY_CAMERA_MEDIA: CameraMedia = {
  width: null, height: null, fps: null, codec: null, bitrateKbps: null,
};

export interface BridgeState {
  drone: DroneLinkState;
  aurora: AuroraLinkState;
  network: NetworkState;
  camera: CameraLinkState;
}

export type StateListener = (state: BridgeState) => void;

/** Tiny observable store shared by drone link, aurora link, and the UI server. */
export class BridgeStore {
  private listeners = new Set<StateListener>();
  state: BridgeState;

  constructor(ports: number[], activeClient?: { enabled: boolean; remoteHost: string; remotePort: number; localPort: number }) {
    this.state = {
      drone: {
        status: "disconnected",
        phase: "idle",
        scanning: false,
        ports: ports.map((port) => ({
          port, bound: false, bindError: null, packetsSeen: 0,
          heartbeatSeen: false, lastSourceIp: null, lastSourcePort: null,
        })),
        activeClient: activeClient?.enabled
          ? {
              ...activeClient, bound: false, bindError: null,
              probesSent: 0, lastProbeAt: null, lastReplyAt: null,
              packetsReceived: 0, lastRxAt: null, lastRxSourceIp: null, lastRxSourcePort: null,
              sysId: null, compId: null,
            }
          : null,
        activePort: null,
        sourceIp: null,
        sourcePort: null,
        packetsPerSecond: null,
        lastHeartbeatAt: null,
        lastPacketAt: null,
        streamsRequested: false,
        vehicle: { ...EMPTY_VEHICLE },
        health: { ...WAITING_HEALTH },
        monitor: { ...EMPTY_MONITOR },
      },
      network: {
        pcIp: null, subnet: null, gateway: null, adapter: null,
        connectionType: null, discovered: [],
      },
      aurora: {
        status: "not_paired",
        stages: freshStages(),
        failureReason: null,
        offlineMode: false,
        paired: false,
        serverUrl: null,
        aircraftId: null,
        expectedSysId: null,
        organisation: null,
        forwarding: false,
        framesForwarded: 0,
        framesRejected: 0,
        forwardErrors: 0,
        queuedFrames: 0,
        lastForwardAt: null,
        lastError: null,
        tokenStoredPlaintext: false,
      },
      camera: {
        state: "stopped",
        detail: null,
        assigned: false,
        orgDeviceId: null,
        displayName: null,
        manufacturer: null,
        model: null,
        sourceProtocol: null,
        rtspReachable: null,
        relayConnected: false,
        framesReceived: 0,
        lastFrameAt: null,
        media: { ...EMPTY_CAMERA_MEDIA },
        ffmpegAvailable: false,
        ffmpegSource: "missing",
      },
    };
  }

  update(fn: (s: BridgeState) => void): void {
    fn(this.state);
    for (const l of this.listeners) l(this.state);
  }

  subscribe(l: StateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
