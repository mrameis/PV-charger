import Database from "better-sqlite3";
import { ControlSettings } from "../types";

const DEFAULTS: ControlSettings = {
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

  get(): ControlSettings {
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

  save(settings: ControlSettings): void {
    this.db
      .prepare(
        `INSERT INTO settings (id, data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(JSON.stringify(settings));
  }

  update(partial: Partial<ControlSettings>): ControlSettings {
    const merged = { ...this.get(), ...partial };
    this.save(merged);
    return merged;
  }

  seedFromLegacy(legacy: Partial<ControlSettings> | null): void {
    const row = this.db.prepare(`SELECT id FROM settings WHERE id = 1`).get();
    if (row) return;
    this.save({ ...DEFAULTS, ...(legacy ?? {}) });
  }
}
