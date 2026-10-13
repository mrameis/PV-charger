import fetch from "node-fetch";
import { logger } from "../logger";
import { GridStatus } from "../types";

/**
 * Netzzähler über eine lokale Volkszähler/AMIS-REST-Schnittstelle (z.B. vzlogger,
 * Smartmeter-Auslesegerät o.ä.), die ein flaches JSON-Objekt liefert, z.B.:
 *   { "saldo": -230.5, "1.8.0": 12345.6, ... }
 *
 * "saldo" (W) ist die aktuelle Netz-Saldoleistung: positiv = Bezug, negativ =
 * Einspeisung/Überschuss - entspricht bereits der GridStatus-Konvention. Keine
 * Phasenaufschlüsselung verfügbar (perPhaseW bleibt null).
 */
const DEFAULT_PATH = "/rest";

export class VolkszaehlerGridClient {
  constructor(private host: string, private path: string, private invert: boolean) {}

  async read(): Promise<GridStatus> {
    try {
      const res = await fetch(`http://${this.host}${this.path || DEFAULT_PATH}`, {
        timeout: 3000,
      } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const raw = Number(data.saldo);
      if (!Number.isFinite(raw)) throw new Error('Feld "saldo" fehlt oder ist keine Zahl');
      const gridPowerW = this.invert ? -raw : raw;
      return { gridPowerW, perPhaseW: null, online: true };
    } catch (err) {
      logger.warn(`Volkszähler: Lesefehler (${this.host}):`, (err as Error).message);
      return { gridPowerW: 0, perPhaseW: null, online: false };
    }
  }
}
