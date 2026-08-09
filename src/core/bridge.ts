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
import { CameraRelay, type CameraRelayOptions } from "./cameraRelay";
import { Diagnostics } from "./diagnostics";
import { TokenStore, Encryptor } from "./tokenStore";
import { NetworkMonitor } from "./network";
import { loadActiveClient, saveActiveClient, type ActiveClientConfig } from "./udpSettings";

export interface BridgeOptions {
  dataDir?: string;
  ports?: number[];
  encryptor?: Encryptor | null;
  fetchFn?: typeof fetch;
  /** override active UDP-client config (tests); default = persisted settings */
  activeClient?: ActiveClientConfig | null;
  /** camera relay overrides (tests inject stub ffmpeg + TCP probe) */
  camera?: CameraRelayOptions;
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
  drone: DroneLink;
  private readonly ports: number[];
  readonly aurora: AuroraLink;
  readonly camera: CameraRelay;
  readonly diagnostics: Diagnostics;
  readonly tokens: TokenStore;
  readonly network: NetworkMonitor;
  readonly dataDir: string;
  /** Running app version — used by the startup update check. */
  readonly appVersion: string = "4.3.0";
  activeClientConfig: ActiveClientConfig;

  constructor(opts: BridgeOptions = {}) {
    this.dataDir = opts.dataDir ?? defaultDataDir();
    const ports = opts.ports ?? DEFAULT_UDP_PORTS;
    this.ports = ports;
    this.activeClientConfig = opts.activeClient !== undefined
      ? (opts.activeClient ?? { enabled: false, remoteHost: "", remotePort: 0, localPort: 0 })
      : loadActiveClient(this.dataDir);
    this.store = new BridgeStore(ports, this.activeClientConfig);
    this.log = new BridgeLog(path.join(this.dataDir, "logs"));
    this.tokens = new TokenStore(this.dataDir, opts.encryptor ?? null);
    this.network = new NetworkMonitor(this.store, this.log);
    this.drone = new DroneLink(this.store, this.log, ports, this.network, this.activeClientConfig);
    this.aurora = new AuroraLink(this.store, this.log, this.tokens, opts.fetchFn ?? fetch);
    this.camera = new CameraRelay(this.store, this.log, this.tokens, opts.fetchFn ?? fetch, opts.camera ?? {});
    this.diagnostics = new Diagnostics(this.store, this.tokens, path.join(this.dataDir, "logs"), opts.fetchFn ?? fetch);
    this.log.log("system", "Aurora Bridge V4 started.");
  }

  /** Auto-start on launch: drone search always; Aurora only if already paired. */
  autoStart(): void {
    this.network.start();
    this.drone.start();
    if (this.tokens.isPaired && !this.store.state.aurora.offlineMode) {
      this.aurora.startForwarding();
      // Camera relay is an independent capability: it self-gates on the Aurora
      // link being authenticated + an assignment + reachability. Starting it
      // here only begins assignment polling; the pipeline waits for the gate.
      this.camera.start();
    }
  }

  /** Persist new active UDP-client settings and restart the drone link with them. */
  applyActiveClient(config: ActiveClientConfig): void {
    saveActiveClient(this.dataDir, config);
    this.activeClientConfig = config;
    this.drone.stop();
    this.store.update((s) => {
      s.drone.activeClient = config.enabled
        ? { ...config, bound: false, bindError: null, probesSent: 0, lastProbeAt: null, lastReplyAt: null }
        : null;
    });
    this.drone = new DroneLink(this.store, this.log, this.ports, this.network, config);
    this.drone.start();
    this.log.log("drone", config.enabled
      ? `UDP client settings applied: local ${config.localPort} → ${config.remoteHost}:${config.remotePort}.`
      : "UDP client mode disabled — passive listening only.");
  }

  shutdown(): void {
    this.network.stop();
    this.drone.stop();
    this.aurora.stopForwarding();
    this.camera.stop();
  }
}
