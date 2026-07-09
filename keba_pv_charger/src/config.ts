import "dotenv/config";
import fs from "fs";

/**
 * Konfigurationsquellen (in dieser Priorität):
 *  1. /data/options.json - wird automatisch von HA gefüllt, wenn dieses Projekt als
 *     Home Assistant Add-on läuft (Werte, die der Nutzer im Add-on-Konfigurationstab setzt).
 *  2. Umgebungsvariablen / .env - für den eigenständigen Betrieb via docker-compose.
 *  3. Fest codierte Defaults unten.
 */
let addonOptions: Record<string, unknown> = {};
const ADDON_OPTIONS_PATH = "/data/options.json";
if (fs.existsSync(ADDON_OPTIONS_PATH)) {
  try {
    addonOptions = JSON.parse(fs.readFileSync(ADDON_OPTIONS_PATH, "utf-8"));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Konnte ${ADDON_OPTIONS_PATH} nicht lesen:`, err);
  }
}

function raw(optionKey: string, envName: string): string | undefined {
  if (optionKey in addonOptions && addonOptions[optionKey] !== null) {
    return String(addonOptions[optionKey]);
  }
  return process.env[envName];
}
function num(optionKey: string, envName: string, def: number): number {
  const v = raw(optionKey, envName);
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${envName} muss eine Zahl sein, war "${v}"`);
  return n;
}
function str(optionKey: string, envName: string, def: string): string {
  return raw(optionKey, envName) ?? def;
}
function bool(optionKey: string, envName: string, def: boolean): boolean {
  const v = raw(optionKey, envName);
  if (v === undefined) return def;
  return v.toLowerCase() === "true" || v === "1";
}

export const config = {
  keba: {
    host: str("keba_host", "KEBA_HOST", "192.168.0.50"),
    port: num("keba_port", "KEBA_PORT", 502),
    unitId: num("keba_unit_id", "KEBA_UNIT_ID", 255),
  },
  shelly3em: {
    host: str("shelly3em_host", "SHELLY3EM_HOST", "192.168.0.51"),
    generation: str("shelly3em_generation", "SHELLY3EM_GENERATION", "gen1") as "gen1" | "gen2",
    invert: bool("shelly3em_invert", "SHELLY3EM_INVERT", false),
  },
  fronius: {
    enabled: bool("fronius_enabled", "FRONIUS_ENABLED", false),
    host: str("fronius_host", "FRONIUS_HOST", ""),
  },
  steca: {
    enabled: bool("steca_enabled", "STECA_ENABLED", false),
    host: str("steca_host", "STECA_HOST", ""),
    xmlPath: str("steca_xml_path", "STECA_XML_PATH", ""),
  },
  victron: {
    enabled: bool("victron_enabled", "VICTRON_ENABLED", false),
    host: str("victron_host", "VICTRON_HOST", ""),
    port: num("victron_port", "VICTRON_PORT", 502),
    unitId: num("victron_unit_id", "VICTRON_UNIT_ID", 100),
  },
  control: {
    phasesMode: str("charge_phases_mode", "CHARGE_PHASES_MODE", "auto") as "1" | "3" | "auto",
    minCurrentA: num("charge_min_current_a", "CHARGE_MIN_CURRENT_A", 6),
    maxCurrentA: num("charge_max_current_a", "CHARGE_MAX_CURRENT_A", 16),
    gridVoltage: num("grid_voltage", "GRID_VOLTAGE", 230),
    intervalSec: num("control_interval_sec", "CONTROL_INTERVAL_SEC", 10),
    phaseSwitchCooldownSec: num("phase_switch_cooldown_sec", "PHASE_SWITCH_COOLDOWN_SEC", 300),
    decisionStabilitySec: num("decision_stability_sec", "DECISION_STABILITY_SEC", 60),
  },
  server: {
    // Ingress spricht den Container immer auf demselben internen Port an, unabhängig
    // von PORT - daher hier bewusst kein Add-on-Options-Feld, sondern nur ENV/Default.
    port: num("__unused", "PORT", 8080),
    dbPath: str("__unused", "DB_PATH", "/data/history.db"),
  },
  isAddon: Object.keys(addonOptions).length > 0,
};
