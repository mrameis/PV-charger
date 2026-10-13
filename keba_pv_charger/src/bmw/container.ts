import fetch from "node-fetch";
import { BmwDb } from "../db/bmwDb";

const API_BASE = "https://api-cardata.bmwgroup.com";
const CONTAINER_NAME = "pv-charger-dashboard";

/** BMW verlangt bei JEDEM CarData-Request den Header x-version (sonst 403 TP-403). */
export function bmwHeaders(accessToken: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "x-version": "v1",
    Accept: "application/json",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

interface ContainerInfo {
  containerId: string;
  name?: string;
  state?: string;
}

interface CreateContainerResponse {
  containerId: string;
}

/**
 * Legt einmalig einen CarData-"Container" an (oder verwendet einen bereits
 * vorhandenen gleichen Namens wieder - BMW erlaubt max. 10 pro Nutzer) und
 * persistiert die Id fuer alle folgenden Starts.
 */
export async function ensureContainer(
  bmwDb: BmwDb,
  accessToken: string,
  existingContainerId: string | null,
  descriptors: string[]
): Promise<string> {
  if (existingContainerId) return existingContainerId;

  const listRes = await fetch(`${API_BASE}/customers/containers`, { headers: bmwHeaders(accessToken) });
  if (listRes.ok) {
    const list = (await listRes.json()) as { containers?: ContainerInfo[] };
    const found = (list.containers ?? []).find((c) => c.name === CONTAINER_NAME && c.state !== "INACTIVE");
    if (found) {
      bmwDb.saveContainerId(found.containerId);
      return found.containerId;
    }
  }

  const res = await fetch(`${API_BASE}/customers/containers`, {
    method: "POST",
    headers: bmwHeaders(accessToken, true),
    body: JSON.stringify({
      name: CONTAINER_NAME,
      purpose: "PV-Charger Dashboard - Anzeige von Akkustand und Ladezustand",
      technicalDescriptors: descriptors,
    }),
  });

  if (!res.ok) {
    throw new Error(`BMW Container-Anlage fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as CreateContainerResponse;
  bmwDb.saveContainerId(data.containerId);
  return data.containerId;
}
