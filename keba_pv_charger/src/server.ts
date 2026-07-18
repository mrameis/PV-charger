import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { config, legacyMigration } from "./config";
import { logger } from "./logger";
import { openDb } from "./db/db";
import { HistoryDb } from "./db/history";
import { SettingsDb } from "./db/settingsDb";
import { VehiclesDb } from "./db/vehiclesDb";
import { DevicesDb } from "./db/devicesDb";
import { EnergyDb } from "./db/energyDb";
import { PvSurplusController } from "./control/controller";
import { ChargeMode, DeviceCategory } from "./types";

const rawDb = openDb(config.server.dbPath);
const historyDb = new HistoryDb(rawDb);
const settingsDb = new SettingsDb(rawDb);
const vehiclesDb = new VehiclesDb(rawDb);
const devicesDb = new DevicesDb(rawDb);
const energyDb = new EnergyDb(rawDb);

// Einmalige Migration von Version 1.x (HA-Options) auf die geräte-basierte Verwaltung.
if (devicesDb.list().length === 0) {
  const migration = legacyMigration();
  if (migration) {
    settingsDb.seedFromLegacy(migration.controlSettings);
    for (const d of migration.devices) devicesDb.create(d);
    logger.info(`Legacy-Migration: ${migration.devices.length} Geräte aus alten Options übernommen`);
  }
}

const controller = new PvSurplusController(historyDb, settingsDb, vehiclesDb, devicesDb, energyDb);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const VALID_CATEGORIES: DeviceCategory[] = ["wallbox", "grid_meter", "battery", "pv_source"];

app.get("/api/status", (_req, res) => {
  res.json(controller.getSnapshot());
});

app.get("/api/history", (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  res.json(historyDb.getRecent(Number.isFinite(hours) ? hours : 24));
});

app.get("/api/history/daily", (req, res) => {
  const days = Number(req.query.days ?? 30);
  res.json(historyDb.getDailyTotals(Number.isFinite(days) ? days : 30));
});

app.get("/api/energy", (_req, res) => {
  res.json(energyDb.get());
});

app.get("/api/settings", (_req, res) => {
  res.json(controller.getSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    const updated = await controller.updateSettings(req.body ?? {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/mode", (req, res) => {
  const mode = req.body?.mode as ChargeMode;
  const valid: ChargeMode[] = ["off", "pv_only", "min_plus_pv", "fast", "manual"];
  if (!valid.includes(mode)) {
    res.status(400).json({ error: `Ungültiger Modus. Erlaubt: ${valid.join(", ")}` });
    return;
  }
  controller.setMode(mode);
  res.json({ ok: true, mode });
});

// --- Geräte (Ladestation / Netzzähler / Batterie / Solar-Wechselrichter) ---

app.get("/api/devices", (req, res) => {
  const category = req.query.category as DeviceCategory | undefined;
  if (category && !VALID_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Ungültige Kategorie" });
    return;
  }
  res.json(devicesDb.list(category));
});

app.post("/api/devices", (req, res) => {
  const body = req.body ?? {};
  if (!VALID_CATEGORIES.includes(body.category)) {
    res.status(400).json({ error: "Ungültige Kategorie" });
    return;
  }
  if (!body.host || !body.deviceType) {
    res.status(400).json({ error: "host und deviceType sind erforderlich" });
    return;
  }
  const device = devicesDb.create({
    category: body.category,
    deviceType: body.deviceType,
    name: body.name || body.deviceType,
    host: body.host,
    port: body.port ?? null,
    unitId: body.unitId ?? null,
    generation: body.generation ?? null,
    invert: body.invert ?? null,
    xmlPath: body.xmlPath ?? null,
    registerOffset: body.registerOffset ?? null,
    active: !!body.active,
    enabled: body.enabled !== false,
  });
  controller.reloadDevices();
  res.json(device);
});

app.put("/api/devices/:id", (req, res) => {
  const id = Number(req.params.id);
  const updated = devicesDb.update(id, req.body ?? {});
  if (!updated) {
    res.status(404).json({ error: "Gerät nicht gefunden" });
    return;
  }
  controller.reloadDevices();
  res.json(updated);
});

app.delete("/api/devices/:id", (req, res) => {
  const id = Number(req.params.id);
  devicesDb.delete(id);
  controller.reloadDevices();
  res.json({ ok: true });
});

app.post("/api/devices/:id/activate", (req, res) => {
  const device = devicesDb.get(Number(req.params.id));
  if (!device) {
    res.status(404).json({ error: "Gerät nicht gefunden" });
    return;
  }
  devicesDb.setActive(device.category, device.id);
  controller.reloadDevices();
  res.json({ ok: true });
});

// --- Fahrzeuge ---

app.get("/api/vehicles", (_req, res) => {
  res.json(vehiclesDb.list());
});

app.post("/api/vehicles", (req, res) => {
  const { name, minCurrentA, maxCurrentA, notes } = req.body ?? {};
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name ist erforderlich" });
    return;
  }
  const vehicle = vehiclesDb.create({
    name,
    minCurrentA: minCurrentA ?? null,
    maxCurrentA: maxCurrentA ?? null,
    notes: notes ?? null,
  });
  res.json(vehicle);
});

app.put("/api/vehicles/:id", (req, res) => {
  const id = Number(req.params.id);
  const updated = vehiclesDb.update(id, req.body ?? {});
  if (!updated) {
    res.status(404).json({ error: "Fahrzeug nicht gefunden" });
    return;
  }
  res.json(updated);
});

app.delete("/api/vehicles/:id", (req, res) => {
  const id = Number(req.params.id);
  vehiclesDb.delete(id);
  res.json({ ok: true });
});

app.post("/api/vehicles/:id/activate", (req, res) => {
  const id = Number(req.params.id);
  controller.setActiveVehicle(Number.isFinite(id) ? id : null);
  res.json({ ok: true });
});

app.post("/api/vehicles/deactivate", (_req, res) => {
  controller.setActiveVehicle(null);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(data: unknown): void {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

wss.on("connection", (ws) => {
  const snap = controller.getSnapshot();
  if (snap) ws.send(JSON.stringify({ type: "snapshot", data: snap }));
});

controller.onUpdate((snapshot) => broadcast({ type: "snapshot", data: snapshot }));

setInterval(() => historyDb.prune(90), 6 * 3600 * 1000);

controller.start();

server.listen(config.server.port, () => {
  logger.info(`Dashboard erreichbar auf http://0.0.0.0:${config.server.port}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM empfangen, beende...");
  controller.stop();
  server.close(() => process.exit(0));
});
