import { randomBytes, createHash } from "crypto";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import { logger } from "../logger";
import { BmwDb } from "../db/bmwDb";
import { BmwTokenSet } from "../types";

const GCDM_BASE = "https://customer.bmwgroup.com";
const SCOPES = "authenticate_user openid cardata:streaming:read cardata:api:read";

export interface BmwDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export interface BmwPendingAuth {
  deviceCode: string;
  codeVerifier: string;
  interval: number;
  expiresAt: number;
  verificationUriComplete: string;
  userCode: string;
}

interface BmwTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token: string;
  gcid: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Schritt 1 des Device Code Flow: Codes anfordern. Das Ergebnis (verificationUriComplete
 * + userCode) wird dem Nutzer im Dashboard angezeigt, damit er sich im Browser einloggt.
 */
export async function requestDeviceCode(clientId: string): Promise<BmwPendingAuth> {
  const { verifier, challenge } = generatePkce();

  const res = await fetch(`${GCDM_BASE}/gcdm/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      response_type: "device_code",
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });

  if (!res.ok) {
    throw new Error(`BMW device/code fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as BmwDeviceCodeResponse;

  return {
    deviceCode: data.device_code,
    codeVerifier: verifier,
    interval: data.interval || 5,
    expiresAt: Date.now() + data.expires_in * 1000,
    verificationUriComplete: data.verification_uri_complete,
    userCode: data.user_code,
  };
}

function tokenResponseToSet(data: BmwTokenResponse): BmwTokenSet {
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    gcid: data.gcid,
    accessExpiresAt: now + data.expires_in * 1000,
    idExpiresAt: now + data.expires_in * 1000,
    // refresh_token ist laut BMW-Doku 14 Tage gültig
    refreshExpiresAt: now + 14 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Schritt 2: Auf die Nutzer-Bestätigung pollen. Gibt null zurück, solange der
 * Nutzer noch nicht bestätigt hat (authorization_pending) - kein Fehler.
 * Wirft, wenn der device_code abgelaufen ist -> Auth-Flow muss neu gestartet werden.
 */
export async function pollDeviceToken(clientId: string, pending: BmwPendingAuth): Promise<BmwTokenSet | null> {
  if (Date.now() > pending.expiresAt) {
    throw new Error("BMW device code abgelaufen - Auth-Flow muss neu gestartet werden");
  }

  const res = await fetch(`${GCDM_BASE}/gcdm/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      code_verifier: pending.codeVerifier,
    }),
  });

  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "authorization_pending" || body.error === "slow_down") return null;
    throw new Error(`BMW token-Fehler: ${JSON.stringify(body)}`);
  }

  if (!res.ok) {
    throw new Error(`BMW device/token fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  return tokenResponseToSet((await res.json()) as BmwTokenResponse);
}

export async function refreshTokens(clientId: string, refreshToken: string): Promise<BmwTokenSet> {
  const res = await fetch(`${GCDM_BASE}/gcdm/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    throw new Error(`BMW Token-Refresh fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  return tokenResponseToSet((await res.json()) as BmwTokenResponse);
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 Minuten Puffer vor Ablauf refreshen

/**
 * Liefert einen garantiert gültigen Access-/ID-Token, refresht bei Bedarf automatisch
 * und persistiert das Ergebnis. Wirft "BMW_NOT_AUTHENTICATED" bzw. "BMW_REFRESH_EXPIRED",
 * falls der Nutzer den Device-Code-Flow (erneut) durchlaufen muss.
 */
export async function ensureValidTokens(db: Database.Database, bmwDb: BmwDb, clientId: string): Promise<BmwTokenSet> {
  const tokens = bmwDb.getTokens();
  if (!tokens) throw new Error("BMW_NOT_AUTHENTICATED");

  if (Date.now() > tokens.refreshExpiresAt) {
    bmwDb.clearTokens();
    throw new Error("BMW_REFRESH_EXPIRED");
  }

  const needsRefresh =
    Date.now() > tokens.accessExpiresAt - REFRESH_MARGIN_MS || Date.now() > tokens.idExpiresAt - REFRESH_MARGIN_MS;
  if (!needsRefresh) return tokens;

  logger.debug("[bmw] Token-Refresh...");
  const refreshed = await refreshTokens(clientId, tokens.refreshToken);
  bmwDb.saveTokens(refreshed);
  return refreshed;
}
