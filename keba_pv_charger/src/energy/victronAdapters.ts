import { VictronClient } from "./victron";
import { PvSourceStatus, BatteryStatus } from "../types";

/** Victron-Gerät im Einsatz als PV-Quelle: Summe aus DC-gekoppeltem MPPT-Laderegler + AC-gekoppelten PV-WR. */
export class VictronPvSource {
  private client: VictronClient;
  constructor(host: string, port: number, unitId: number, private label: string) {
    this.client = new VictronClient(host, port, unitId);
  }
  async read(): Promise<PvSourceStatus> {
    const r = await this.client.read();
    if (!r.online) return { name: this.label, powerW: null, online: false };
    const total = (r.pvDcCoupledW ?? 0) + (r.pvAcCoupledW ?? 0);
    return {
      name: this.label,
      powerW: total,
      online: true,
      extra: { dcGekoppeltW: r.pvDcCoupledW, acGekoppeltW: r.pvAcCoupledW },
    };
  }
}

/**
 * Victron-Gerät im Einsatz als Batterie: Ladezustand, Lade-/Entladeleistung UND die
 * aktuelle Solar-Ladeleistung des angeschlossenen MPPT-Ladereglers (DC-gekoppelt).
 * Damit ist die Solarladung direkt in der Batterie-Kategorie sichtbar, ohne dass
 * dasselbe Victron-Gerät zusätzlich unter "Solar-Wechselrichter" angelegt werden muss.
 */
export class VictronBatterySource {
  private client: VictronClient;
  constructor(host: string, port: number, unitId: number, private label: string) {
    this.client = new VictronClient(host, port, unitId);
  }
  async read(): Promise<BatteryStatus> {
    const r = await this.client.read();
    return {
      name: this.label,
      socPercent: r.batterySocPercent,
      powerW: r.batteryPowerW,
      online: r.online,
      solarPowerW: r.pvDcCoupledW,
    };
  }
}
