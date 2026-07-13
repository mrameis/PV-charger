import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { config, legacyOptionsAsSettings } from "./config";
import { logger } from "./logger";
import { openDb } from "./db/db";
import { HistoryDb } from "./db/history";
import { SettingsDb } from "./db/settingsDb";
import { VehiclesDb } from "./db/vehiclesDb";
import { PvSurplusController } from "./control/controller";
import { ChargeMode } from "./types";

const rawDb = openDb(config.server.dbPath);
const historyDb = new HistoryDb(rawDb);
const settingsDb = new SettingsDb(rawDb);
const vehiclesDb = new VehiclesDb(rawDb);

// Einmalige Migration: bestehende HA-Options aus der alten Version übernehmen,
// falls die Einstellungen-DB noch leer ist.
settingsDb.seedFromLegacyOptions(legacyOptionsAsSettings());

const controller = new PvSurplusController(historyDb, settingsDb, vehiclesDb);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/status", (_req, res) => {
  res.json(controller.getSnapshot());
});

app.get("/api/history", (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  res.json(historyDb.getRecent(Number.isFinite(hours) ? hours : 24));
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
  const valid: ChargeMode[] = ["off", "pv_only", "min_plus_pv", "fast"];
  if (!valid.includes(mode)) {
    res.status(400).json({ error: `Ungültiger Modus. Erlaubt: ${valid.join(", ")}` });
    return;
  }
  controller.setMode(mode);
  res.json({ ok: true, mode });
});

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
