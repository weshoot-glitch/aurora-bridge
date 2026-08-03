/**
 * Aurora connection handshake — the visible stage machine behind the old
 * "CONNECTING…" label.
 *
 * HONESTY: the Bridge talks to Aurora over HTTPS (sign-in, health check,
 * telemetry POSTs). There is deliberately NO WebSocket pathway, so the stages
 * describe the real HTTPS handshake — nothing is invented.
 *
 * Rule: a stage either completes (✓), is actively in progress, or FAILS with
 * a specific classified reason. The UI must never show a bare "CONNECTING".
 */

export type StageStatus = "pending" | "active" | "done" | "failed";

export type AuroraStageId =
  | "signed_in"          // token present (sign-in approved / paired)
  | "device_registered"  // token + telemetry URL stored
  | "aircraft_verified"  // aircraft binding checked
  | "reach"              // HTTPS health check answered by Aurora Cloud
  | "session"            // Aurora accepted the health report — link proven
  | "stream";            // first telemetry frame accepted end-to-end

export interface AuroraStage {
  id: AuroraStageId;
  label: string;
  status: StageStatus;
  /** specific reason on failure, or progress detail while active — never generic */
  detail: string | null;
}

export const STAGE_LABELS: Record<AuroraStageId, string> = {
  signed_in: "Sign-in approved",
  device_registered: "Device registered",
  aircraft_verified: "Aircraft verified",
  reach: "Contacting Aurora Cloud (HTTPS health check)",
  session: "Aurora link established",
  stream: "Telemetry stream active",
};

export const STAGE_ORDER: AuroraStageId[] = [
  "signed_in", "device_registered", "aircraft_verified", "reach", "session", "stream",
];

export function freshStages(): AuroraStage[] {
  return STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], status: "pending", detail: null }));
}

/** Map an HTTP status to the operator-facing failure reason. Never generic. */
export function classifyHttpFailure(status: number, serverError?: string | null): string {
  const suffix = serverError ? ` — server said: ${serverError}` : "";
  if (status === 401) return `401 Unauthorized — cloud authentication rejected or expired. Sign in again.${suffix}`;
  if (status === 403) return `403 Forbidden — this device's access was revoked in Aurora.${suffix}`;
  if (status === 404) return `404 Endpoint not found — the server URL is wrong or the Aurora API changed.${suffix}`;
  if (status === 429) return `429 Rate limited — Aurora is throttling this device.${suffix}`;
  if (status >= 500) return `${status} Server error — Aurora Cloud failed to process the request.${suffix}`;
  return `HTTP ${status} — unexpected response from Aurora.${suffix}`;
}

/** Map a network/runtime exception to a specific failure reason. */
export function classifyException(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code ?? "";
  const msg = e?.message ?? String(err);
  const causeMsg = e?.cause?.message ?? "";
  const all = `${code} ${msg} ${causeMsg}`;
  if (e?.name === "AbortError" || /abort/i.test(msg)) return "Handshake timeout — Aurora did not answer in time.";
  if (/CERT|certificate|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|DEPTH_ZERO/i.test(all))
    return `TLS certificate failure — secure connection could not be verified (${code || "certificate error"}).`;
  if (/ECONNREFUSED/i.test(all)) return "Connection refused — nothing is answering at the server address.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(all)) return "DNS lookup failed — the server address could not be resolved.";
  if (/ECONNRESET/i.test(all)) return "Connection reset — the server dropped the connection mid-request.";
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/i.test(all)) return "Handshake timeout — the network path to Aurora timed out.";
  if (/ENETUNREACH|EHOSTUNREACH/i.test(all)) return "Network unreachable — no route to Aurora from this PC.";
  return `Network error — ${msg}${code ? ` (${code})` : ""}`;
}
