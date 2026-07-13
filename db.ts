import { AppSettings } from "../types";
import { WallboxClient } from "./types";
import { KebaWallbox } from "./keba";
import { GoEChargerWallbox } from "./goecharger";

export function createWallboxClient(settings: AppSettings): WallboxClient {
  if (settings.wallboxType === "go_echarger") {
    return new GoEChargerWallbox(settings.wallboxHost);
  }
  return new KebaWallbox(settings.wallboxHost, settings.wallboxPort, settings.wallboxUnitId);
}
