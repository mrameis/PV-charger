import Database from "better-sqlite3";
import { EnergyTotals } from "../types";

/**
 * Schätzt den Solaranteil einer momentanen Ladeleistung nach der Standard-
 * Selbstverbrauchs-Heuristik (analog evcc/openWB): alles, was nicht als Netzbezug
 * anfällt, wird der PV zugerechnet. Bei Netz-Einspeisung trotz Ladens (gridPowerW <= 0)
 * gilt die gesamte Ladeleistung als PV-gedeckt.
 *   pvAnteil = max(0, ladeleistung - max(0, netzbezug))
 * Das ist eine Näherung (keine physikalische Zuordnung einzelner Elektronen),
 * aber der in der Praxis übliche Ansatz für "wie viel meines Ladevorgangs war Solar".
 */
export function estimatePvShareW(chargingPowerW: number, gridPowerW: number): number {
  return Math.max(0, chargingPowerW - Math.max(0, gridPowerW));
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class EnergyDb {
  private lastTs: number | null = null;

  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS energy_totals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_charged_wh REAL NOT NULL DEFAULT 0,
        total_pv_wh REAL NOT NULL DEFAULT 0,
        today_date TEXT,
        today_charged_wh REAL NOT NULL DEFAULT 0,
        today_pv_wh REAL NOT NULL DEFAULT 0
      );
    `);
    const row = this.db.prepare(`SELECT id FROM energy_totals WHERE id = 1`).get();
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO energy_totals (id, total_charged_wh, total_pv_wh, today_date, today_charged_wh, today_pv_wh)
           VALUES (1, 0, 0, ?, 0, 0)`
        )
        .run(todayKey());
    }
  }

  get(): EnergyTotals {
    const row = this.db
      .prepare(
        `SELECT total_charged_wh as totalChargedWh, total_pv_wh as totalPvWh,
                today_charged_wh as todayChargedWh, today_pv_wh as todayPvWh
         FROM energy_totals WHERE id = 1`
      )
      .get() as EnergyTotals;
    return row;
  }

  /**
   * Integriert die aktuelle Ladeleistung über die seit dem letzten Aufruf vergangene
   * Zeit auf (Trapezregel light: einfacher Rechteck-Ansatz reicht bei 10s-Takt).
   * Wird bei jedem Regel-Tick mit der frischen Ladeleistung/Netzleistung aufgerufen.
   */
  accumulate(nowMs: number, chargingPowerW: number, gridPowerW: number): void {
    if (this.lastTs === null) {
      this.lastTs = nowMs;
      return;
    }
    const dtHours = (nowMs - this.lastTs) / 3_600_000;
    this.lastTs = nowMs;
    // Größere Lücken (z.B. nach Neustart/Absturz) nicht aufintegrieren, um keine
    // unrealistischen Sprünge in der Bilanz zu erzeugen.
    if (dtHours <= 0 || dtHours > 0.5) return;
    if (chargingPowerW <= 0) return;

    const chargedWh = chargingPowerW * dtHours;
    const pvWh = estimatePvShareW(chargingPowerW, gridPowerW) * dtHours;

    const today = todayKey();
    const current = this.db.prepare(`SELECT today_date as d FROM energy_totals WHERE id = 1`).get() as {
      d: string;
    };

    if (current.d !== today) {
      this.db
        .prepare(
          `UPDATE energy_totals SET
             total_charged_wh = total_charged_wh + ?,
             total_pv_wh = total_pv_wh + ?,
             today_date = ?,
             today_charged_wh = ?,
             today_pv_wh = ?
           WHERE id = 1`
        )
        .run(chargedWh, pvWh, today, chargedWh, pvWh);
    } else {
      this.db
        .prepare(
          `UPDATE energy_totals SET
             total_charged_wh = total_charged_wh + ?,
             total_pv_wh = total_pv_wh + ?,
             today_charged_wh = today_charged_wh + ?,
             today_pv_wh = today_pv_wh + ?
           WHERE id = 1`
        )
        .run(chargedWh, pvWh, chargedWh, pvWh);
    }
  }
}
