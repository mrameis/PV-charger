import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { SystemSnapshot } from "../types";

export class HistoryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        ts INTEGER PRIMARY KEY,
        grid_power_w REAL,
        pv_total_w REAL,
        charging_power_w REAL,
        current_a REAL,
        phases INTEGER,
        mode TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts);
    `);
  }

  insertSnapshot(s: SystemSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO history (ts, grid_power_w, pv_total_w, charging_power_w, current_a, phases, mode)
      VALUES (@ts, @grid, @pv, @charge, @current, @phases, @mode)
    `);
    stmt.run({
      ts: s.timestamp,
      grid: s.grid?.gridPowerW ?? null,
      pv: s.pvTotalW,
      charge: s.keba?.activePowerW ?? null,
      current: s.targetCurrentA,
      phases: s.activePhases,
      mode: s.mode,
    });
  }

  /** Letzte `hours` Stunden an Verlaufsdaten, leicht abgetastet für kompakte Antworten. */
  getRecent(hours: number): unknown[] {
    const since = Date.now() - hours * 3600 * 1000;
    return this.db
      .prepare(`SELECT * FROM history WHERE ts >= ? ORDER BY ts ASC`)
      .all(since);
  }

  /** Entfernt Einträge älter als `days` Tage (Aufräumjob). */
  prune(days: number): void {
    const cutoff = Date.now() - days * 86400 * 1000;
    this.db.prepare(`DELETE FROM history WHERE ts < ?`).run(cutoff);
  }
}
