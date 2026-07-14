import "dotenv/config";
import fs from "fs";
import { ControlSettings, DeviceConfig } from "./types";

const ADDON_OPTIONS_PATH = "/data/options.json";

function readAddonOptions(): Record<string, unknown> {
  if (!fs.existsSync(ADDON_OPTIONS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ADDON_OPTIONS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export const config = {
  server: {
    port: Number(process.env.PORT ?? 8080),
    dbPath: process.env.DB_PATH ?? "/data/history.db",
  },
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export interface LegacyMigration {
  controlSettings: Partial<ControlSettings>;
  devices: Array<Omit<DeviceConfig, "id">>;
}

/**
 * Migrationshilfe für Nutzer, die von Version 1.x (Konfiguration nur über den alten
 * HA-Options-Tab bzw. AppSettings) auf die geräte-basierte Verwaltung upgraden.
 */
export function legacyMigration(): LegacyMigration | null {
  const opts = readAddonOptions();
  if (!("keba_host" in opts) && !("shelly3em_host" in opts)) return null;

  const s = <T,>(k: string, def: T): T => (opts[k] as T) ?? def;
  const devices: Array<Omit<DeviceConfig, "id">> = [];

  devices.push({
    category: "wallbox",
    deviceType: "keba",
    name: "Keba (migriert)",
    host: s("keba_host", "192.168.0.50"),
    port: s("keba_port", 502),
    unitId: s("keba_unit_id", 255),
    generation: null,
    invert: null,
    xmlPath: null,
    active: true,
    enabled: true,
  });

  devices.push({
    category: "grid_meter",
    deviceType: "shelly",
    name: "Shelly 3EM (migriert)",
    host: s("shelly3em_host", "192.168.0.51"),
    port: null,
    unitId: null,
    generation: s("shelly3em_generation", "gen1"),
    invert: s("shelly3em_invert", false),
    xmlPath: null,
    active: true,
    enabled: true,
  });

  if (s("fronius_enabled", false)) {
    devices.push({
      category: "pv_source",
      deviceType: "fronius",
      name: "Fronius (migriert)",
      host: s("fronius_host", ""),
      port: null,
      unitId: null,
      generation: null,
      invert: null,
      xmlPath: null,
      active: false,
      enabled: true,
    });
  }
  if (s("steca_enabled", false)) {
    devices.push({
      category: "pv_source",
      deviceType: "steca",
      name: "StecaGrid (migriert)",
      host: s("steca_host", ""),
      port: null,
      unitId: null,
      generation: null,
      invert: null,
      xmlPath: s("steca_xml_path", ""),
      active: false,
      enabled: true,
    });
  }
  if (s("victron_enabled", false)) {
    devices.push({
      category: "pv_source",
      deviceType: "victron",
      name: "Victron PV (migriert)",
      host: s("victron_host", ""),
      port: s("victron_port", 502),
      unitId: s("victron_unit_id", 100),
      generation: null,
      invert: null,
      xmlPath: null,
      active: false,
      enabled: true,
    });
    devices.push({
      category: "battery",
      deviceType: "victron",
      name: "Victron Batterie (migriert)",
      host: s("victron_host", ""),
      port: s("victron_port", 502),
      unitId: s("victron_unit_id", 100),
      generation: null,
      invert: null,
      xmlPath: null,
      active: false,
      enabled: true,
    });
  }

  return {
    controlSettings: {
      phasesMode: s("charge_phases_mode", "auto"),
      minCurrentA: s("charge_min_current_a", 6),
      maxCurrentA: s("charge_max_current_a", 16),
      gridVoltage: s("grid_voltage", 230),
      intervalSec: s("control_interval_sec", 10),
      phaseSwitchCooldownSec: s("phase_switch_cooldown_sec", 300),
      decisionStabilitySec: s("decision_stability_sec", 60),
    },
    devices,
  };
}
