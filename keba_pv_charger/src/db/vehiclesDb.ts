import Database from "better-sqlite3";
import { Vehicle } from "../types";

export class VehiclesDb {
  constructor(private db: Database.Database) {}

  list(): Vehicle[] {
    return this.db
      .prepare(`SELECT id, name, min_current_a as minCurrentA, max_current_a as maxCurrentA, notes FROM vehicles ORDER BY name`)
      .all() as Vehicle[];
  }

  get(id: number): Vehicle | null {
    const v = this.db
      .prepare(`SELECT id, name, min_current_a as minCurrentA, max_current_a as maxCurrentA, notes FROM vehicles WHERE id = ?`)
      .get(id) as Vehicle | undefined;
    return v ?? null;
  }

  create(v: Omit<Vehicle, "id">): Vehicle {
    const res = this.db
      .prepare(`INSERT INTO vehicles (name, min_current_a, max_current_a, notes) VALUES (?, ?, ?, ?)`)
      .run(v.name, v.minCurrentA, v.maxCurrentA, v.notes);
    return { id: Number(res.lastInsertRowid), ...v };
  }

  update(id: number, v: Partial<Omit<Vehicle, "id">>): Vehicle | null {
    const current = this.get(id);
    if (!current) return null;
    const merged = { ...current, ...v };
    this.db
      .prepare(`UPDATE vehicles SET name = ?, min_current_a = ?, max_current_a = ?, notes = ? WHERE id = ?`)
      .run(merged.name, merged.minCurrentA, merged.maxCurrentA, merged.notes, id);
    return merged;
  }

  delete(id: number): void {
    this.db.prepare(`DELETE FROM vehicles WHERE id = ?`).run(id);
  }
}
