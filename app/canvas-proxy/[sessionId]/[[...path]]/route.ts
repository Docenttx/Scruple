// Canvas HTTP proxy — THE provenance gate for canvas v2, re-platformed onto
// the capture component (WO-10).
//
// Every byte going to and from the user's per-user Modal ComfyUI container
// passes through this route. The browser never learns the Modal URL; only
// the proxy knows it, and only the proxy is server-side trusted to call
// Modal with the shared-secret header.
//
// ── WHAT THIS ROUTE STILL OWNS, AND WHAT MOVED ────────────────────────
//
// The component (`services/scruple-capture`) is deliberately single-upstream
// and speaks raw `node:http`. A Next route handler has neither: it gets a
// `NextRequest`, returns a `Response`, and resolves a different upstream per
// request from `canvas_sessions.modal_url`. So the TRANSPORT stays here and
// the DECISIONS move out, into modules the two legs of canvas share:
//
//   lib/canvas/gate.ts       per-session routing, ownership, `?t=` strip,
//                            the shared-secret header, the keepalive constant
//   lib/canvas/egress.ts     WHICH routes carry artifact bytes — the
//                            component's own BYTE_EGRESS table (§10 C-7),
//                            plus the tripwire for routes nobody enumerated
//   lib/canvas/correlate.ts  the component's correlator, persisted, because
//                            canvas's WS leg is a different process
//   lib/canvas/witness.ts    what a capture MEANS, and what a failed one does
//
// Provenance side-effects on the hot path:
//   - POST /prompt        body teed; once Modal returns a prompt_id, pair it
//                         with the workflow JSON and open the pending row
//                         with its writing nodes pinned on it. Active project
//                         resolved server-side from the user's session.
//   - byte-egress routes  BUFFERED, never streamed, and the capture row is
//                         written BEFORE a byte reaches the browser. `/view`
//                         is one of five (H-4 §10 C-7); gating only `/view`
//                         was the narrower gate the grade found.
//   - everything else     passthrough, past the tripwire.
//
// WebSocket frames are handled by a separate Node sidecar
// (scripts/canvas-ws-proxy.mjs at :8190 behind a CF tunnel), because Next.js
// route handlers cannot upgrade to WS. That sidecar is no longer
// pass-through; see lib/canvas/ws-capture.ts.
//
// See docs/architecture/canvas-v2.md decision 2 and docs/canon/
// CANVAS_BASELINE.md.

