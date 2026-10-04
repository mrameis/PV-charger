export type ChargeMode = "off" | "pv_only" | "min_plus_pv" | "fast" | "manual";
export type PhasesMode = "1" | "3" | "auto";

export type DeviceCategory = "wallbox" | "grid_meter" | "battery" | "pv_source";
export type DeviceType =
  | "keba"
  | "go_echarger"
  | "shelly"
  | "shelly1pm"
  | "victron"
  | "fronius"
  | "steca"
  | "volkszaehler";

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
  invert: boolean | null; // Netzzähler (Shelly/Volkszähler): Messrichtung umkehren
  xmlPath: string | null; // Steca (XML-Pfad) oder Volkszähler (REST-Pfad, Default /rest)
  active: boolean; // wallbox/grid_meter: genau 1 pro Kategorie steuert die Regelung
  enabled: boolean; // battery/pv_source: ein-/ausblendbar ohne Löschen
  registerOffset: number | null; // nur Keba: Debug-Hilfe bei Off-by-one-Registeradressierung
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
  /** Tatsächlich von der Wallbox gemeldete Phasenzahl (nicht die interne Regel-Annahme). */
  reportedPhases: 1 | 3 | null;
  /** Wer laut Wallbox aktuell den Phasenumschalt-Kontakt steuern darf (Keba: 3=Modbus TCP). */
  reportedPhaseSource: number | null;
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
  /** Ziel-Ladeleistung (W) im Modus "manuell", vom Nutzer per Regler eingestellt. */
  manualPowerW: number;
  /**
   * Batterie-Regelung für die PV-Überschussmodi (pv_only/min_plus_pv). Ohne
   * konfigurierte Batterie ohne Wirkung. Zwei Zustände, per Ladezustand
   * (SoC) mit Hysterese unterschieden:
   * - SoC < batteryBoostSocPercent: die Batterie hat Vorrang. Es wird bis zu
   *   batteryMaxChargePowerW an PV-Überschuss für die Batterie reserviert
   *   (vom Auto abgezogen), damit sie mit maximaler Leistung lädt. Das Auto
   *   lädt nur mit dem verbleibenden Überschuss.
   * - SoC >= batteryBoostSocPercent (+2% Hysterese): die Batterie darf als
   *   Boost fürs Auto mitwirken. Bis zu batteryMaxDischargePowerW an
   *   Batterie-Entladung wird NICHT von der Ladeleistung abgezogen (gilt als
   *   nutzbarer Überschuss); Entladung darüber hinaus (z.B. durch normalen
   *   Hausverbrauch) wird weiterhin wie Netzbezug behandelt.
   */
  batteryProtectionEnabled: boolean;
  /** Schwelle (%) zwischen Batterie-Vorrang (darunter) und Boost-Erlaubnis (darüber). */
  batteryBoostSocPercent: number;
  /** Für die Batterie reservierte Ladeleistung (W), wenn SoC unter der Schwelle liegt. */
  batteryMaxChargePowerW: number;
  /** Maximal als Boost fürs Auto nutzbare Batterie-Entladeleistung (W), wenn SoC über der Schwelle liegt. */
  batteryMaxDischargePowerW: number;
}

export interface EnergyTotals {
  totalChargedWh: number;
  totalPvWh: number;
  todayChargedWh: number;
  todayPvWh: number;
}

export interface BmwConfig {
  clientId: string;
  vin: string;
  containerId: string | null;
  /** technicalDescriptor-Keys, die im BMW-Container angelegt werden (siehe BMW_DEFAULT_DESCRIPTORS). */
  descriptors: string[];
  enabled: boolean;
}

/** OAuth2-Tokens für die BMW-CarData-Anbindung, persistiert in bmw_tokens. */
export interface BmwTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  gcid: string;
  /** Unix-Timestamp (ms) */
  accessExpiresAt: number;
  /** Unix-Timestamp (ms) */
  idExpiresAt: number;
  /** Unix-Timestamp (ms) - refresh_token ist 14 Tage gültig */
  refreshExpiresAt: number;
}

/** Für das Dashboard aufbereiteter BMW-Fahrzeugzustand (rein zur Anzeige, keine Ladelogik-Kopplung). */
export interface BmwStatus {
  vin: string;
  socDisplayed: number | null;
  socTarget: number | null;
  remainingRangeKm: number | null;
  chargingStatus: string | null;
  chargingHvStatus: string | null;
  chargingPortStatus: string | null;
  preconditioningActive: boolean | null;
  lastUpdate: string | null;
  streamConnected: boolean;
  /** "idle" = nicht konfiguriert/nicht eingeloggt, "pending" = Login läuft, "authenticated" = aktiv. */
  authStatus: "idle" | "pending" | "authenticated";
}

export const BMW_DEFAULT_DESCRIPTORS = [
  "vehicle.body.chargingPort.status",
  "vehicle.drivetrain.batteryManagement.header",
  "vehicle.drivetrain.electricEngine.charging.hvStatus",
  "vehicle.drivetrain.electricEngine.charging.status",
  "vehicle.drivetrain.electricEngine.charging.timeRemaining",
  "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange",
  "vehicle.powertrain.electric.battery.stateOfCharge.target",
  "vehicle.powertrain.electric.battery.stateOfCharge.displayed",
  "vehicle.vehicle.preConditioning.activity",
  "vehicle.vehicle.travelledDistance",
] as const;

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
