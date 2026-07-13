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
 *   eto: Gesamt-Ladeenergie in 0.1 kWh (Beispiel: 130 = 13 kWh)
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
    const activePowerW = Math.round((nrg[11] ?? 0) * 10); // 0.01kW -> W
    const totalEnergyWh = Math.round(Number(s.eto ?? 0) * 100); // 0.1kWh -> Wh

    return {
      state: car,
      stateText: CAR_STATE_TEXT[car] ?? `Unbekannt (${car})`,
      cablePlugged: car !== 1,
      errorCode: Number(s.err ?? 0),
      currentsMa: [
        Math.round((nrg[4] ?? 0) * 100),
        Math.round((nrg[5] ?? 0) * 100),
        Math.round((nrg[6] ?? 0) * 100),
      ],
      activePowerW,
      totalEnergyWh,
      voltages: [nrg[0] ?? 0, nrg[1] ?? 0, nrg[2] ?? 0],
      maxSupportedCurrentA: Number(s.ama ?? 32),
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
