// Canvas HTTP+WS proxy — THE provenance gate for canvas v2.
//
// Every byte going to/from the user's per-user Modal ComfyUI container
// passes through this route. The browser never learns the Modal URL;
// only the proxy knows it, and only the proxy is server-side trusted
// to call Modal with the shared-secret header.
//
// Provenance side-effects on the hot path:
//   - POST /prompt    — body teed; once Modal returns a prompt_id, pair
//                       it with the workflow JSON and write a
//                       canvas_pending_iterations row (lib/canvas/witness
//                       :startWorkflow). Active project resolved
//                       server-side from the user's session.
//   - GET  /view      — response body teed (output bytes); paired with
//                       the most recent pending row and pushed into
//                       ingestIteration via captureOutput. Triggers the
//                       leaf hash, witness signature, storage write.
//   - everything else — pure passthrough.
//
// WebSocket frames are handled by a separate Node sidecar
// (scripts/canvas-ws-proxy.mjs at :8190 behind a CF tunnel), because
// Next.js route handlers don't speak WS.
//
// See docs/architecture/canvas-v2.md decision 2.

import { type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import {
  startWorkflow,
  captureOutput,
  resolveActiveProjectId,
} from '@/lib/canvas/witness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CanvasSessionRow {
  id: string;
  user_id: string;
  machine_id: string;
  modal_url: string;
  status: string;
}

function getSessionRow(sessionId: string): CanvasSessionRow | null {
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

/** Build the upstream URL on the Modal endpoint for a given sub-path +
 *  the incoming request's query string (less our internal `?t=` legacy
 *  token, which should never have been here in v2 anyway). */
function buildUpstreamUrl(
  sessionRow: CanvasSessionRow,
  subPath: string,
  search: URLSearchParams,
): string {
  const base = new URL(sessionRow.modal_url);
  // Drop legacy session-token query var (was set by lib/canvas/session.ts
  // mint helper in COM-4; v2 makes session-id path-positioned instead).
  base.search = '';
  const trimmedBase = base.toString().replace(/\/?$/, '/');
  const upstream = new URL(subPath, trimmedBase);
  for (const [k, v] of search) {
    if (k === 't') continue;
    upstream.searchParams.set(k, v);
  }
  return upstream.toString();
}

async function handler(req: NextRequest, ctx: { params: Promise<{ sessionId: string; path?: string[] }> }) {
  const params = await ctx.params;
  const sessionId = params.sessionId;
  const subPath = (params.path ?? []).join('/');

  // ── Auth + session ownership ─────────────────────────────────────
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  const row = getSessionRow(sessionId);
  if (!row) {
    return new Response('Canvas session not found / expired', { status: 404 });
  }
  if (row.user_id !== userId) {
    return new Response('Forbidden', { status: 403 });
  }

  // ── Build outbound request ───────────────────────────────────────
  const upstreamUrl = buildUpstreamUrl(row, subPath, req.nextUrl.searchParams);
  const outHeaders = new Headers(req.headers);
  outHeaders.delete('host');
  outHeaders.delete('cookie'); // don't leak scruple-web cookies to Modal
  outHeaders.delete('authorization');
  const sharedSecret = process.env.SCRUPLE_CANVAS_SHARED_SECRET;
  if (sharedSecret) {
    outHeaders.set('X-Scruple-Shared-Secret', sharedSecret);
  }

  // ── Capture POST /prompt body before forwarding ──────────────────
  const isPromptPost = req.method === 'POST' && subPath === 'prompt';
  const isViewGet = req.method === 'GET' && subPath === 'view';
  let promptBodyText: string | undefined;
  let bodyToForward: BodyInit | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (isPromptPost) {
      promptBodyText = await req.text();
      bodyToForward = promptBodyText;
    } else {
      bodyToForward = await req.arrayBuffer();
    }
  }

  // ── Forward to Modal ─────────────────────────────────────────────
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: outHeaders,
      body: bodyToForward,
      // @ts-expect-error — Node-only opt for streaming bodies
      duplex: 'half',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[canvas-proxy] upstream fetch failed ${upstreamUrl}: ${message}`);
    return new Response(`Bad gateway: ${message}`, { status: 502 });
  }

  // ── Intercept hooks (fire-and-forget; never block the response) ──
  if (isPromptPost && promptBodyText) {
    try {
      const parsedReq = JSON.parse(promptBodyText) as { prompt?: Record<string, unknown> };
      const cloned = upstreamRes.clone();
      cloned
        .json()
        .then((resBody: unknown) => {
          const promptId = (resBody as { prompt_id?: string } | null)?.prompt_id;
          if (!promptId || !parsedReq.prompt) return;
          const projectId = resolveActiveProjectId(row.user_id);
          if (projectId === null) {
            console.warn(`[canvas-proxy] /prompt witnessed but no active project for ${row.user_id}; skipping`);
            return;
          }
          startWorkflow({
            sessionId: row.id,
            userId: row.user_id,
            promptId,
            projectId,
            workflowApiJson: parsedReq.prompt,
          });
        })
        .catch((e) => console.warn('[canvas-proxy] /prompt intercept parse failed', e));
    } catch (e) {
      console.warn('[canvas-proxy] /prompt intercept failed', e);
    }
  }

  if (isViewGet && upstreamRes.ok) {
    const filename = req.nextUrl.searchParams.get('filename');
    if (filename) {
      const cloned = upstreamRes.clone();
      cloned
        .arrayBuffer()
        .then((ab) => {
          const buf = Buffer.from(ab);
          const contentType =
            upstreamRes.headers.get('content-type') ?? 'application/octet-stream';
          return captureOutput({
            sessionId: row.id,
            userId: row.user_id,
            machineId: row.machine_id,
            filename,
            bytes: buf,
            contentType,
          });
        })
        .catch((e) => console.warn('[canvas-proxy] /view capture failed', e));
    }
  }

  // ── Stream response back to the browser ──────────────────────────
  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.delete('access-control-allow-origin');
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const OPTIONS = handler;
export const HEAD = handler;
