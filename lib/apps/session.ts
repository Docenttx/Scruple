// Generic app-session helpers — WO-KOHYA Phase 2.
//
// Parallels lib/canvas/session.ts but backend-neutral: mints a row in
// app_sessions and calls whichever backend spawns the endpoint (Modal
// or RunPod) via lib/apps/session-backends.ts.
//
// Canvas keeps its own session table for now (canvas_sessions) — this
// module supports the new apps (Kohya first). We can migrate Canvas
// later.

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { conn } from '@/lib/db/sqlite';
import { getApp } from './registry';
import type { AppId } from './session-backends';
import { getSessionBackend } from './session-backends';
import '@/lib/apps/backends'; // side-effect: register modal + runpod

export const DEFAULT_APP_SESSION_MS = 60 * 60 * 1000; // 1h

export interface AppSessionRow {
  id: string;
  user_id: string;
  app_id: AppId;
  backend: 'modal' | 'runpod' | 'local';
  machine_id: string;
  endpoint_id: string;
  endpoint_url: string;
  hourly_rate_cents: number;
  signed_token: string;
  started_at: string;
  last_activity_at: string;
  expires_at: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface MintedAppSession {
  id: string;
  appId: AppId;
  endpointUrl: string;
  signedToken: string;
  expiresAt: string;
  hourlyRateCents: number;
  backendMessage?: string;
}

/**
 * The per-session credential — WO-12.
 *
 * WAS: HMAC(AUTH_SECRET, id | userId | appId | expiresAt), truncated to 128
 * bits. Nothing ever recomputed it — every consumer compares against the
 * stored column — so the derivation bought nothing and cost something: it made
 * every session token a deterministic function of one global secret over four
 * values an attacker mostly knows.
 *
 * NOW: 256 bits of CSPRNG, stored, compared. It is a capability, not a
 * derivation, and it is what WO-12 hands the pod in place of
 * SCRUPLE_APPS_WITNESS_SECRET.
 *
 * WHAT THIS CREDENTIAL IS AND IS NOT. It authenticates a SELF-DECLARATION by
 * the party being measured, scoped to one session, expiring with it and
 * revocable with it. It does not fix P3 and is not offered as a fix: P3 is
 * about custody, not scope, and this key still lives in a shell the tenant
 * controls (STUDIO_P1-P8_GRADE.md, Path B, P3; H4-DUKPT-CAPTURE-COMPONENT.md
 * preamble). What it does is retire a credential that authenticated EVERY
 * user's traffic in favour of one that authenticates one session's, so that a
 * path which may never produce a leaf also cannot forge another tenant's
 * records. The ceiling stays `witnessed: false`.
 */
function mintSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Mint a new app session for the user on the chosen machine.
 *  Revokes any prior active session for (user, app). Spawns the
 *  endpoint via the app's backend. */
export async function mintAppSession(
  userId: string,
  appId: AppId,
  machineId: string,
): Promise<MintedAppSession> {
  const app = getApp(appId);
  if (!app) throw new Error(`Unknown app id '${appId}'`);
  if (app.backend === 'local') {
    throw new Error(`App '${appId}' is local — no session to mint`);
  }
  if (!app.enabled) {
    throw new Error(
      `App '${appId}' disabled — its backend (${app.backend}) is not configured`,
    );
  }

  // Revoke any prior active session for (user, app).
  conn()
    .prepare(
      `UPDATE app_sessions
          SET status = 'revoked'
        WHERE user_id = ? AND app_id = ? AND status = 'active'`,
    )
    .run(userId, appId);

  const backend = getSessionBackend(app.backend);
  const id = `as_${nanoid(10)}`;

  // Minted BEFORE the spawn, because the backend has to hand it to the
  // workload — that is the whole of WO-12's custody change on this path. It
  // is deliberately independent of `expiresAt`, which is only known after a
  // spawn that can take minutes; the token is a random capability and the
  // expiry lives in the row, where the route reads it.
  const sessionToken = mintSessionToken();

  const spawned = await backend.spawnEndpoint({
    userId,
    machineId,
    appId,
    sessionId: id,
    sessionToken,
  });

  const expiresAt = new Date(Date.now() + DEFAULT_APP_SESSION_MS).toISOString();
  const signedToken = sessionToken;
  const hourlyRateCents = backend.pricePerHourCents(machineId);

  conn()
    .prepare(
      `INSERT INTO app_sessions
         (id, user_id, app_id, backend, machine_id, endpoint_id, endpoint_url,
          hourly_rate_cents, signed_token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      appId,
      spawned.backend,
      machineId,
      spawned.endpointId,
      spawned.url,
      hourlyRateCents,
      signedToken,
      expiresAt,
    );

  return {
    id,
    appId,
    endpointUrl: spawned.url,
    signedToken,
    expiresAt,
    hourlyRateCents,
    backendMessage: spawned.message,
  };
}

export function getActiveAppSession(userId: string, appId: AppId): AppSessionRow | null {
  const row = conn()
    .prepare(
      `SELECT * FROM app_sessions
        WHERE user_id = ? AND app_id = ?
          AND status = 'active'
          AND expires_at > datetime('now')
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId, appId) as AppSessionRow | undefined;
  return row ?? null;
}

export function getAppSessionById(sessionId: string): AppSessionRow | null {
  const row = conn()
    .prepare(`SELECT * FROM app_sessions WHERE id = ?`)
    .get(sessionId) as AppSessionRow | undefined;
  return row ?? null;
}

/** Revoke and best-effort terminate the endpoint on the backend. */
export async function revokeAppSession(sessionId: string, userId: string): Promise<boolean> {
  const row = getAppSessionById(sessionId);
  if (!row || row.user_id !== userId || row.status !== 'active') return false;

  conn()
    .prepare(`UPDATE app_sessions SET status = 'revoked' WHERE id = ?`)
    .run(sessionId);

  const backend = getSessionBackend(row.backend as 'modal' | 'runpod');
  await backend.terminateEndpoint(row.endpoint_id);
  return true;
}

/** Proxy URL the browser iframes — same pattern as canvas. */
export function proxyUrlForAppSession(appId: AppId, sessionId: string): string {
  const app = getApp(appId);
  if (!app || !app.proxyRoute) {
    throw new Error(`App '${appId}' has no proxy route`);
  }
  return `${app.proxyRoute}/${sessionId}`;
}
