import ModbusRTU from "modbus-serial";
import { logger } from "../logger";
import { WallboxStatus } from "../types";
import { WallboxClient } from "./types";

/**
 * Registerbelegung gemäß "KeContact P30 Charging Station Modbus TCP Programmers Guide"
 * (offizielles KEBA-Dokument, mehrfach quellenübereinstimmend geprüft für P30c/P30x).
 *
 * WICHTIG ZUR VERIFIZIERUNG:
 *  - Unit-ID MUSS 255 sein, Port 502.
 *  - An der Wallbox muss DIP-Schalter DSW1.3 auf ON stehen (aktiviert Modbus TCP).
 *    Modbus TCP und die UDP-Schnittstelle können NICHT gleichzeitig verwendet werden!
 *  - Alle "Read"-Werte sind 32-Bit Big-Endian, über 2 aufeinanderfolgende Register verteilt.
 *  - Die "Write"-Register (5xxx) sind einzelne 16-Bit Register (Function Code 6).
 *  - Bei manchen Firmware-Ständen wurde ein Faktor-10-Fehler bei der Gesamtenergie (1036)
 *    berichtet. Bitte nach Erstinbetriebnahme mit dem Display der Wallbox gegenchecken.
 *
 *  - PHASENUMSCHALTUNG (Register 5050/5052), per Nutzerbericht korrigiert:
 *    Register 5050 ist NICHT die Zielphase, sondern legt fest, welcher Kanal den
 *    X2-Kontakt (Phasenumschalt-Relais) steuern darf ("Source"):
 *      0 = deaktiviert, 1 = CPM Profiles, 2 = CPM Direct Control, 3 = Modbus TCP, 4 = UDP
 *    Das ist das Modbus-Äquivalent zum UDP-Kommando "x2src". Ohne 5050=3 ignoriert die
 *    Wallbox jeden Umschaltbefehl über Modbus, selbst wenn 5052 korrekt gesetzt wird.
 *    Register 5052 ist Ziel UND Auslöser in einem Schreibvorgang: 0 = 1-phasig, 1 = 3-phasig.
 *    Diese App setzt 5050 vor jeder Umschaltung neu auf 3, damit sie als Quelle aktiv
 *    bleibt (z.B. falls vorher per UDP "x2src 4" o.ä. gesetzt wurde).
 */
const REG = {
  state: 1000,
  cableState: 1004,
  errorCode: 1006,
  currentL1: 1008,
  currentL2: 1010,
  currentL3: 1012,
  activePower: 1020,
  totalEnergy: 1036,
  voltageL1: 1040,
  voltageL2: 1042,
  voltageL3: 1044,
  maxSupportedCurrent: 1110,
  phaseSwitchState: 1552, // tatsächlicher Phasenstatus laut Wallbox (nicht unsere Annahme)
} as const;

const WRITE_REG = {
  setChargingCurrent: 5004,
  enableDisable: 5014,
  phaseSwitchSource: 5050, // 0=aus,1=CPM Profiles,2=CPM Direct,3=Modbus TCP,4=UDP
  phaseSwitchTrigger: 5052, // 0=1-phasig, 1=3-phasig (Ziel + Auslöser in einem)
} as const;

const STATE_TEXT: Record<number, string> = {
  0: "Starting",
  1: "Nicht bereit",
  2: "Bereit",
  3: "Lädt",
  4: "Fehler",
  5: "Unterbrochen",
};

export class KebaWallbox implements WallboxClient {
  private client = new ModbusRTU();
  private connected = false;

  constructor(private host: string, private port: number, private unitId: number) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
    logger.info(`Keba: verbunden mit ${this.host}:${this.port} (Unit ${this.unitId})`);
  }

  private async readUint32(addr: number): Promise<number> {
    const res = await this.client.readHoldingRegisters(addr, 2);
    const [hi, lo] = res.data;
    return ((hi << 16) >>> 0) | lo;
  }

  async readStatus(): Promise<WallboxStatus> {
    await this.connect();

    const state = await this.readUint32(REG.state);
    const cableState = await this.readUint32(REG.cableState);
    const errorCode = await this.readUint32(REG.errorCode);
    const i1 = await this.readUint32(REG.currentL1);
    const i2 = await this.readUint32(REG.currentL2);
    const i3 = await this.readUint32(REG.currentL3);
    const activePower = await this.readUint32(REG.activePower);
    const totalEnergy = await this.readUint32(REG.totalEnergy);
    const v1 = await this.readUint32(REG.voltageL1);
    const v2 = await this.readUint32(REG.voltageL2);
    const v3 = await this.readUint32(REG.voltageL3);
    const maxSupported = await this.readUint32(REG.maxSupportedCurrent);

    let reportedPhases: 1 | 3 | null = null;
    try {
      const rawPhaseState = await this.readUint32(REG.phaseSwitchState);
      // Laut Doku "enthält den Phasenumschalt-Status (1 oder 3 Phasen)" - manche
      // Firmware-Stände könnten stattdessen die 0/1-Schreibkonvention zurückspiegeln
      // (0=1-phasig, 1=3-phasig). Beide Fälle werden abgedeckt, alles andere -> unbekannt.
      if (rawPhaseState === 1) reportedPhases = 1;
      else if (rawPhaseState === 3) reportedPhases = 3;
      else if (rawPhaseState === 0) reportedPhases = 1;
      else logger.debug(`Keba: unerwarteter Phasenstatus-Rohwert ${rawPhaseState} (Register 1552)`);
    } catch (err) {
      logger.debug("Keba: Phasenstatus-Register nicht lesbar:", (err as Error).message);
    }

    return {
      state,
      stateText: STATE_TEXT[state] ?? `Unbekannt (${state})`,
      cablePlugged: cableState >= 3,
      errorCode,
      currentsMa: [i1, i2, i3],
      activePowerW: Math.round(activePower / 1000),
      totalEnergyWh: totalEnergy,
      voltages: [v1, v2, v3],
      maxSupportedCurrentA: Math.round(maxSupported / 1000),
      reportedPhases,
      online: true,
    };
  }

  async setChargingCurrentA(amps: number): Promise<void> {
    await this.connect();
    const mA = amps <= 0 ? 0 : Math.round(amps * 1000);
    await this.client.writeRegister(WRITE_REG.setChargingCurrent, mA);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.connect();
    await this.client.writeRegister(WRITE_REG.enableDisable, enabled ? 1 : 0);
  }

  async setPhases(phases: 1 | 3): Promise<void> {
    await this.connect();
    // Modbus TCP als Quelle für den X2-Kontakt beanspruchen (siehe Kommentar oben) -
    // entspricht dem UDP-Kommando "x2src 3". Muss vor jedem Trigger gesetzt sein,
    // da die Wallbox sonst Umschaltbefehle über Modbus stillschweigend ignoriert.
    await this.client.writeRegister(WRITE_REG.phaseSwitchSource, 3);
    await this.client.writeRegister(WRITE_REG.phaseSwitchTrigger, phases === 3 ? 1 : 0);
    logger.info(`Keba: Phasenumschaltung ausgelöst -> ${phases}-phasig`);
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.client.close(() => undefined);
      this.connected = false;
    }
  }
}
