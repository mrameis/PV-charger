import ModbusRTU from "modbus-serial";
import { logger } from "../logger";
import { PvSourceStatus } from "../types";

/**
 * Victron GX-Gerät (Cerbo GX / Venus GX) via Modbus TCP, Unit-ID 100 (com.victronenergy.system).
 *
 * ACHTUNG - Register nur mit mittlerer Sicherheit übernommen (Victron pflegt eine offizielle
 * "CCGX Modbus-TCP register list" als Excel-Datei, exakte Adressen können je nach
 * Firmware-Version leicht abweichen). Bitte nach Inbetriebnahme mit der Victron-App/VRM
 * gegenchecken und ggf. in der .env über VICTRON_REG_* anpassen.
 *   - Batterie-Ladezustand (SOC, %):      Register 843 (uint16, Skalierung x1)
 *   - Batterieleistung (W, + = Laden):    Register 842 (int16, Skalierung x1)
 *   - PV-Leistung AC-gekoppelt (W):       Register 850 (uint16, Skalierung x1)
 */
export class VictronClient {
  private client = new ModbusRTU();
  private connected = false;

  constructor(
    private host: string,
    private port: number,
    private unitId: number,
    private regSoc = 843,
    private regBatteryPower = 842,
    private regPvAcCoupled = 850
  ) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
  }

  async read(): Promise<PvSourceStatus> {
    try {
      await this.connect();
      const soc = await this.client.readHoldingRegisters(this.regSoc, 1);
      const batPower = await this.client.readHoldingRegisters(this.regBatteryPower, 1);
      const pvAc = await this.client.readHoldingRegisters(this.regPvAcCoupled, 1);

      const toSigned16 = (v: number) => (v > 32767 ? v - 65536 : v);

      return {
        name: "Victron",
        powerW: pvAc.data[0] ?? null,
        online: true,
        extra: {
          batterySocPercent: soc.data[0] ?? null,
          batteryPowerW: toSigned16(batPower.data[0] ?? 0),
        },
      };
    } catch (err) {
      this.connected = false;
      logger.warn(`Victron: Lesefehler (${this.host}):`, (err as Error).message);
      return { name: "Victron", powerW: null, online: false };
    }
  }
}
