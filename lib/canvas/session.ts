// Per-user canvas session helpers.
//
// A canvas session is a (user, machine) pair pointing at a Modal-hosted
// ComfyUI container. The session_token is an HMAC of {id, user_id,
// expires_at} that the canvas page sends back on every witness POST so
// the scruple-web server can attribute incoming events to the right
// user without trusting the canvas iframe to be honest about identity.
//
// See docs/architecture/canvas-v2.md for the architecture (WO-4 will
// replace the iframe-direct-to-Modal pattern with an HTTP+WS proxy
// that captures workflow + outputs server-side; tokens become opaque
// session ids inside the proxy URL path).
//
// Schema: lib/db/migrations/020_canvas_sessions.sql.
// Catalog: lib/compute/machines.ts.
// Canvas v2 (WO-2): no tier-gating. Stripe-card requirement is added
// in WO-6's session lifecycle.

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { conn } from '@/lib/db/sqlite';
import { getMachineById } from '@/lib/compute/machines';

const HMAC_KEY = process.env.AUTH_SECRET ?? '';
if (!HMAC_KEY) {
  // Don't throw at import-time — auth.ts handles that — but warn loud
  // so the canvas session feature surfaces the misconfig instead of
  // silently issuing tokens with an empty key.
  console.warn('[canvas/session] AUTH_SECRET not set; canvas tokens will be unsigned');
}

const DEFAULT_SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour, matches Modal timeout

export interface CanvasSessionRow {
  id: string;
  user_id: string;
  machine_id: string;
  modal_url: string;
  signed_token: string;
  started_at: string;
  last_activity_at: string;
  expires_at: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface VerifiedToken {
  sessionId: string;
  userId: string;
  machineId: string;
}

/**
 * Read the per-machine canvas Modal URL from env. Set by the user
 * after running `modal deploy modal/canvas_app.py` (see WO Deferred
 * Follow-ups). Returns null when the env var is missing → caller
 * surfaces a clear "Canvas not yet deployed for this GPU class" error
 * rather than the silent fallback used by the per-request runner.
 */
export function getCanvasUrlForMachine(machineId: string): string | null {
  const machine = getMachineById(machineId);
  if (!machine) return null;
  // Env var convention: MODAL_CANVAS_APP_URL_<MACHINE_ID_UPPER_WITH_UNDERSCORES>
  // e.g. t4-free → MODAL_CANVAS_APP_URL_T4_FREE
  const key = `MODAL_CANVAS_APP_URL_${machineId.toUpperCase().replace(/-/g, '_')}`;
  return process.env[key] ?? null;
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', HMAC_KEY).update(payload).digest('hex');
}

function tokenBody(sessionId: string, userId: string, machineId: string, expiresAt: string): string {
  // Compact JSON; field order matters for HMAC reproducibility.
  return JSON.stringify({ s: sessionId, u: userId, m: machineId, e: expiresAt });
}

function signedTokenFor(sessionId: string, userId: string, machineId: string, expiresAt: string): string {
  const body = tokenBody(sessionId, userId, machineId, expiresAt);
  const sig = hmac(body);
  // base64url(body) + '.' + sig — opaque to the canvas, verifiable server-side
  return Buffer.from(body, 'utf8').toString('base64url') + '.' + sig;
}

export function verifyCanvasToken(token: string): VerifiedToken | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const bodyB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = hmac(body);
  // Constant-time compare
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  let parsed: { s?: string; u?: string; m?: string; e?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed.s || !parsed.u || !parsed.m || !parsed.e) return null;
  if (new Date(parsed.e).getTime() < Date.now()) return null;
  return { sessionId: parsed.s, userId: parsed.u, machineId: parsed.m };
}

export interface MintedSession {
  id: string;
  signedToken: string;
  modalUrl: string;
  expiresAt: string;
}

/**
 * Mint a new session for the user on the chosen machine. Revokes any
 * existing active session for the user first (one-active-per-user rule).
 *
 * Throws when:
 *   - machine_id is not in the catalog
 *   - the per-machine Modal URL env var is unset (deploy not done yet)
 *
 * Tier-gating is the caller's job — this helper trusts the input.
 */
