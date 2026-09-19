import mqtt, { MqttClient } from "mqtt";
import Database from "better-sqlite3";
import { logger } from "../logger";
import { BmwDb } from "../db/bmwDb";
import { BmwStatus } from "../types";
import { ensureValidTokens } from "./auth";
import { BmwTelematicEntry } from "./rest";

const MQTT_HOST = "customer.streaming-cardata.bmwgroup.com";
const MQTT_PORT = 9000;

interface BmwStreamMessage {
  vin: string;
  entityId?: string;
  timestamp: string;
  data: Record<string, BmwTelematicEntry>;
}

type StateListener = (state: BmwStatus) => void;

/**
 * MQTT-Streaming-Client für BMW CarData.
 *
 * Eigenheiten, die dieser Client berücksichtigt:
 * - Nur EINE gleichzeitige Verbindung pro GCID erlaubt -> vor jedem Reconnect wird
 *   die alte Verbindung sauber geschlossen.
 * - Das ID-Token (= MQTT-Passwort) läuft nach 1h ab -> proaktiver Reconnect mit
 *   frischem Passwort 5 Minuten vor Ablauf (BMW kennt kein "Passwort auf offener
 *   Verbindung erneuern").
 * - Daten kommen nur, wenn das Fahrzeug aktiv Daten erzeugt (fährt/lädt/vorklimatisiert).
 *   Stillstand des Datenstroms im Parkzustand ist normal, kein Fehler.
 */
export class BmwStreamingClient {
  private client: MqttClient | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private listeners: StateListener[] = [];
  private state: BmwStatus;

  constructor(private db: Database.Database, private bmwDb: BmwDb, private clientId: string, private vin: string) {
    this.state = {
      vin,
      socDisplayed: null,
      socTarget: null,
      remainingRangeKm: null,
      chargingStatus: null,
      chargingHvStatus: null,
      chargingPortStatus: null,
      preconditioningActive: null,
      lastUpdate: null,
      streamConnected: false,
      authStatus: "authenticated",
    };
  }

  onStateChange(listener: StateListener): void {
    this.listeners.push(listener);
  }

  getState(): BmwStatus {
    return this.state;
  }

  applyHydration(hydration: Record<string, BmwTelematicEntry>): void {
    for (const [descriptor, entry] of Object.entries(hydration)) {
      this.applyToState(descriptor, entry.value);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client?.end(true);
    this.client = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    // Immer zuerst eine evtl. noch offene Verbindung schließen - one-connection-per-GCID.
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }

    let tokens;
    try {
      tokens = await ensureValidTokens(this.db, this.bmwDb, this.clientId);
    } catch (err) {
      logger.error("[bmw] Token ungültig, Streaming pausiert:", (err as Error).message);
      this.state.streamConnected = false;
      this.state.authStatus = "idle";
      this.emit();
      // Kein Retry-Loop bei fehlender Authentifizierung - das Dashboard muss den
      // Nutzer zum erneuten Device-Code-Flow auffordern.
      return;
    }

    const topic = `${tokens.gcid}/${this.vin}`;

    this.client = mqtt.connect({
      host: MQTT_HOST,
      port: MQTT_PORT,
      protocol: "mqtts",
      protocolVersion: 4, // MQTT 3.1.1
      username: tokens.gcid,
      password: tokens.idToken,
      clientId: `pv-charger-${this.vin}-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 0, // Reconnects steuern wir selbst (siehe scheduleRefresh/scheduleReconnect)
      connectTimeout: 15_000,
    });

    this.client.on("connect", () => {
      logger.info("[bmw] MQTT verbunden, subscribe auf", topic);
      this.client?.subscribe(topic, { qos: 1 }, (err) => {
        if (err) logger.error("[bmw] Subscribe fehlgeschlagen:", err.message);
      });
      this.state.streamConnected = true;
      this.emit();
    });

    this.client.on("message", (_topic, payload) => this.handleMessage(payload));

    this.client.on("error", (err) => logger.error("[bmw] MQTT-Fehler:", err.message));

    this.client.on("close", () => {
      this.state.streamConnected = false;
      this.emit();
      if (!this.stopped) this.scheduleReconnect(10_000);
    });

    const msUntilRefresh = Math.max(tokens.idExpiresAt - Date.now() - 5 * 60_000, 30_000);
    this.scheduleRefresh(msUntilRefresh);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, delayMs);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, delayMs);
  }

  private handleMessage(payload: Buffer): void {
    let msg: BmwStreamMessage;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      logger.warn("[bmw] Ungültiges MQTT-Payload ignoriert");
      return;
    }

    for (const [descriptor, entry] of Object.entries(msg.data || {})) {
      this.bmwDb.upsertState(descriptor, entry.value, entry.unit, entry.timestamp);
      this.applyToState(descriptor, entry.value);
    }

    this.state.lastUpdate = msg.timestamp || new Date().toISOString();
    this.emit();
  }

  private applyToState(descriptor: string, value: string | number | null): void {
    const num = value === null ? null : Number(value);
    switch (descriptor) {
      case "vehicle.powertrain.electric.battery.stateOfCharge.displayed":
        this.state.socDisplayed = num;
        break;
      case "vehicle.powertrain.electric.battery.stateOfCharge.target":
        this.state.socTarget = num;
        break;
      case "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange":
        this.state.remainingRangeKm = num;
        break;
      case "vehicle.drivetrain.electricEngine.charging.status":
        this.state.chargingStatus = value === null ? null : String(value);
        break;
      case "vehicle.drivetrain.electricEngine.charging.hvStatus":
        this.state.chargingHvStatus = value === null ? null : String(value);
        break;
      case "vehicle.body.chargingPort.status":
        this.state.chargingPortStatus = value === null ? null : String(value);
        break;
      case "vehicle.vehicle.preConditioning.activity":
        this.state.preconditioningActive = value !== null && String(value) !== "INACTIVE";
        break;
      default:
        break;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
