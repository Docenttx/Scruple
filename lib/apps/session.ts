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

function signedTokenFor(id: string, userId: string, appId: string, expiresAt: string): string {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
  if (!secret) throw new Error('AUTH_SECRET / NEXTAUTH_SECRET not set');
  const h = crypto.createHmac('sha256', secret);
  h.update(`${id}\n${userId}\n${appId}\n${expiresAt}`);
  return h.digest('hex').slice(0, 32);
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

  const spawned = await backend.spawnEndpoint({
    userId,
    machineId,
    appId,
    sessionId: id,
  });

  const expiresAt = new Date(Date.now() + DEFAULT_APP_SESSION_MS).toISOString();
  const signedToken = signedTokenFor(id, userId, appId, expiresAt);
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
