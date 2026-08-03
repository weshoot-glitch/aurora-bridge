/**
 * Dev-only MAVLink drone simulator: emits HEARTBEAT + telemetry over UDP to
 * 127.0.0.1:14550 exactly like an ArduPilot vehicle streaming to a GCS.
 * Run: npm run sim
 */
import * as dgram from "dgram";
import { MavLinkProtocolV2, minimal, common } from "node-mavlink";

const TARGET_PORT = Number(process.env.SIM_PORT ?? 14550);
const protocol = new MavLinkProtocolV2(1, 1); // sysId 1, autopilot component
const socket = dgram.createSocket("udp4");
let seq = 0;

function send(msg: Parameters<MavLinkProtocolV2["serialize"]>[0]): void {
  socket.send(protocol.serialize(msg, seq++ & 0xff), TARGET_PORT, "127.0.0.1");
}

let t = 0;
console.log(`[sim] streaming MAVLink to 127.0.0.1:${TARGET_PORT}`);
setInterval(() => {
  t += 1;

  const hb = new minimal.Heartbeat();
  hb.type = 2; // quadrotor
  hb.autopilot = 3; // ArduPilot
  hb.baseMode = 81 | (t > 10 ? 128 : 0); // custom mode enabled; arm after 10s
  hb.customMode = 5; // LOITER
  hb.systemStatus = 4;
  hb.mavlinkVersion = 3;
  send(hb);

  const sys = new common.SysStatus();
  sys.voltageBattery = 24600;
  sys.batteryRemaining = Math.max(20, 95 - Math.floor(t / 10));
  send(sys);

  const gps = new common.GpsRawInt();
  gps.fixType = 3;
  gps.satellitesVisible = 14;
  gps.lat = Math.round((24.7136 + t * 1e-6) * 1e7);
  gps.lon = Math.round((46.6753 + t * 1e-6) * 1e7);
  send(gps);

  const pos = new common.GlobalPositionInt();
  pos.lat = gps.lat;
  pos.lon = gps.lon;
  pos.alt = 612000 + t * 100;
  pos.relativeAlt = Math.min(t, 80) * 1000;
  pos.vx = 120; pos.vy = 40; pos.vz = -50;
  pos.hdg = ((t * 300) % 36000);
  send(pos);

  const hud = new common.VfrHud();
  hud.airspeed = 6.2;
  hud.groundspeed = 5.8;
  hud.heading = Math.floor((t * 3) % 360);
  hud.throttle = 55;
  hud.alt = 612 + t * 0.1;
  hud.climb = 0.5;
  send(hud);
}, 1000);
