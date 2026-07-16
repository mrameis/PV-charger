import dgram from "dgram";
import { logger } from "../logger";
import { WallboxStatus } from "../types";
import { WallboxClient } from "./types";

const KEBA_UDP_PORT = 7090;
const UDP_PAUSE_MS = 150; // Doku fordert min. 100ms zwischen Befehlen - mit Sicherheitsmarge
const COMMAND_TIMEOUT_MS = 3000;

const STATE_TEXT: Record<number, string> = {
  0: "Starting",
  1: "Nicht bereit",
  2: "Bereit",
  3: "Lädt",
  4: "Fehler",
  5: "Unterbrochen",
};

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Keba KeContact P30 - Steuerung über die UDP-Schnittstelle (Port 7090), gemäß
 * offiziellem "KeContact P30 Charging Station UDP Programmers Guide V2.04".
 * Ersetzt die vorherige Modbus-TCP-Anbindung: die Register zur Phasenumschaltung/
 * -status hatten sich als unzuverlässig interpretierbar herausgestellt (mehrere
 * Firmware-abhängige Fehlversuche), während die UDP-Befehle im offiziellen Handbuch
 * mit konkreten Beispielen und erwarteten Antworten eindeutig dokumentiert sind.
 *
 * WICHTIG:
 *  - DIP-Schalter DSW1.3 muss weiterhin auf ON stehen (identisch zur Modbus-Variante).
 *  - Die Wallbox schickt Antworten/spontane Status-Updates an die Adresse+Port des
 *    zuletzt sendenden Clients - es wird daher ein dauerhaft gebundener lokaler
 *    UDP-Socket verwendet (kein klassisches Request/Response wie bei HTTP).
 *  - UDP hat keine Fehlerkorrektur; einzelne Pakete können verloren gehen. Es wird
 *    mit Timeout gewartet, aber nicht automatisch wiederholt (die App versucht es
 *    beim nächsten Regel-Tick erneut).
 *  - Phasenstatus wird NICHT aus einem Status-Register gelesen (das war die
 *    Fehlerquelle der vorherigen Version), sondern direkt aus dem gemessenen Strom
 *    auf L2/L3 abgeleitet (report 3, Felder I2/I3): fließt dort nennenswerter Strom,
 *    wird tatsächlich 3-phasig geladen - das kann nicht durch ein missverständliches
 *    Register verfälscht werden.
 *  - x2src wird auf 4 (UDP) gesetzt, nicht 3 (Modbus TCP) - wir steuern jetzt über
 *    UDP, nicht mehr über Modbus.
 *  - Zum Stoppen/Setzen des Ladestroms wird "currtime" verwendet (für den regulären
 *    Gebrauch vorgesehen, nicht-permanent), nicht "ena" oder "curr" (laut Doku aus-
 *    drücklich nur für seltene/permanente Änderungen gedacht).
 */
export class KebaWallbox implements WallboxClient {
  private socket: dgram.Socket | null = null;
  private socketReady: Promise<void> | null = null;
  private pendingReports = new Map<string, PendingRequest>();
  private pendingAck: PendingRequest | null = null;
  private lastCommandAt = 0;

  constructor(private host: string) {}

