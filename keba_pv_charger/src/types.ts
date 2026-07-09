export type ChargeMode = "off" | "pv_only" | "min_plus_pv" | "fast";

export interface KebaStatus {
  state: number; // 0 starting,1 not ready,2 ready,3 charging,4 error,5 interrupted (siehe keba/modbus.ts)
  stateText: string;
  cableState: number;
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

export interface SystemSnapshot {
  timestamp: number;
  keba: KebaStatus | null;
  grid: GridStatus | null;
  pvSources: PvSourceStatus[];
  pvTotalW: number | null;
  mode: ChargeMode;
  activePhases: 1 | 3;
  targetCurrentA: number;
  controllerNote: string;
}
