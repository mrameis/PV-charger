import { WallboxStatus } from "../types";

/** Gemeinsame Schnittstelle für alle unterstützten Wallbox-Treiber. */
export interface WallboxClient {
  readStatus(): Promise<WallboxStatus>;
  /** amps <= 0 bedeutet "pausieren" (Interpretation ist treiberspezifisch). */
  setChargingCurrentA(amps: number): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  setPhases(phases: 1 | 3): Promise<void>;
  close(): Promise<void>;
}
