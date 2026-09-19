import fetch from "node-fetch";

const API_BASE = "https://api-cardata.bmwgroup.com";

export interface BmwTelematicEntry {
  timestamp: string | null;
  unit: string | null;
  value: string | number | null;
}

interface BmwRestTelematicResponse {
  telematicData: Record<string, BmwTelematicEntry>;
}

/**
 * Genau EIN Anwendungsfall: die einmalige Cache-Hydration beim Start/Reconnect
 * (evcc-Pattern). NICHT für zyklisches Polling verwenden - die BMW-API erlaubt
 * nur 50 Requests/Tag. Live-Updates kommen ausschließlich über streaming.ts (MQTT).
 */
export async function fetchTelematicDataOnce(
  accessToken: string,
  vin: string,
  containerId: string
): Promise<Record<string, BmwTelematicEntry>> {
  const res = await fetch(
    `${API_BASE}/customers/vehicles/${vin}/telematicData?containerId=${encodeURIComponent(containerId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (res.status === 429 || res.status === 403) {
    throw new Error("BMW_RATE_LIMIT: Tageslimit von 50 REST-Requests erreicht");
  }
  if (!res.ok) {
    throw new Error(`BMW telematicData fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as BmwRestTelematicResponse;
  return data.telematicData;
}
