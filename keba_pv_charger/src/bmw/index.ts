import Database from "better-sqlite3";
import { logger } from "../logger";
import { BmwDb } from "../db/bmwDb";
import { BmwStatus, BMW_DEFAULT_DESCRIPTORS } from "../types";
import { requestDeviceCode, pollDeviceToken, ensureValidTokens, BmwPendingAuth } from "./auth";
import { ensureContainer } from "./container";
import { fetchTelematicDataOnce } from "./rest";
import { BmwStreamingClient } from "./streaming";

export type Broadcast = (data: unknown) => void;

/**
 * Orchestriert die BMW-CarData-Anbindung: Start, Cache-Hydration, Streaming und
 * den einmaligen Device-Code-Login. Rein additiv zum Dashboard - keine Kopplung
 * an die Ladelogik (PvSurplusController).
 */
export class BmwIntegration {
  private streaming: BmwStreamingClient | null = null;
  private pendingAuth: BmwPendingAuth | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: Database.Database, private bmwDb: BmwDb, private broadcast: Broadcast) {}

  /** Beim Server-Start aufrufen. Läuft ins Leere, falls noch nicht konfiguriert/authentifiziert. */
  async start(): Promise<void> {
    const config = this.bmwDb.getConfig();
    if (!config || !config.enabled) return;

    if (!this.bmwDb.getTokens()) {
      logger.info("[bmw] Noch nicht authentifiziert - warte auf Device-Code-Flow über das Dashboard");
      this.broadcastState();
      return;
    }

    try {
      const valid = await ensureValidTokens(this.db, this.bmwDb, config.clientId);
      const containerId = await ensureContainer(this.bmwDb, valid.accessToken, config.containerId, config.descriptors);

      this.streaming = new BmwStreamingClient(this.db, this.bmwDb, config.clientId, config.vin);
      this.streaming.onStateChange((state) => this.broadcast({ type: "bmw", data: state }));

      // Einmalige Cache-Hydration beim Start (zählt gegen die 50/Tag-Quota, aber nur 1x).
      try {
        const hydration = await fetchTelematicDataOnce(valid.accessToken, config.vin, containerId);
        for (const [descriptor, entry] of Object.entries(hydration)) {
          this.bmwDb.upsertState(descriptor, entry.value, entry.unit, entry.timestamp);
        }
        this.streaming.applyHydration(hydration);
      } catch (err) {
        logger.warn("[bmw] Cache-Hydration übersprungen:", (err as Error).message);
      }

      await this.streaming.start();
      this.broadcast({ type: "bmw", data: this.streaming.getState() });
    } catch (err) {
      logger.error("[bmw] Start fehlgeschlagen:", (err as Error).message);
      this.broadcastState();
    }
  }

  stop(): void {
    this.streaming?.stop();
    this.streaming = null;
  }

  getState(): BmwStatus {
    if (this.streaming) return this.streaming.getState();
    const config = this.bmwDb.getConfig();
    return {
      vin: config?.vin ?? "",
      socDisplayed: null,
      socTarget: null,
      remainingRangeKm: null,
      chargingStatus: null,
      chargingHvStatus: null,
      chargingPortStatus: null,
      preconditioningActive: null,
      lastUpdate: null,
      streamConnected: false,
      authStatus: this.getAuthStatus(),
    };
  }

  private broadcastState(): void {
    this.broadcast({ type: "bmw", data: this.getState() });
  }

  // ---- Einmaliger Setup-/Login-Flow, vom Dashboard aus getriggert ----

  /** Schritt 1: Client-ID + VIN speichern und Device-Code-Flow starten. */
  async beginAuth(clientId: string, vin: string): Promise<{ verificationUriComplete: string; userCode: string }> {
    this.bmwDb.saveConfig({
      clientId,
      vin,
      containerId: null,
      descriptors: [...BMW_DEFAULT_DESCRIPTORS],
      enabled: true,
    });

    this.pendingAuth = await requestDeviceCode(clientId);
    this.startPolling(clientId);
    this.broadcastState();

    return {
      verificationUriComplete: this.pendingAuth.verificationUriComplete,
      userCode: this.pendingAuth.userCode,
    };
  }

  getAuthStatus(): "idle" | "pending" | "authenticated" {
    if (this.bmwDb.getTokens()) return "authenticated";
    if (this.pendingAuth) return "pending";
    return "idle";
  }

  private startPolling(clientId: string): void {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(async () => {
      if (!this.pendingAuth) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        return;
      }
      try {
        const tokens = await pollDeviceToken(clientId, this.pendingAuth);
        if (tokens) {
          this.bmwDb.saveTokens(tokens);
          this.pendingAuth = null;
          if (this.pollTimer) clearInterval(this.pollTimer);
          logger.info("[bmw] Authentifizierung erfolgreich, starte Integration");
          await this.start();
        }
      } catch (err) {
        logger.error("[bmw] Auth-Polling abgebrochen:", (err as Error).message);
        this.pendingAuth = null;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.broadcastState();
      }
    }, (this.pendingAuth?.interval ?? 5) * 1000);
  }
}
