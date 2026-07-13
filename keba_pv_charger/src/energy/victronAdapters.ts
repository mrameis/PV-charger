import { VictronClient } from "./victron";
import { PvSourceStatus, BatteryStatus } from "../types";

/** Victron-Gerät im Einsatz als PV-Quelle (AC-gekoppelte PV-Leistung). */
export class VictronPvSource {
  private client: VictronClient;
  constructor(host: string, port: number, unitId: number, private label: string) {
    this.client = new VictronClient(host, port, unitId);
  }
  async read(): Promise<PvSourceStatus> {
    const r = await this.client.read();
    return { name: this.label, powerW: r.powerW, online: r.online };
  }
}

/** Victron-Gerät im Einsatz als Batterie (Ladezustand + Lade-/Entladeleistung). */
export class VictronBatterySource {
  private client: VictronClient;
  constructor(host: string, port: number, unitId: number, private label: string) {
    this.client = new VictronClient(host, port, unitId);
  }
  async read(): Promise<BatteryStatus> {
    const r = await this.client.read();
    const soc = r.extra?.batterySocPercent;
    const power = r.extra?.batteryPowerW;
    return {
      name: this.label,
      socPercent: typeof soc === "number" ? soc : null,
      powerW: typeof power === "number" ? power : null,
      online: r.online,
    };
  }
}
