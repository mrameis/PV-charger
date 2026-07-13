import Database from "better-sqlite3";
import { AppSettings } from "../types";

const DEFAULTS: AppSettings = {
  wallboxType: "keba",
  wallboxHost: "192.168.0.50",
  wallboxPort: 502,
  wallboxUnitId: 255,

  shellyHost: "192.168.0.51",
  shellyGeneration: "gen1",
  shellyInvert: false,

  froniusEnabled: false,
  froniusHost: "",

  stecaEnabled: false,
  stecaHost: "",
  stecaXmlPath: "",

  victronEnabled: false,
  victronHost: "",
  victronPort: 502,
  victronUnitId: 100,

  phasesMode: "auto",
  minCurrentA: 6,
  maxCurrentA: 16,
  gridVoltage: 230,
  intervalSec: 10,
  phaseSwitchCooldownSec: 300,
  decisionStabilitySec: 60,

  mode: "min_plus_pv",
  activeVehicleId: null,
};

export class SettingsDb {
  constructor(private db: Database.Database) {}

  get(): AppSettings {
    const row = this.db.prepare(`SELECT data FROM settings WHERE id = 1`).get() as
      | { data: string }
      | undefined;
    if (!row) return { ...DEFAULTS };
    try {
      return { ...DEFAULTS, ...JSON.parse(row.data) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(settings: AppSettings): void {
    this.db
      .prepare(
        `INSERT INTO settings (id, data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(JSON.stringify(settings));
  }

  update(partial: Partial<AppSettings>): AppSettings {
    const merged = { ...this.get(), ...partial };
    this.save(merged);
    return merged;
  }

  /** Einmalige Migration aus der alten HA-Options-basierten Version (falls vorhanden). */
  seedFromLegacyOptions(legacy: Partial<AppSettings> | null): void {
    const row = this.db.prepare(`SELECT id FROM settings WHERE id = 1`).get();
    if (row) return; // schon konfiguriert, nichts tun
    this.save({ ...DEFAULTS, ...(legacy ?? {}) });
  }
}
