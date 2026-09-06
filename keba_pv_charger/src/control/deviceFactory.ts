import { DeviceConfig, PvSourceStatus, BatteryStatus } from "../types";
import { WallboxClient } from "../wallbox/types";
import { KebaWallbox } from "../wallbox/keba";
import { GoEChargerWallbox } from "../wallbox/goecharger";
import { Shelly3EmClient } from "../energy/shelly3em";
import { FroniusClient } from "../energy/fronius";
import { StecaClient } from "../energy/steca";
import { ShellyPvSource } from "../energy/shellyPv";
import { Shelly1PmSource } from "../energy/shelly1pm";
import { VictronPvSource, VictronBatterySource } from "../energy/victronAdapters";

export function createWallboxClient(device: DeviceConfig): WallboxClient {
  if (device.deviceType === "go_echarger") {
    return new GoEChargerWallbox(device.host);
  }
  return new KebaWallbox(device.host, device.port ?? 502, device.unitId ?? 255, device.registerOffset ?? 0);
}

export function createGridClient(device: DeviceConfig): Shelly3EmClient {
  return new Shelly3EmClient(device.host, device.generation ?? "gen1", device.invert ?? false);
}

export interface Readable<T> {
  read(): Promise<T>;
}

export function createPvSourceClient(device: DeviceConfig): Readable<PvSourceStatus> {
  const label = device.name || device.deviceType;
  switch (device.deviceType) {
    case "fronius":
      return new FroniusClient(device.host);
    case "steca":
      return new StecaClient(device.host, device.xmlPath || undefined);
    case "victron":
      return new VictronPvSource(device.host, device.port ?? 502, device.unitId ?? 100, label);
    case "shelly":
      return new ShellyPvSource(device.host, device.generation ?? "gen1", label);
    case "shelly1pm":
      return new Shelly1PmSource(device.host, device.generation ?? "gen1", label);
    default:
      throw new Error(`Gerätetyp ${device.deviceType} ist keine gültige PV-Quelle`);
  }
}

export function createBatteryClient(device: DeviceConfig): Readable<BatteryStatus> {
  const label = device.name || device.deviceType;
  if (device.deviceType === "victron") {
    return new VictronBatterySource(device.host, device.port ?? 502, device.unitId ?? 100, label);
  }
  throw new Error(`Gerätetyp ${device.deviceType} ist keine gültige Batteriequelle`);
}
