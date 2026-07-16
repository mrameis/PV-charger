import Database from "better-sqlite3";
import { SystemSnapshot } from "../types";
import { estimatePvShareW } from "./energyDb";

export interface DailyHistoryEntry {
  date: string; // YYYY-MM-DD (lokale Zeit)
  chargedWh: number;
  pvWh: number;
}

export class HistoryDb {
  constructor(private db: Database.Database) {}

  insertSnapshot(s: SystemSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO history (ts, grid_power_w, pv_total_w, charging_power_w, current_a, phases, mode)
      VALUES (@ts, @grid, @pv, @charge, @current, @phases, @mode)
    `);
    stmt.run({
      ts: s.timestamp,
      grid: s.grid?.gridPowerW ?? null,
      pv: s.pvTotalW,
      charge: s.wallbox?.activePowerW ?? null,
      current: s.targetCurrentA,
      phases: s.activePhases,
      mode: s.mode,
    });
  }

  /** Letzte `hours` Stunden an Verlaufsdaten. */
  getRecent(hours: number): unknown[] {
    const since = Date.now() - hours * 3600 * 1000;
    return this.db.prepare(`SELECT * FROM history WHERE ts >= ? ORDER BY ts ASC`).all(since);
  }

  /**
   * Aggregiert die letzten `days` Tage zu Tageswerten (geladene Menge + Solaranteil),
   * durch Aufintegrieren der pro Tick gespeicherten Leistungswerte. Gleiche Heuristik
   * wie bei der laufenden Energiebilanz (energyDb.ts): Solaranteil = Ladeleistung
   * minus Netzbezug.
   */
  getDailyTotals(days: number): DailyHistoryEntry[] {
    const since = Date.now() - days * 86400 * 1000;
    const rows = this.db
      .prepare(
        `SELECT ts, grid_power_w as gridPowerW, charging_power_w as chargingPowerW
         FROM history WHERE ts >= ? ORDER BY ts ASC`
      )
      .all(since) as Array<{ ts: number; gridPowerW: number | null; chargingPowerW: number | null }>;

    const byDate = new Map<string, DailyHistoryEntry>();
    let prevTs: number | null = null;

    for (const row of rows) {
      if (prevTs === null) {
        prevTs = row.ts;
        continue;
      }
      const dtHours = (row.ts - prevTs) / 3_600_000;
      prevTs = row.ts;
      if (dtHours <= 0 || dtHours > 0.5) continue;

      const chargingPowerW = row.chargingPowerW ?? 0;
      if (chargingPowerW <= 0) continue;
      const gridPowerW = row.gridPowerW ?? 0;

      const d = new Date(row.ts);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;

      const entry = byDate.get(dateKey) ?? { date: dateKey, chargedWh: 0, pvWh: 0 };
      entry.chargedWh += chargingPowerW * dtHours;
      entry.pvWh += estimatePvShareW(chargingPowerW, gridPowerW) * dtHours;
      byDate.set(dateKey, entry);
    }

    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Entfernt Einträge älter als `days` Tage (Aufräumjob). */
  prune(days: number): void {
    const cutoff = Date.now() - days * 86400 * 1000;
    this.db.prepare(`DELETE FROM history WHERE ts < ?`).run(cutoff);
  }
}
