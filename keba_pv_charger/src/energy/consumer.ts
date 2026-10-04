import { Shelly3EmClient } from "./shelly3em";
import { Shelly1PmSource } from "./shelly1pm";
import { ConsumerStatus } from "../types";

/**
 * Nutzt einen Shelly 3EM/Pro 3EM zur reinen Verbrauchsmessung eines einzelnen
 * Lastzweigs (z.B. Wärmepumpe), statt als Netz-Bezugszähler. Wie bei der
 * PV-Erzeugungsmessung wird nur der Betrag genutzt (keine Vorzeichen-
 * Interpretation als Bezug/Einspeisung) - ein Verbrauchszweig zieht immer Leistung.
 */
export class ShellyConsumerSource {
  private client: Shelly3EmClient;

  constructor(private host: string, generation: "gen1" | "gen2", private label: string) {
    this.client = new Shelly3EmClient(host, generation, false);
  }

  async read(): Promise<ConsumerStatus> {
    const g = await this.client.read();
    if (!g.online) return { name: this.label, powerW: null, online: false };
    return { name: this.label, powerW: Math.round(Math.abs(g.gridPowerW)), online: true };
  }
}

/**
 * Shelly 1PM/Plus 1PM/Pro 1PM für einphasige Verbrauchszweige. Reine Delegation an
 * Shelly1PmSource (identische Antwortform), nur unter dem passenden Namen für die
 * Verbraucher-Kategorie.
 */
export class Shelly1PmConsumerSource {
  private client: Shelly1PmSource;

  constructor(host: string, generation: "gen1" | "gen2", label: string) {
    this.client = new Shelly1PmSource(host, generation, label);
  }

  async read(): Promise<ConsumerStatus> {
    return this.client.read();
  }
}
