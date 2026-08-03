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

const APP_VERSION = "4.0.0";
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

export class AuroraLink {
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private queue: QueuedFrame[] = [];
  private sending = false;

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
      const res = await this.fetchFn(`${base}/api/controllers/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null;
        const msg = detail?.error ?? `HTTP ${res.status}`;
        this.log.log("aurora", `Pairing failed: ${msg}`, "error");
        return { ok: false, error: msg };
      }
      const data = await res.json() as {
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
      const res = await this.fetchFn(`${base}/api/controllers/signin/start`, {
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
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json() as {
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
      const res = await this.fetchFn(`${serverUrl}/api/controllers/signin/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      if (res.status === 404) { this.signIn = null; return { status: "expired" }; }
      if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
      const data = await res.json() as {
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

  /** Start the 1 Hz forwarding loop. No-op unless paired and not offline. */
  startForwarding(): void {
    if (this.timer) return;
    if (this.store.state.aurora.offlineMode) return;
    if (!this.tokens.isPaired) {
      this.store.update((s) => { s.aurora.status = "not_paired"; });
      return;
    }
    this.store.update((s) => { s.aurora.status = "connecting"; s.aurora.forwarding = true; });
    this.log.log("aurora", "Connecting to Aurora...");
    this.timer = setInterval(() => { void this.forwardTick(); }, FORWARD_INTERVAL_MS);
    this.healthTimer = setInterval(() => { void this.sendHealth(); }, HEALTH_INTERVAL_MS);
    void this.sendHealth(); // prove the link immediately, even with no drone yet
  }

  stopForwarding(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
    this.store.update((s) => { s.aurora.forwarding = false; });
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
      const res = await this.fetchFn(meta.telemetryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) {
        this.handleRevoked(res.status);
        return;
      }
      if (!res.ok) {
        this.enqueue(body);
        this.noteError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null) as { ok?: boolean; warning?: string } | null;
      if (data?.ok === false) {
        // Server accepted the request but refused routing (e.g. unexpected sysId).
        this.store.update((s) => {
          s.aurora.framesRejected += 1;
          s.aurora.status = "connected";
          s.aurora.lastError = data.warning ?? "frame not routed";
        });
        return;
      }
      this.store.update((s) => {
        s.aurora.framesForwarded += 1;
        s.aurora.lastForwardAt = Date.now();
        s.aurora.status = "connected";
        s.aurora.lastError = null;
      });
      if (this.store.state.aurora.framesForwarded === 1) {
        this.log.log("aurora", "Aurora connected. Forwarding telemetry.");
      }
      if (this.queue.length > 0) await this.flushQueue(token, meta.telemetryUrl);
    } catch (err) {
      this.enqueue(body);
      this.noteError((err as Error).message);
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
      const res = await this.fetchFn(batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ frames }),
      });
      if (res.status === 401 || res.status === 403) {
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
    const token = this.tokens.token;
    const meta = this.tokens.meta;
    if (!token || !meta) return;
    const state = this.queue.length > 0 ? "buffering" : "ok";
    try {
      const res = await this.fetchFn(meta.telemetryUrl.replace(/\/telemetry$/, "/health"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state, appVersion: APP_VERSION, queuedFrames: this.queue.length }),
      });
      if (res.status === 401 || res.status === 403) {
        this.handleRevoked(res.status);
        return;
      }
      if (res.ok) {
        // Keeps "Drone Offline / Aurora Connected" honest: the link itself is
        // proven alive by the health ping even when there is no telemetry.
        this.store.update((s) => {
          if (s.aurora.status === "connecting" || s.aurora.status === "error") {
            s.aurora.status = "connected";
            s.aurora.lastError = null;
          }
        });
      }
    } catch { /* health is best-effort; forward loop will surface errors */ }
  }

  private handleRevoked(status: number): void {
    this.stopForwarding();
    this.tokens.clear();
    this.queue = [];
    this.store.update((s) => {
      s.aurora.status = "revoked";
      s.aurora.paired = false;
      s.aurora.queuedFrames = 0;
      s.aurora.lastError = status === 403 ? "Device access revoked by Aurora" : "Token rejected — re-pair required";
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
