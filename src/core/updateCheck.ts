/**
 * Startup update check — reads the latest published GitHub Release and
 * compares it to the running version. Honest by construction:
 *   • no release repo configured, network down, or no release yet → null
 *     (the UI simply shows nothing — never a fabricated "up to date").
 *   • an update is only announced when the published version is STRICTLY
 *     newer than the running one.
 * The update itself is a normal installer download (AuroraBridgeSetup.exe);
 * settings live under AppData so reinstalling preserves them.
 */

/** "owner/repo" of the published Aurora Bridge releases. Empty = check disabled. */
export const RELEASE_REPO = "";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string | null;
  publishedAt: string | null;
}

/** Compare dotted numeric versions (ignores a leading "v"). >0 ⇒ a newer than b. */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string) => s.replace(/^v/i, "").split(".").map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkForUpdate(
  currentVersion: string,
  repo: string = RELEASE_REPO,
): Promise<UpdateInfo | null> {
  if (!repo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "aurora-bridge" },
    });
    if (!res.ok) return null;
    const rel = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      published_at?: string;
    };
    const latest = rel.tag_name ?? "";
    if (!latest || compareVersions(latest, currentVersion) <= 0) return null;
    return {
      currentVersion,
      latestVersion: latest.replace(/^v/i, ""),
      releaseUrl: rel.html_url ?? `https://github.com/${repo}/releases/latest`,
      releaseNotes: rel.body ?? null,
      publishedAt: rel.published_at ?? null,
    };
  } catch {
    return null; // offline / rate-limited — silently no banner, never an error state
  }
}
