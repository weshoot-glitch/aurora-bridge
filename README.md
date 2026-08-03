# Aurora Bridge V4 (Windows desktop)

One purpose: **connect a MAVLink drone to Aurora.** Nothing else.

The two links are completely independent:

- **Drone link (UDP MAVLink).** Binds every common MAVLink UDP port
  (14540, 14550, 14551, 14552, 14555, 5760), waits for the first valid
  HEARTBEAT, locks onto that port + source, and requests telemetry streams
  itself — no Mission Planner / UniGCS needed (close them; they hold the ports).
- **Aurora link (HTTPS).** Pair once with a code from Aurora → Controllers,
  then telemetry is forwarded at 1 Hz. If Aurora is unreachable, frames with a
  real position buffer (~15 min) and catch up via the batch endpoint.
  Aurora failing NEVER stops the drone link; losing the drone NEVER
  disconnects Aurora.

**Offline Mode** ignores Aurora entirely — drone-only, live telemetry on screen.

The **Connection Manager** is the first screen: per-port UDP state, heartbeat,
source IP, packet rate, Aurora HTTPS/auth state, one-click **TEST CONNECTIONS**
(PASS/FAIL with concrete reasons) and **EXPORT DIAGNOSTICS** (zip with
config.json — token redacted — bridge.log, connection.log, mavlink.log,
system_info.txt).

## Honesty rules (binding, same as the rest of Aurora)

- Unknown values render as `—` and are OMITTED from telemetry posts — never 0.
- MAVLink sentinels (heading 65535, battery −1, sats 255, voltage 65535) are filtered.
- `flightMode` is displayed locally but deliberately not sent.
- Wire field is `lng`, not `lon` (see api-server routes/controllers.ts).
- 401/403 → pairing cleared, status REVOKED, drone link untouched.

## Security

- Pairing token encrypted with Windows DPAPI (Electron `safeStorage`); if OS
  encryption is unavailable the UI shows an explicit plaintext-storage warning.
- Control server binds 127.0.0.1 only; token never leaves the core.
- Diagnostics export always redacts the token.

## Dev (in the repl — no Electron needed)

```
npm run dev:headless   # core + UI on http://127.0.0.1:8765
npm run sim            # fake ArduPilot quad streaming to udp/14550
npm test               # vitest suite (real UDP loopback MAVLink)
```

## Build (GitHub Actions)

`.github/workflows/windows.yml` builds the installer on `windows-latest` when
this directory is pushed as its own repository. Output: NSIS installer +
portable exe artifacts.
