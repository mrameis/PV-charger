import fetch from "node-fetch";
import { logger } from "../logger";
import { PvSourceStatus } from "../types";

/**
 * Shelly 1PM / Plus 1PM / Pro 1PM - Einzelkanal-Leistungsmessung mit Schaltausgang,
 * hier genutzt zur reinen Erzeugungsmessung eines einzelnen Wechselrichters.
 *
 * Gen1 (klassisch "1PM"):        GET http://<ip>/status  -> meters[0].power
 * Gen2/Gen3 (Plus/Pro 1PM, RPC): GET http://<ip>/rpc/Switch.GetStatus?id=0 -> apower
 */
export class Shelly1PmSource {
  constructor(private host: string, private generation: "gen1" | "gen2", private label: string) {}

  async read(): Promise<PvSourceStatus> {
    try {
      const power = this.generation === "gen2" ? await this.readGen2() : await this.readGen1();
      return { name: this.label, powerW: Math.round(Math.abs(power)), online: true };
    } catch (err) {
      logger.warn(`Shelly 1PM: Lesefehler (${this.host}):`, (err as Error).message);
      return { name: this.label, powerW: null, online: false };
    }
  }

  private async readGen1(): Promise<number> {
    const res = await fetch(`http://${this.host}/status`, { timeout: 3000 } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const power = data?.meters?.[0]?.power;
    if (typeof power !== "number") throw new Error("Kein 'meters[0].power' im Status gefunden");
    return power;
  }

  private async readGen2(): Promise<number> {
    const res = await fetch(`http://${this.host}/rpc/Switch.GetStatus?id=0`, { timeout: 3000 } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    if (typeof data.apower !== "number") throw new Error("Kein 'apower' im Status gefunden");
    return data.apower;
  }
}
