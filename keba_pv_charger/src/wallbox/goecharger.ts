import fetch from "node-fetch";
import { logger } from "../logger";
import { WallboxStatus } from "../types";
import { WallboxClient } from "./types";

/**
 * go-eCharger (Home/Home+, HW v3/v4) - lokale HTTP API v2.
 * Quelle: offizielles Repo github.com/goecharger/go-eCharger-API-v2, mehrfach
 * gegengeprüft mit unabhängigen Community-Quellen (Foren, andere Integrationen).
 *
 * Voraussetzung: in der go-e App unter "Internet" -> "Erweiterte Einstellungen"
 * muss die "Lokale HTTP API v2" aktiviert sein.
 *
 * Lesen:  GET http://<ip>/api/status
 * Setzen: GET http://<ip>/api/set?amp=16&frc=0&psm=1  (mehrere Keys in einem Request)
 *
 * Relevante Felder:
 *   car: 1=bereit/kein Fahrzeug, 2=lädt, 3=wartet auf Fahrzeug, 4=fertig (Fahrzeug
 *        noch verbunden), 5=Fehler
 *   amp: aktueller Sollstrom in A (6-32, je nach Hardware-Ausbaustufe)
 *   frc: forceState - 0=Neutral (Ladelogik entscheidet), 1=Off (kein Laden),
 *        2=On (erzwungen an)
 *   psm: phaseSwitchMode - 1=1-phasig erzwungen, 2=3-phasig erzwungen
 *        (WICHTIG: hier NICHT den Auto-Modus der Wallbox selbst nutzen, da wir die
 *        Umschaltung komplett selbst mit unserer eigenen PV-Überschusslogik steuern)
 *   nrg: 16-elementiges Array mit Spannungen/Strömen/Leistungen, siehe unten
 *   eto: Gesamt-Ladeenergie in Wh (API v2, apikeys-en.md: "energy_total, measured
 *        in Wh"; die alte v1-API nutzte 0.1 kWh)
 *
 * nrg-Array in API v2 (echtes Beispiel einer ladenden Wallbox, OpenHAB-Issue #13041):
 *   [228,231,233,1, 15.3,0,0, 3500,0,0,0, 3600, 100,1,0,78]
 *   [0..3]  Spannung L1, L2, L3, N in V
 *   [4..6]  Strom L1, L2, L3 in A (Kommazahl, NICHT 0.1 A wie in v1)
 *   [7..10] Leistung L1, L2, L3, N in W
 *   [11]    Gesamtleistung in W
 *   [12..15] Leistungsfaktoren in %
 * Alle Werte sind in v2 direkte SI-Einheiten, ohne Skalierungsfaktor. Die Skalierungen
 * der alten v1-Doku (0.1 A, 0.1 kW, 0.01 kW) gelten fuer v3/v4/Gemini NICHT mehr -
 * wer sie anwendet, bekommt Potenzfehler (z.B. 70 kW statt 7 kW).
 *
 * ACHTUNG Phasenumschaltung: manche Fahrzeuge (z. B. div. Stellantis-Modelle)
 * verlangen laut Community-Berichten, dass die Wallbox beim Umschalten im Standby
 * ist ("Ausstecken simulieren"). Bitte vor Produktivbetrieb einmal manuell testen,
 * ob dein Fahrzeug die Umschaltung ohne Probleme mitmacht - siehe README.
 */
const CAR_STATE_TEXT: Record<number, string> = {
  1: "Bereit, kein Fahrzeug",
  2: "Lädt",
  3: "Wartet auf Fahrzeug",
  4: "Ladevorgang beendet",
  5: "Fehler",
};

interface GoEStatus {
  car?: string;
  amp?: string;
  err?: string;
  alw?: string;
  nrg?: number[];
  eto?: string;
  ama?: string; // maximal einstellbarer Strom (Hardware-Grenze)
}

export class GoEChargerWallbox implements WallboxClient {
  constructor(private host: string) {}

  private async get(path: string): Promise<GoEStatus> {
    const res = await fetch(`http://${this.host}${path}`, { timeout: 3000 } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as GoEStatus;
  }

  async readStatus(): Promise<WallboxStatus> {
    const s = await this.get("/api/status");
    const car = Number(s.car ?? 0);
    const nrg = s.nrg ?? new Array(16).fill(0);
    // API v2: nrg[11] ist die Gesamtleistung direkt in W. Fallback auf die Summe der
    // Phasenleistungen (ebenfalls W), falls das Feld fehlt.
    const sumPhasesW = (nrg[7] ?? 0) + (nrg[8] ?? 0) + (nrg[9] ?? 0);
    const activePowerW = Math.round(Number.isFinite(nrg[11]) ? nrg[11] : sumPhasesW);
    // eto ist bei API v2 bereits in Wh.
    const totalEnergyWh = Math.round(Number(s.eto ?? 0));

    // go-e liefert keinen direkten "Ist-Phasen"-Status, daher aus den gemessenen
    // Stroemen abgeleitet: fliesst nennenswerter Strom (> 0.3 A) auf L2 oder L3, wird
    // 3-phasig geladen. Ohne Ladevorgang ist das nicht bestimmbar -> null.
    // nrg[4..6] sind Ampere (Kommazahl) -> *1000 fuer mA.
    const iL1 = (nrg[4] ?? 0) * 1000;
    const iL2 = (nrg[5] ?? 0) * 1000;
    const iL3 = (nrg[6] ?? 0) * 1000;
    const isCharging = car === 2;
    const reportedPhases: 1 | 3 | null = !isCharging ? null : iL2 > 300 || iL3 > 300 ? 3 : 1;

    return {
      state: car,
      stateText: CAR_STATE_TEXT[car] ?? `Unbekannt (${car})`,
      cablePlugged: car !== 1,
      errorCode: Number(s.err ?? 0),
      currentsMa: [Math.round(iL1), Math.round(iL2), Math.round(iL3)],
      activePowerW,
      totalEnergyWh,
      voltages: [nrg[0] ?? 0, nrg[1] ?? 0, nrg[2] ?? 0],
      maxSupportedCurrentA: Number(s.ama ?? 32),
      reportedPhases,
      reportedPhaseSource: null, // go-e kennt kein Modbus-Source-Konzept wie Keba
      online: true,
    };
  }

  async setChargingCurrentA(amps: number): Promise<void> {
    if (amps <= 0) {
      // go-e kennt kein "0A anbieten" wie Keba - Pausieren geschieht über frc=1 (Off).
      await this.get("/api/set?frc=1");
      return;
    }
    const clamped = Math.max(6, Math.round(amps));
    await this.get(`/api/set?amp=${clamped}&frc=0`);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.get(`/api/set?frc=${enabled ? 0 : 1}`);
  }

  async setPhases(phases: 1 | 3): Promise<void> {
    await this.get(`/api/set?psm=${phases === 3 ? 2 : 1}`);
    logger.info(`go-eCharger: Phasenumschaltung ausgelöst -> ${phases}-phasig`);
  }

  async close(): Promise<void> {
    // zustandslos (HTTP), nichts zu schließen
  }
}
