/**
 * Network discovery: shows the operator where THIS PC sits on the network,
 * and which devices are sending MAVLink-shaped UDP traffic to it.
 *
 * Honesty rules:
 *  - Values we cannot determine are null (rendered "—"), never guessed.
 *  - Discovery is PASSIVE — we report devices that actually sent us packets
 *    on the MAVLink ports. We never claim a device is a drone until a valid
 *    MAVLink frame has been parsed from it.
 */
import * as os from "os";
import { execFile } from "child_process";
import type { BridgeStore } from "./state";
import type { BridgeLog } from "./log";

const REFRESH_MS = 10000;
const DEVICE_STALE_MS = 30000;
const MAX_DEVICES = 32;

interface AdapterInfo {
  name: string;
  address: string;
  netmask: string;
}

function pickActiveAdapter(): AdapterInfo | null {
  const ifs = os.networkInterfaces();
  const candidates: AdapterInfo[] = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        candidates.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Prefer private-LAN addresses (that's where the drone lives).
  const lan = candidates.find((c) =>
    c.address.startsWith("192.168.") || c.address.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return lan ?? candidates[0];
}

function connectionTypeFor(adapterName: string): string | null {
  const n = adapterName.toLowerCase();
  if (n.includes("wi-fi") || n.includes("wifi") || n.includes("wlan") || n.includes("wireless")) return "WiFi";
  if (n.includes("eth") || n.includes("en") && !n.includes("wlan")) return "Ethernet";
  return null;
}

/** Default gateway via the OS routing table; null if it cannot be read. */
function readGateway(cb: (gw: string | null) => void): void {
  if (process.platform === "win32") {
    execFile("route", ["print", "0.0.0.0"], { timeout: 4000 }, (err, stdout) => {
      if (err) return cb(null);
      const m = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
      cb(m ? m[1] : null);
    });
  } else {
    execFile("ip", ["route", "show", "default"], { timeout: 4000 }, (err, stdout) => {
      if (err) return cb(null);
      const m = stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/);
      cb(m ? m[1] : null);
    });
  }
}

export class NetworkMonitor {
  private timer: NodeJS.Timeout | null = null;
  private announced = false;

  constructor(private store: BridgeStore, private log: BridgeLog) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by DroneLink whenever a UDP packet arrives — passive discovery. */
  reportSender(ip: string, port: number, validMavlink: boolean): void {
    const now = Date.now();
    this.store.update((s) => {
      let dev = s.network.discovered.find((d) => d.ip === ip && d.port === port);
      if (!dev) {
        if (s.network.discovered.length >= MAX_DEVICES) return;
        dev = { ip, port, protocol: "UDP", mavlink: false, lastSeenAt: now };
        s.network.discovered.push(dev);
        this.log.log("network", `Device discovered: ${ip} sending UDP on port ${port}.`);
      }
      dev.lastSeenAt = now;
      if (validMavlink && !dev.mavlink) {
        dev.mavlink = true;
        this.log.log("network", `Device ${ip}:${port} is speaking MAVLink.`);
      }
    });
  }

  /** True when `ip` is inside the PC's active subnet (null = unknown). */
  sameSubnet(ip: string): boolean | null {
    const { pcIp, subnet } = this.store.state.network;
    if (!pcIp || !subnet) return null;
    const toInt = (a: string) => a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    try {
      const mask = toInt(subnet);
      return (toInt(pcIp) & mask) === (toInt(ip) & mask);
    } catch { return null; }
  }

  private refresh(): void {
    const adapter = pickActiveAdapter();
    readGateway((gateway) => {
      const now = Date.now();
      this.store.update((s) => {
        s.network.pcIp = adapter?.address ?? null;
        s.network.subnet = adapter?.netmask ?? null;
        s.network.adapter = adapter?.name ?? null;
        s.network.connectionType = adapter ? connectionTypeFor(adapter.name) : null;
        s.network.gateway = gateway;
        s.network.discovered = s.network.discovered.filter((d) => now - d.lastSeenAt <= DEVICE_STALE_MS);
      });
      if (!this.announced) {
        this.announced = true;
        if (adapter) {
          this.log.log("network", `PC is ${adapter.address} on ${adapter.name}${gateway ? `, gateway ${gateway}` : ""}.`);
        } else {
          this.log.log("network", "PC is not connected to any network — connect to the drone's WiFi first.", "warn");
        }
      }
    });
  }
}
