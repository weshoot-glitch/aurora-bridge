/**
 * Bridge composition root — wires store, drone link, aurora link, diagnostics.
 * Used identically by the Electron app, the headless dev runner, and tests.
 */
import * as path from "path";
import * as os from "os";
import { BridgeStore } from "./state";
import { BridgeLog } from "./log";
import { DroneLink, DEFAULT_UDP_PORTS } from "./droneLink";
import { AuroraLink } from "./auroraLink";
import { Diagnostics } from "./diagnostics";
import { TokenStore, Encryptor } from "./tokenStore";
import { NetworkMonitor } from "./network";

export interface BridgeOptions {
  dataDir?: string;
  ports?: number[];
  encryptor?: Encryptor | null;
  fetchFn?: typeof fetch;
}

export function defaultDataDir(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "AuroraBridge");
  }
  return path.join(os.homedir(), ".aurora-bridge");
}

export class Bridge {
  readonly store: BridgeStore;
  readonly log: BridgeLog;
  readonly drone: DroneLink;
  readonly aurora: AuroraLink;
  readonly diagnostics: Diagnostics;
  readonly tokens: TokenStore;
  readonly network: NetworkMonitor;
  readonly dataDir: string;
  /** Running app version — used by the startup update check. */
  readonly appVersion: string = "4.0.0";

  constructor(opts: BridgeOptions = {}) {
    this.dataDir = opts.dataDir ?? defaultDataDir();
    const ports = opts.ports ?? DEFAULT_UDP_PORTS;
    this.store = new BridgeStore(ports);
    this.log = new BridgeLog(path.join(this.dataDir, "logs"));
    this.tokens = new TokenStore(this.dataDir, opts.encryptor ?? null);
    this.network = new NetworkMonitor(this.store, this.log);
    this.drone = new DroneLink(this.store, this.log, ports, this.network);
    this.aurora = new AuroraLink(this.store, this.log, this.tokens, opts.fetchFn ?? fetch);
    this.diagnostics = new Diagnostics(this.store, this.tokens, path.join(this.dataDir, "logs"), opts.fetchFn ?? fetch);
    this.log.log("system", "Aurora Bridge V4 started.");
  }

  /** Auto-start on launch: drone search always; Aurora only if already paired. */
  autoStart(): void {
    this.network.start();
    this.drone.start();
    if (this.tokens.isPaired && !this.store.state.aurora.offlineMode) {
      this.aurora.startForwarding();
    }
  }

  shutdown(): void {
    this.network.stop();
    this.drone.stop();
    this.aurora.stopForwarding();
  }
}
