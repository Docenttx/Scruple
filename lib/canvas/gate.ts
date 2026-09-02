// Canvas's half of the gate: the five things the component does not do.
//
// THE COMPONENT IS DELIBERATELY SINGLE-UPSTREAM. `services/scruple-capture`
// takes one `SCRUPLE_CAPTURE_UPSTREAM_URL`, resolved once at start-up, and
// its config refuses to start without it. That is correct for a sidecar the
// vendor deploys next to one ComfyUI. Canvas resolves a DIFFERENT upstream
// per request, from `canvas_sessions.modal_url`, after checking that the
// NextAuth principal owns that session. Those two facts are the whole reason
// this file exists rather than a call into `HttpGate`.
//
// Everything here is TRANSPORT AND AUTHORISATION. Nothing here decides what
// gets captured — `lib/canvas/egress.ts` does that, from the component's own
// route table, and `lib/canvas/capture.ts` decides what a capture means.
// Keeping the split in the same places the component keeps it is what makes
// this a re-platform rather than a second implementation.
//
// The five behaviours WO-7's report says canvas needs on top, and where each
// one lives, so that a later reader can check none was dropped:
//
//   1. per-session routing              getSessionRow() + buildUpstreamUrl()
//   2. X-Scruple-Shared-Secret          upstreamHeaders()
//   3. NextAuth ownership check         authorizeSession()
//   4. `?t=` legacy-token strip         buildUpstreamUrl()
//   5. 30s bidirectional keepalive      scripts/canvas-ws-proxy.mjs, and
//                                       KEEPALIVE_INTERVAL_MS below
//
// Each has a test in test/v2/canvas-retrofit.test.ts named after it.

import { conn } from '@/lib/db/sqlite';

export interface CanvasSessionRow {
  id: string;
  user_id: string;
  machine_id: string;
  modal_url: string;
  status: string;
}

/**
 * (5) THE KEEPALIVE, and why it is a provenance control rather than a
 * comfort feature.
 *
 * Cloudflare and Modal close an idle tunnel at roughly 100-125 seconds. A
 * long generation produces no WS traffic for minutes at a time. Without a
 * ping on BOTH legs the socket dies mid-run, the browser reconnects with a
 * fresh clientId, and ComfyUI's `executing` / `execution_success` messages —
 * which route with broadcast=False to the ORIGINAL clientId — go to a socket
 * nobody is reading.
 *
 * The visible symptom is a missing leaf. The cause is a timeout. Anyone
 * debugging that starts in the witness path and finds nothing wrong there,
 * which is why this constant is documented here and asserted in the tests
 * rather than left as an interval literal in a script.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

export function getSessionRow(sessionId: string): CanvasSessionRow | null {
  return (
    (conn()
      .prepare(
        `SELECT id, user_id, machine_id, modal_url, status
           FROM canvas_sessions
          WHERE id = ?
            AND status = 'active'
            AND expires_at > datetime('now')`,
      )
      .get(sessionId) as CanvasSessionRow | undefined) ?? null
  );
}

export type Authorisation = 'ok' | 'not-found' | 'forbidden';

/**
 * (3) P4, and it is the reason canvas passes P4 while the pod-side shells do
 * not: the end user supplies a session id, never a user id and never a
 * project id. Both are resolved server-side from the authenticated
 * principal. A session id that exists but belongs to someone else is
 * `forbidden`, not `not-found` — the row was found, and pretending otherwise
 * would hide an ownership violation inside an expiry.
 */
export function authorizeSession(
  row: CanvasSessionRow | null,
  userId: string | undefined,
): Authorisation {
  if (!userId) return 'forbidden';
  if (!row) return 'not-found';
  return row.user_id === userId ? 'ok' : 'forbidden';
}

/**
 * (1) and (4). Build the upstream URL on this session's Modal endpoint.
 *
 * The `?t=` strip is not cosmetic. It was a session token minted into the
 * query string by the pre-v2 design (COM-4); v2 makes the session id
 * path-positioned and server-resolved instead. Forwarding it would push a
 * credential-shaped value into Modal's access logs for a credential that no
 * longer authorises anything — the worst of both, a secret in a log that
 * cannot even be revoked because nothing reads it.
 */
export function buildUpstreamUrl(
  modalUrl: string,
  subPath: string,
  search: URLSearchParams,
): string {
  const base = new URL(modalUrl);
  base.search = '';
  const trimmedBase = base.toString().replace(/\/?$/, '/');
  const upstream = new URL(subPath, trimmedBase);
  for (const [k, v] of search) {
    if (k === 't') continue;
    upstream.searchParams.set(k, v);
  }
  return upstream.toString();
}

/**
 * (2) P3. The shared secret is held by the proxy and the WS sidecar, both
 * server-side; the browser receives a session id, not a credential, and
 * never the upstream URL.
 *
 * The three deletes are the other half of that claim and are load-bearing in
 * the opposite direction: scruple-web's own cookies and Authorization header
 * must not cross into a Modal container. `X-Scruple-Shared-Secret` is set
 * LAST so that a request arriving with that header already on it cannot
 * smuggle a value through — the tenant's browser is upstream of this
 * function.
 */
export function upstreamHeaders(
  incoming: Headers,
  sharedSecret = process.env.SCRUPLE_CANVAS_SHARED_SECRET,
  opts: { stripRange?: boolean } = {},
): Headers {
  const out = new Headers(incoming);
  out.delete('host');
  out.delete('cookie');
  out.delete('authorization');
  out.delete('x-scruple-shared-secret');
  // A gzipped body would hash to something no holder of the artifact could
  // reproduce, and `as-delivered` fidelity means the bytes the consumer
  // keeps. Same reason and same line as the component's outboundHeaders().
  out.set('accept-encoding', 'identity');
  // WO-32 — the same reason, one status code further along.
  //
  // A browser scrubbing a video sends `Range`. This header was forwarded,
  // Modal answered 206 with a FRAGMENT, and the capture gate read
  // `upstreamRes.ok` — true for every 2xx, 206 included. So the fragment
  // was hashed and written as though it were the artifact: a content_hash
  // for bytes that are not the work, minted silently, once per scrub.
  //
  // A partial body hashes to something no holder of the artifact can
  // reproduce — the accept-encoding sentence above, verbatim. On a route
  // whose bytes become evidence there is no such thing as a partial
  // artifact, so the request is normalised to the whole resource before it
  // is asked for. Costs a full body on a scrub; buys a hash that means
  // what it says.
  if (opts.stripRange) {
    out.delete('range');
    out.delete('if-range');
  }
  if (sharedSecret) out.set('X-Scruple-Shared-Secret', sharedSecret);
  return out;
}
