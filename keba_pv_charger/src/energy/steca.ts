import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { logger } from "../logger";
import { PvSourceStatus } from "../types";

/**
 * StecaGrid 6003 - liest /measurements.xml.
 *
 * Format (verifiziert an einer echten StecaGrid 6003, Firmware Net13/HMI13):
 *   <root><Device ...><Measurements>
 *     <Measurement Value="721.9" Unit="W" Type="AC_Power"/>
 *     <Measurement Value="348.7" Unit="V" Type="DC_Voltage"/>
 *     ...
 *     <Measurement Unit="W" Type="GridPower"/>  <- ohne Value, dieses Gerät hat
 *                                                   KEINEN integrierten Netzzähler.
 *   </Measurements></Device></root>
 *
 * Die Gesamt-Wechselstromleistung steht im Element mit Type="AC_Power". Da die Steca
 * keinen Netzzähler liefert, wird sie hier - wie geplant - nur zur Anzeige der
 * PV-Erzeugung genutzt, nicht als Regelgröße (das übernimmt der Shelly 3EM).
 */
const DEFAULT_PATH = "/measurements.xml";

interface StecaMeasurement {
  Value?: string;
  Unit?: string;
  Type?: string;
}

export class StecaClient {
  constructor(private host: string, private path: string = DEFAULT_PATH) {}

  async read(): Promise<PvSourceStatus> {
    try {
      const res = await fetch(`http://${this.host}${this.path}`, { timeout: 3000 } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const parsed = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });

      const measurementsRaw = parsed?.root?.Device?.Measurements?.Measurement;
      const measurements: StecaMeasurement[] = Array.isArray(measurementsRaw)
        ? measurementsRaw
        : measurementsRaw
        ? [measurementsRaw]
        : [];

      const findValue = (type: string): number | null => {
        const m = measurements.find((x) => x.Type === type);
        if (!m || m.Value === undefined || m.Value === "") return null;
        const n = Number(m.Value);
        return Number.isNaN(n) ? null : n;
      };

      const acPower = findValue("AC_Power");
      if (acPower === null) {
        logger.warn(`Steca: kein AC_Power-Wert im XML gefunden (${this.host}${this.path})`);
        return { name: "StecaGrid 6003", powerW: null, online: false };
      }

      return {
        name: "StecaGrid 6003",
        powerW: Math.round(acPower),
        online: true,
        extra: {
          dcVoltageV: findValue("DC_Voltage"),
          dcCurrentA: findValue("DC_Current"),
          temperatureC: findValue("Temp"),
        },
      };
    } catch (err) {
      logger.warn(`Steca: Lesefehler (${this.host}${this.path}):`, (err as Error).message);
      return { name: "StecaGrid 6003", powerW: null, online: false };
    }
  }
}
