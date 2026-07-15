const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const modeSelect = document.getElementById("mode-select");
const chartCanvas = document.getElementById("chart");
const ctx = chartCanvas.getContext("2d");
const wallboxSubtitle = document.getElementById("wallbox-subtitle");

let currentMode = null;
let vehicles = [];
let activeWallboxLabel = null;

function fmtW(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "– W";
  return `${Math.round(v).toLocaleString("de-DE")} W`;
}

// ============================== TABS ==============================
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${btn.dataset.tab}`));
  if (btn.dataset.tab === "settings") loadAllSettings();
  if (btn.dataset.tab === "history") loadDailyHistory();
});

document.getElementById("settings-subtabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".subtab-btn");
  if (!btn) return;
  document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".subtab-panel").forEach((p) =>
    p.classList.toggle("hidden", p.id !== `settings-${btn.dataset.subtab}`)
  );
});

// ============================== LADEMODUS ==============================
function setActiveMode(mode) {
  currentMode = mode;
  [...modeSelect.children].forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
}

modeSelect.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  setActiveMode(btn.dataset.mode);
  await fetch("api/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: btn.dataset.mode }),
  }).catch((err) => console.error("Moduswechsel fehlgeschlagen", err));
});

// --- Manuelle Ladeleistung (1,4 - 11 kW) ---
const manualSlider = document.getElementById("manual-power-slider");
const manualValueLabel = document.getElementById("manual-power-value");
let manualSliderDebounce = null;

function fmtKw(watts) {
  return `${(watts / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`;
}

manualSlider.addEventListener("input", () => {
  manualValueLabel.textContent = fmtKw(Number(manualSlider.value));
  clearTimeout(manualSliderDebounce);
  manualSliderDebounce = setTimeout(async () => {
    await fetch("api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualPowerW: Number(manualSlider.value) }),
    });
    // Wenn der Nutzer den Regler bewegt, ist die Absicht klar: in den manuellen Modus wechseln.
    if (currentMode !== "manual") {
      setActiveMode("manual");
      await fetch("api/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "manual" }),
      });
    }
  }, 400);
});

// ============================== DASHBOARD-ANZEIGE ==============================

/**
 * Verrechnet Batterieleistung (+ = lädt, - = entlädt), die Solarleistung des an der
 * Batterie hängenden MPPT-Ladereglers und die Netzleistung zu einem verständlichen
 * Text, passend zur Topologie Victron -> Solar-MPPT -> Batterie mit ESS-Zero-Feed-in:
 *   - Entladen: Gesamtleistung = |Batterie| + Solar (beides deckt den Hausverbrauch)
 *   - Laden: zuerst aus Solarüberschuss, erst wenn der nicht reicht aus dem Netz;
 *     reicht der Solarüberschuss für mehr als die Ladeleistung, geht der Rest
 *     zusätzlich als Einspeisung ins Netz (an gridW erkennbar).
 */
function batteryBreakdownText(battW, solarW, gridW) {
  const solar = solarW ?? 0;
  if (battW > 20) {
    const fromSolar = Math.min(solar, battW);
    const fromGrid = Math.max(0, battW - solar);
    let txt = `lädt: ${fmtW(fromSolar)} Solar`;
    if (fromGrid > 20) txt += ` + ${fmtW(fromGrid)} Netz`;
    else if (gridW !== null && gridW < -20) txt += ` (+${fmtW(Math.abs(gridW))} Solarüberschuss ins Netz)`;
    return txt;
  }
  if (battW < -20) {
    const total = Math.abs(battW) + solar;
    return `entlädt: ${fmtW(Math.abs(battW))} Batterie + ${fmtW(solar)} Solar = ${fmtW(total)} gesamt`;
  }
  return "im Ruhezustand";
}

/** Kurzform derselben Verrechnung für die Beschriftung im SVG-Diagramm (wenig Platz). */
function batteryBreakdownShort(battW, solarW) {
  const solar = solarW ?? 0;
  if (battW > 20) {
    const fromSolar = Math.min(solar, battW);
    const fromGrid = Math.max(0, battW - solar);
    return fromGrid > 20 ? `${fmtW(fromSolar)} Solar + ${fmtW(fromGrid)} Netz` : `${fmtW(fromSolar)} Solar`;
  }
  if (battW < -20) return `+${fmtW(solar)} Solar`;
  return "Ruhezustand";
}

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

  const batteries = snapshot.batteries ?? [];
  const battPowerW = batteries.reduce((sum, b) => sum + (b.online ? b.powerW ?? 0 : 0), 0);
  const battSolarW = batteries.reduce((sum, b) => sum + (b.online ? b.solarPowerW ?? 0 : 0), 0);
  document.getElementById("val-batt").textContent = batteries.length ? fmtW(battPowerW) : "keine Batterie";
  document.getElementById("val-batt-solar").textContent = batteries.length
    ? batteryBreakdownShort(battPowerW, battSolarW)
    : "";
  document.getElementById("path-house-batt").classList.toggle("active", Math.abs(battPowerW) > 50);
}

function updateStatus(snapshot) {
  const wallbox = snapshot.wallbox;
  document.getElementById("keba-state").textContent = wallbox ? wallbox.stateText : "nicht erreichbar";

  const reported = wallbox?.reportedPhases ?? null;
  const phasesText =
    reported !== null
      ? `${reported}-phasig`
      : `${snapshot.activePhases}-phasig (Soll, Wallbox meldet aktuell nichts)`;
  document.getElementById("keba-phases").textContent = phasesText;

  document.getElementById("keba-current").textContent = `${snapshot.targetCurrentA} A`;
  document.getElementById("controller-note").textContent = snapshot.controllerNote;
  if (currentMode !== snapshot.mode) setActiveMode(snapshot.mode);
  wallboxSubtitle.textContent = activeWallboxLabel ? `${activeWallboxLabel} · PV-Überschussladen` : "PV-Überschussladen";
}

function updateSources(snapshot) {
  const list = document.getElementById("source-list");
  list.innerHTML = "";
  if (!snapshot.pvSources.length) {
    list.innerHTML = '<li class="source-empty">Keine PV-Quellen konfiguriert (siehe Einstellungen).</li>';
  } else {
    for (const s of snapshot.pvSources) {
      const li = document.createElement("li");
      li.innerHTML = s.online
        ? `<span>${s.name}</span><span class="source-value">${fmtW(s.powerW)}</span>`
        : `<span>${s.name}</span><span class="source-offline">offline</span>`;
      list.appendChild(li);
    }
  }

  const batList = document.getElementById("battery-list");
  batList.innerHTML = "";
  if (!snapshot.batteries.length) {
    batList.innerHTML = '<li class="source-empty">Keine Batterie konfiguriert.</li>';
  } else {
    const gridW = snapshot.grid?.gridPowerW ?? null;
    for (const b of snapshot.batteries) {
      const li = document.createElement("li");
      const socTxt = b.socPercent !== null ? `${b.socPercent}%` : "–";
      const breakdown = b.online ? batteryBreakdownText(b.powerW ?? 0, b.solarPowerW, gridW) : "";
      li.innerHTML = b.online
        ? `<span>${b.name} <small>(${socTxt}) – ${breakdown}</small></span><span class="source-value">${fmtW(b.powerW)}</span>`
        : `<span>${b.name}</span><span class="source-offline">offline</span>`;
      batList.appendChild(li);
    }
  }
}

function fmtKWh(wh) {
  return `${(wh / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} kWh`;
}

function updateEnergy(energy) {
  const todayPct = energy.todayChargedWh > 0 ? Math.round((energy.todayPvWh / energy.todayChargedWh) * 100) : 0;
  const totalPct = energy.totalChargedWh > 0 ? Math.round((energy.totalPvWh / energy.totalChargedWh) * 100) : 0;

  document.getElementById("energy-today-total").textContent = fmtKWh(energy.todayChargedWh);
  document.getElementById("energy-today-sub").textContent = `${fmtKWh(energy.todayPvWh)} Solar (${todayPct}%)`;
  document.getElementById("energy-today-bar").style.width = `${todayPct}%`;

  document.getElementById("energy-total-total").textContent = fmtKWh(energy.totalChargedWh);
  document.getElementById("energy-total-sub").textContent = `${fmtKWh(energy.totalPvWh)} Solar (${totalPct}%)`;
  document.getElementById("energy-total-bar").style.width = `${totalPct}%`;
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
  if (id === null) await fetch("api/vehicles/deactivate", { method: "POST" });
  else await fetch(`api/vehicles/${id}/activate`, { method: "POST" });
}

// ============================== VERLAUFSDIAGRAMM ==============================
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

// --- Ladehistorie (Tagesansicht) ---
const historyChartCanvas = document.getElementById("history-chart");
const historyCtx = historyChartCanvas.getContext("2d");

function drawDailyChart(days) {
  const dpr = window.devicePixelRatio || 1;
  const w = historyChartCanvas.clientWidth;
  const h = historyChartCanvas.clientHeight || 220;
  historyChartCanvas.width = w * dpr;
  historyChartCanvas.height = h * dpr;
  historyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  historyCtx.clearRect(0, 0, w, h);
  if (!days.length) return;

  const padding = { top: 10, right: 10, bottom: 24, left: 40 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const maxWh = Math.max(500, ...days.map((d) => d.chargedWh));
  const barSlot = plotW / days.length;
  const barWidth = Math.min(28, barSlot * 0.6);

  historyCtx.strokeStyle = "rgba(255,255,255,0.08)";
  historyCtx.beginPath();
  historyCtx.moveTo(padding.left, padding.top + plotH);
  historyCtx.lineTo(w - padding.right, padding.top + plotH);
  historyCtx.stroke();

  historyCtx.font = "10px var(--font-mono)";
  historyCtx.fillStyle = "#8b97a5";
  historyCtx.textAlign = "center";

  days.forEach((d, i) => {
    const x = padding.left + barSlot * i + barSlot / 2;
    const solarH = (d.pvWh / maxWh) * plotH;
    const gridH = ((d.chargedWh - d.pvWh) / maxWh) * plotH;
    const yBottom = padding.top + plotH;

    historyCtx.fillStyle = "#e2574c";
    historyCtx.fillRect(x - barWidth / 2, yBottom - gridH - solarH, barWidth, gridH);
    historyCtx.fillStyle = "#2fb8a6";
    historyCtx.fillRect(x - barWidth / 2, yBottom - solarH, barWidth, solarH);

    if (days.length <= 14 || i % Math.ceil(days.length / 14) === 0) {
      historyCtx.fillStyle = "#8b97a5";
      historyCtx.fillText(d.date.slice(5), x, yBottom + 14);
    }
  });
}

function renderHistoryTable(days) {
  const tbody = document.querySelector("#history-table tbody");
  tbody.innerHTML = "";
  if (!days.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="source-empty">Noch keine Ladehistorie vorhanden.</td></tr>';
    return;
  }
  for (const d of [...days].reverse()) {
    const pct = d.chargedWh > 0 ? Math.round((d.pvWh / d.chargedWh) * 100) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.date}</td><td>${fmtKWh(d.chargedWh)}</td><td>${fmtKWh(d.pvWh)}</td><td>${pct}%</td>`;
    tbody.appendChild(tr);
  }
}

async function loadDailyHistory() {
  try {
    const res = await fetch("api/history/daily?days=30");
    const days = await res.json();
    drawDailyChart(days);
    renderHistoryTable(days);
  } catch (err) {
    console.error("Ladehistorie konnte nicht geladen werden", err);
  }
}
window.addEventListener("resize", () => {
  if (!document.getElementById("tab-history").classList.contains("hidden")) loadDailyHistory();
});

// ============================== GERÄTEVERWALTUNG (EINSTELLUNGEN) ==============================
const CATEGORY_TYPES = {
  wallbox: [
    ["keba", "Keba KeContact (Modbus TCP)"],
    ["go_echarger", "go-eCharger (lokale HTTP API)"],
  ],
  grid_meter: [["shelly", "Shelly 3EM / Pro 3EM"]],
  battery: [["victron", "Victron GX (Cerbo/Venus)"]],
  pv_source: [
    ["fronius", "Fronius Wechselrichter"],
    ["steca", "StecaGrid (XML)"],
    ["victron", "Victron (PV-gekoppelt)"],
    ["shelly", "Shelly 3EM (Einzelmessung Wechselrichter)"],
    ["shelly1pm", "Shelly 1PM (Einzelmessung Wechselrichter)"],
  ],
};

const FIELDS = {
  keba: [
    { name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.50" },
    { name: "port", label: "Modbus-Port", type: "number", default: 502 },
    { name: "unitId", label: "Modbus Unit-ID", type: "number", default: 255 },
  ],
  go_echarger: [{ name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.60" }],
  shelly: [
    { name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.51" },
    {
      name: "generation",
      label: "Generation",
      type: "select",
      options: [
        ["gen1", "Gen1 (klassisch)"],
        ["gen2", "Gen2 (Pro, RPC)"],
      ],
      default: "gen1",
    },
  ],
  shelly1pm: [
    { name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.55" },
    {
      name: "generation",
      label: "Generation",
      type: "select",
      options: [
        ["gen1", "Gen1 (klassisch 1PM)"],
        ["gen2", "Gen2/3 (Plus/Pro 1PM, RPC)"],
      ],
      default: "gen1",
    },
  ],
  victron: [
    { name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.54" },
    { name: "port", label: "Port", type: "number", default: 502 },
    { name: "unitId", label: "Unit-ID", type: "number", default: 100 },
  ],
  fronius: [{ name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.52" }],
  steca: [
    { name: "host", label: "IP-Adresse", type: "text", placeholder: "192.168.0.53" },
    { name: "xmlPath", label: "XML-Pfad (optional)", type: "text", placeholder: "/measurements.xml" },
  ],
};

function fieldsFor(category, deviceType) {
  const fields = [...(FIELDS[deviceType] || [])];
  if (category === "grid_meter" && deviceType === "shelly") {
    fields.push({ name: "invert", label: "Messrichtung invertieren", type: "checkbox" });
  }
  return fields;
}

async function loadCategory(category) {
  const res = await fetch(`api/devices?category=${category}`);
  const devices = await res.json();
  if (category === "wallbox") {
    const active = devices.find((d) => d.active);
    activeWallboxLabel = active ? active.name : null;
  }
  renderDeviceList(category, devices);
  renderAddArea(category, devices.length > 0);
}

function renderDeviceList(category, devices) {
  const ul = document.querySelector(`[data-list="${category}"]`);
  ul.innerHTML = "";
  if (!devices.length) {
    ul.innerHTML = '<li class="device-empty">Noch kein Gerät hinzugefügt.</li>';
    return;
  }
  const singleActive = category === "wallbox" || category === "grid_meter";
  for (const d of devices) {
    const li = document.createElement("li");
    li.className = "device-card" + (d.active ? " is-active" : "");
    const typeLabel = (CATEGORY_TYPES[category].find(([v]) => v === d.deviceType) || [d.deviceType, d.deviceType])[1];
    const metaParts = [typeLabel, d.host];
    if (d.port) metaParts.push(`Port ${d.port}`);
    if (d.generation) metaParts.push(d.generation);
    const actionBtn = singleActive
      ? `<button class="active-btn${d.active ? " is-active" : ""}" data-action="activate" data-id="${d.id}">${
          d.active ? "Aktiv" : "Aktivieren"
        }</button>`
      : `<button class="toggle-btn${d.enabled ? "" : " is-off"}" data-action="toggle" data-id="${d.id}">${
          d.enabled ? "Aktiviert" : "Deaktiviert"
        }</button>`;
    li.innerHTML = `
      <div class="device-info">
        <div class="device-name">${d.name}</div>
        <div class="device-meta">${metaParts.join(" · ")}</div>
      </div>
      <div class="device-actions">
        ${actionBtn}
        <button class="danger" data-action="delete" data-id="${d.id}">Löschen</button>
      </div>`;
    ul.appendChild(li);
  }
  ul.onclick = async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === "activate") {
      await fetch(`api/devices/${id}/activate`, { method: "POST" });
    } else if (btn.dataset.action === "toggle") {
      const dev = devices.find((x) => x.id === id);
      await fetch(`api/devices/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !dev.enabled }),
      });
    } else if (btn.dataset.action === "delete") {
      if (confirm("Gerät wirklich löschen?")) await fetch(`api/devices/${id}`, { method: "DELETE" });
    }
    loadCategory(category);
  };
}

function renderAddArea(category, hasDevices) {
  const container = document.querySelector(`[data-add="${category}"]`);
  container.innerHTML = "";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "device-add-toggle";
  toggleBtn.textContent = hasDevices ? "+ Weiteres Gerät hinzufügen" : "+ Gerät hinzufügen";

  const formWrap = document.createElement("div");
  formWrap.style.display = "none";
  toggleBtn.onclick = () => {
    formWrap.style.display = formWrap.style.display === "none" ? "block" : "none";
  };

  container.appendChild(toggleBtn);
  container.appendChild(formWrap);
  buildAddForm(category, formWrap);
}

function buildAddForm(category, formWrap) {
  const types = CATEGORY_TYPES[category];
  const form = document.createElement("form");
  form.className = "device-add-form";

  const typeSelect = document.createElement("select");
  typeSelect.name = "deviceType";
  for (const [value, label] of types) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    typeSelect.appendChild(opt);
  }
  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Gerätetyp";
  typeLabel.appendChild(typeSelect);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.placeholder = "Anzeigename (optional)";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  nameLabel.appendChild(nameInput);

  const dynamicRow = document.createElement("div");
  dynamicRow.className = "field-row";

  function renderDynamicFields() {
    dynamicRow.innerHTML = "";
    for (const f of fieldsFor(category, typeSelect.value)) {
      const label = document.createElement("label");
      if (f.type === "checkbox") {
        label.className = "checkbox";
        label.style.flexDirection = "row";
        label.style.alignItems = "center";
        label.style.textTransform = "none";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = f.name;
        label.appendChild(input);
        label.append(" " + f.label);
      } else if (f.type === "select") {
        label.textContent = f.label;
        const select = document.createElement("select");
        select.name = f.name;
        for (const [v, l] of f.options) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = l;
          if (v === f.default) opt.selected = true;
          select.appendChild(opt);
        }
        label.appendChild(select);
      } else {
        label.textContent = f.label;
        const input = document.createElement("input");
        input.type = f.type;
        input.name = f.name;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.default !== undefined) input.value = f.default;
        label.appendChild(input);
      }
      dynamicRow.appendChild(label);
    }
  }
  renderDynamicFields();
  typeSelect.addEventListener("change", renderDynamicFields);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Hinzufügen";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = "Abbrechen";
  cancelBtn.onclick = () => {
    formWrap.style.display = "none";
  };
  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);

  form.appendChild(typeLabel);
  form.appendChild(nameLabel);
  form.appendChild(dynamicRow);
  form.appendChild(actions);
  formWrap.appendChild(form);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { category, deviceType: typeSelect.value, name: nameInput.value };
    for (const el of form.elements) {
      if (!el.name || el.name === "deviceType" || el.name === "name") continue;
      if (el.type === "checkbox") data[el.name] = el.checked;
      else if (el.type === "number") data[el.name] = el.value === "" ? null : Number(el.value);
      else data[el.name] = el.value;
    }
    submitBtn.disabled = true;
    try {
      await fetch("api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      form.reset();
      formWrap.style.display = "none";
      await loadCategory(category);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ============================== REGELPARAMETER ==============================
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

async function loadControlSettings() {
  const res = await fetch("api/settings");
  const data = await res.json();
  fillForm(document.getElementById("form-control"), data);
}

document.getElementById("form-control").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Speichere…";
  try {
    await fetch("api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readForm(e.target)),
    });
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

// ============================== FAHRZEUGE ==============================
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
  const activeId = window.__lastSnapshot?.activeVehicle?.id ?? null;
  for (const v of vehicles) {
    const li = document.createElement("li");
    const meta = [v.minCurrentA !== null ? `min ${v.minCurrentA}A` : null, v.maxCurrentA !== null ? `max ${v.maxCurrentA}A` : null]
      .filter(Boolean)
      .join(" · ");
    li.innerHTML = `
      <div><div>${v.name}</div><div class="vehicle-meta">${meta || "Standard-Limits"}</div></div>
      <div class="vehicle-actions">
        <button class="active-btn${activeId === v.id ? " is-active" : ""}" data-action="activate" data-id="${v.id}">${
      activeId === v.id ? "Aktiv" : "Aktivieren"
    }</button>
        <button class="danger" data-action="delete" data-id="${v.id}">Löschen</button>
      </div>`;
    list.appendChild(li);
  }
}

document.getElementById("vehicle-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "activate") await activateVehicle(id);
  else if (btn.dataset.action === "delete") {
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

// ============================== EINSTELLUNGEN LADEN ==============================
async function loadAllSettings() {
  await Promise.all([
    loadCategory("wallbox"),
    loadCategory("grid_meter"),
    loadCategory("battery"),
    loadCategory("pv_source"),
    loadControlSettings(),
    loadVehicles(),
  ]);
}

// ============================== WEBSOCKET ==============================
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
    updateEnergy(snapshot.energy);

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
  await Promise.all([loadHistory(), loadVehicles(), loadCategory("wallbox")]);
  try {
    const res = await fetch("api/settings");
    const settings = await res.json();
    manualSlider.value = settings.manualPowerW;
    manualValueLabel.textContent = fmtKw(settings.manualPowerW);
  } catch (err) {
    console.error("Konnte manuelle Ladeleistung nicht laden", err);
  }
  connect();
}
init();
