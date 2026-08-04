/**
 * Active UDP-client settings (UniRC7-style radios).
 *
 * Some controllers (e.g. UniRC7) do NOT broadcast MAVLink to whoever is
 * listening — they only reply to the peer that contacts them first on a
 * fixed endpoint. This config drives an ACTIVE client: the bridge binds a
 * local port, sends an initial outbound GCS heartbeat to the remote to
 * establish the return path, and keeps probing so the link re-establishes
 * itself if the radio's network drops.
 *
 * Transport-level only: MAVLink parsing/locking is untouched.
 */
import * as fs from "fs";
import * as path from "path";

/** Mirrors DEFAULT_UDP_PORTS (kept here to avoid an import cycle) — the active
 *  client must never share a port with a passive listener: two UDP sockets on
 *  one port with reuseAddr get platform-dependent delivery. */
export const PASSIVE_LISTEN_PORTS = [14540, 14550, 14551, 14552, 14555, 5760];

export interface ActiveClientConfig {
  enabled: boolean;
  remoteHost: string;
  remotePort: number;
  /** local client port the bridge binds — must differ from remotePort */
  localPort: number;
}

export const DEFAULT_ACTIVE_CLIENT: ActiveClientConfig = {
  enabled: true,
  remoteHost: "192.168.144.20", // UniRC7 air/ground unit default
  remotePort: 19856,
  localPort: 14580,
};

const FILE = "udp-settings.json";

export function validateActiveClient(raw: Partial<ActiveClientConfig>): { ok: true; config: ActiveClientConfig } | { ok: false; error: string } {
  const enabled = raw.enabled === true;
  const remoteHost = typeof raw.remoteHost === "string" ? raw.remoteHost.trim() : "";
  const remotePort = Number(raw.remotePort);
  const localPort = Number(raw.localPort);
  if (!remoteHost || !/^[a-zA-Z0-9.\-:]+$/.test(remoteHost)) return { ok: false, error: "Remote host is required (e.g. 192.168.144.20)." };
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return { ok: false, error: "Remote port must be 1–65535." };
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) return { ok: false, error: "Local port must be 1024–65535." };
  if (localPort === remotePort) return { ok: false, error: `Local port must not equal the remote port (${remotePort}) — the radio owns that port.` };
  if (PASSIVE_LISTEN_PORTS.includes(localPort)) return { ok: false, error: `Local port ${localPort} is already used by the bridge's passive listeners (${PASSIVE_LISTEN_PORTS.join(", ")}) — pick a different one (e.g. 14580).` };
  return { ok: true, config: { enabled, remoteHost, remotePort, localPort } };
}

export function loadActiveClient(dataDir: string): ActiveClientConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as Partial<ActiveClientConfig>;
    const v = validateActiveClient(raw);
    if (v.ok) return { ...v.config, enabled: raw.enabled === true };
  } catch { /* missing or corrupt → defaults */ }
  return { ...DEFAULT_ACTIVE_CLIENT };
}

export function saveActiveClient(dataDir: string, config: ActiveClientConfig): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(config, null, 2), "utf8");
}
