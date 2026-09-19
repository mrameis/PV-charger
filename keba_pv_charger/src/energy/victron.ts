import ModbusRTU from "modbus-serial";
import { logger } from "../logger";

/**
 * Victron GX-Gerät (Cerbo GX / Venus GX) via Modbus TCP, Unit-ID 100 (com.victronenergy.system).
 *
 * Register verifiziert anhand mehrerer unabhängiger, übereinstimmender Quellen
 * (offizielle Victron "CCGX Modbus-TCP register list", Victron-Community-Threads,
 * mehrere unabhängige Home-Assistant-Modbus-Configs):
 *   - Batterie-Spannung (V):                     Register 840, uint16, Skalierung x0.1
 *   - Batterie-Strom (A, + = Laden):              Register 841, int16,  Skalierung x0.1
 *   - Batterie-Leistung (W, + = Laden):           Register 842, int16,  Skalierung x1
 *   - Batterie-Ladezustand SOC (%):                Register 843, uint16, Skalierung x1
 *   - PV-Leistung DC-gekoppelt/MPPT-Laderegler (W): Register 850, uint16, Skalierung x1
 *     (das ist der Wert für einen direkt am GX-Gerät angeschlossenen Solar-MPPT-Laderegler)
 *   - PV-Leistung AC-gekoppelt, Summe L1-L3 (W):   Register 808+809+810, je uint16, x1
 *     (für AC-seitig eingespeiste PV-Wechselrichter, z.B. am Ausgang eines Multiplus)
 *
 * Vorherige Version dieser Datei hatte Register 850 fälschlich als "AC-gekoppelt"
 * beschriftet - es ist tatsächlich der DC-gekoppelte (MPPT-)Wert. Der gelesene Wert
 * war dadurch inhaltlich bereits korrekt, nur die Beschriftung war falsch.
 */
export interface VictronReading {
  online: boolean;
  batterySocPercent: number | null;
  batteryPowerW: number | null;
  batteryVoltageV: number | null;
  pvDcCoupledW: number | null;
  pvAcCoupledW: number | null;
}

const REG = {
  batteryVoltage: 840,
  batteryCurrent: 841,
  batteryPower: 842,
  batterySoc: 843,
  pvAcL1: 808,
  pvAcL2: 809,
  pvAcL3: 810,
  pvDcCoupled: 850,
} as const;

function toSigned16(v: number): number {
  return v > 32767 ? v - 65536 : v;
}

export class VictronClient {
  private client = new ModbusRTU();
  private connected = false;

  constructor(private host: string, private port: number, private unitId: number) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
  }

  private async reg(addr: number): Promise<number> {
    const res = await this.client.readHoldingRegisters(addr, 1);
    return res.data[0];
  }

  async read(): Promise<VictronReading> {
    try {
      await this.connect();
      const [voltage, current, power, soc, pvAcL1, pvAcL2, pvAcL3, pvDc] = await Promise.all([
        this.reg(REG.batteryVoltage),
        this.reg(REG.batteryCurrent),
        this.reg(REG.batteryPower),
        this.reg(REG.batterySoc),
        this.reg(REG.pvAcL1),
        this.reg(REG.pvAcL2),
        this.reg(REG.pvAcL3),
        this.reg(REG.pvDcCoupled),
      ]);

      return {
        online: true,
        batterySocPercent: soc,
        batteryPowerW: toSigned16(power),
        batteryVoltageV: Math.round(voltage * 0.1 * 10) / 10,
        pvDcCoupledW: pvDc,
        pvAcCoupledW: pvAcL1 + pvAcL2 + pvAcL3,
      };
    } catch (err) {
      this.connected = false;
      logger.warn(`Victron: Lesefehler (${this.host}):`, (err as Error).message);
      return {
        online: false,
        batterySocPercent: null,
        batteryPowerW: null,
        batteryVoltageV: null,
        pvDcCoupledW: null,
        pvAcCoupledW: null,
      };
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.client.close(() => undefined);
      this.connected = false;
    }
  }
}

const sharedClients = new Map<string, VictronClient>();

function keyOf(host: string, port: number, unitId: number): string {
  return `${host}:${port}:${unitId}`;
}

/**
 * Liefert eine gemeinsam genutzte VictronClient-Instanz für host:port:unitId.
 * WICHTIG: Dasselbe Victron-GX-Gerät wird häufig sowohl als PV-Quelle als auch als
 * Batterie eingetragen (z.B. automatisch durch die Legacy-Migration in config.ts).
 * Ohne dieses Sharing würden dafür zwei unabhängige Modbus-TCP-Verbindungen zum
 * selben Gerät aufgebaut - das kann je nach GX-Firmwarestand zu Verbindungslimits
 * bzw. sporadischen Timeouts führen. Mit Sharing gibt es pro Gerät nur eine Verbindung.
 */
export function getSharedVictronClient(host: string, port: number, unitId: number): VictronClient {
  const key = keyOf(host, port, unitId);
  let client = sharedClients.get(key);
  if (!client) {
    client = new VictronClient(host, port, unitId);
    sharedClients.set(key, client);
  }
  return client;
}

/**
 * Schließt und vergisst alle gemeinsam genutzten Victron-Verbindungen. Muss beim
 * Neuaufbau der Geräte-Clients (reloadDevices) aufgerufen werden, bevor neue
 * PV-/Batterie-Clients erzeugt werden - sonst bleiben beim Bearbeiten eines
 * Victron-Geräts über die UI die alten Modbus-Sockets offen (Leak).
 */
export async function closeAllSharedVictronClients(): Promise<void> {
  for (const client of sharedClients.values()) {
    await client.close().catch(() => undefined);
  }
  sharedClients.clear();
}
