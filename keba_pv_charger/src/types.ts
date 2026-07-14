export type ChargeMode = "off" | "pv_only" | "min_plus_pv" | "fast";
export type PhasesMode = "1" | "3" | "auto";

export type DeviceCategory = "wallbox" | "grid_meter" | "battery" | "pv_source";
export type DeviceType = "keba" | "go_echarger" | "shelly" | "shelly1pm" | "victron" | "fronius" | "steca";

/** Ein im Interface hinzugefügtes Gerät (Ladestation, Netzzähler, Batterie oder Solar-WR). */
export interface DeviceConfig {
  id: number;
  category: DeviceCategory;
  deviceType: DeviceType;
  name: string; // Anzeigename, Default = Gerätetyp
  host: string;
  port: number | null;
  unitId: number | null;
  generation: "gen1" | "gen2" | null; // nur Shelly
  invert: boolean | null; // nur Shelly als Netzzähler
  xmlPath: string | null; // nur Steca
  active: boolean; // wallbox/grid_meter: genau 1 pro Kategorie steuert die Regelung
  enabled: boolean; // battery/pv_source: ein-/ausblendbar ohne Löschen
}

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

export interface BatteryStatus {
  name: string;
  socPercent: number | null;
  powerW: number | null; // positiv = lädt, negativ = entlädt
  solarPowerW: number | null; // Ladeleistung durch angeschlossenen Solar-Laderegler (falls vorhanden)
  online: boolean;
}

export interface Vehicle {
  id: number;
  name: string;
  minCurrentA: number | null;
  maxCurrentA: number | null;
  notes: string | null;
}

/** Regelparameter (Geräte selbst leben jetzt in der devices-Tabelle). */
export interface ControlSettings {
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

export interface EnergyTotals {
  totalChargedWh: number;
  totalPvWh: number;
  todayChargedWh: number;
  todayPvWh: number;
}

export interface SystemSnapshot {
  timestamp: number;
  wallbox: WallboxStatus | null;
  grid: GridStatus | null;
  pvSources: PvSourceStatus[];
  pvTotalW: number | null;
  batteries: BatteryStatus[];
  mode: ChargeMode;
  activePhases: 1 | 3;
  targetCurrentA: number;
  controllerNote: string;
  activeVehicle: { id: number; name: string; minCurrentA: number | null } | null;
  energy: EnergyTotals;
}
