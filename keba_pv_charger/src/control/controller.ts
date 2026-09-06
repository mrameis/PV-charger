import { logger } from "../logger";
import { ControlSettings, ChargeMode, SystemSnapshot, PvSourceStatus, BatteryStatus, WallboxStatus } from "../types";
import { HistoryDb } from "../db/history";
import { SettingsDb } from "../db/settingsDb";
import { VehiclesDb } from "../db/vehiclesDb";
import { DevicesDb } from "../db/devicesDb";
import { EnergyDb } from "../db/energyDb";
import { WallboxClient } from "../wallbox/types";
import { Shelly3EmClient } from "../energy/shelly3em";
import { closeAllSharedVictronClients } from "../energy/victron";
import {
  createWallboxClient,
  createGridClient,
  createPvSourceClient,
  createBatteryClient,
  Readable,
} from "./deviceFactory";

const WALLBOX_READY_STATES = new Set([2, 3]); // Keba: 2=Bereit,3=Lädt | go-e: car 2/3/4 werden separat behandelt

// Phasenumschalt-Sequenzierung: das X2-Schütz darf NIE unter Last schalten (sonst
// Verschweißgefahr -> genau die Ursache dafür, dass eine Umschaltung 3->1 hängen
// bleibt, obwohl 1->3 vorher geklappt hat). Daher erst Strom auf 0 und Ladung
// stoppen, aktiv auf Stromlosigkeit pollen, dann erst schalten, dann Settle-Zeit
// abwarten, bevor wieder Strom angefordert wird.
const PHASE_SWITCH_SAFE_CURRENT_MA = 500; // Schwelle "kein nennenswerter Stromfluss mehr"
const PHASE_SWITCH_STOP_TIMEOUT_SEC = 90; // Abbruch, falls Fahrzeug nicht reagiert
const PHASE_SWITCH_SETTLE_SEC = 5; // Wartezeit nach dem Schalten, bevor Ladung wieder freigegeben wird

type PhaseSwitchState = "idle" | "awaiting_stop" | "settling";

