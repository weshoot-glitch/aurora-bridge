/* Aurora Bridge V4 UI — plain JS client of the local control server. */
"use strict";

const $ = (id) => document.getElementById(id);
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);

/* Per-launch capability token, injected via the launch URL hash (#auth=...).
   Kept in sessionStorage so in-page reloads keep working. */
const AUTH = (() => {
  const m = location.hash.match(/auth=([0-9a-f]+)/);
  if (m) {
    sessionStorage.setItem("bridgeAuth", m[1]);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("bridgeAuth") || "";
})();

let state = null;

/* ---------- tabs ---------- */
const pages = { manager: $("page-manager"), main: $("page-main") };
function showTab(name) {
  pages.manager.hidden = name !== "manager";
  pages.main.hidden = name !== "main";
  $("tab-manager").classList.toggle("active", name === "manager");
  $("tab-main").classList.toggle("active", name === "main");
}
$("tab-manager").onclick = () => showTab("manager");
$("tab-main").onclick = () => showTab("main");

/* ---------- websocket ---------- */
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws?auth=${AUTH}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") { state = msg.state; render(); }
    if (msg.type === "log") appendLog(msg.line);
  };
  ws.onclose = () => setTimeout(connectWs, 1000);
}
connectWs();

/* ---------- log window ---------- */
function appendLog(line) {
  const el = document.createElement("span");
  el.className = line.level === "warn" ? "log-warn" : line.level === "error" ? "log-error" : "";
  el.textContent = `${new Date(line.ts).toLocaleTimeString()}  ${line.message}\n`;
  const win = $("log-window");
  win.appendChild(el);
  while (win.childNodes.length > 500) win.removeChild(win.firstChild);
  win.scrollTop = win.scrollHeight;
}

/* ---------- actions ---------- */
async function api(action, body) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Auth": AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/* ---------- startup update check (once per launch; silent when offline) ---------- */
(async () => {
  try {
    const res = await fetch(`/api/update-check`, { headers: { "X-Bridge-Auth": AUTH } });
    const { update } = await res.json();
    if (!update) return;
    $("update-text").textContent = `Version ${update.latestVersion} available. Download and install? Your settings are preserved.`;
    $("btn-update-download").onclick = () => window.open(update.releaseUrl, "_blank");
    $("btn-update-later").onclick = () => { $("update-banner").hidden = true; };
    $("update-banner").hidden = false;
  } catch { /* offline or old server — no banner, never an error */ }
})();

/* ---------- sign-in registration (device-authorization) ---------- */
let signinTimer = null;
function stopSignin(msg) {
  if (signinTimer) { clearInterval(signinTimer); signinTimer = null; }
  $("signin-wait").hidden = true;
  $("btn-signin").disabled = false;
  if (msg) { $("signin-error").textContent = msg; $("signin-error").hidden = false; }
}
$("btn-signin").onclick = async () => {
  $("signin-error").hidden = true;
  const serverUrl = ($("signin-url").value || "https://aurorauavsystems.com").trim();
  $("btn-signin").disabled = true;
  const start = await api("aurora/signin/start", { serverUrl });
  if (!start.ok) { stopSignin(`Could not reach Aurora: ${start.error || "unknown error"}`); return; }
  $("signin-code").textContent = start.userCodeDisplay;
  $("signin-verify-url").textContent = start.verifyUrl.split("?")[0];
  $("signin-status").textContent = "Waiting for approval…";
  $("signin-wait").hidden = false;
  window.open(start.verifyUrl, "_blank");
  signinTimer = setInterval(async () => {
    const r = await api("aurora/signin/poll");
    if (r.status === "pending") return;
    if (r.status === "approved") { stopSignin(); return; } // state push updates the UI
    if (r.status === "denied") return stopSignin("The request was denied in Aurora.");
    if (r.status === "expired") return stopSignin("The request expired — sign in again.");
    if (r.status === "error") $("signin-status").textContent = `Retrying… (${r.error || "network"})`;
  }, 3000);
};
$("btn-signin-cancel").onclick = () => stopSignin();

