/**
 * Aurora handshake stage machine — no silent failures, no generic CONNECTING.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { BridgeStore } from "../src/core/state";
import { BridgeLog } from "../src/core/log";
import { TokenStore } from "../src/core/tokenStore";
import { AuroraLink } from "../src/core/auroraLink";
import { classifyHttpFailure, classifyException } from "../src/core/handshake";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hs-"));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeLink(fetchFn: typeof fetch) {
  const dir = tmpDir();
  const store = new BridgeStore([14550]);
  const log = new BridgeLog(path.join(dir, "logs"));
  const tokens = new TokenStore(dir, null);
  tokens.save({
    token: "test-token", telemetryUrl: "https://aurora.example/api/controllers/telemetry",
    serverUrl: "https://aurora.example", aircraftId: 7, expectedSysId: 1, deviceId: 3,
  });
  const link = new AuroraLink(store, log, tokens, fetchFn);
  return { link, store, tokens, dir };
}

const stage = (store: BridgeStore, id: string) => store.state.aurora.stages.find((s) => s.id === id)!;
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("classifiers", () => {
  it("maps HTTP statuses to specific reasons", () => {
    expect(classifyHttpFailure(401)).toMatch(/401 Unauthorized/);
    expect(classifyHttpFailure(403)).toMatch(/403 Forbidden/);
    expect(classifyHttpFailure(404)).toMatch(/404 Endpoint not found/);
    expect(classifyHttpFailure(500)).toMatch(/500 Server error/);
    expect(classifyHttpFailure(502)).toMatch(/502 Server error/);
  });
  it("maps exceptions to specific reasons", () => {
    expect(classifyException(Object.assign(new Error("x"), { name: "AbortError" }))).toMatch(/timeout/i);
    expect(classifyException(Object.assign(new Error("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }))).toMatch(/TLS certificate/);
    expect(classifyException(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toMatch(/refused/);
    expect(classifyException(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toMatch(/DNS/);
  });
});

describe("handshake stage machine", () => {
  it("completes every stage when the cloud answers, and stream waits for the drone", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    expect(stage(store, "signed_in").status).toBe("done");
    expect(stage(store, "device_registered").status).toBe("done");
    expect(stage(store, "aircraft_verified").status).toBe("done");
    expect(stage(store, "reach").status).toBe("done");
    expect(stage(store, "session").status).toBe("done");
    expect(stage(store, "stream").status).toBe("active"); // no drone yet — honest wait, not a fake success
    expect(store.state.aurora.status).toBe("connected");
    expect(store.state.aurora.failureReason).toBeNull();
    link.stopForwarding();
  });

  it("fails the reach stage with 401 and revokes — never a silent CONNECTING", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: "bad token" })) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    expect(stage(store, "reach").status).toBe("failed");
    expect(store.state.aurora.failureReason).toMatch(/401 Unauthorized/);
    expect(store.state.aurora.status).toBe("revoked");
    link.stopForwarding();
  });

  it("fails with 404 endpoint not found", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(404, { error: "no such route" })) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    expect(stage(store, "reach").status).toBe("failed");
    expect(store.state.aurora.failureReason).toMatch(/404 Endpoint not found/);
    expect(store.state.aurora.status).toBe("error");
    link.stopForwarding();
  });

  it("classifies network exceptions (connection refused)", async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    expect(stage(store, "reach").status).toBe("failed");
    expect(store.state.aurora.failureReason).toMatch(/refused/);
    link.stopForwarding();
  });

  it("fails signed_in immediately when no token is stored", async () => {
    const dir = tmpDir();
    const store = new BridgeStore([14550]);
    const log = new BridgeLog(path.join(dir, "logs"));
    const tokens = new TokenStore(dir, null);
    const link = new AuroraLink(store, log, tokens, fetch);
    link.startForwarding();
    await flush();
    expect(store.state.aurora.status).toBe("not_paired");
    link.stopForwarding();
  });

  it("marks stream failed when the server rejects routing, but keeps the link up", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      calls++;
      if (String(url).endsWith("/health")) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { ok: false, warning: "unexpected sysId" });
    }) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    // simulate a live drone frame
    store.update((s) => {
      s.drone.status = "connected";
      s.drone.vehicle.sysId = 9;
      s.drone.vehicle.lat = 1; s.drone.vehicle.lon = 2;
    });
    await (link as unknown as { forwardTick(): Promise<void> }).forwardTick();
    expect(stage(store, "stream").status).toBe("failed");
    expect(stage(store, "stream").detail).toMatch(/Telemetry subscription rejected/);
    expect(store.state.aurora.status).toBe("connected"); // link alive, routing refused — honest split
    expect(store.state.aurora.framesRejected).toBe(1);
    link.stopForwarding();
    expect(calls).toBeGreaterThan(0);
  });

  it("completes stream on the first accepted frame", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const { link, store } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    store.update((s) => {
      s.drone.status = "connected";
      s.drone.vehicle.sysId = 9;
    });
    await (link as unknown as { forwardTick(): Promise<void> }).forwardTick();
    expect(stage(store, "stream").status).toBe("done");
    expect(store.state.aurora.framesForwarded).toBe(1);
    link.stopForwarding();
  });

  it("writes the wire trace (request + status code) into bridge.log", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const { link, dir } = makeLink(fetchFn);
    link.startForwarding();
    await flush();
    link.stopForwarding();
    await flush();
    const logText = fs.readFileSync(path.join(dir, "logs", "bridge.log"), "utf8");
    expect(logText).toMatch(/→ POST https:\/\/aurora\.example\/api\/controllers\/health/);
    expect(logText).toMatch(/← HTTP 200/);
  });
});

import { redactForLog } from "../src/core/auroraLink";

describe("log redaction", () => {
  it("masks tokens and codes in URLs and JSON bodies", () => {
    expect(redactForLog("https://x/api?token=abc123&x=1")).not.toContain("abc123");
    expect(redactForLog('{"token":"secret-t","status":"approved"}')).not.toContain("secret-t");
    expect(redactForLog('{"deviceCode":"dc-1","userCode":"uc-1"}')).not.toMatch(/dc-1|uc-1/);
  });
});
