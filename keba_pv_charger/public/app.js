const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const modeSelect = document.getElementById("mode-select");
const chartCanvas = document.getElementById("chart");
const ctx = chartCanvas.getContext("2d");
const wallboxSubtitle = document.getElementById("wallbox-subtitle");

let currentMode = null;
let currentSettings = null;
let vehicles = [];

function fmtW(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "– W";
  return `${Math.round(v).toLocaleString("de-DE")} W`;
}

// --- Tabs ---
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `tab-${btn.dataset.tab}`);
  });
  if (btn.dataset.tab === "settings") loadSettingsIntoForms();
});

// --- Lademodus ---
function setActiveMode(mode) {
  currentMode = mode;
  [...modeSelect.children].forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
}

modeSelect.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  setActiveMode(btn.dataset.mode);
  try {
    await fetch("api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: btn.dataset.mode }),
    });
  } catch (err) {
    console.error("Moduswechsel fehlgeschlagen", err);
  }
});

// --- Energiefluss ---
function updateFlow(snapshot) {
  const gridW = snapshot.grid?.gridPowerW ?? 0;
  const pvW = snapshot.pvTotalW;
  const evW = snapshot.wallbox?.activePowerW ?? 0;

  document.getElementById("val-pv").textContent = pvW !== null ? fmtW(pvW) : "n/v";
  document.getElementById("val-grid").textContent = `${gridW >= 0 ? "Bezug " : "Einspeisung "}${fmtW(Math.abs(gridW))}`;
  document.getElementById("val-ev").textContent = fmtW(evW);

  document.getElementById("path-pv-house").classList.toggle("active", (pvW ?? 0) > 50);
  document.getElementById("path-grid-house").classList.toggle("active", Math.abs(gridW) > 50);
  document.getElementById("path-house-ev").classList.toggle("active", evW > 50);
}

function updateStatus(snapshot) {
  const wallbox = snapshot.wallbox;
  document.getElementById("keba-state").textContent = wallbox ? wallbox.stateText : "nicht erreichbar";
  document.getElementById("keba-phases").textContent = `${snapshot.activePhases}-phasig`;
  document.getElementById("keba-current").textContent = `${snapshot.targetCurrentA} A`;
  document.getElementById("controller-note").textContent = snapshot.controllerNote;
  if (currentMode !== snapshot.mode) setActiveMode(snapshot.mode);

  if (currentSettings) {
    wallboxSubtitle.textContent =
      currentSettings.wallboxType === "go_echarger" ? "go-eCharger · PV-Überschussladen" : "Keba KeContact · PV-Überschussladen";
  }
}

function updateSources(snapshot) {
  const list = document.getElementById("source-list");
  list.innerHTML = "";
  if (!snapshot.pvSources.length) {
    list.innerHTML = '<li class="source-empty">Keine zusätzlichen PV-Quellen konfiguriert.</li>';
    return;
  }
  for (const s of snapshot.pvSources) {
    const li = document.createElement("li");
    const extra = s.extra
      ? Object.entries(s.extra).map(([k, v]) => `${k}: ${v ?? "–"}`).join(" · ")
      : "";
    li.innerHTML = s.online
      ? `<span>${s.name}${extra ? " <small>(" + extra + ")</small>" : ""}</span><span class="source-value">${fmtW(s.powerW)}</span>`
      : `<span>${s.name}</span><span class="source-offline">offline</span>`;
    list.appendChild(li);
  }
}

function updateVehicleQuickpicks(snapshot) {
  const list = document.getElementById("vehicle-quickpicks");
  list.innerHTML = "";
  if (!vehicles.length) {
    list.innerHTML = '<li class="source-empty">Keine Fahrzeuge angelegt (siehe Einstellungen).</li>';
    return;
  }
  const activeId = snapshot.activeVehicle?.id ?? null;
  const wrap = document.createElement("li");
  wrap.style.display = "block";
  wrap.style.border = "none";
  const noneBtn = document.createElement("button");
  noneBtn.className = "vehicle-quick-btn" + (activeId === null ? " is-active" : "");
  noneBtn.textContent = "Standard";
  noneBtn.onclick = () => activateVehicle(null);
  wrap.appendChild(noneBtn);
  for (const v of vehicles) {
    const b = document.createElement("button");
    b.className = "vehicle-quick-btn" + (activeId === v.id ? " is-active" : "");
    b.textContent = v.name;
    b.onclick = () => activateVehicle(v.id);
    wrap.appendChild(b);
  }
  list.appendChild(wrap);
}

async function activateVehicle(id) {
  if (id === null) {
    await fetch("api/vehicles/deactivate", { method: "POST" });
  } else {
    await fetch(`api/vehicles/${id}/activate`, { method: "POST" });
  }
}