$("btn-connect").onclick = () => api("drone/connect");
$("btn-disconnect").onclick = () => api("drone/disconnect");
$("offline-toggle").onchange = (e) => api("aurora/offline", { offline: e.target.checked });
$("btn-unpair").onclick = () => { if (confirm("Remove Aurora pairing from this PC?")) api("aurora/unpair"); };

$("pair-form").onsubmit = async (e) => {
  e.preventDefault();
  $("pair-error").hidden = true;
  $("btn-login").disabled = true;
  const result = await api("aurora/pair", {
    serverUrl: $("pair-url").value.trim(),
    pairingString: $("pair-code").value.trim(),
  });
  $("btn-login").disabled = false;
  if (!result.ok) {
    $("pair-error").textContent = `Pairing failed: ${result.error}`;
    $("pair-error").hidden = false;
  } else {
    $("pair-code").value = "";
  }
};

async function runTests() {
  const btn = $("btn-test-all");
  btn.disabled = true; btn.textContent = "TESTING…";
  try {
    const { results } = await api("tests/run");
    const tbody = $("test-table").querySelector("tbody");
    tbody.innerHTML = "";
    for (const r of results) {
      const tr = document.createElement("tr");
      const verdict = document.createElement("td");
      verdict.className = r.pass ? "pass" : "fail";
      verdict.textContent = r.pass ? "PASS" : "FAIL";
      const label = document.createElement("td");
      label.textContent = r.label;
      const detail = document.createElement("td");
      detail.textContent = r.detail;
      tr.append(verdict, label, detail);
      tbody.appendChild(tr);
    }
  } finally {
    btn.disabled = false; btn.textContent = "TEST CONNECTIONS";
  }
}
$("btn-test-all").onclick = runTests;
$("btn-test-aurora").onclick = () => { showTab("manager"); runTests(); };

$("btn-export").onclick = async () => {
  const r = await api("diagnostics/export");
  $("export-path").textContent = r.ok ? `Saved: ${r.path}` : "Export failed";
};

/* ---------- render ---------- */
const DRONE_LAMP = { connected: "green", searching: "yellow", disconnected: "red" };
const AURORA_LAMP = {
  connected: "green", connecting: "yellow", offline_mode: "yellow",
  not_paired: "red", error: "red", revoked: "red",
};
const AURORA_LABEL = {
  connected: "CONNECTED", connecting: "CONNECTING…", offline_mode: "OFFLINE MODE",
  not_paired: "NOT PAIRED", error: "ERROR", revoked: "REVOKED",
};

function setLamp(id, cls) {
  const el = $(id);
  el.className = "lamp " + (cls || "");
}

const HEALTH_ROWS = [
  ["heartbeat", "Heartbeat"], ["packetRate", "Packet Rate"], ["gps", "GPS"],
  ["battery", "Battery"], ["attitude", "Attitude"], ["globalPosition", "Global Position"],
  ["ekf", "EKF"], ["missionCurrent", "Mission Current"],
];
const VERDICT_LABEL = { pass: "PASS", waiting: "WAITING", failed: "FAILED" };

function renderPhaseStrip(d, a) {
  const order = ["searching", "heartbeat_found", "vehicle_connected", "telemetry_active", "aurora_connected", "forwarding"];
  let reached = order.indexOf(d.phase); // -1 for idle
  if (d.phase === "telemetry_active" && a.status === "connected") {
    // "Forwarding" only counts with a FRESH delivered frame — a historical
    // lastForwardAt from before a drop must not display as current.
    const fresh = a.lastForwardAt && Date.now() - a.lastForwardAt < 5000;
    reached = a.forwarding && fresh ? 5 : 4;
  }
  document.querySelectorAll("#phase-strip li").forEach((li, i) => {
    li.classList.toggle("done", i < reached);
    li.classList.toggle("active", i === reached);
  });
}

