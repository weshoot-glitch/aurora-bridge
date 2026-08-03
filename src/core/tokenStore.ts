import * as fs from "fs";
import * as path from "path";

/**
 * Pairing credential store.
 *
 * On Windows under Electron the token is encrypted with the OS keychain via
 * `safeStorage` (injected by the Electron main process). When no encryptor is
 * available (headless dev), the token is written plaintext with 0600 perms and
 * the UI shows an explicit warning — never silently.
 */
export interface Encryptor {
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

interface StoredPairing {
  tokenBlob: string; // base64 (encrypted or plain, see `encrypted`)
  encrypted: boolean;
  telemetryUrl: string;
  serverUrl: string;
  aircraftId: number | null;
  expectedSysId: number | null;
  deviceId: number | null;
}

export class TokenStore {
  private filePath: string;
  private cache: StoredPairing | null = null;

  constructor(dir: string, private encryptor: Encryptor | null) {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "pairing.json");
    try {
      this.cache = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this.cache = null;
    }
  }

  get isPaired(): boolean {
    return this.cache !== null;
  }

  get isPlaintext(): boolean {
    return this.cache !== null && !this.cache.encrypted;
  }

  get meta(): Omit<StoredPairing, "tokenBlob" | "encrypted"> | null {
    if (!this.cache) return null;
    const { tokenBlob: _t, encrypted: _e, ...meta } = this.cache;
    return meta;
  }

  get token(): string | null {
    if (!this.cache) return null;
    const raw = Buffer.from(this.cache.tokenBlob, "base64");
    if (!this.cache.encrypted) return raw.toString("utf8");
    if (!this.encryptor) return null; // encrypted blob but no decryptor — treat as unpaired
    try {
      return this.encryptor.decrypt(raw);
    } catch {
      return null;
    }
  }

  save(input: {
    token: string;
    telemetryUrl: string;
    serverUrl: string;
    aircraftId: number | null;
    expectedSysId: number | null;
    deviceId: number | null;
  }): void {
    const encrypted = this.encryptor !== null;
    const blob = encrypted
      ? this.encryptor!.encrypt(input.token)
      : Buffer.from(input.token, "utf8");
    this.cache = {
      tokenBlob: blob.toString("base64"),
      encrypted,
      telemetryUrl: input.telemetryUrl,
      serverUrl: input.serverUrl,
      aircraftId: input.aircraftId,
      expectedSysId: input.expectedSysId,
      deviceId: input.deviceId,
    };
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache), { mode: 0o600 });
  }

  clear(): void {
    this.cache = null;
    try { fs.unlinkSync(this.filePath); } catch { /* already gone */ }
  }
}
