import { Shelly3EmClient } from "./shelly3em";
import { PvSourceStatus } from "../types";

/**
 * Nutzt einen Shelly (3EM oder Pro 3EM) zur reinen Erzeugungsmessung eines einzelnen
 * Wechselrichters (z. B. an dessen AC-Ausgang montiert), statt als Netz-Bezugszähler.
 * Anders als beim Netzzähler-Einsatz wird hier der Betrag genutzt (keine Vorzeichen-
 * Interpretation als Bezug/Einspeisung).
 */
export class ShellyPvSource {
  private client: Shelly3EmClient;

  constructor(private host: string, generation: "gen1" | "gen2", private label: string) {
    this.client = new Shelly3EmClient(host, generation, false);
  }

  async read(): Promise<PvSourceStatus> {
    const g = await this.client.read();
    if (!g.online) return { name: this.label, powerW: null, online: false };
    return { name: this.label, powerW: Math.round(Math.abs(g.gridPowerW)), online: true };
  }
}