// --- Verlaufsdiagramm ---
let history = [];

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = chartCanvas.clientWidth;
  const h = chartCanvas.clientHeight || 220;
  chartCanvas.width = w * dpr;
  chartCanvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) return;

  const padding = { top: 10, right: 10, bottom: 20, left: 10 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const allVals = history.flatMap((d) => [d.pv_total_w ?? 0, d.grid_power_w ?? 0, d.charging_power_w ?? 0]);
  const maxV = Math.max(500, ...allVals.map((v) => Math.abs(v)));
  const minTs = history[0].ts;
  const maxTs = history[history.length - 1].ts;

  const x = (ts) => padding.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * plotW;
  const y = (v) => padding.top + plotH / 2 - (v / maxV) * (plotH / 2);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(padding.left, y(0));
  ctx.lineTo(w - padding.right, y(0));
  ctx.stroke();

  function drawSeries(key, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    history.forEach((d, i) => {
      const px = x(d.ts);
      const py = y(d[key] ?? 0);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  drawSeries("pv_total_w", "#f2a93b");
  drawSeries("grid_power_w", "#e2574c");
  drawSeries("charging_power_w", "#2fb8a6");
}

async function loadHistory() {
  try {
    const res = await fetch("api/history?hours=24");
    history = await res.json();
    drawChart();
  } catch (err) {
    console.error("Verlauf konnte nicht geladen werden", err);
  }
}
window.addEventListener("resize", drawChart);

// --- Einstellungen ---
function fillForm(form, data) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === "checkbox") el.checked = !!data[el.name];
    else el.value = data[el.name] ?? "";
  }
}

function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "number") out[el.name] = el.value === "" ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

function toggleKebaOnlyFields() {
  const isKeba = document.querySelector('#form-wallbox [name="wallboxType"]').value === "keba";
  document.querySelectorAll(".keba-only").forEach((el) => el.classList.toggle("hidden", !isKeba));
}

async function loadSettingsIntoForms() {
  try {
    const res = await fetch("api/settings");
    currentSettings = await res.json();
    fillForm(document.getElementById("form-wallbox"), currentSettings);
    fillForm(document.getElementById("form-shelly"), currentSettings);
    fillForm(document.getElementById("form-control"), currentSettings);
    fillForm(document.getElementById("form-sources"), currentSettings);
    toggleKebaOnlyFields();
  } catch (err) {
    console.error("Einstellungen konnten nicht geladen werden", err);
  }
}

async function saveSettings(partial) {
  const res = await fetch("api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  currentSettings = await res.json();
}

document.getElementById("form-wallbox").addEventListener("change", (e) => {
  if (e.target.name === "wallboxType") toggleKebaOnlyFields();
});

for (const id of ["form-wallbox", "form-shelly", "form-control", "form-sources"]) {
  document.getElementById(id).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Speichere…";
    try {
      await saveSettings(readForm(e.target));
      btn.textContent = "Gespeichert ✓";
    } catch (err) {
      btn.textContent = "Fehler!";
      console.error(err);
    }
    setTimeout(() => {
      btn.textContent = "Speichern";
      btn.disabled = false;
    }, 1500);
  });
}

// --- Fahrzeuge ---
async function loadVehicles() {
  const res = await fetch("api/vehicles");
  vehicles = await res.json();
  renderVehicleList();
}

function renderVehicleList() {
  const list = document.getElementById("vehicle-list");
  list.innerHTML = "";
  if (!vehicles.length) {
    list.innerHTML = '<li class="source-empty">Noch keine Fahrzeuge angelegt.</li>';
    return;
  }
  const activeId = currentSnapshotActiveVehicleId();
  for (const v of vehicles) {
    const li = document.createElement("li");
    const meta = [
      v.minCurrentA !== null ? `min ${v.minCurrentA}A` : null,
      v.maxCurrentA !== null ? `max ${v.maxCurrentA}A` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    li.innerHTML = `
      <div>
        <div>${v.name}</div>
        <div class="vehicle-meta">${meta || "Standard-Limits"}</div>
      </div>
      <div class="vehicle-actions">
        <button class="active-btn${activeId === v.id ? " is-active" : ""}" data-action="activate" data-id="${v.id}">${
      activeId === v.id ? "Aktiv" : "Aktivieren"
    }</button>
        <button class="danger" data-action="delete" data-id="${v.id}">Löschen</button>
      </div>`;
    list.appendChild(li);
  }
}

function currentSnapshotActiveVehicleId() {
  return window.__lastSnapshot?.activeVehicle?.id ?? null;
}

document.getElementById("vehicle-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "activate") {
    await activateVehicle(id);
  } else if (btn.dataset.action === "delete") {
    if (confirm("Fahrzeug wirklich löschen?")) {
      await fetch(`api/vehicles/${id}`, { method: "DELETE" });
      await loadVehicles();
    }
  }
});

document.getElementById("form-add-vehicle").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readForm(e.target);
  if (!data.name) return;
  await fetch("api/vehicles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  e.target.reset();
  await loadVehicles();
});

// --- WebSocket Live-Updates ---
function wsUrl() {
  const url = new URL("ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function connect() {
  const ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    connDot.classList.add("live");
    connText.textContent = "live";
  };
  ws.onclose = () => {
    connDot.classList.remove("live");
    connText.textContent = "getrennt – erneuter Versuch…";
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== "snapshot") return;
    const snapshot = msg.data;
    window.__lastSnapshot = snapshot;
    updateFlow(snapshot);
    updateStatus(snapshot);
    updateSources(snapshot);
    updateVehicleQuickpicks(snapshot);
    renderVehicleList();

    history.push({
      ts: snapshot.timestamp,
      pv_total_w: snapshot.pvTotalW,
      grid_power_w: snapshot.grid?.gridPowerW ?? null,
      charging_power_w: snapshot.wallbox?.activePowerW ?? null,
    });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    history = history.filter((d) => d.ts >= cutoff);
    drawChart();
  };
}

async function init() {
  await Promise.all([loadHistory(), loadVehicles(), loadSettingsIntoForms()]);
  connect();
}
init();
