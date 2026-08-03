import * as fs from "fs";
import * as path from "path";
import type { LogLine } from "./state";

const MAX_LINES = 2000;

/**
 * Ring-buffer log with per-category files on disk so Export Diagnostics can
 * ship bridge.log / connection.log / mavlink.log.
 *
 * NEVER log tokens or pairing codes — callers must not pass them in.
 */
export class BridgeLog {
  readonly lines: LogLine[] = [];
  private listeners = new Set<(line: LogLine) => void>();
  private streams = new Map<string, fs.WriteStream>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): fs.WriteStream {
    let s = this.streams.get(name);
    if (!s) {
      s = fs.createWriteStream(path.join(this.dir, name), { flags: "a" });
      this.streams.set(name, s);
    }
    return s;
  }

  log(category: LogLine["category"], message: string, level: LogLine["level"] = "info"): void {
    const line: LogLine = { ts: Date.now(), level, category, message };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    const text = `${new Date(line.ts).toISOString()} [${level.toUpperCase()}] ${message}\n`;
    this.file("bridge.log").write(text);
    if (category === "drone") this.file("mavlink.log").write(text);
    if (category === "aurora") this.file("connection.log").write(text);
    if (category === "network") this.file("network.log").write(text);
    for (const l of this.listeners) l(line);
  }

  subscribe(l: (line: LogLine) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get directory(): string {
    return this.dir;
  }
}
