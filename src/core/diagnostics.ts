/**
 * One-click connection tests. Every test returns PASS/FAIL with a concrete
 * reason — never a vague failure. Tests observe; they never change state.
 */
import * as dns from "dns/promises";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import AdmZip from "adm-zip";
import type { BridgeStore } from "./state";
import type { TokenStore } from "./tokenStore";

export interface TestResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

const PROBE_HOST = "connectivitycheck.gstatic.com";

export class Diagnostics {
  constructor(
    private store: BridgeStore,
    private tokens: TokenStore,
    private logDir: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private get serverUrl(): string | null {
    return this.tokens.meta?.serverUrl ?? this.store.state.aurora.serverUrl;
  }

  async testInternet(): Promise<TestResult> {
    try {
      const res = await this.fetchFn(`https://${PROBE_HOST}/generate_204`, { signal: AbortSignal.timeout(5000) });
      return res.status < 500
        ? { id: "internet", label: "Internet", pass: true, detail: "Outbound HTTPS reachable" }
        : { id: "internet", label: "Internet", pass: false, detail: `Probe answered HTTP ${res.status}` };
    } catch (err) {
      return { id: "internet", label: "Internet", pass: false, detail: `No outbound connectivity: ${(err as Error).message}` };
    }
  }

  async testDns(): Promise<TestResult> {
    const url = this.serverUrl;
    const host = url ? new URL(url).hostname : PROBE_HOST;
    try {
      const addrs = await dns.resolve(host);
      return { id: "dns", label: "DNS", pass: true, detail: `${host} → ${addrs[0]}` };
    } catch (err) {
      return { id: "dns", label: "DNS", pass: false, detail: `Cannot resolve ${host}: ${(err as Error).message}` };
    }
  }

  async testAuroraHttps(): Promise<TestResult> {
    const url = this.serverUrl;
    if (!url) return { id: "aurora_https", label: "Aurora HTTPS", pass: false, detail: "No Aurora server configured — pair or enter a server URL first" };
    try {
      const res = await this.fetchFn(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
      // Any HTTP answer proves TLS + routing work; auth is a separate test.
      return { id: "aurora_https", label: "Aurora HTTPS", pass: true, detail: `${new URL(url).hostname} answered HTTP ${res.status}` };
    } catch (err) {
      return { id: "aurora_https", label: "Aurora HTTPS", pass: false, detail: `${url} unreachable: ${(err as Error).message}` };
    }
  }

  async testAuthentication(): Promise<TestResult> {
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) return { id: "auth", label: "Authentication", pass: false, detail: "Not paired — use LOGIN with a pairing code from Aurora" };
    try {
      // Health endpoint validates the bearer token without sending telemetry.
      const res = await this.fetchFn(meta.telemetryUrl.replace(/\/telemetry$/, "/health"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: "ok", queuedFrames: 0 }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return { id: "auth", label: "Authentication", pass: true, detail: "Device token accepted by Aurora" };
      if (res.status === 401) return { id: "auth", label: "Authentication", pass: false, detail: "Token rejected (401) — re-pair this device" };
      if (res.status === 403) return { id: "auth", label: "Authentication", pass: false, detail: "Device revoked or disabled in Aurora (403)" };
      return { id: "auth", label: "Authentication", pass: false, detail: `Unexpected HTTP ${res.status}` };
    } catch (err) {
      return { id: "auth", label: "Authentication", pass: false, detail: `Could not reach Aurora: ${(err as Error).message}` };
    }
  }

  testNetwork(): TestResult {
    const n = this.store.state.network;
    if (!n.pcIp) return { id: "network", label: "Network", pass: false, detail: "PC is not connected to any network — join the drone's WiFi first" };
    const parts = [`PC ${n.pcIp}`];
    if (n.adapter) parts.push(`adapter ${n.adapter}${n.connectionType ? ` (${n.connectionType})` : ""}`);
    if (n.gateway) parts.push(`gateway ${n.gateway}`);
    return { id: "network", label: "Network", pass: true, detail: parts.join(", ") };
  }

  testMavlink(): TestResult {
    const d = this.store.state.drone;
    const n = this.store.state.network;
    const speaking = n.discovered.filter((x) => x.mavlink);
    if (speaking.length > 0) {
      return { id: "mavlink", label: "MAVLink", pass: true, detail: `MAVLink traffic from ${speaking.map((x) => `${x.ip} (UDP ${x.port})`).join(", ")}` };
    }
    const bound = d.ports.filter((p) => p.bound).length;
    if (!d.scanning) return { id: "mavlink", label: "MAVLink", pass: false, detail: "Drone link is stopped — press CONNECT" };
    if (bound === 0) return { id: "mavlink", label: "MAVLink", pass: false, detail: "No UDP ports could be bound — close Mission Planner / UniGCS and try again" };
    const raw = n.discovered.length;
    if (raw > 0) return { id: "mavlink", label: "MAVLink", pass: false, detail: `${raw} device(s) sending UDP but none is valid MAVLink yet` };
    return { id: "mavlink", label: "MAVLink", pass: false, detail: "No MAVLink packets received — PC may not be on the same network as the drone" };
  }

  testHeartbeat(): TestResult {
    const d = this.store.state.drone;
    if (d.status === "connected" && d.lastHeartbeatAt && Date.now() - d.lastHeartbeatAt < 5000) {
      const rate = d.monitor.heartbeatRateHz;
      return { id: "heartbeat", label: "Heartbeat", pass: true, detail: `Stable heartbeat from sysId ${d.vehicle.sysId}${rate !== null ? ` at ${rate} Hz` : ""}` };
    }
    const anyMavlink = this.store.state.network.discovered.some((x) => x.mavlink);
    if (anyMavlink) return { id: "heartbeat", label: "Heartbeat", pass: false, detail: "Drone found but no vehicle heartbeat received — the flight controller may still be booting" };
    return { id: "heartbeat", label: "Heartbeat", pass: false, detail: "No heartbeat — no MAVLink device found yet" };
  }

  /** Honest by design: this bridge sends telemetry over HTTPS only. */
  testWebSocket(): TestResult {
    return {
      id: "websocket", label: "Aurora WebSocket", pass: true,
      detail: "Not used — telemetry travels over secure HTTPS; no WebSocket is required by this bridge",
    };
  }

  async testTelemetryUpload(): Promise<TestResult> {
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (this.store.state.aurora.offlineMode) return { id: "upload", label: "Telemetry Upload", pass: false, detail: "Offline Mode is ON — uploads deliberately disabled" };
    if (!token || !meta) return { id: "upload", label: "Telemetry Upload", pass: false, detail: "Not paired — use LOGIN with a pairing code from Aurora" };
    const a = this.store.state.aurora;
    if (a.lastForwardAt && Date.now() - a.lastForwardAt < 15000) {
      return { id: "upload", label: "Telemetry Upload", pass: true, detail: `Live — ${a.framesForwarded} frames delivered (last ${Math.round((Date.now() - a.lastForwardAt) / 1000)}s ago)` };
    }
    // No recent live frame — prove the upload path with an authenticated health post.
    try {
      const res = await this.fetchFn(meta.telemetryUrl.replace(/\/telemetry$/, "/health"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: "ok", queuedFrames: a.queuedFrames }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        return this.store.state.drone.status === "connected"
          ? { id: "upload", label: "Telemetry Upload", pass: true, detail: "Upload path verified — waiting on a position fix before frames flow" }
          : { id: "upload", label: "Telemetry Upload", pass: true, detail: "Upload path verified — no drone connected, nothing to send yet" };
      }
      if (res.status === 401 || res.status === 403) return { id: "upload", label: "Telemetry Upload", pass: false, detail: "Aurora rejected this device's token — re-pair required" };
      return { id: "upload", label: "Telemetry Upload", pass: false, detail: `Aurora answered HTTP ${res.status}` };
    } catch (err) {
      return { id: "upload", label: "Telemetry Upload", pass: false, detail: `Cannot reach Aurora: ${(err as Error).message}` };
    }
  }

  testDrone(): TestResult {
    const d = this.store.state.drone;
    if (d.status === "connected" && d.lastHeartbeatAt) {
      return {
        id: "drone", label: "Drone (MAVLink)", pass: true,
        detail: `Heartbeat from sysId ${d.vehicle.sysId} on UDP ${d.activePort} (${d.sourceIp}:${d.sourcePort})`,
      };
    }
    const bound = d.ports.filter((p) => p.bound).length;
    const packets = d.ports.reduce((a, p) => a + p.packetsSeen, 0);
    if (!d.scanning) return { id: "drone", label: "Drone (MAVLink)", pass: false, detail: "Drone link is stopped — press CONNECT" };
    if (bound === 0) return { id: "drone", label: "Drone (MAVLink)", pass: false, detail: "No UDP ports could be bound — another GCS (Mission Planner/UniGCS) may be holding them; close it" };
    if (packets === 0) return { id: "drone", label: "Drone (MAVLink)", pass: false, detail: `Listening on ${bound} ports but no packets received — check the drone WiFi network and that the N7 streams to this PC` };
    return { id: "drone", label: "Drone (MAVLink)", pass: false, detail: `${packets} packets seen but no valid vehicle heartbeat yet` };
  }

  testForwarding(): TestResult {
    const a = this.store.state.aurora;
    if (a.offlineMode) return { id: "forwarding", label: "Forwarding", pass: false, detail: "Offline Mode is ON — Aurora forwarding deliberately disabled" };
    if (!a.paired) return { id: "forwarding", label: "Forwarding", pass: false, detail: "Not paired with Aurora" };
    if (!a.forwarding) return { id: "forwarding", label: "Forwarding", pass: false, detail: "Forwarding loop not running" };
    if (a.lastForwardAt && Date.now() - a.lastForwardAt < 10000) {
      return { id: "forwarding", label: "Forwarding", pass: true, detail: `${a.framesForwarded} frames delivered, last ${Math.round((Date.now() - a.lastForwardAt) / 1000)}s ago` };
    }
    if (this.store.state.drone.status !== "connected") {
      return { id: "forwarding", label: "Forwarding", pass: false, detail: "No live drone telemetry to forward (drone not connected)" };
    }
    return { id: "forwarding", label: "Forwarding", pass: false, detail: a.lastError ? `Last error: ${a.lastError}` : "No frame delivered in the last 10s" };
  }

  async runAll(): Promise<TestResult[]> {
    const [internet, dnsRes, https, auth, upload] = await Promise.all([
      this.testInternet(), this.testDns(), this.testAuroraHttps(), this.testAuthentication(),
      this.testTelemetryUpload(),
    ]);
    return [
      this.testNetwork(), internet, dnsRes,
      this.testMavlink(), this.testHeartbeat(), this.testDrone(),
      https, this.testWebSocket(), auth, upload, this.testForwarding(),
    ];
  }

  /** Export Diagnostics — ZIP with config (token REDACTED), logs, system info. */
  exportZip(outPath: string): string {
    const zip = new AdmZip();
    const meta = this.tokens.meta;
    const s = this.store.state;
    zip.addFile("config.json", Buffer.from(JSON.stringify({
      serverUrl: meta?.serverUrl ?? null,
      aircraftId: meta?.aircraftId ?? null,
      expectedSysId: meta?.expectedSysId ?? null,
      deviceId: meta?.deviceId ?? null,
      paired: this.tokens.isPaired,
      token: this.tokens.isPaired ? "<redacted>" : null,
      offlineMode: s.aurora.offlineMode,
      udpPorts: s.drone.ports.map((p) => p.port),
    }, null, 2)));
    for (const name of ["bridge.log", "connection.log", "network.log", "mavlink.log"]) {
      const p = path.join(this.logDir, name);
      if (fs.existsSync(p)) zip.addLocalFile(p);
    }
    zip.addFile("system_information.txt", Buffer.from([
      `Aurora Bridge Desktop 4.0.0`,
      `Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
      `Hostname: ${os.hostname()}`,
      `Node: ${process.version}`,
      `Exported: ${new Date().toISOString()}`,
      `Drone status: ${s.drone.status}`,
      `Aurora status: ${s.aurora.status}`,
      `Interfaces: ${Object.entries(os.networkInterfaces()).map(([n, addrs]) =>
        `${n}=${(addrs ?? []).filter((a) => a.family === "IPv4").map((a) => a.address).join(",")}`).join(" ")}`,
    ].join("\n")));
    zip.writeZip(outPath);
    return outPath;
  }
}