function render() {
  if (!state) return;
  const d = state.drone, a = state.aurora, v = d.vehicle, n = state.network, pm = d.monitor;

  renderPhaseStrip(d, a);

  /* network panel */
  $("n-pc").textContent = fmt(n.pcIp);
  $("n-subnet").textContent = fmt(n.subnet);
  $("n-gateway").textContent = fmt(n.gateway);
  $("n-adapter").textContent = fmt(n.adapter);
  $("n-type").textContent = fmt(n.connectionType);
  const devBody = $("device-table").querySelector("tbody");
  devBody.innerHTML = "";
  for (const dev of n.discovered) {
    const tr = document.createElement("tr");
    for (const c of [dev.ip, dev.protocol, dev.port, dev.mavlink ? "YES" : "—"]) {
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.appendChild(td);
    }
    if (dev.ip === d.sourceIp) tr.style.color = "var(--green)";
    devBody.appendChild(tr);
  }
  $("no-devices").hidden = n.discovered.length > 0;

  /* MAVLink health panel */
  const healthBody = $("health-table").querySelector("tbody");
  healthBody.innerHTML = "";
  for (const [key, label] of HEALTH_ROWS) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = label;
    const tdVerdict = document.createElement("td");
    const verdict = d.health[key];
    tdVerdict.textContent = VERDICT_LABEL[verdict] || "—";
    tdVerdict.className = `verdict-${verdict}`;
    tr.append(tdLabel, tdVerdict);
    healthBody.appendChild(tr);
  }

  /* packet monitor */
  $("pm-pps").textContent = fmt(pm.packetsPerSecond);
  $("pm-dropped").textContent = String(pm.droppedPackets);
  $("pm-hbrate").textContent = pm.heartbeatRateHz !== null ? `${pm.heartbeatRateHz} Hz` : "—";
  $("pm-latency").textContent = pm.latencyMs !== null ? `${pm.latencyMs} ms` : "—";
  $("pm-lastpkt").textContent = pm.lastPacketAt
    ? `${Math.max(0, Math.round((Date.now() - pm.lastPacketAt) / 1000))}s ago`
    : d.scanning ? "No MAVLink packets received" : "—";

  /* failure banner — tell the operator exactly where the problem is */
  const banner = $("failure-banner");
  if (d.status === "connected" && (a.status === "connected" || a.offlineMode)) {
    banner.textContent = a.offlineMode
      ? "DRONE CONNECTED — OFFLINE MODE (Aurora deliberately ignored)"
      : "ALL SYSTEMS GO — drone connected, telemetry forwarding to Aurora";
    banner.className = "banner green";
  } else if (d.status === "connected") {
    banner.textContent = `DRONE OK — AURORA PROBLEM: ${AURORA_LABEL[a.status]}${a.lastError ? " — " + a.lastError : ""}`;
    banner.className = "banner yellow";
  } else if (a.status === "connected") {
    banner.textContent = "AURORA OK — DRONE PROBLEM: " + (d.scanning ? "searching, no heartbeat yet" : "drone link stopped — press CONNECT");
    banner.className = "banner yellow";
  } else if (!d.scanning) {
    banner.textContent = "IDLE — press CONNECT to search for the drone";
    banner.className = "banner";
  } else {
    banner.textContent = "SEARCHING FOR DRONE — Aurora " + AURORA_LABEL[a.status];
    banner.className = "banner yellow";
  }

  /* manager page */
  setLamp("lamp-drone", DRONE_LAMP[d.status] === "green" ? "green" : d.scanning ? "yellow" : "red");
  setLamp("lamp-aurora", AURORA_LAMP[a.status]);
  const tbody = $("udp-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const p of d.ports) {
    const tr = document.createElement("tr");
    const cells = [
      p.port,
      p.bindError ? `BIND FAILED: ${p.bindError}` : p.bound ? (p.packetsSeen > 0 ? "RECEIVING" : "LISTENING") : "—",
      p.packetsSeen,
      p.heartbeatSeen ? "YES" : "—",
      p.lastSourceIp ? `${p.lastSourceIp}:${p.lastSourcePort}` : "—",
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.appendChild(td);
    }
    if (p.port === d.activePort) tr.style.color = "var(--green)";
    tbody.appendChild(tr);
  }
  $("m-drone-status").textContent = d.status.toUpperCase();
  $("m-active-port").textContent = fmt(d.activePort);
  $("m-source").textContent = d.sourceIp ? `${d.sourceIp}:${d.sourcePort}` : "—";
  $("m-sysid").textContent = v.sysId !== null ? `${v.sysId} / ${fmt(v.compId)}` : "—";
  $("m-vtype").textContent = fmt(v.vehicleType);
  $("m-pps").textContent = fmt(d.packetsPerSecond);
  $("m-streams").textContent = d.streamsRequested ? "YES (4 Hz)" : "—";

  $("m-server").textContent = fmt(a.serverUrl);
  $("m-aurora-status").textContent = AURORA_LABEL[a.status];
  $("m-auth").textContent = a.paired ? "PAIRED" : "NOT PAIRED";
  $("m-aircraft").textContent = fmt(a.aircraftId);
  $("m-expected-sysid").textContent = fmt(a.expectedSysId);
  $("m-forwarded").textContent = `${a.framesForwarded}${a.framesRejected ? ` (+${a.framesRejected} rejected)` : ""}`;
  $("m-queued").textContent = fmt(a.queuedFrames);
  $("m-lasterror").textContent = fmt(a.lastError);
  $("offline-toggle").checked = a.offlineMode;
  $("plaintext-warning").hidden = !a.tokenStoredPlaintext;

  /* main page */
  setLamp("lamp-drone2", DRONE_LAMP[d.status] === "green" ? "green" : d.scanning ? "yellow" : "red");
  setLamp("lamp-aurora2", AURORA_LAMP[a.status]);
  const bigD = $("big-drone-status");
  bigD.textContent = d.status === "connected" ? "CONNECTED" : d.scanning ? "SEARCHING…" : "DISCONNECTED";
  bigD.className = "status-big " + (d.status === "connected" ? "green" : d.scanning ? "yellow" : "red");
  const bigA = $("big-aurora-status");
  bigA.textContent = AURORA_LABEL[a.status];
  bigA.className = "status-big " + AURORA_LAMP[a.status];

  $("v-type").textContent = fmt(v.vehicleType) + (v.autopilot ? ` · ${v.autopilot}` : "");
  $("v-sysid").textContent = fmt(v.sysId);
  $("v-mode").textContent = fmt(v.flightMode);
  $("v-armed").textContent = v.armed === null ? "—" : v.armed ? "ARMED" : "DISARMED";
  $("v-batt").textContent = v.batteryPercent !== null
    ? `${v.batteryPercent}%${v.batteryVoltage !== null ? ` (${v.batteryVoltage.toFixed(1)} V)` : ""}`
    : v.batteryVoltage !== null ? `${v.batteryVoltage.toFixed(1)} V` : "—";
  $("v-gps").textContent = v.gpsFix !== null ? `${v.gpsFix}${v.satellites !== null ? ` · ${v.satellites} sats` : ""}` : "—";
  $("v-pos").textContent = v.lat !== null && v.lon !== null ? `${v.lat.toFixed(6)}, ${v.lon.toFixed(6)}` : "—";
  $("v-alt").textContent = v.relativeAltM !== null ? `${v.relativeAltM.toFixed(1)} m` : "—";
  $("v-gspd").textContent = v.groundspeedMs !== null ? `${v.groundspeedMs.toFixed(1)} m/s` : "—";
  $("v-hdg").textContent = v.headingDeg !== null ? `${Math.round(v.headingDeg)}°` : "—";
  $("v-pps").textContent = fmt(d.packetsPerSecond);

  $("btn-connect").hidden = d.scanning;
  $("btn-disconnect").hidden = !d.scanning;
  $("a-auth").textContent = a.paired ? "YES" : "NO";
  $("a-aircraft").textContent = fmt(a.aircraftId);
  $("a-fwd").textContent = a.offlineMode ? "OFF (offline mode)" : a.forwarding ? "ON" : "OFF";
  $("btn-unpair").hidden = !a.paired;
  if (a.serverUrl && !$("pair-url").value) $("pair-url").value = a.serverUrl;
}
