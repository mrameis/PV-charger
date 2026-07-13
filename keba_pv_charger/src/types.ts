export type ChargeMode = "off" | "pv_only" | "min_plus_pv" | "fast";
export type WallboxType = "keba" | "go_echarger";
export type PhasesMode = "1" | "3" | "auto";

/** Generalisierter Wallbox-Status, den jeder Wallbox-Treiber (Keba, go-eCharger, ...) liefert. */
export interface WallboxStatus {
  state: number;
  stateText: string;
  cablePlugged: boolean;
  errorCode: number;
  currentsMa: [number, number, number];
  activePowerW: number;
  totalEnergyWh: number;
  voltages: [number, number, number];
  maxSupportedCurrentA: number;
  online: boolean;
}

export interface GridStatus {
  gridPowerW: number; // positiv = Bezug, negativ = Einspeisung/Überschuss
  perPhaseW: [number, number, number] | null;
  online: boolean;
}

export interface PvSourceStatus {
  name: string;
  powerW: number | null;
  extra?: Record<string, number | string | null>;
  online: boolean;
}

export interface Vehicle {
  id: number;
  name: string;
  minCurrentA: number | null; // Override, null = Standard-Einstellung der Anlage nutzen
  maxCurrentA: number | null;
  notes: string | null;
}

/** Laufzeit-Konfiguration - im Interface unter "Einstellungen" editierbar, in SQLite persistiert. */
export interface AppSettings {
  wallboxType: WallboxType;
  wallboxHost: string;
  wallboxPort: number;
  wallboxUnitId: number; // nur für Keba (Modbus Unit-ID) relevant

  shellyHost: string;
  shellyGeneration: "gen1" | "gen2";
  shellyInvert: boolean;

  froniusEnabled: boolean;
  froniusHost: string;

  stecaEnabled: boolean;
  stecaHost: string;
  stecaXmlPath: string;

  victronEnabled: boolean;
  victronHost: string;
  victronPort: number;
  victronUnitId: number;

  phasesMode: PhasesMode;
  minCurrentA: number;
  maxCurrentA: number;
  gridVoltage: number;
  intervalSec: number;
  phaseSwitchCooldownSec: number;
  decisionStabilitySec: number;

  mode: ChargeMode;
  activeVehicleId: number | null;
}

export interface SystemSnapshot {
  timestamp: number;
  wallbox: WallboxStatus | null;
  grid: GridStatus | null;
  pvSources: PvSourceStatus[];
  pvTotalW: number | null;
  mode: ChargeMode;
  activePhases: 1 | 3;
  targetCurrentA: number;
  controllerNote: string;
  activeVehicle: { id: number; name: string; minCurrentA: number | null } | null;
}
