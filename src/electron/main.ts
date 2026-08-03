/**
 * Electron shell — a thin window onto the local control server.
 * Token encryption uses Electron safeStorage (DPAPI on Windows).
 */
import { app, BrowserWindow, safeStorage } from "electron";
import * as path from "path";
import { Bridge } from "../core/bridge";
import { startControlServer } from "../server/controlServer";
import type { Encryptor } from "../core/tokenStore";

let bridge: Bridge | null = null;

function makeEncryptor(): Encryptor | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}

async function createWindow(): Promise<void> {
  bridge = new Bridge({
    dataDir: path.join(app.getPath("appData"), "AuroraBridge"),
    encryptor: makeEncryptor(),
  });
  bridge.autoStart();

  const uiDir = path.join(__dirname, "..", "..", "ui");
  const { port, authToken } = await startControlServer(bridge, uiDir);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Aurora Bridge",
    backgroundColor: "#0b0e12",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // The per-launch capability token rides the URL hash — only this window gets it.
  await win.loadURL(`http://127.0.0.1:${port}/#auth=${authToken}`);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  bridge?.shutdown();
  app.quit();
});
