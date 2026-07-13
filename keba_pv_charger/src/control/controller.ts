import { Shelly3EmClient } from "../energy/shelly3em";
import { FroniusClient } from "../energy/fronius";
import { StecaClient } from "../energy/steca";
import { VictronClient } from "../energy/victron";
import { createWallboxClient } from "../wallbox/factory";
import { WallboxClient } from "../wallbox/types";
import { logger } from "../logger";
import { AppSettings, ChargeMode, SystemSnapshot, PvSourceStatus } from "../types";
import { HistoryDb } from "../db/history";
import { SettingsDb } from "../db/settingsDb";
import { VehiclesDb } from "../db/vehiclesDb";

const WALLBOX_READY_STATES = new Set([2, 3]); // Keba: 2=Bereit,3=Lädt | go-e: car 2/3/4 werden separat behandelt

export class PvSurplusController {
  private settings: AppSettings;
  private activePhases: 1 | 3 = 1;
  private lastPhaseSwitch = 0;
  private wantMorePhasesSince: number | null = null;
  private wantFewerPhasesSince: number | null = null;
  private wantPauseSince: number | null = null;
  private lastSnapshot: SystemSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: SystemSnapshot) => void> = [];

  private wallbox: WallboxClient;
  private shelly: Shelly3EmClient;
  private fronius: FroniusClient | null = null;
  private steca: StecaClient | null = null;
  private victron: VictronClient | null = null;

  constructor(private db: HistoryDb, private settingsDb: SettingsDb, private vehiclesDb: VehiclesDb) {
    this.settings = this.settingsDb.get();
    this.wallbox = createWallboxClient(this.settings);
    this.shelly = new Shelly3EmClient(
      this.settings.shellyHost,
      this.settings.shellyGeneration,
      this.settings.shellyInvert
    );
    this.buildOptionalSources();
    if (this.settings.phasesMode === "1") this.activePhases = 1;
    if (this.settings.phasesMode === "3") this.activePhases = 3;
  }

  private buildOptionalSources(): void {
    this.fronius = this.settings.froniusEnabled ? new FroniusClient(this.settings.froniusHost) : null;
    this.steca = this.settings.stecaEnabled
      ? new StecaClient(this.settings.stecaHost, this.settings.stecaXmlPath || undefined)
      : null;
    this.victron = this.settings.victronEnabled
      ? new VictronClient(this.settings.victronHost, this.settings.victronPort, this.settings.victronUnitId)
      : null;
  }

  onUpdate(cb: (s: SystemSnapshot) => void): void {
    this.listeners.push(cb);
  }

  getSnapshot(): SystemSnapshot | null {
    return this.lastSnapshot;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  /**
   * Übernimmt geänderte Einstellungen aus dem Interface. Geräte-relevante Felder
   * (Wallbox-Typ/-IP, Zähler-IP, ...) erzeugen die jeweiligen Clients neu.
   */
  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const needsWallboxReconnect =
      "wallboxType" in partial || "wallboxHost" in partial || "wallboxPort" in partial || "wallboxUnitId" in partial;
    const needsShellyReconnect = "shellyHost" in partial || "shellyGeneration" in partial || "shellyInvert" in partial;
    const needsSourceRebuild =
      "froniusEnabled" in partial ||
      "froniusHost" in partial ||
      "stecaEnabled" in partial ||
      "stecaHost" in partial ||
      "stecaXmlPath" in partial ||
      "victronEnabled" in partial ||
      "victronHost" in partial ||
      "victronPort" in partial ||
      "victronUnitId" in partial;

    this.settings = this.settingsDb.update(partial);

    if (needsWallboxReconnect) {
      await this.wallbox.close().catch(() => undefined);
      this.wallbox = createWallboxClient(this.settings);
      logger.info(`Wallbox-Konfiguration geändert -> Typ ${this.settings.wallboxType} @ ${this.settings.wallboxHost}`);
    }
    if (needsShellyReconnect) {
      this.shelly = new Shelly3EmClient(
        this.settings.shellyHost,
        this.settings.shellyGeneration,
        this.settings.shellyInvert
      );
    }
    if (needsSourceRebuild) {
      this.buildOptionalSources();
    }
    if ("phasesMode" in partial) {
      if (this.settings.phasesMode === "1") this.activePhases = 1;
      if (this.settings.phasesMode === "3") this.activePhases = 3;
    }
    return this.settings;
  }

  setMode(mode: ChargeMode): void {
    this.settings = this.settingsDb.update({ mode });
  }

  setActiveVehicle(vehicleId: number | null): void {
    this.settings = this.settingsDb.update({ activeVehicleId: vehicleId });
  }

  start(): void {
    this.tick().catch((e) => logger.error("Fehler im ersten Regel-Tick:", e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error("Fehler im Regel-Tick:", e));
    }, this.settings.intervalSec * 1000);
    logger.info(`Regelschleife gestartet (Intervall ${this.settings.intervalSec}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Effektive Mindest-/Maximalstromgrenzen unter Berücksichtigung des aktiven Fahrzeugprofils. */
  private effectiveLimits(): { minA: number; maxA: number } {
    const vehicleId = this.settings.activeVehicleId;
    if (vehicleId === null) return { minA: this.settings.minCurrentA, maxA: this.settings.maxCurrentA };
    const vehicle = this.vehiclesDb.get(vehicleId);
    if (!vehicle) return { minA: this.settings.minCurrentA, maxA: this.settings.maxCurrentA };
    return {
      minA: vehicle.minCurrentA ?? this.settings.minCurrentA,
      maxA: vehicle.maxCurrentA ?? this.settings.maxCurrentA,
    };
  }

  private minPowerW(phases: 1 | 3): number {
    return this.effectiveLimits().minA * phases * this.settings.gridVoltage;
  }
  private maxPowerW(phases: 1 | 3): number {
    return this.effectiveLimits().maxA * phases * this.settings.gridVoltage;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const [wallbox, grid, froniusS, stecaS, victronS] = await Promise.all([
      this.wallbox.readStatus().catch((e) => {
        logger.warn("Wallbox: Lesefehler:", (e as Error).message);
        return null;
      }),
      this.shelly.read(),
      this.fronius?.read() ?? Promise.resolve<PvSourceStatus | null>(null),
      this.steca?.read() ?? Promise.resolve<PvSourceStatus | null>(null),
      this.victron?.read() ?? Promise.resolve<PvSourceStatus | null>(null),
    ]);

    const pvSources = [froniusS, stecaS, victronS].filter((s): s is PvSourceStatus => !!s);
    const pvTotalW = pvSources.some((s) => s.powerW !== null)
      ? pvSources.reduce((sum, s) => sum + (s.powerW ?? 0), 0)
      : null;

    const { minA, maxA } = this.effectiveLimits();
    let note = "";
    let targetCurrentA = 0;

    if (!wallbox) {
      note = "Wallbox nicht erreichbar - keine Regelung möglich.";
    } else if (this.settings.mode === "off") {
      note = "Modus 'Aus': Wallbox gesperrt.";
      await this.safeCall(() => this.wallbox.setEnabled(false));
    } else if (!wallbox.cablePlugged) {
      note = "Kein Fahrzeug angesteckt.";
      await this.safeCall(() => this.wallbox.setEnabled(true));
      await this.safeCall(() => this.wallbox.setChargingCurrentA(0));
    } else if (!WALLBOX_READY_STATES.has(wallbox.state) && wallbox.errorCode !== 0) {
      note = `Wallbox-Status "${wallbox.stateText}" - keine Regelung möglich.`;
    } else if (this.settings.mode === "fast") {
      targetCurrentA = maxA;
      note = "Modus 'Schnell': volle Ladeleistung.";
      await this.applyPhaseDecision(now, this.maxPowerW(3) + 1);
      await this.safeCall(() => this.wallbox.setEnabled(true));
      await this.safeCall(() => this.wallbox.setChargingCurrentA(targetCurrentA));
    } else {
      const currentChargingPowerW = wallbox.activePowerW;
      const gridPowerW = grid.online ? grid.gridPowerW : 0;
      let targetPowerW = currentChargingPowerW - gridPowerW;

      await this.applyPhaseDecision(now, targetPowerW);

      const minP = this.minPowerW(this.activePhases);
      const maxP = this.maxPowerW(this.activePhases);

      if (this.settings.mode === "min_plus_pv") {
        targetPowerW = Math.max(targetPowerW, minP);
      }

      if (targetPowerW < minP) {
        if (this.wantPauseSince === null) this.wantPauseSince = now;
        const stableFor = (now - this.wantPauseSince) / 1000;
        if (stableFor >= this.settings.decisionStabilitySec) {
          targetCurrentA = 0;
          note = `Zu wenig PV-Überschuss (< ${Math.round(minP)} W) - Ladung pausiert.`;
        } else {
          targetCurrentA = Math.max(
            minA,
            Math.round(currentChargingPowerW / (this.settings.gridVoltage * this.activePhases))
          );
          note = `Überschuss knapp, warte ${Math.round(
            this.settings.decisionStabilitySec - stableFor
          )}s vor Pause.`;
        }
      } else {
        this.wantPauseSince = null;
        const clamped = Math.min(targetPowerW, maxP);
        targetCurrentA = Math.max(minA, Math.round(clamped / (this.settings.gridVoltage * this.activePhases)));
        note = `Überschussladen aktiv, ${this.activePhases}-phasig.`;
      }

      await this.safeCall(() => this.wallbox.setEnabled(true));
      await this.safeCall(() => this.wallbox.setChargingCurrentA(targetCurrentA));
    }

    const vehicle =
      this.settings.activeVehicleId !== null ? this.vehiclesDb.get(this.settings.activeVehicleId) : null;

    const snapshot: SystemSnapshot = {
      timestamp: now,
      wallbox,
      grid,
      pvSources,
      pvTotalW,
      mode: this.settings.mode,
      activePhases: this.activePhases,
      targetCurrentA,
      controllerNote: note,
      activeVehicle: vehicle ? { id: vehicle.id, name: vehicle.name, minCurrentA: vehicle.minCurrentA } : null,
    };
    this.lastSnapshot = snapshot;
    this.db.insertSnapshot(snapshot);
    for (const cb of this.listeners) cb(snapshot);
  }

  private async applyPhaseDecision(now: number, targetPowerW: number): Promise<void> {
    if (this.settings.phasesMode !== "auto") return;

    const cooldownOk = (now - this.lastPhaseSwitch) / 1000 >= this.settings.phaseSwitchCooldownSec;
    const max1P = this.maxPowerW(1);
    const min3P = this.minPowerW(3);

    if (this.activePhases === 1 && targetPowerW > max1P) {
      if (this.wantMorePhasesSince === null) this.wantMorePhasesSince = now;
      const stableFor = (now - this.wantMorePhasesSince) / 1000;
      if (stableFor >= this.settings.decisionStabilitySec && cooldownOk) {
        await this.safeCall(() => this.wallbox.setPhases(3));
        this.activePhases = 3;
        this.lastPhaseSwitch = now;
        this.wantMorePhasesSince = null;
        logger.info("Automatische Umschaltung: 1-phasig -> 3-phasig");
      }
    } else {
      this.wantMorePhasesSince = null;
    }

    if (this.activePhases === 3 && targetPowerW < min3P) {
      if (this.wantFewerPhasesSince === null) this.wantFewerPhasesSince = now;
      const stableFor = (now - this.wantFewerPhasesSince) / 1000;
      if (stableFor >= this.settings.decisionStabilitySec && cooldownOk) {
        await this.safeCall(() => this.wallbox.setPhases(1));
        this.activePhases = 1;
        this.lastPhaseSwitch = now;
        this.wantFewerPhasesSince = null;
        logger.info("Automatische Umschaltung: 3-phasig -> 1-phasig");
      }
    } else {
      this.wantFewerPhasesSince = null;
    }
  }

  private async safeCall(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.warn("Wallbox-Schreibbefehl fehlgeschlagen:", (err as Error).message);
    }
  }
}