  private async ensureSocket(): Promise<void> {
    if (this.socket) return;
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg) => this.handleMessage(msg));
    socket.on("error", (err) => logger.warn("Keba UDP: Socket-Fehler:", err.message));
    this.socketReady = new Promise((resolve) => {
      socket.bind(0, () => resolve());
    });
    await this.socketReady;
  }

  private handleMessage(msg: Buffer): void {
    const text = msg.toString("utf-8").trim();
    const jsonStart = text.indexOf("{");

    if (jsonStart >= 0) {
      let json: any = null;
      try {
        json = JSON.parse(text.slice(jsonStart));
      } catch {
        return;
      }
      if (json?.ID !== undefined) {
        const key = String(json.ID);
        const pending = this.pendingReports.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingReports.delete(key);
          pending.resolve(json);
        }
      }
      // JSON-Pakete ohne "ID" sind spontane Status-Push-Meldungen (z.B. {"Plug": 1})
      // - werden bewusst ignoriert, der Regelkreis pollt ohnehin periodisch.
      return;
    }

    if (this.pendingAck) {
      clearTimeout(this.pendingAck.timer);
      const p = this.pendingAck;
      this.pendingAck = null;
      if (text.toUpperCase().includes("OK")) p.resolve(text);
      else p.reject(new Error(`Wallbox antwortete mit Fehler: ${text}`));
    }
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastCommandAt;
    if (elapsed < UDP_PAUSE_MS) {
      await new Promise((r) => setTimeout(r, UDP_PAUSE_MS - elapsed));
    }
    this.lastCommandAt = Date.now();
  }

  private async sendRaw(command: string): Promise<void> {
    await this.ensureSocket();
    await this.pace();
    await new Promise<void>((resolve, reject) => {
      this.socket!.send(command, KEBA_UDP_PORT, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Sendet einen Steuerbefehl und wartet auf die Text-Bestätigung ("TCH-OK :done"). */
  private async sendCommand(command: string): Promise<void> {
    await this.sendRaw(command);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error(`Keine Antwort auf "${command}" (Timeout)`));
      }, COMMAND_TIMEOUT_MS);
      this.pendingAck = { resolve: () => resolve(), reject, timer };
    });
  }

  /** Sendet "report N" und wartet auf das zugehörige JSON mit passender ID. */
  private async requestReport(id: string): Promise<any> {
    await this.sendRaw(`report ${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReports.delete(id);
        reject(new Error(`Keine Antwort auf "report ${id}" (Timeout)`));
      }, COMMAND_TIMEOUT_MS);
      this.pendingReports.set(id, { resolve, reject, timer });
    });
  }

  async readStatus(): Promise<WallboxStatus> {
    const r2 = await this.requestReport("2");
    const r3 = await this.requestReport("3");

    const state = Number(r2.State ?? 0);
    const plug = Number(r2.Plug ?? 0);
    const i1 = Number(r3.I1 ?? 0);
    const i2 = Number(r3.I2 ?? 0);
    const i3 = Number(r3.I3 ?? 0);

    // Phasenstatus aus dem tatsächlich gemessenen Strom ableiten (robuster als ein
    // Status-Register): fließt Strom auf L2 oder L3, wird 3-phasig geladen. Ohne
    // Stromfluss (nicht am Laden) ist das nicht bestimmbar -> null.
    const isCharging = state === 3;
    const reportedPhases: 1 | 3 | null = !isCharging ? null : i2 > 300 || i3 > 300 ? 3 : 1;

    return {
      state,
      stateText: STATE_TEXT[state] ?? `Unbekannt (${state})`,
      cablePlugged: plug === 5 || plug === 7,
      errorCode: Number(r2.Error1 ?? 0) || Number(r2.Error2 ?? 0),
      currentsMa: [i1, i2, i3],
      activePowerW: Math.round(Number(r3.P ?? 0) / 1000), // mW -> W
      totalEnergyWh: Math.round(Number(r3["E total"] ?? 0) / 10), // 0.1Wh -> Wh
      voltages: [Number(r3.U1 ?? 0), Number(r3.U2 ?? 0), Number(r3.U3 ?? 0)],
      maxSupportedCurrentA: Math.round(Number(r2["Curr HW"] ?? 0) / 1000),
      reportedPhases,
      reportedPhaseSource: r2["X2 phaseSwitch source"] ?? null,
      online: true,
    };
  }

  async setChargingCurrentA(amps: number): Promise<void> {
    if (amps <= 0) {
      // "currtime 0 1" ist laut Doku der vorgesehene Weg, das Laden temporär (nicht
      // dauerhaft) zu stoppen - im Gegensatz zu "ena 0", das dauerhafte Wirkung hat
      // und laut Handbuch nicht für den regulären Regelbetrieb gedacht ist.
      await this.sendCommand("currtime 0 1");
      return;
    }
    const mA = Math.round(amps * 1000);
    await this.sendCommand(`currtime ${mA} 1`);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.sendCommand("currtime 0 1");
    }
    // Aktivieren geschieht implizit durch den nächsten setChargingCurrentA-Aufruf
    // mit einem Stromwert > 0 (currtime überschreibt den Stopp-Zustand automatisch).
  }

  async setPhases(phases: 1 | 3): Promise<void> {
    // "4" beansprucht UDP als Quelle für den X2-Kontakt (x2src) - wichtig: seit dem
    // Umstieg von Modbus TCP auf UDP muss hier 4 stehen, nicht mehr 3, sonst
    // ignoriert die Wallbox unsere Umschaltbefehle erneut.
    await this.sendCommand("x2src 4");
    await this.sendCommand(`x2 ${phases === 3 ? 1 : 0}`);
    logger.info(`Keba (UDP): Phasenumschaltung ausgelöst -> ${phases}-phasig`);
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