export function mintCanvasSession(userId: string, machineId: string): MintedSession {
  const machine = getMachineById(machineId);
  if (!machine) throw new Error(`Unknown machine_id: ${machineId}`);
  const baseUrl = getCanvasUrlForMachine(machineId);
  if (!baseUrl) {
    throw new Error(
      `Canvas not deployed for ${machineId}. Set ${
        `MODAL_CANVAS_APP_URL_${machineId.toUpperCase().replace(/-/g, '_')}`
      } after running modal deploy modal/canvas_app.py.`,
    );
  }

  // Revoke any prior active session.
  conn()
    .prepare(`UPDATE canvas_sessions SET status = 'revoked' WHERE user_id = ? AND status = 'active'`)
    .run(userId);

  const id = `cs_${nanoid(10)}`;
  const expiresAtMs = Date.now() + DEFAULT_SESSION_DURATION_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  // Canvas v2 (WO-5): signed_token kept for back-compat schema but
  // unused by the proxy flow — the proxy authenticates via the
  // sessionId+user_id row lookup, never via a token in URL.
  const signedToken = signedTokenFor(id, userId, machineId, expiresAt);

  // modal_url stored verbatim WITHOUT a ?t= query param. Only the
  // server-side proxy reads it; the browser never sees the Modal URL.
  // The proxy URL exposed to the browser is `/canvas-proxy/<id>/`.
  // payment_status defaults to 'none' here; WO-6 path mints the Stripe
  // hold via createCanvasHold() right after this insert.
  conn()
    .prepare(
      `INSERT INTO canvas_sessions
         (id, user_id, machine_id, modal_url, signed_token, expires_at, last_heartbeat)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
    )
    .run(id, userId, machineId, baseUrl, signedToken, expiresAt);

  return { id, signedToken, modalUrl: baseUrl, expiresAt };
}

/** The browser-facing URL for a session — points at the scruple-web
 *  proxy, never at the underlying Modal endpoint directly. */
export function proxyUrlForSession(sessionId: string): string {
  return `/canvas-proxy/${sessionId}/`;
}

/**
 * Mint a session AND create the Stripe pre-auth hold in one
 * orchestrated call. Used by both /api/canvas/session POST and the
 * server-side mint in /canvas/page.tsx so the Stripe state always
 * matches the canvas_sessions row.
 *
 * If the hold fails (no card on file, payment method invalid, Stripe
 * down), the mint is rolled back so the session row never exists
 * without a corresponding PaymentIntent.
 *
 * Throws CanvasMintError with a user-facing `code` so the caller can
 * decide how to surface it (`no_card`, `stripe_down`, `not_deployed`).
 */
export class CanvasMintError extends Error {
  constructor(
    public code: 'no_card' | 'stripe_down' | 'not_deployed' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'CanvasMintError';
  }
}

import { ensureStripeCustomer } from '@/lib/stripe/customer';
import { createCanvasHold } from '@/lib/stripe/canvas';

/** Comma-separated emails from SCRUPLE_CANVAS_BILLING_BYPASS_EMAILS.
 *  When the signed-in user's email matches, the Stripe hold is skipped
 *  and a synthetic paymentIntentId is stamped instead. Never active in
 *  production builds (guarded by NODE_ENV != 'production'). */
function isBillingBypassed(userEmail: string | null | undefined): boolean {
  if (!userEmail) return false;
  if (process.env.NODE_ENV === 'production') return false;
  const raw = process.env.SCRUPLE_CANVAS_BILLING_BYPASS_EMAILS ?? '';
  if (!raw.trim()) return false;
  const allow = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(userEmail.toLowerCase());
}

export async function mintCanvasSessionWithBilling(
  userId: string,
  machineId: string,
  userEmail?: string | null,
): Promise<MintedSession & { paymentIntentId: string; holdCents: number }> {
  let minted: MintedSession;
  try {
    minted = mintCanvasSession(userId, machineId);
  } catch (e) {
    throw new CanvasMintError(
      'not_deployed',
      e instanceof Error ? e.message : String(e),
    );
  }

  // Dev bypass — allowlisted emails skip Stripe entirely (dev env only).
  if (isBillingBypassed(userEmail)) {
    console.log(`[canvas] billing bypass for ${userEmail} (SCRUPLE_CANVAS_BILLING_BYPASS_EMAILS)`);
    return {
      ...minted,
      paymentIntentId: `dev_bypass_canvas_${Date.now()}`,
      holdCents: 0,
    };
  }

  try {
    const customerId = await ensureStripeCustomer(userId);
    const hold = await createCanvasHold({
      sessionId: minted.id,
      userId,
      customerId,
      machineId,
    });
    return { ...minted, paymentIntentId: hold.paymentIntentId, holdCents: hold.holdCents };
  } catch (e) {
    // Roll back the session row — never leave a row without a hold.
    revokeCanvasSession(minted.id, userId);
    const message = e instanceof Error ? e.message : String(e);
    if (/payment method/i.test(message) || /no payment/i.test(message)) {
      throw new CanvasMintError('no_card', message);
    }
    throw new CanvasMintError('stripe_down', message);
  }
}

export function getActiveCanvasSession(userId: string): CanvasSessionRow | null {
  const row = conn()
    .prepare(
      `SELECT * FROM canvas_sessions
        WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now')
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId) as CanvasSessionRow | undefined;
  return row ?? null;
}

export function revokeCanvasSession(sessionId: string, userId: string): boolean {
  const result = conn()
    .prepare(
      `UPDATE canvas_sessions
          SET status = 'revoked'
        WHERE id = ? AND user_id = ? AND status = 'active'`,
    )
    .run(sessionId, userId);
  return result.changes > 0;
}

export function touchCanvasSession(sessionId: string): void {
  conn()
    .prepare(
      `UPDATE canvas_sessions
          SET last_activity_at = datetime('now')
        WHERE id = ? AND status = 'active'`,
    )
    .run(sessionId);
}
