import fetch from "node-fetch";
import { BmwDb } from "../db/bmwDb";

const API_BASE = "https://api-cardata.bmwgroup.com";

interface CreateContainerResponse {
  containerId: string;
}

/**
 * Legt einmalig einen CarData-"Container" an, der festlegt, welche technicalDescriptor-Keys
 * per REST abrufbar sind, und persistiert die Id für alle folgenden Starts.
 */
export async function ensureContainer(
  bmwDb: BmwDb,
  accessToken: string,
  existingContainerId: string | null,
  descriptors: string[]
): Promise<string> {
  if (existingContainerId) return existingContainerId;

  const res = await fetch(`${API_BASE}/customers/containers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "pv-charger-dashboard",
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
