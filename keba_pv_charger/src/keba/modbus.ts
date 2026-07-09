import ModbusRTU from "modbus-serial";
import { logger } from "../logger";
import { KebaStatus } from "../types";

/**
 * Registerbelegung gemäß "KeContact P30 Charging Station Modbus TCP Programmers Guide"
 * (offizielles KEBA-Dokument, mehrfach quellenübereinstimmend geprüft für P30c/P30x).
 *
 * WICHTIG ZUR VERIFIZIERUNG:
 *  - Unit-ID MUSS 255 sein, Port 502.
 *  - An der Wallbox muss DIP-Schalter DSW1.3 auf ON stehen (aktiviert Modbus TCP).
 *    Modbus TCP und die UDP-Schnittstelle können NICHT gleichzeitig verwendet werden!
 *  - Alle "Read"-Werte sind 32-Bit Big-Endian, über 2 aufeinanderfolgende Register verteilt.
 *    Laut KEBA-Doku darf man maximal 2 Register (=1 Wert) pro Leseanfrage abfragen.
 *  - Die "Write"-Register (5xxx) sind einzelne 16-Bit Register (Function Code 6).
 *  - Bei manchen Firmware-Ständen wurde ein Faktor-10-Fehler bei der Gesamtenergie (1036)
 *    berichtet. Bitte nach Erstinbetriebnahme mit dem Display der Wallbox gegenchecken
 *    (siehe README, Abschnitt "Verifizierung").
 *  - Die Register für die automatische Phasenumschaltung (5050/5052, 1550/1552) sind laut
 *    mehreren Nutzerberichten je nach Firmware nicht immer zuverlässig. Bitte vor dem
 *    produktiven Einsatz unbedingt mit dem "phaseSwitch"-Testendpunkt prüfen (siehe README).
 */

const REG = {
  state: 1000,
  cableState: 1004,
  errorCode: 1006,
  currentL1: 1008,
  currentL2: 1010,
  currentL3: 1012,
  serial: 1014,
  productType: 1016,
  activePower: 1020,
  totalEnergy: 1036,
  voltageL1: 1040,
  voltageL2: 1042,
  voltageL3: 1044,
  powerFactor: 1046,
  maxChargingCurrent: 1100,
  maxSupportedCurrent: 1110,
  phaseSwitchSource: 1550,
  phaseSwitchState: 1552,
} as const;

const WRITE_REG = {
  setChargingCurrent: 5004, // mA, 0 = kein Strom freigegeben (Pause), sonst 6000-63000
  setEnergyLimit: 5010, // Wh, 0 = kein Limit
  unlockPlug: 5012,
  enableDisable: 5014, // 0 = disable, 1 = enable
  phaseSwitchToggle: 5050, // Zielzustand vor Trigger: 0 = 1-phasig, 1 = 3-phasig
  phaseSwitchTrigger: 5052, // 1 schreiben um Umschaltung auszulösen
} as const;

const STATE_TEXT: Record<number, string> = {
  0: "Starting",
  1: "Not ready for charging",
  2: "Ready for charging",
  3: "Charging",
  4: "Error",
  5: "Interrupted",
};

export class KebaModbusClient {
  private client: ModbusRTU;
  private connected = false;

  constructor(
    private host: string,
    private port: number,
    private unitId: number
  ) {
    this.client = new ModbusRTU();
  }

  async connect(): Promise<void> {
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
    return (hi << 16) >>> 0 | lo;
  }

  /** Liest den vollständigen Status der Wallbox aus. Wirft bei Verbindungsfehlern. */
  async readStatus(): Promise<KebaStatus> {
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
      cableState,
      cablePlugged: cableState >= 3,
      errorCode,
      currentsMa: [i1, i2, i3],
      // activePower ist laut Doku in mW angegeben -> in W umrechnen.
      // Bitte nach Erstinbetriebnahme mit Wallbox-Display abgleichen (siehe README).
      activePowerW: Math.round(activePower / 1000),
      totalEnergyWh: totalEnergy,
      voltages: [v1, v2, v3],
      maxSupportedCurrentA: Math.round(maxSupported / 1000),
      online: true,
    };
  }

  /** Setzt den Ladestrom in Ampere (0 = Pause, sonst 6-32A je nach Wallbox-Ausbaustufe). */
  async setChargingCurrentA(amps: number): Promise<void> {
    await this.connect();
    const mA = amps <= 0 ? 0 : Math.round(amps * 1000);
    await this.client.writeRegister(WRITE_REG.setChargingCurrent, mA);
    logger.debug(`Keba: Ladestrom gesetzt auf ${amps} A (${mA} mA)`);
  }

  /** Gibt die Ladestation frei (enable) oder sperrt sie komplett (disable). */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.connect();
    await this.client.writeRegister(WRITE_REG.enableDisable, enabled ? 1 : 0);
    logger.debug(`Keba: enable=${enabled}`);
  }

  /**
   * Löst eine Phasenumschaltung aus. ACHTUNG: erfordert aktivierte automatische
   * Phasenumschaltung (S10-Zubehör bzw. entsprechende Wallbox-Konfiguration) UND
   * DSW1.2=OFF / DSW1.3=ON an der Wallbox. Bitte vor Produktivbetrieb einmalig manuell
   * über den Test-Endpunkt /api/keba/phase-switch-test verifizieren.
   */
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
