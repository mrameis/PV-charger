import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
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

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      min_current_a REAL,
      max_current_a REAL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      device_type TEXT NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER,
      unit_id INTEGER,
      generation TEXT,
      invert INTEGER,
      xml_path TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_devices_category ON devices(category);
  `);

  return db;
}
