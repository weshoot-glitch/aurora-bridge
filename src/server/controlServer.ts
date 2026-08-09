/**
 * Local control server: serves the UI and a loopback-only JSON/WS API.
 * The Electron window (or a browser in dev) is just a client of this server —
 * which keeps the core testable and reusable for the future Android build.
 *
 * Security model: binds 127.0.0.1 ONLY, and every API/WS access requires a
 * per-launch random capability token. Loopback alone is NOT enough — any
 * website open in a browser could otherwise POST to this server (CSRF/DNS
 * rebinding). The token is injected into the UI via the launch URL hash and
 * is never derivable by another origin.
 */
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Bridge } from "../core/bridge";
import { checkForUpdate, type UpdateInfo } from "../core/updateCheck";
import { validateActiveClient, DEFAULT_ACTIVE_CLIENT } from "../core/udpSettings";

const MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

export interface ControlServer {
  server: http.Server;
  port: number;
  /** per-launch capability token — append as `#auth=<token>` to the UI URL */
  authToken: string;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function startControlServer(bridge: Bridge, uiDir: string, port = 0): Promise<ControlServer> {
  const authToken = crypto.randomBytes(24).toString("hex");

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    // Host pinning defeats DNS rebinding; token defeats CSRF.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return false;
    const header = req.headers["x-bridge-auth"];
    const supplied = typeof header === "string" ? header : url.searchParams.get("auth") ?? "";
    return supplied.length > 0 && timingSafeEqualStr(supplied, authToken);
  };

  const server = http.createServer((req, res) => {
    void handle(bridge, uiDir, req, res, authorized).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "state", state: bridge.store.state }));
    for (const line of bridge.log.lines.slice(-200)) {
      ws.send(JSON.stringify({ type: "log", line }));
    }
    const offState = bridge.store.subscribe((state) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "state", state }));
    });
    const offLog = bridge.log.subscribe((line) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "log", line }));
    });
    ws.on("close", () => { offState(); offLog(); });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: boundPort, authToken });
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

// Once-per-launch update-check cache (undefined = not yet checked).
let updateCheckResult: UpdateInfo | null | undefined;

async function handle(
  bridge: Bridge,
  uiDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorized: (req: http.IncomingMessage, url: URL) => boolean,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname.startsWith("/api/")) {
    if (!authorized(req, url)) return json(401, { error: "unauthorized" });
    const action = url.pathname.slice(5);
    if (req.method === "GET" && action === "state") return json(200, bridge.store.state);
    if (req.method === "GET" && action === "update-check") {
      // Cached once per launch — the check is a startup concern, not a poll.
      if (updateCheckResult === undefined) {
        updateCheckResult = await checkForUpdate(bridge.appVersion);
      }
      return json(200, { update: updateCheckResult });
    }
    if (req.method === "POST" && action === "drone/connect") { bridge.drone.start(); return json(200, { ok: true }); }
    if (req.method === "POST" && action === "drone/disconnect") { bridge.drone.stop(); return json(200, { ok: true }); }
    if (req.method === "GET" && action === "drone/udp-settings") {
      return json(200, { config: bridge.activeClientConfig, defaults: DEFAULT_ACTIVE_CLIENT });
    }
    if (req.method === "POST" && action === "drone/udp-settings") {
      const body = await readBody(req);
      if (body.enabled !== true) {
        bridge.applyActiveClient({ ...bridge.activeClientConfig, enabled: false });
        return json(200, { ok: true, config: bridge.activeClientConfig });
      }
      const v = validateActiveClient(body as never);
      if (!v.ok) return json(400, { error: v.error });
      bridge.applyActiveClient({ ...v.config, enabled: true });
      return json(200, { ok: true, config: v.config });
    }
    if (req.method === "POST" && action === "aurora/pair") {
      const body = await readBody(req);
      if (typeof body.serverUrl !== "string" || !body.serverUrl) return json(400, { error: "serverUrl required" });
      const result = await bridge.aurora.pair({
        serverUrl: body.serverUrl,
        pairingString: typeof body.pairingString === "string" ? body.pairingString : undefined,
      });
      if (result.ok && !bridge.store.state.aurora.offlineMode) {
        bridge.aurora.startForwarding();
        bridge.camera.start();
      }
      return json(result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "aurora/unpair") { bridge.camera.stop(); bridge.aurora.unpair(); return json(200, { ok: true }); }
    if (req.method === "POST" && action === "aurora/signin/start") {
      const body = await readBody(req);
      if (typeof body.serverUrl !== "string" || !body.serverUrl) return json(400, { error: "serverUrl required" });
      const result = await bridge.aurora.signInStart(body.serverUrl);
      return json(result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "aurora/signin/poll") {
      return json(200, await bridge.aurora.signInPoll());
    }
    if (req.method === "POST" && action === "aurora/offline") {
      const body = await readBody(req);
      const offline = body.offline === true;
      bridge.aurora.setOfflineMode(offline);
      // Camera relay follows Aurora offline mode — no cloud, no relay.
      if (offline) bridge.camera.stop();
      else if (bridge.tokens.isPaired) bridge.camera.start();
      return json(200, { ok: true });
    }
    if (req.method === "POST" && action === "aurora/start") { bridge.aurora.startForwarding(); bridge.camera.start(); return json(200, { ok: true }); }
    if (req.method === "POST" && action === "tests/run") return json(200, { results: await bridge.diagnostics.runAll() });
    if (req.method === "POST" && action === "diagnostics/export") {
      const out = path.join(bridge.dataDir, `aurora-bridge-diagnostics-${Date.now()}.zip`);
      bridge.diagnostics.exportZip(out);
      return json(200, { ok: true, path: out });
    }
    return json(404, { error: "unknown action" });
  }

  // Static UI (no secrets in these files; API is what's protected)
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(uiDir, rel));
  if (!file.startsWith(path.normalize(uiDir)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}
