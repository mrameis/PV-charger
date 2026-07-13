import { logger } from "../logger";
import { ControlSettings, ChargeMode, SystemSnapshot, PvSourceStatus, BatteryStatus } from "../types";
import { HistoryDb } from "../db/history";
import { SettingsDb } from "../db/settingsDb";
import { VehiclesDb } from "../db/vehiclesDb";
import { DevicesDb } from "../db/devicesDb";
import { WallboxClient } from "../wallbox/types";
import { Shelly3EmClient } from "../energy/shelly3em";
import {
  createWallboxClient,
  createGridClient,
  createPvSourceClient,
  createBatteryClient,
  Readable,
} from "./deviceFactory";

const WALLBOX_READY_STATES = new Set([2, 3]); // Keba: 2=Bereit,3=Lädt | go-e: car 2/3/4 werden separat behandelt

export class PvSurplusController {
  private settings: ControlSettings;
  private activePhases: 1 | 3 = 1;
  private lastPhaseSwitch = 0;
  private wantMorePhasesSince: number | null = null;
  private wantFewerPhasesSince: number | null = null;
  private wantPauseSince: number | null = null;
  private lastSnapshot: SystemSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: SystemSnapshot) => void> = [];

  private wallbox: WallboxClient | null = null;
  private grid: Shelly3EmClient | null = null;
  private pvSourceClients: Readable<PvSourceStatus>[] = [];
  private batteryClients: Readable<BatteryStatus>[] = [];

  constructor(private db: HistoryDb, private settingsDb: SettingsDb, private vehiclesDb: VehiclesDb, private devicesDb: DevicesDb) {
    this.settings = this.settingsDb.get();
    if (this.settings.phasesMode === "1") this.activePhases = 1;
    if (this.settings.phasesMode === "3") this.activePhases = 3;
    this.reloadDevices();
  }

  /** Baut alle Geräte-Clients neu aus der aktuellen devices-Tabelle auf. */
  reloadDevices(): void {
    const activeWallbox = this.devicesDb.getActive("wallbox");
    const activeGrid = this.devicesDb.getActive("grid_meter");

    if (this.wallbox) this.wallbox.close().catch(() => undefined);
    this.wallbox = activeWallbox ? createWallboxClient(activeWallbox) : null;
    this.grid = activeGrid ? createGridClient(activeGrid) : null;

    this.pvSourceClients = this.devicesDb
      .list("pv_source")
      .filter((d) => d.enabled)
      .map((d) => {
        try {
          return createPvSourceClient(d);
        } catch (err) {
          logger.warn(`PV-Quelle ${d.name} konnte nicht erstellt werden:`, (err as Error).message);
          return null;
        }
      })
      .filter((c): c is Readable<PvSourceStatus> => !!c);

    this.batteryClients = this.devicesDb
      .list("battery")
      .filter((d) => d.enabled)
      .map((d) => {
        try {
          return createBatteryClient(d);
        } catch (err) {
          logger.warn(`Batteriequelle ${d.name} konnte nicht erstellt werden:`, (err as Error).message);
          return null;
        }
      })
      .filter((c): c is Readable<BatteryStatus> => !!c);

    logger.info(
      `Geräte neu geladen: Wallbox=${activeWallbox?.deviceType ?? "keine"}, Netzzähler=${
        activeGrid?.deviceType ?? "keiner"
      }, PV-Quellen=${this.pvSourceClients.length}, Batterien=${this.batteryClients.length}`
    );
  }

  onUpdate(cb: (s: SystemSnapshot) => void): void {
    this.listeners.push(cb);
  }

  getSnapshot(): SystemSnapshot | null {
    return this.lastSnapshot;
  }

  getSettings(): ControlSettings {
    return this.settings;
  }

  async updateSettings(partial: Partial<ControlSettings>): Promise<ControlSettings> {
    this.settings = this.settingsDb.update(partial);
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

    const wallbox = this.wallbox
      ? await this.wallbox.readStatus().catch((e) => {
          logger.warn("Wallbox: Lesefehler:", (e as Error).message);
          return null;
        })
      : null;
    const grid = this.grid
      ? await this.grid.read()
      : { gridPowerW: 0, perPhaseW: null, online: false };

    const pvSources = await Promise.all(
      this.pvSourceClients.map((c) =>
        c.read().catch((e) => {
          logger.warn("PV-Quelle: Lesefehler:", (e as Error).message);
          return { name: "?", powerW: null, online: false } as PvSourceStatus;
        })
      )
    );
    const batteries = await Promise.all(
      this.batteryClients.map((c) =>
        c.read().catch((e) => {
          logger.warn("Batteriequelle: Lesefehler:", (e as Error).message);
          return { name: "?", socPercent: null, powerW: null, online: false } as BatteryStatus;
        })
      )
    );

    const pvTotalW = pvSources.some((s) => s.powerW !== null)
      ? pvSources.reduce((sum, s) => sum + (s.powerW ?? 0), 0)
      : null;

    const { minA, maxA } = this.effectiveLimits();
    let note = "";
    let targetCurrentA = 0;

    if (!this.wallbox) {
      note = "Keine Ladestation konfiguriert (siehe Einstellungen -> Ladestation).";
    } else if (!wallbox) {
      note = "Wallbox nicht erreichbar - keine Regelung möglich.";
    } else if (this.settings.mode === "off") {
      note = "Modus 'Aus': Wallbox gesperrt.";
      await this.safeCall(() => this.wallbox!.setEnabled(false));
    } else if (!wallbox.cablePlugged) {
      note = "Kein Fahrzeug angesteckt.";
      await this.safeCall(() => this.wallbox!.setEnabled(true));
      await this.safeCall(() => this.wallbox!.setChargingCurrentA(0));
    } else if (!WALLBOX_READY_STATES.has(wallbox.state) && wallbox.errorCode !== 0) {
      note = `Wallbox-Status "${wallbox.stateText}" - keine Regelung möglich.`;
    } else if (this.settings.mode === "fast") {
      targetCurrentA = maxA;
      note = "Modus 'Schnell': volle Ladeleistung.";
      await this.applyPhaseDecision(now, this.maxPowerW(3) + 1);
      await this.safeCall(() => this.wallbox!.setEnabled(true));
      await this.safeCall(() => this.wallbox!.setChargingCurrentA(targetCurrentA));
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

      await this.safeCall(() => this.wallbox!.setEnabled(true));
      await this.safeCall(() => this.wallbox!.setChargingCurrentA(targetCurrentA));
    }

    const vehicle =
      this.settings.activeVehicleId !== null ? this.vehiclesDb.get(this.settings.activeVehicleId) : null;

    const snapshot: SystemSnapshot = {
      timestamp: now,
      wallbox,
      grid,
      pvSources,
      pvTotalW,
      batteries,
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
    if (this.settings.phasesMode !== "auto" || !this.wallbox) return;

    const cooldownOk = (now - this.lastPhaseSwitch) / 1000 >= this.settings.phaseSwitchCooldownSec;
    const max1P = this.maxPowerW(1);
    const min3P = this.minPowerW(3);

    if (this.activePhases === 1 && targetPowerW > max1P) {
      if (this.wantMorePhasesSince === null) this.wantMorePhasesSince = now;
      const stableFor = (now - this.wantMorePhasesSince) / 1000;
      if (stableFor >= this.settings.decisionStabilitySec && cooldownOk) {
        await this.safeCall(() => this.wallbox!.setPhases(3));
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
        await this.safeCall(() => this.wallbox!.setPhases(1));
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
