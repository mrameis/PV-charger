import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { HistoryDb } from "./db/history";
import { PvSurplusController } from "./control/controller";
import { ChargeMode } from "./types";

const db = new HistoryDb(config.server.dbPath);
const controller = new PvSurplusController(db);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/status", (_req, res) => {
  res.json(controller.getSnapshot());
});

app.get("/api/history", (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  res.json(db.getRecent(Number.isFinite(hours) ? hours : 24));
});

app.get("/api/config", (_req, res) => {
  res.json({
    mode: controller.getMode(),
    minCurrentA: config.control.minCurrentA,
    maxCurrentA: config.control.maxCurrentA,
    phasesMode: config.control.phasesMode,
    gridVoltage: config.control.gridVoltage,
  });
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
  if (snap) ws.send(JSON.stringify(snap));
});

controller.onUpdate((snapshot) => broadcast(snapshot));

// Täglicher Aufräumjob für alte Verlaufsdaten (90 Tage Historie behalten)
setInterval(() => db.prune(90), 6 * 3600 * 1000);

controller.start();

server.listen(config.server.port, () => {
  logger.info(`Dashboard erreichbar auf http://0.0.0.0:${config.server.port}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM empfangen, beende...");
  controller.stop();
  server.close(() => process.exit(0));
});
