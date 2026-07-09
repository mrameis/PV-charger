const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const modeSelect = document.getElementById("mode-select");
const chartCanvas = document.getElementById("chart");
const ctx = chartCanvas.getContext("2d");

let currentMode = null;

function fmtW(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "– W";
  return `${Math.round(v).toLocaleString("de-DE")} W`;
}

function setActiveMode(mode) {
  currentMode = mode;
  [...modeSelect.children].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
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

function updateFlow(snapshot) {
  const gridW = snapshot.grid?.gridPowerW ?? 0;
  const pvW = snapshot.pvTotalW;
  const evW = snapshot.keba?.activePowerW ?? 0;

  document.getElementById("val-pv").textContent = pvW !== null ? fmtW(pvW) : "n/v";
  document.getElementById("val-grid").textContent = `${gridW >= 0 ? "Bezug " : "Einspeisung "}${fmtW(
    Math.abs(gridW)
  )}`;
  document.getElementById("val-ev").textContent = fmtW(evW);

  const pvLine = document.getElementById("path-pv-house");
  const gridLine = document.getElementById("path-grid-house");
  const evLine = document.getElementById("path-house-ev");

  pvLine.classList.toggle("active", (pvW ?? 0) > 50);
  gridLine.classList.toggle("active", Math.abs(gridW) > 50);
  evLine.classList.toggle("active", evW > 50);

  // Netzpfeil-Richtung: bei Einspeisung (negativ) zeigt der Fluss praktisch von Haus->Netz,
  // wir behalten die feste Pfadrichtung bei und drücken die Richtung stattdessen über Text aus,
  // um das SVG einfach zu halten.
}

function updateStatus(snapshot) {
  const keba = snapshot.keba;
  document.getElementById("keba-state").textContent = keba ? keba.stateText : "nicht erreichbar";
  document.getElementById("keba-phases").textContent = `${snapshot.activePhases}-phasig`;
  document.getElementById("keba-current").textContent = `${snapshot.targetCurrentA} A`;
  document.getElementById("controller-note").textContent = snapshot.controllerNote;

  if (currentMode !== snapshot.mode) setActiveMode(snapshot.mode);
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
      ? Object.entries(s.extra)
          .map(([k, v]) => `${k}: ${v ?? "–"}`)
          .join(" · ")
      : "";
    li.innerHTML = s.online
      ? `<span>${s.name}${extra ? " <small>(" + extra + ")</small>" : ""}</span><span class="source-value">${fmtW(
          s.powerW
        )}</span>`
      : `<span>${s.name}</span><span class="source-offline">offline</span>`;
    list.appendChild(li);
  }
}

// --- Verlaufsdiagramm (leichtgewichtig, ohne externe Abhängigkeit) ---
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

  function x(ts) {
    return padding.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * plotW;
  }
  function y(v) {
    return padding.top + plotH / 2 - (v / maxV) * (plotH / 2);
  }

  // Nulllinie
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

// --- WebSocket Live-Updates ---
function wsUrl() {
  // Relative Auflösung gegen die aktuelle Dokument-URL, damit das auch hinter dem
  // Home-Assistant-Ingress-Pfadpräfix (/api/hassio_ingress/<token>/...) funktioniert.
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
    const snapshot = JSON.parse(event.data);
    updateFlow(snapshot);
    updateStatus(snapshot);
    updateSources(snapshot);

    history.push({
      ts: snapshot.timestamp,
      pv_total_w: snapshot.pvTotalW,
      grid_power_w: snapshot.grid?.gridPowerW ?? null,
      charging_power_w: snapshot.keba?.activePowerW ?? null,
    });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    history = history.filter((d) => d.ts >= cutoff);
    drawChart();
  };
}

loadHistory().then(connect);
