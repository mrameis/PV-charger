import Database from "better-sqlite3";
import { DeviceCategory, DeviceConfig } from "../types";

interface DeviceRow {
  id: number;
  category: string;
  device_type: string;
  name: string;
  host: string;
  port: number | null;
  unit_id: number | null;
  generation: string | null;
  invert: number | null;
  xml_path: string | null;
  active: number;
  enabled: number;
}

function rowToDevice(r: DeviceRow): DeviceConfig {
  return {
    id: r.id,
    category: r.category as DeviceCategory,
    deviceType: r.device_type as DeviceConfig["deviceType"],
    name: r.name,
    host: r.host,
    port: r.port,
    unitId: r.unit_id,
    generation: r.generation as DeviceConfig["generation"],
    invert: r.invert === null ? null : !!r.invert,
    xmlPath: r.xml_path,
    active: !!r.active,
    enabled: !!r.enabled,
  };
}

export class DevicesDb {
  constructor(private db: Database.Database) {}

  list(category?: DeviceCategory): DeviceConfig[] {
    const rows = category
      ? (this.db.prepare(`SELECT * FROM devices WHERE category = ? ORDER BY id`).all(category) as DeviceRow[])
      : (this.db.prepare(`SELECT * FROM devices ORDER BY category, id`).all() as DeviceRow[]);
    return rows.map(rowToDevice);
  }

  get(id: number): DeviceConfig | null {
    const row = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  getActive(category: DeviceCategory): DeviceConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM devices WHERE category = ? AND active = 1 LIMIT 1`)
      .get(category) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  create(d: Omit<DeviceConfig, "id">): DeviceConfig {
    // Wallbox/Netzzähler: das erste Gerät einer Kategorie wird automatisch aktiv.
    const isSingleActiveCategory = d.category === "wallbox" || d.category === "grid_meter";
    const existingCount = isSingleActiveCategory
      ? (this.db.prepare(`SELECT COUNT(*) as c FROM devices WHERE category = ?`).get(d.category) as { c: number }).c
      : 0;
    const active = isSingleActiveCategory ? existingCount === 0 || d.active : d.active;

    const res = this.db
      .prepare(
        `INSERT INTO devices (category, device_type, name, host, port, unit_id, generation, invert, xml_path, active, enabled)
         VALUES (@category, @deviceType, @name, @host, @port, @unitId, @generation, @invert, @xmlPath, @active, @enabled)`
      )
      .run({
        category: d.category,
        deviceType: d.deviceType,
        name: d.name,
        host: d.host,
        port: d.port,
        unitId: d.unitId,
        generation: d.generation,
        invert: d.invert === null ? null : d.invert ? 1 : 0,
        xmlPath: d.xmlPath,
        active: active ? 1 : 0,
        enabled: d.enabled ? 1 : 0,
      });
    const created = this.get(Number(res.lastInsertRowid))!;
    if (isSingleActiveCategory && active) this.setActive(d.category, created.id);
    return this.get(created.id)!;
  }

  update(id: number, patch: Partial<Omit<DeviceConfig, "id" | "category">>): DeviceConfig | null {
    const current = this.get(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE devices SET device_type=@deviceType, name=@name, host=@host, port=@port, unit_id=@unitId,
         generation=@generation, invert=@invert, xml_path=@xmlPath, enabled=@enabled WHERE id=@id`
      )
      .run({
        id,
        deviceType: merged.deviceType,
        name: merged.name,
        host: merged.host,
        port: merged.port,
        unitId: merged.unitId,
        generation: merged.generation,
        invert: merged.invert === null ? null : merged.invert ? 1 : 0,
        xmlPath: merged.xmlPath,
        enabled: merged.enabled ? 1 : 0,
      });
    return this.get(id);
  }

  /** Setzt genau ein Gerät der Kategorie als aktiv (für wallbox/grid_meter). */
  setActive(category: DeviceCategory, id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE devices SET active = 0 WHERE category = ?`).run(category);
      this.db.prepare(`UPDATE devices SET active = 1 WHERE id = ?`).run(id);
    });
    tx();
  }

  delete(id: number): void {
    this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  }
}