import { type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/auth';
import {
  authorizeSession,
  buildUpstreamUrl,
  getSessionRow,
  upstreamHeaders,
  type CanvasSessionRow,
} from '@/lib/canvas/gate';
import { classifyRoute, tripwire, viewDirectory } from '@/lib/canvas/egress';
import {
  captureBytes,
  mimeFromUpstream,
  resolveActiveProjectId,
  startWorkflow,
} from '@/lib/canvas/witness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(req: NextRequest, ctx: { params: Promise<{ sessionId: string; path?: string[] }> }) {
  const params = await ctx.params;
  const sessionId = params.sessionId;
  const subPath = (params.path ?? []).join('/');

  // ── (3) Auth + session ownership ─────────────────────────────────
  // P4: the end user supplies a session id and nothing else. userId comes
  // from auth(); the project is resolved server-side. See gate.ts.
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const row = getSessionRow(sessionId);
  switch (authorizeSession(row, userId)) {
    case 'forbidden':
      return new Response(userId ? 'Forbidden' : 'Unauthorized', { status: userId ? 403 : 401 });
    case 'not-found':
      return new Response('Canvas session not found / expired', { status: 404 });
    case 'ok':
      break;
  }
  const sessionRow = row as CanvasSessionRow;

  // ── (1) per-session routing, (4) `?t=` strip, (2) shared secret ──
  const upstreamUrl = buildUpstreamUrl(sessionRow.modal_url, subPath, req.nextUrl.searchParams);
  const outHeaders = upstreamHeaders(req.headers);

  // ── Which kind of route is this? ─────────────────────────────────
  // The component's own table (§10 C-7), not the two-entry enumeration
  // this route used to carry. `byte-egress` is five routes, not one.
  const routeKind = classifyRoute(req.method, subPath);
  const isPromptPost = routeKind === 'prompt';
  const isByteEgress = routeKind === 'byte-egress';

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

  // ── Cold-start guard for the root GET ───────────────────────────
  // Cloudflare gives up on the origin at 100s. Modal cold-start on a
  // fresh container can take 150s. To avoid a hard 524, on the very
  // first request for the root path we short-timeout the upstream fetch
  // and, if it hasn't responded in 8s, return a lightweight HTML shell
  // that meta-refreshes every 6s. The refresh is a fresh Cloudflare
  // request each time; container warms in the background; the moment
  // Modal responds inside the 8s window, we stream it back and the
  // shell is never seen again.
  const isRootGet = req.method === 'GET' && subPath === '';

  // ── Forward to Modal ─────────────────────────────────────────────
  let upstreamRes: Response;
  try {
    if (isRootGet) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: outHeaders,
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(t);
        if ((e as { name?: string }).name === 'AbortError') {
          return coldStartShellResponse(sessionRow.machine_id);
        }
        throw e;
      }
      clearTimeout(t);
    } else {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        body: bodyToForward,
        // @ts-expect-error — Node-only opt for streaming bodies
        duplex: 'half',
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The upstream URL never appears in what the tenant sees.
    console.error(`[canvas-proxy] upstream fetch failed ${upstreamUrl}: ${message}`);
    return new Response('Bad gateway: upstream unavailable', { status: 502 });
  }

  // ── POST /prompt: open the pending record ────────────────────────
  // Still fire-and-forget: nothing has been produced yet, so there is no
  // artifact to hold back, and blocking the queue submission on a DB write
  // would make a provenance bookkeeping error into an outage.
  if (isPromptPost && promptBodyText) {
    try {
      const parsedReq = JSON.parse(promptBodyText) as { prompt?: Record<string, unknown> };
      const cloned = upstreamRes.clone();
      cloned
        .json()
        .then((resBody: unknown) => {
          const promptId = (resBody as { prompt_id?: string } | null)?.prompt_id;
          if (!promptId || !parsedReq.prompt) return;
          const projectId = resolveActiveProjectId(sessionRow.user_id);
          if (projectId === null) {
            console.error(
              `[canvas-proxy] /prompt accepted but no active project for ${sessionRow.user_id}; ` +
                'every output of this workflow will be recorded as unwitnessed egress.',
            );
            return;
          }
          startWorkflow({
            sessionId: sessionRow.id,
            userId: sessionRow.user_id,
            promptId,
            projectId,
            workflowApiJson: parsedReq.prompt,
          });
        })
        .catch((e) => console.error('[canvas-proxy] /prompt intercept parse failed', e));
    } catch (e) {
      console.error('[canvas-proxy] /prompt intercept failed', e);
    }
  }

  // ── Byte egress: BUFFER, CAPTURE, THEN DELIVER ───────────────────
  //
  // The order is the point, and it is the component's
  // (surfaces/http-gate.ts): "A captured route is BUFFERED, never streamed.
  // The client must not hold a byte before the counter is spent." Canvas has
  // no counter; its equivalent local, cheap, must-succeed step is the capture
  // row. The old code cloned the response and captured in a `.then()` that
  // nobody awaited, so the browser held the image before — and often
  // instead of — anything recording it.
  //
  // Buffering is not a new cost: the previous code already did
  // `cloned.arrayBuffer()` on the whole body.
  let captureHeader: string | null = null;
  let bufferedBody: Buffer | null = null;
  if (isByteEgress && upstreamRes.ok) {
    bufferedBody = Buffer.from(await upstreamRes.arrayBuffer());
    if (bufferedBody.length > 0) {
      const contentType = upstreamRes.headers.get('content-type');
      const filename =
        req.nextUrl.searchParams.get('filename') ?? subPath.split('/').pop() ?? '';
      try {
        const outcome = await captureBytes({
          sessionId: sessionRow.id,
          userId: sessionRow.user_id,
          machineId: sessionRow.machine_id,
          egress: `/${subPath}`,
          surface: 'network-gate-http',
          filename,
          bytes: bufferedBody,
          mime: mimeFromUpstream(contentType, `/${subPath}`),
        });
        // C-8 is recorded, not acted on: `?type=` picks between output/,
        // temp/ and input/, and PreviewImage writes to temp/. Canvas gates
        // all three because it gates the ROUTE rather than a directory —
        // which is the one advantage a network gate has over the watcher
        // canvas cannot have.
        const dir = viewDirectory(req.nextUrl.searchParams);
        captureHeader = `${outcome.header}; dir=${dir ?? 'unknown'}`;
      } catch (e) {
        // FAIL CLOSED, and only here. Nothing recorded these bytes — not
        // even that we failed to record them — so the bytes do not leave.
        // This is the only place canvas is allowed to break the user's
        // workflow, and it is the place where not breaking it would mean
        // handing over an artifact nothing can attest to having seen.
        console.error(
          `[canvas-proxy] REFUSING ${subPath}: capture row could not be written`,
          e,
        );
        return new Response(
          'scruple: refusing to deliver bytes it could not record\n',
          { status: 502, headers: { 'content-type': 'text/plain' } },
        );
      }
    }
  }

  // ── The tripwire ─────────────────────────────────────────────────
  // Any other 2xx leaving with a non-control-plane content type is a route
  // nobody enumerated. Logged and counted, never captured: ComfyUI serves
  // its own frontend through this proxy and every icon would otherwise
  // become an iteration.
  tripwire(subPath, upstreamRes.status, upstreamRes.headers.get('content-type'), isByteEgress);

  // ── Stream response back to the browser ──────────────────────────
  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.delete('access-control-allow-origin');
  // `content-encoding` would be a lie: upstreamHeaders() asked Modal for
  // identity, and undici has already decoded anything that arrived encoded.
  respHeaders.delete('content-encoding');
  // The failure is visible AT THE SURFACE THE ARTIFACT LEFT BY, not only in
  // a log. `failed` here means the bytes below have no leaf.
  if (captureHeader) respHeaders.set('X-Scruple-Capture', captureHeader);

  // Root HTML gets a <base href="/canvas-proxy/<sid>/"> injection so
  // that ComfyUI's relative URLs (href="user.css", src="assets/*.js")
  // resolve back through the proxy with the session-id path segment
  // intact. Without this, the browser strips 'cs_xxx' when resolving
  // relative URLs and every asset 404s → blank iframe.
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  if (isRootGet && contentType.includes('text/html')) {
    const html = await upstreamRes.text();
    const prefix = `/canvas-proxy/${sessionId}`;
    // WebSocket bridge is a separate sidecar (canvas-ws-proxy.mjs on :8190),
    // exposed via its own Cloudflare hostname because Next.js route handlers
    // can't upgrade to WS. Browser opens wss://<host>/<sid>/<comfyui-path>.
    // Local dev fallback: ws://localhost:8190.
    const wsOrigin = process.env.NEXT_PUBLIC_CANVAS_WS_ORIGIN
      ?? (process.env.NODE_ENV === 'production'
        ? 'wss://scruple-canvas-ws.stooges.ai'
        : 'ws://localhost:8190');
    // <base> handles relative URLs in HTML attributes; the shim
    // handles ComfyUI's JS which uses absolute-from-root paths like
    // /api/users, /api/system_stats, /api/prompt, /view, /ws. Base
    // has no effect on those — the browser resolves them against
    // origin — so we patch fetch/XHR/WebSocket to prepend our
    // session-id prefix any time the URL starts with '/'.
    const injection = `
<base href="${prefix}/">
<script>
(function () {
  var PREFIX = ${JSON.stringify(prefix)};
  var STEM = '/canvas-proxy';
  function rewrite(u) {
    if (typeof u !== 'string') return u;
    if (!u || u[0] !== '/') return u; // relative/scheme'd urls pass through
    if (u.slice(0, PREFIX.length + 1) === PREFIX + '/') return u; // already prefixed
    if (u === PREFIX) return u;
    // ComfyUI derives some URLs from location.pathname minus its last
    // segment — that gives '/canvas-proxy' (without the session id).
    // Splice the session id back in.
    if (u.slice(0, STEM.length + 1) === STEM + '/') {
      return PREFIX + u.slice(STEM.length);
    }
    // Any other absolute-from-root path → wrap under the prefix.
    return PREFIX + u;
  }
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') return _fetch.call(this, rewrite(input), init);
    if (input && input.url) return _fetch.call(this, new Request(rewrite(input.url), input), init);
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = rewrite(url);
    return _open.apply(this, arguments);
  };
  // WebSocket bridge: browser connects to a dedicated WS host (the
  // canvas-ws-proxy sidecar) with the session id encoded in the path.
  // The sidecar resolves the session, forwards to the correct Modal URL.
  var WS_ORIGIN = ${JSON.stringify(wsOrigin)};
  var SESSION_ID = ${JSON.stringify(sessionId)};
  var _WS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /^wss?:\\/\\//i.test(url)) {
      try {
        var u = new URL(url);
        var wsPath = u.pathname;
        // Strip any /canvas-proxy or /canvas-proxy/<sid> that may have
        // leaked into the path (ComfyUI JS derives WS URLs from
        // location.pathname minus the last segment). Whatever is left
        // becomes the ComfyUI-relative path; empty → '/'.
        if (wsPath.slice(0, PREFIX.length) === PREFIX) {
          wsPath = wsPath.slice(PREFIX.length) || '/';
        } else if (wsPath.slice(0, STEM.length + 1) === STEM + '/') {
          // /canvas-proxy/foo → /foo (keep leading slash)
          wsPath = wsPath.slice(STEM.length);
        } else if (wsPath === STEM) {
          wsPath = '/';
        }
        if (wsPath[0] !== '/') wsPath = '/' + wsPath;
        url = WS_ORIGIN + '/' + SESSION_ID + wsPath + u.search;
      } catch (e) {}
    }
    return protocols ? new _WS(url, protocols) : new _WS(url);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;
})();
</script>`;
    const rewritten = html.includes('<head>')
      ? html.replace('<head>', `<head>${injection}`)
      : `${injection}${html}`;
    respHeaders.delete('content-length');
    return new Response(rewritten, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  }

  if (bufferedBody !== null) {
    respHeaders.set('content-length', String(bufferedBody.length));
    return new Response(new Uint8Array(bufferedBody), {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}

/** Static HTML shown while Modal cold-starts the ComfyUI container.
 *  Self-refreshes every 6 seconds. Each request bumps Modal further
 *  through its cold-start; eventually one lands within the 8s window
 *  and the browser gets the real ComfyUI page. */
function coldStartShellResponse(machineId: string): Response {
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="6">
  <title>Warming up ComfyUI…</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; background:#0b0b0b; color:#eaeaea;
           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
           display:flex; align-items:center; justify-content:center;
           height:100vh; flex-direction:column; text-align:center; padding:1rem; }
    .spinner { width:48px; height:48px; border:3px solid #333;
               border-top-color:#c94a4a; border-radius:50%;
               animation: spin 1s linear infinite; margin-bottom:1.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { color:#c94a4a; font-size:1.05rem; font-weight:600; margin:0 0 .6rem; }
    p  { color:#aaa; font-size:.8rem; max-width:36rem; line-height:1.5; margin:.2rem 0; }
    .meta { color:#666; font-size:.7rem; text-transform:uppercase;
            letter-spacing:.08em; margin-top:1.2rem; }
  </style>
</head><body>
  <div class="spinner"></div>
  <h1>Warming up ComfyUI on ${machineId}</h1>
  <p>The first container boot after idle can take 60-180 seconds. This
     page auto-refreshes every 6 seconds until the canvas is ready.</p>
  <p class="meta">If you see this for more than 5 minutes, refresh manually or
     switch to a different machine in Settings → Compute.</p>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const OPTIONS = handler;
export const HEAD = handler;