export class PvSurplusController {
  private settings: ControlSettings;
  private activePhases: 1 | 3 = 1;
  private lastPhaseSwitch = 0;
  private wantMorePhasesSince: number | null = null;
  private wantFewerPhasesSince: number | null = null;
  private wantPauseSince: number | null = null;
  private phaseSwitchState: PhaseSwitchState = "idle";
  private phaseSwitchTarget: 1 | 3 | null = null;
  private phaseSwitchStateSince = 0;
  private lastSnapshot: SystemSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: SystemSnapshot) => void> = [];

  private wallbox: WallboxClient | null = null;
  private grid: Shelly3EmClient | null = null;
  private pvSourceClients: Readable<PvSourceStatus>[] = [];
  private batteryClients: Readable<BatteryStatus>[] = [];

  constructor(
    private db: HistoryDb,
    private settingsDb: SettingsDb,
    private vehiclesDb: VehiclesDb,
    private devicesDb: DevicesDb,
    private energyDb: EnergyDb
  ) {
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

    // BUGFIX: vor dem Neuaufbau alte Victron-Modbus-Verbindungen schließen, sonst
    // bleiben bei jedem Geräte-Update über die UI zusätzliche Sockets offen (Leak),
    // bis irgendwann das Verbindungslimit des GX-Geräts erreicht ist.
    closeAllSharedVictronClients().catch(() => undefined);

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

    // Interne Annahme über die aktive Phasenzahl mit der tatsächlichen Meldung der
    // Wallbox synchronisieren (Grundursache für "Umschaltung geht nur 1->3, nicht
    // zurück": ohne diesen Abgleich konnte die interne Annahme von der Realität
    // abweichen, z.B. nach einem Neustart der App, und die Hysterese-Logik hat dann
    // nie erkannt, dass tatsächlich schon 3-phasig geladen wird).
    if (wallbox?.reportedPhases) {
      this.activePhases = wallbox.reportedPhases;
    }

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
      const blocked = await this.applyPhaseDecision(now, this.maxPowerW(3) + 1, wallbox);
      if (blocked) {
        note = this.phaseSwitchNote();
        await this.safeCall(() => this.wallbox!.setEnabled(false));
        await this.safeCall(() => this.wallbox!.setChargingCurrentA(0));
      } else {
        targetCurrentA = maxA;
        note = "Modus 'Schnell': volle Ladeleistung.";
        await this.safeCall(() => this.wallbox!.setEnabled(true));
        await this.safeCall(() => this.wallbox!.setChargingCurrentA(targetCurrentA));
      }
    } else if (this.settings.mode === "manual") {
      const desiredPowerW = this.settings.manualPowerW;
      const blocked = await this.applyPhaseDecision(now, desiredPowerW, wallbox);
      if (blocked) {
        note = this.phaseSwitchNote();
        await this.safeCall(() => this.wallbox!.setEnabled(false));
        await this.safeCall(() => this.wallbox!.setChargingCurrentA(0));
      } else {
        const minP = this.minPowerW(this.activePhases);
        const maxP = this.maxPowerW(this.activePhases);
        const clampedW = Math.min(Math.max(desiredPowerW, minP), maxP);
        targetCurrentA = Math.round(clampedW / (this.settings.gridVoltage * this.activePhases));
        note = `Manueller Modus: Zielleistung ${(desiredPowerW / 1000).toFixed(1)} kW.`;
        await this.safeCall(() => this.wallbox!.setEnabled(true));
        await this.safeCall(() => this.wallbox!.setChargingCurrentA(targetCurrentA));
      }
    } else {
      const currentChargingPowerW = wallbox.activePowerW;
      const gridPowerW = grid.online ? grid.gridPowerW : 0;
      let targetPowerW = currentChargingPowerW - gridPowerW;

      const blocked = await this.applyPhaseDecision(now, targetPowerW, wallbox);

      if (blocked) {
        note = this.phaseSwitchNote();
        await this.safeCall(() => this.wallbox!.setEnabled(false));
        await this.safeCall(() => this.wallbox!.setChargingCurrentA(0));
      } else {
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
    }

    const vehicle =
      this.settings.activeVehicleId !== null ? this.vehiclesDb.get(this.settings.activeVehicleId) : null;

    const chargingPowerW = wallbox?.activePowerW ?? 0;
    const gridPowerWForEnergy = grid.online ? grid.gridPowerW : 0;
    this.energyDb.accumulate(now, chargingPowerW, gridPowerWForEnergy);

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
      energy: this.energyDb.get(),
    };
    this.lastSnapshot = snapshot;
    this.db.insertSnapshot(snapshot);
    for (const cb of this.listeners) cb(snapshot);
  }

  /**
   * Trifft die Phasenumschalt-Entscheidung UND fährt eine ggf. laufende
   * Umschaltsequenz weiter. Rückgabe true = Ladung muss diese Runde blockiert
   * (Strom 0, disabled) bleiben, weil gerade gestoppt/geschaltet/settled wird.
   *
   * Wichtig: wallbox.setPhases() wird ausschließlich dann aufgerufen, wenn die
   * Wallbox nachweislich NICHT lädt und auf keiner Phase mehr nennenswerter
   * Strom fließt. Alles andere schaltet das externe Wechselschütz unter Last -
   * das war die Ursache dafür, dass 3->1 dauerhaft hängen blieb (Kontakte
   * verschweißen unter Last, ein Stecker-Reset ändert daran nichts).
   */
  private async applyPhaseDecision(now: number, targetPowerW: number, wallbox: WallboxStatus): Promise<boolean> {
    if (!this.wallbox) return false;

    // Eine laufende Umschaltsequenz wird IMMER zu Ende gefahren - unabhängig vom
    // aktuellen phasesMode. Sonst könnte ein Moduswechsel mitten in der Sequenz die
    // Wallbox dauerhaft im "gesperrt"-Zustand (ena=0) hängen lassen.
    if (this.phaseSwitchState !== "idle") {
      const elapsed = (now - this.phaseSwitchStateSince) / 1000;

      if (this.phaseSwitchState === "awaiting_stop") {
        const currentsSafe = wallbox.currentsMa.every((mA) => mA < PHASE_SWITCH_SAFE_CURRENT_MA);
        const notCharging = wallbox.state !== 3;

        if (currentsSafe && notCharging) {
          await this.safeCall(() => this.wallbox!.setPhases(this.phaseSwitchTarget!));
          logger.info(
            `Phasenumschaltung: Wallbox stromlos, Relais wird auf ${this.phaseSwitchTarget}-phasig gelegt.`
          );
          this.phaseSwitchState = "settling";
          this.phaseSwitchStateSince = now;
        } else if (elapsed >= PHASE_SWITCH_STOP_TIMEOUT_SEC) {
          logger.warn(
            `Phasenumschaltung abgebrochen: seit ${Math.round(elapsed)}s kein sicherer Umschaltpunkt ` +
              `(Status "${wallbox.stateText}", Ströme ${wallbox.currentsMa.join("/")} mA). ` +
              `Ladung wird beim bisherigen ${this.activePhases}-phasigen Stand fortgesetzt.`
          );
          this.phaseSwitchState = "idle";
          this.phaseSwitchTarget = null;
        }
        return true;
      }

      // "settling": Relais hat geschaltet, kurze Pause bevor wieder Strom fließt,
      // damit der Kontakt sicher durchgeschaltet hat, bevor Last anliegt.
      if (elapsed >= PHASE_SWITCH_SETTLE_SEC) {
        this.activePhases = this.phaseSwitchTarget!;
        this.lastPhaseSwitch = now;
        logger.info(`Phasenumschaltung abgeschlossen: jetzt ${this.activePhases}-phasig.`);
        this.phaseSwitchState = "idle";
        this.phaseSwitchTarget = null;
        return false;
      }
      return true;
    }

    const cooldownOk = (now - this.lastPhaseSwitch) / 1000 >= this.settings.phaseSwitchCooldownSec;

    // Fest eingestellte Phasenzahl (kein Auto-Modus): Hardware ggf. EINMALIG an die
    // gewünschte Zahl angleichen.
    // BUGFIX: Bisher wurde bei phasesMode "1"/"3" nur die interne Buchhaltung
    // (this.activePhases) gesetzt - die Wallbox bekam nie einen setPhases()-Befehl,
    // d.h. der feste Modus hatte in der Praxis keinerlei Wirkung auf die Hardware,
    // solange nicht zufällig der Auto-Modus zuvor schon auf dem gewünschten Stand war.
    if (this.settings.phasesMode !== "auto") {
      const desired = this.settings.phasesMode === "1" ? 1 : 3;
      if (this.activePhases !== desired && cooldownOk) {
        this.beginPhaseSwitch(desired, now);
        return true;
      }
      return false;
    }

    const max1P = this.maxPowerW(1);
    const min3P = this.minPowerW(3);

    if (this.activePhases === 1 && targetPowerW > max1P) {
      if (this.wantMorePhasesSince === null) this.wantMorePhasesSince = now;
      const stableFor = (now - this.wantMorePhasesSince) / 1000;
      if (stableFor >= this.settings.decisionStabilitySec && cooldownOk) {
        this.beginPhaseSwitch(3, now);
        return true;
      }
    } else {
      this.wantMorePhasesSince = null;
    }

    if (this.activePhases === 3 && targetPowerW < min3P) {
      if (this.wantFewerPhasesSince === null) this.wantFewerPhasesSince = now;
      const stableFor = (now - this.wantFewerPhasesSince) / 1000;
      if (stableFor >= this.settings.decisionStabilitySec && cooldownOk) {
        this.beginPhaseSwitch(1, now);
        return true;
      }
    } else {
      this.wantFewerPhasesSince = null;
    }

    return false;
  }

  private beginPhaseSwitch(target: 1 | 3, now: number): void {
    logger.info(
      `Automatische Umschaltung eingeleitet: ${this.activePhases}-phasig -> ${target}-phasig ` +
        `(Ladung wird zuerst gestoppt, dann erst das Relais geschaltet).`
    );
    this.phaseSwitchState = "awaiting_stop";
    this.phaseSwitchTarget = target;
    this.phaseSwitchStateSince = now;
    this.wantMorePhasesSince = null;
    this.wantFewerPhasesSince = null;
  }

  private phaseSwitchNote(): string {
    if (this.phaseSwitchState === "awaiting_stop") {
      return `Phasenumschaltung auf ${this.phaseSwitchTarget}-phasig: warte, bis Wallbox stromlos ist.`;
    }
    return `Phasenumschaltung auf ${this.phaseSwitchTarget}-phasig: Relais geschaltet, Settle-Zeit läuft.`;
  }

  private async safeCall(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.warn("Wallbox-Schreibbefehl fehlgeschlagen:", (err as Error).message);
    }
  }
}
