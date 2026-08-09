#!/usr/bin/env node
/**
 * Stub ffmpeg for headless tests — NO real ffmpeg in the repl.
 *
 * Mimics the subset of ffmpeg the Camera Relay drives:
 *  - accepts the same CLI args (we only read the output playlist path, the last arg)
 *  - emits `-progress pipe:1` key=value lines on stdout (frame/fps/bitrate)
 *  - writes fake HLS segments (.ts) and a playlist (.m3u8) to the work dir
 *
 * Behaviour switches (env vars set by the test):
 *  - STUB_MODE=frames   → advances frames + writes segments (happy path → live)
 *  - STUB_MODE=noframes → runs but never advances frames (→ no_frames)
 *  - STUB_MODE=crash    → exits non-zero shortly after start (→ relay_disconnected)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const mode = process.env.STUB_MODE || "frames";
const args = process.argv.slice(2);
const playlist = args[args.length - 1]; // ffmpeg output path is the final positional arg
const workDir = path.dirname(playlist);
try { fs.mkdirSync(workDir, { recursive: true }); } catch { /* noop */ }

if (mode === "crash") {
  process.stderr.write("stub-ffmpeg: simulated RTSP drop\n");
  setTimeout(() => process.exit(1), 200);
} else if (mode === "noframes") {
  // Running, connected, but no frames ever advance.
  let ticks = 0;
  const t = setInterval(() => {
    process.stdout.write(`frame=0\nfps=0.0\nbitrate=N/A\nprogress=continue\n`);
    if (++ticks > 200) clearInterval(t);
  }, 200);
  process.on("SIGTERM", () => process.exit(0));
} else {
  // Happy path: advance frames + write real (fake-content) segments + playlist.
  let frame = 0;
  let seg = 0;
  const write = () => {
    frame += 30;
    const segName = `seg${String(seg).padStart(5, "0")}.ts`;
    try { fs.writeFileSync(path.join(workDir, segName), Buffer.from(`FAKE-TS-${seg}-${Date.now()}`)); } catch { /* noop */ }
    const recent = [];
    for (let i = Math.max(0, seg - 4); i <= seg; i++) recent.push(`seg${String(i).padStart(5, "0")}.ts`);
    const m3u8 = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:2",
      `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, seg - 4)}`,
      ...recent.flatMap((s) => ["#EXTINF:2.000,", s]),
    ].join("\n") + "\n";
    try { fs.writeFileSync(playlist, m3u8); } catch { /* noop */ }
    seg++;
    process.stdout.write(`frame=${frame}\nfps=30.0\nbitrate=2500.0 kbits/s\nprogress=continue\n`);
  };
  write();
  const t = setInterval(write, 200);
  process.on("SIGTERM", () => { clearInterval(t); process.exit(0); });
}
