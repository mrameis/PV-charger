import fetch from "node-fetch";
import { logger } from "../logger";
import { PvSourceStatus } from "../types";

/**
 * Fronius Solar API (lokal, kein Cloud-Zugriff nötig).
 * GetPowerFlowRealtimeData liefert P_PV (aktuelle Erzeugung in W), sofern vom Modell
 * unterstützt. Fällt darauf ohne PV-Wert zurück, versucht ersatzweise
 * GetInverterRealtimeData (Scope=System, PAC).
 */
export class FroniusClient {
  constructor(private host: string) {}

  async read(): Promise<PvSourceStatus> {
    try {
      const res = await fetch(
        `http://${this.host}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
        { timeout: 3000 } as any
      );
      if (res.ok) {
        const data: any = await res.json();
        const pPv = data?.Body?.Data?.Site?.P_PV;
        if (typeof pPv === "number") {
          return { name: "Fronius", powerW: Math.round(pPv), online: true };
        }
      }
    } catch (err) {
      logger.debug(`Fronius: PowerFlow nicht verfügbar (${this.host}):`, (err as Error).message);
    }

    try {
      const res2 = await fetch(
        `http://${this.host}/solar_api/v1/GetInverterRealtimeData.cgi?Scope=System`,
        { timeout: 3000 } as any
      );
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      const data2: any = await res2.json();
      const pac = data2?.Body?.Data?.PAC?.Values;
      const total = pac ? Object.values(pac).reduce((a: number, b: any) => a + Number(b), 0) : null;
      return { name: "Fronius", powerW: total !== null ? Math.round(total as number) : null, online: total !== null };
    } catch (err) {
      logger.warn(`Fronius: Lesefehler (${this.host}):`, (err as Error).message);
      return { name: "Fronius", powerW: null, online: false };
    }
  }
}
