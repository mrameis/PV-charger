import { KebaModbusClient } from "../keba/modbus";
import { Shelly3EmClient } from "../energy/shelly3em";
import { FroniusClient } from "../energy/fronius";
import { StecaClient } from "../energy/steca";
import { VictronClient } from "../energy/victron";
import { config } from "../config";
import { logger } from "../logger";
import { ChargeMode, SystemSnapshot, PvSourceStatus } from "../types";
import { HistoryDb } from "../db/history";

const KEBA_READY = 2;
const KEBA_CHARGING = 3;

export class PvSurplusController {
  private mode: ChargeMode = "min_plus_pv";
  private activePhases: 1 | 3 = 1;
  private lastPhaseSwitch = 0;
  private wantMorePhasesSince: number | null = null;
  private wantFewerPhasesSince: number | null = null;
  private wantPauseSince: number | null = null;
  private lastSnapshot: SystemSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: SystemSnapshot) => void> = [];

  private keba = new KebaModbusClient(config.keba.host, config.keba.port, config.keba.unitId);
  private shelly = new Shelly3EmClient(
    config.shelly3em.host,
    config.shelly3em.generation,
    config.shelly3em.invert
  );
  private fronius = config.fronius.enabled ? new FroniusClient(config.fronius.host) : null;
  private steca = config.steca.enabled
    ? new StecaClient(config.steca.host, config.steca.xmlPath || undefined)
    : null;
  private victron = config.victron.enabled
    ? new VictronClient(config.victron.host, config.victron.port, config.victron.unitId)
    : null;

  constructor(private db: HistoryDb) {
    if (config.control.phasesMode === "1") this.activePhases = 1;
    if (config.control.phasesMode === "3") this.activePhases = 3;
  }

  onUpdate(cb: (s: SystemSnapshot) => void): void {
    this.listeners.push(cb);
  }

  getSnapshot(): SystemSnapshot | null {
    return this.lastSnapshot;
  }

  setMode(mode: ChargeMode): void {
    logger.info(`Modus geändert: ${this.mode} -> ${mode}`);
    this.mode = mode;
  }

  getMode(): ChargeMode {
    return this.mode;
  }

  start(): void {
    this.tick().catch((e) => logger.error("Fehler im ersten Regel-Tick:", e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error("Fehler im Regel-Tick:", e));
    }, config.control.intervalSec * 1000);
    logger.info(`Regelschleife gestartet (Intervall ${config.control.intervalSec}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private minPowerW(phases: 1 | 3): number {
    return config.control.minCurrentA * phases * config.control.gridVoltage;
  }
  private maxPowerW(phases: 1 | 3): number {
    return config.control.maxCurrentA * phases * config.control.gridVoltage;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const [keba, grid, froniusS, stecaS, victronS] = await Promise.all([
      this.keba.readStatus().catch((e) => {
        logger.warn("Keba: Lesefehler:", (e as Error).message);
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

    let note = "";
    let targetCurrentA = 0;

    if (!keba) {
      note = "Keba nicht erreichbar - keine Regelung möglich.";
    } else if (this.mode === "off") {
      note = "Modus 'Aus': Wallbox gesperrt.";
      await this.safeCall(() => this.keba.setEnabled(false));
    } else if (!keba.cablePlugged) {
      note = "Kein Fahrzeug angesteckt.";
      await this.safeCall(() => this.keba.setEnabled(true));
      await this.safeCall(() => this.keba.setChargingCurrentA(0));
    } else if (keba.state !== KEBA_READY && keba.state !== KEBA_CHARGING) {
      note = `Wallbox-Status "${keba.stateText}" - keine Regelung möglich.`;
    } else if (this.mode === "fast") {
      targetCurrentA = config.control.maxCurrentA;
      note = "Modus 'Schnell': volle Ladeleistung.";
      await this.applyPhaseDecision(now, this.maxPowerW(3) + 1); // drängt Richtung 3-phasig falls auto
      await this.safeCall(() => this.keba.setEnabled(true));
      await this.safeCall(() => this.keba.setChargingCurrentA(targetCurrentA));
    } else {
      // pv_only oder min_plus_pv
      const currentChargingPowerW = keba.activePowerW;
      const gridPowerW = grid.online ? grid.gridPowerW : 0;
      // Klassische Selbstverbrauchsregel: neuer Sollwert = aktuelle Ladeleistung - Netzbezug
      // (Netzbezug negativ = Einspeisung/Überschuss -> Sollwert steigt)
      let targetPowerW = currentChargingPowerW - gridPowerW;

      await this.applyPhaseDecision(now, targetPowerW);

      const minP = this.minPowerW(this.activePhases);
      const maxP = this.maxPowerW(this.activePhases);

      if (this.mode === "min_plus_pv") {
        targetPowerW = Math.max(targetPowerW, minP);
      }

      if (targetPowerW < minP) {
        // Nicht genug Überschuss für den Mindeststrom -> nach Stabilitätsfenster pausieren
        if (this.wantPauseSince === null) this.wantPauseSince = now;
        const stableFor = (now - this.wantPauseSince) / 1000;
        if (stableFor >= config.control.decisionStabilitySec) {
          targetCurrentA = 0;
          note = `Zu wenig PV-Überschuss (< ${Math.round(minP)} W) - Ladung pausiert.`;
        } else {
          // in der Übergangszeit weiter mit aktuellem Wert laden, nicht sofort abbrechen
          targetCurrentA = Math.max(
            config.control.minCurrentA,
            Math.round(currentChargingPowerW / (config.control.gridVoltage * this.activePhases))
          );
          note = `Überschuss knapp, warte ${Math.round(
            config.control.decisionStabilitySec - stableFor
          )}s vor Pause.`;
        }
      } else {
        this.wantPauseSince = null;
        const clamped = Math.min(targetPowerW, maxP);
        targetCurrentA = Math.max(
          config.control.minCurrentA,
          Math.round(clamped / (config.control.gridVoltage * this.activePhases))
        );
        note = `Überschussladen aktiv, ${this.activePhases}-phasig.`;
      }

      await this.safeCall(() => this.keba.setEnabled(true));
      await this.safeCall(() => this.keba.setChargingCurrentA(targetCurrentA));
    }

    const snapshot: SystemSnapshot = {
      timestamp: now,
      keba,
      grid,
      pvSources,
      pvTotalW,
      mode: this.mode,
      activePhases: this.activePhases,
      targetCurrentA,
      controllerNote: note,
    };
    this.lastSnapshot = snapshot;
    this.db.insertSnapshot(snapshot);
    for (const cb of this.listeners) cb(snapshot);
  }

  /** Entscheidet auto-modus Phasenumschaltung mit Hysterese + Cooldown. */
  private async applyPhaseDecision(now: number, targetPowerW: number): Promise<void> {
    if (config.control.phasesMode !== "auto") return;

    const cooldownOk = (now - this.lastPhaseSwitch) / 1000 >= config.control.phaseSwitchCooldownSec;
    const max1P = this.maxPowerW(1);
    const min3P = this.minPowerW(3);

    if (this.activePhases === 1 && targetPowerW > max1P) {
      if (this.wantMorePhasesSince === null) this.wantMorePhasesSince = now;
      const stableFor = (now - this.wantMorePhasesSince) / 1000;
      if (stableFor >= config.control.decisionStabilitySec && cooldownOk) {
        await this.safeCall(() => this.keba.setPhases(3));
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
      if (stableFor >= config.control.decisionStabilitySec && cooldownOk) {
        await this.safeCall(() => this.keba.setPhases(1));
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
      logger.warn("Keba-Schreibbefehl fehlgeschlagen:", (err as Error).message);
    }
  }
}
