/**
 * Headless dev runner (no Electron): starts the bridge core + control server
 * on a fixed port so the UI can be exercised in a browser. Dev only.
 * Run: npm run dev:headless
 */
import * as path from "path";
import { Bridge } from "../core/bridge";
import { startControlServer } from "../server/controlServer";

const PORT = Number(process.env.BRIDGE_UI_PORT ?? 8765);

async function main(): Promise<void> {
  const bridge = new Bridge({ dataDir: path.join(process.cwd(), ".dev-data") });
  bridge.autoStart();
  const uiDir = path.join(process.cwd(), "ui");
  const { port, authToken } = await startControlServer(bridge, uiDir, PORT);
  console.log(`[bridge] UI on http://127.0.0.1:${port}/#auth=${authToken}`);
}

void main();
