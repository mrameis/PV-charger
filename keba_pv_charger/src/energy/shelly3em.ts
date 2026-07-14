import fetch from "node-fetch";
import { logger } from "../logger";
import { GridStatus } from "../types";

/**
 * Liest den Netz-Bezugszähler (Shelly 3EM) am Hausanschlusspunkt.
 * Konvention: positive Leistung = Bezug aus dem Netz, negative Leistung = Einspeisung
 * (= aktuell verfügbarer PV-Überschuss). Falls deine CT-Zangen andersherum montiert sind,
 * SHELLY3EM_INVERT=true setzen.
 *
 * Gen1 (klassische Shelly 3EM): GET http://<ip>/status -> emeters[]
 * Gen2 (Shelly Pro 3EM / 3EM-63, RPC-API): GET http://<ip>/rpc/EM.GetStatus?id=0
 */
export class Shelly3EmClient {
  constructor(
    private host: string,
    private generation: "gen1" | "gen2",
    private invert: boolean
  ) {}

  async read(): Promise<GridStatus> {
    try {
      if (this.generation === "gen2") {
        return await this.readGen2();
      }
      return await this.readGen1();
    } catch (err) {
      logger.warn(`Shelly 3EM: Lesefehler (${this.host}):`, (err as Error).message);
      return { gridPowerW: 0, perPhaseW: null, online: false };
    }
  }

  private sign(v: number): number {
    return this.invert ? -v : v;
  }

  private async readGen1(): Promise<GridStatus> {
    const res = await fetch(`http://${this.host}/status`, { timeout: 3000 } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const emeters: any[] = data.emeters ?? [];
    const perPhase = emeters.slice(0, 3).map((e) => this.sign(Number(e.power) || 0)) as [
      number,
      number,
      number
    ];
    const total = perPhase.reduce((a, b) => a + b, 0);
    return { gridPowerW: total, perPhaseW: perPhase, online: true };
  }

  private async readGen2(): Promise<GridStatus> {
    const res = await fetch(`http://${this.host}/rpc/EM.GetStatus?id=0`, {
      timeout: 3000,
    } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const perPhase: [number, number, number] = [
      this.sign(Number(data.a_act_power) || 0),
      this.sign(Number(data.b_act_power) || 0),
      this.sign(Number(data.c_act_power) || 0),
    ];
    const total =
      data.total_act_power !== undefined
        ? this.sign(Number(data.total_act_power))
        : perPhase.reduce((a, b) => a + b, 0);
    return { gridPowerW: total, perPhaseW: perPhase, online: true };
  }
}
