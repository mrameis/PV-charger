import ModbusRTU from "modbus-serial";
import { logger } from "../logger";
import { WallboxStatus } from "../types";
import { WallboxClient } from "./types";

/**
 * Keba KeContact P30 - Steuerung über Modbus TCP (Port 502, Unit-ID 255).
 *
 * HINWEIS ZUR PROTOKOLLWAHL: Diese App hatte zwischenzeitlich (Version 3.0) auf die
 * UDP-Schnittstelle umgestellt, da die Modbus-Register zur Phasenumschaltung sich als
 * missverständlich herausstellten. Bei einer konkreten Installation antwortete die
 * Wallbox jedoch überhaupt nicht mehr auf UDP (Port 7090) - getestet von vier
 * unabhängigen Quellen (App im Docker-Bridge-Netz, App im Host-Netz, separates
 * SSH-Terminal, unabhängiger Windows-Rechner), obwohl UDP nachweislich früher
 * funktioniert hatte. Da das nicht auf ein Software-Problem dieser App zurückzuführen
 * war, wurde auf Modbus TCP zurückgebaut (das nachweislich zuverlässig erreichbar
 * ist), unter Beibehaltung der verbesserten, register-unabhängigen Phasenerkennung
 * (siehe unten). Falls sich das UDP-Rätsel mit KEBA-Support klärt, kann bei Bedarf
 * wieder auf UDP wechseln - der Code dafür liegt in der Git-Historie.
 *
 * Registerbelegung gemäß "KeContact P30 Charging Station Modbus TCP Programmers
 * Guide", zusätzlich abgeglichen mit dem "UDP Programmers Guide V2.04", da beide
 * Schnittstellen dieselbe zugrundeliegende Funktionalität mit paralleler Semantik
 * abbilden:
 *  - Register 5050 (Schreiben) / 1550 (Lesen): Quelle für den X2-Phasenumschalt-
 *    Kontakt. 0=aus,1=OCPP,2=REST Direct,3=Modbus TCP,4=UDP. Ohne 5050=3 ignoriert
 *    die Wallbox Umschaltbefehle über Modbus - wird vor jedem Trigger neu gesetzt.
 *  - Register 5052 (Schreiben): 0=1-phasig, 1=3-phasig (Ziel + Auslöser in einem).
 *  - Laut Handbuch ist zwischen zwei Umschaltungen ein Cooldown von 5 Minuten
 *    vorgeschrieben (deckt sich mit unserem Standard-Cooldown von 300s).
 *
 * PHASENERKENNUNG: wird NICHT aus einem Status-Register gelesen (das hatte sich in
 * der Praxis als unzuverlässig interpretierbar herausgestellt), sondern direkt aus
 * dem gemessenen Strom auf L2/L3 abgeleitet: fließt dort nennenswerter Strom, lädt
 * die Wallbox tatsächlich 3-phasig - unabhängig von der Interpretation eines
 * Status-Registers.
 *
 * WICHTIG ZUR VERIFIZIERUNG:
 *  - Unit-ID MUSS 255 sein, Port 502.
 *  - DIP-Schalter DSW1.3 muss auf ON stehen. Modbus TCP und UDP-Schnittstelle
 *    können nicht gleichzeitig verwendet werden.
 *  - Manche Modbus-Implementierungen zählen Registeradressen ab 1 statt ab 0 - falls
 *    nötig, in den Ladestation-Einstellungen den "Register-Offset" testen (1 oder -1).
 *  - Alle "Read"-Werte sind 32-Bit Big-Endian, über 2 aufeinanderfolgende Register
 *    verteilt. Die "Write"-Register (5xxx) sind einzelne 16-Bit Register (FC6).
 *  - Bei manchen Firmware-Ständen wurde ein Faktor-10-Fehler bei der Gesamtenergie
 *    (1036) berichtet - nach Erstinbetriebnahme mit dem Wallbox-Display abgleichen.
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
  phaseSwitchSourceRead: 1550, // Rückmeldung, wer aktuell den X2-Kontakt steuern darf
} as const;

const WRITE_REG = {
  setChargingCurrent: 5004,
  enableDisable: 5014,
  phaseSwitchSource: 5050, // 0=aus,1=OCPP,2=REST Direct,3=Modbus TCP,4=UDP
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

  constructor(
    private host: string,
    private port: number,
    private unitId: number,
    private registerOffset = 0
  ) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
    logger.info(
      `Keba: verbunden mit ${this.host}:${this.port} (Unit ${this.unitId}${
        this.registerOffset ? `, Register-Offset ${this.registerOffset}` : ""
      })`
    );
  }

  private async readUint32(addr: number): Promise<number> {
    const res = await this.client.readHoldingRegisters(addr + this.registerOffset, 2);
    const [hi, lo] = res.data;
    return ((hi << 16) >>> 0) | lo;
  }

  private async writeReg(addr: number, value: number): Promise<void> {
    await this.client.writeRegister(addr + this.registerOffset, value);
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

    // Phasenstatus aus dem tatsächlich gemessenen Strom ableiten (robuster als ein
    // Status-Register): fließt Strom auf L2 oder L3, wird 3-phasig geladen. Ohne
    // Stromfluss (nicht am Laden) ist das nicht bestimmbar -> null.
    const isCharging = state === 3;
    const reportedPhases: 1 | 3 | null = !isCharging ? null : i2 > 300 || i3 > 300 ? 3 : 1;

    let reportedPhaseSource: number | null = null;
    try {
      reportedPhaseSource = await this.readUint32(REG.phaseSwitchSourceRead);
    } catch (err) {
      logger.debug("Keba: Phasenumschalt-Quelle nicht lesbar:", (err as Error).message);
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
      reportedPhaseSource,
      online: true,
    };
  }

  async setChargingCurrentA(amps: number): Promise<void> {
    await this.connect();
    const mA = amps <= 0 ? 0 : Math.round(amps * 1000);
    await this.writeReg(WRITE_REG.setChargingCurrent, mA);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.connect();
    await this.writeReg(WRITE_REG.enableDisable, enabled ? 1 : 0);
  }

  async setPhases(phases: 1 | 3): Promise<void> {
    await this.connect();
    // Modbus TCP als Quelle für den X2-Kontakt beanspruchen - entspricht dem
    // UDP-Kommando "x2src 3". Muss vor jedem Trigger gesetzt sein, da die Wallbox
    // sonst Umschaltbefehle über Modbus stillschweigend ignoriert.
    await this.writeReg(WRITE_REG.phaseSwitchSource, 3);
    await this.writeReg(WRITE_REG.phaseSwitchTrigger, phases === 3 ? 1 : 0);
    logger.info(`Keba: Phasenumschaltung ausgelöst -> ${phases}-phasig`);
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.client.close(() => undefined);
      this.connected = false;
    }
  }
}
