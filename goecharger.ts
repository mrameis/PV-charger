import "dotenv/config";
import fs from "fs";
import { AppSettings } from "./types";

const ADDON_OPTIONS_PATH = "/data/options.json";

function readAddonOptions(): Record<string, unknown> {
  if (!fs.existsSync(ADDON_OPTIONS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ADDON_OPTIONS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Server-Basics kommen weiterhin aus Env/.env (Standalone) oder haben feste Defaults
 * (Add-on/Ingress-Betrieb). Alle Geräte-/Regel-Einstellungen leben jetzt in der
 * SQLite-DB und sind im Interface unter "Einstellungen" editierbar.
 */
export const config = {
  server: {
    port: Number(process.env.PORT ?? 8080),
    dbPath: process.env.DB_PATH ?? "/data/history.db",
  },
  logLevel: process.env.LOG_LEVEL ?? "info",
};

/**
 * Migrationshilfe für Nutzer, die von der alten Version (Konfiguration nur über den
 * HA-Options-Tab) auf die neue, im Interface konfigurierbare Version upgraden:
 * liest /data/options.json (falls vorhanden) und mappt die alten Feldnamen auf
 * AppSettings, damit die bisherige Konfiguration beim ersten Start übernommen wird.
 */
export function legacyOptionsAsSettings(): Partial<AppSettings> | null {
  const opts = readAddonOptions();
  if (!("keba_host" in opts) && !("shelly3em_host" in opts)) return null;

  const s = <T,>(k: string, def: T): T => (opts[k] as T) ?? def;
  return {
    wallboxType: "keba",
    wallboxHost: s("keba_host", "192.168.0.50"),
    wallboxPort: s("keba_port", 502),
    wallboxUnitId: s("keba_unit_id", 255),
    shellyHost: s("shelly3em_host", "192.168.0.51"),
    shellyGeneration: s("shelly3em_generation", "gen1"),
    shellyInvert: s("shelly3em_invert", false),
    froniusEnabled: s("fronius_enabled", false),
    froniusHost: s("fronius_host", ""),
    stecaEnabled: s("steca_enabled", false),
    stecaHost: s("steca_host", ""),
    stecaXmlPath: s("steca_xml_path", ""),
    victronEnabled: s("victron_enabled", false),
    victronHost: s("victron_host", ""),
    victronPort: s("victron_port", 502),
    victronUnitId: s("victron_unit_id", 100),
    phasesMode: s("charge_phases_mode", "auto"),
    minCurrentA: s("charge_min_current_a", 6),
    maxCurrentA: s("charge_max_current_a", 16),
    gridVoltage: s("grid_voltage", 230),
    intervalSec: s("control_interval_sec", 10),
    phaseSwitchCooldownSec: s("phase_switch_cooldown_sec", 300),
    decisionStabilitySec: s("decision_stability_sec", 60),
  };
}
