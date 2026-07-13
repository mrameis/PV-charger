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
 *  - Die Register für die automatische Phasenumschaltung (5050/5052) sind laut mehreren
 *    Nutzerberichten je nach Firmware nicht immer zuverlässig - vor Produktivbetrieb testen.
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
} as const;

const WRITE_REG = {
  setChargingCurrent: 5004,
  enableDisable: 5014,
  phaseSwitchToggle: 5050,
  phaseSwitchTrigger: 5052,
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
    await this.client.writeRegister(WRITE_REG.phaseSwitchToggle, phases === 3 ? 1 : 0);
    await this.client.writeRegister(WRITE_REG.phaseSwitchTrigger, 1);
    logger.info(`Keba: Phasenumschaltung ausgelöst -> ${phases}-phasig`);
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.client.close(() => undefined);
      this.connected = false;
    }
  }
}
