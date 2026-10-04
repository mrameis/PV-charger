import Database from "better-sqlite3";
import { BmwConfig, BmwTokenSet, BMW_DEFAULT_DESCRIPTORS } from "../types";

interface BmwConfigRow {
  client_id: string;
  vin: string;
  container_id: string | null;
  descriptors: string | null;
  enabled: number;
}

interface BmwTokensRow {
  access_token: string;
  refresh_token: string;
  id_token: string;
  gcid: string;
  access_expires_at: number;
  id_expires_at: number;
  refresh_expires_at: number;
}

export class BmwDb {
  constructor(private db: Database.Database) {}

  // ---- Konfiguration (Client-ID, VIN, Container, aktive Descriptor-Keys) ----

  getConfig(): BmwConfig | null {
    const row = this.db
      .prepare(`SELECT client_id, vin, container_id, descriptors, enabled FROM bmw_config WHERE id = 1`)
      .get() as BmwConfigRow | undefined;
    if (!row || !row.client_id || !row.vin) return null;
    return {
      clientId: row.client_id,
      vin: row.vin,
      containerId: row.container_id,
      descriptors: row.descriptors ? JSON.parse(row.descriptors) : [...BMW_DEFAULT_DESCRIPTORS],
      enabled: !!row.enabled,
    };
  }

  saveConfig(config: BmwConfig): void {
    this.db
      .prepare(
        `INSERT INTO bmw_config (id, client_id, vin, container_id, descriptors, enabled)
         VALUES (1, @clientId, @vin, @containerId, @descriptors, @enabled)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           vin = excluded.vin,
           container_id = excluded.container_id,
           descriptors = excluded.descriptors,
           enabled = excluded.enabled`
      )
      .run({
        clientId: config.clientId,
        vin: config.vin,
        containerId: config.containerId,
        descriptors: JSON.stringify(config.descriptors),
        enabled: config.enabled ? 1 : 0,
      });
  }

  saveContainerId(containerId: string): void {
    this.db.prepare(`UPDATE bmw_config SET container_id = ? WHERE id = 1`).run(containerId);
  }

  setEnabled(enabled: boolean): void {
    this.db.prepare(`UPDATE bmw_config SET enabled = ? WHERE id = 1`).run(enabled ? 1 : 0);
  }

  // ---- Tokens ----

  getTokens(): BmwTokenSet | null {
    const row = this.db
      .prepare(
        `SELECT access_token, refresh_token, id_token, gcid, access_expires_at, id_expires_at, refresh_expires_at
         FROM bmw_tokens WHERE id = 1`
      )
      .get() as BmwTokensRow | undefined;
    if (!row || !row.access_token) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      idToken: row.id_token,
      gcid: row.gcid,
      accessExpiresAt: row.access_expires_at,
      idExpiresAt: row.id_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
    };
  }

  saveTokens(tokens: BmwTokenSet): void {
    this.db
      .prepare(
        `INSERT INTO bmw_tokens (id, access_token, refresh_token, id_token, gcid, access_expires_at, id_expires_at, refresh_expires_at)
         VALUES (1, @accessToken, @refreshToken, @idToken, @gcid, @accessExpiresAt, @idExpiresAt, @refreshExpiresAt)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           id_token = excluded.id_token,
           gcid = excluded.gcid,
           access_expires_at = excluded.access_expires_at,
           id_expires_at = excluded.id_expires_at,
           refresh_expires_at = excluded.refresh_expires_at`
      )
      .run(tokens);
  }

  clearTokens(): void {
    this.db.prepare(`DELETE FROM bmw_tokens WHERE id = 1`).run();
  }

  // ---- Live-Zustand (letzte bekannte Werte je Descriptor, für Neustarts) ----

  upsertState(descriptor: string, value: string | number | null, unit: string | null, timestamp: string | null): void {
    this.db
      .prepare(
        `INSERT INTO bmw_state (descriptor, value, unit, timestamp)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(descriptor) DO UPDATE SET
           value = excluded.value,
           unit = excluded.unit,
           timestamp = excluded.timestamp
         WHERE excluded.timestamp IS NULL OR bmw_state.timestamp IS NULL OR excluded.timestamp >= bmw_state.timestamp`
      )
      .run(descriptor, value === null ? null : String(value), unit, timestamp);
  }
}
