// Kohya HTTP proxy — WO-KOHYA Phase 3.
//
// Same shape as canvas-proxy: browser talks to /kohya-proxy/<sid>/*,
// server proxies to https://<podId>-7860.proxy.runpod.net/*. Provenance
// capture is delegated to the in-pod monkey-patched
// safetensors.torch.save_file (Phase 4) so we don't need per-endpoint
// intercepts here.
//
// Notable divergences from canvas-proxy:
//   - Session lookup is app_sessions (not canvas_sessions)
//   - No <base href> injection needed — Gradio's Vue+Svelte assets use
//     relative-to-document URLs that work under our sessionId prefix
//     once the fetch/XHR/WS shim rewrites them
//   - WS proxy target hostname reads NEXT_PUBLIC_KOHYA_WS_ORIGIN
//   - Cold-start shell same pattern (RunPod pod spawn can take 60-120s
//     even after we return from mint — Gradio's Python boot is slow)

import { type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface AppSessionRow {
  id: string;
  user_id: string;
  app_id: string;
  backend: string;
  endpoint_url: string;
  status: string;
}

function getSessionRow(sessionId: string): AppSessionRow | null {
  return (
    (conn()
      .prepare(
        `SELECT id, user_id, app_id, backend, endpoint_url, status
           FROM app_sessions
          WHERE id = ?
            AND app_id = 'kohya'
            AND status = 'active'
            AND expires_at > datetime('now')`,
      )
      .get(sessionId) as AppSessionRow | undefined) ?? null
  );
}

function buildUpstreamUrl(
  base: string,
  subPath: string,
  search: URLSearchParams,
): string {
  const trimmedBase = base.endsWith('/') ? base : base + '/';
  const upstream = new URL(subPath, trimmedBase);
  for (const [k, v] of search) upstream.searchParams.set(k, v);
  return upstream.toString();
}

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string; path?: string[] }> },
) {
  const params = await ctx.params;
  const sessionId = params.sessionId;
  const subPath = (params.path ?? []).join('/');

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const row = getSessionRow(sessionId);
  if (!row) return new Response('Kohya session not found / expired', { status: 404 });
  if (row.user_id !== userId) return new Response('Forbidden', { status: 403 });

  const upstreamUrl = buildUpstreamUrl(row.endpoint_url, subPath, req.nextUrl.searchParams);
  const outHeaders = new Headers(req.headers);
  outHeaders.delete('host');
  outHeaders.delete('cookie');
  outHeaders.delete('authorization');
  // RunPod's proxy doesn't need a shared secret — the pod URL itself
  // is unguessable (podId is opaque nanoid-like).

  let bodyToForward: BodyInit | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    bodyToForward = await req.arrayBuffer();
  }

  const isRootGet = req.method === 'GET' && subPath === '';

  let upstreamRes: Response;
  try {
    if (isRootGet) {
      // Cold-start shell — RunPod pod may still be booting Gradio.
      // Cloudflare gives up on origin at 100s; we bail at 8s and return
      // a self-refreshing HTML shell (same trick as canvas-proxy).
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
          return coldStartShell();
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
    return new Response(`Bad gateway: ${message}`, { status: 502 });
  }

  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.delete('access-control-allow-origin');

  // Inject fetch/XHR/WS shim into the HTML root so Gradio's absolute
  // paths get routed back through our proxy.
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  if (isRootGet && contentType.includes('text/html')) {
    const html = await upstreamRes.text();
    const prefix = `/kohya-proxy/${sessionId}`;
    const wsOrigin =
      process.env.NEXT_PUBLIC_KOHYA_WS_ORIGIN ??
      (process.env.NODE_ENV === 'production'
        ? 'wss://scruple-kohya-ws.stooges.ai'
        : 'ws://localhost:8191');
    const injection = `
<base href="${prefix}/">
<script>
(function () {
  var PREFIX = ${JSON.stringify(prefix)};
  var STEM = '/kohya-proxy';
  var WS_ORIGIN = ${JSON.stringify(wsOrigin)};
  var SESSION_ID = ${JSON.stringify(sessionId)};
  function rewrite(u) {
    if (typeof u !== 'string') return u;
    if (!u || u[0] !== '/') return u;
    if (u.slice(0, PREFIX.length + 1) === PREFIX + '/') return u;
    if (u === PREFIX) return u;
    if (u.slice(0, STEM.length + 1) === STEM + '/') return PREFIX + u.slice(STEM.length);
    return PREFIX + u;
  }
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') return _fetch.call(this, rewrite(input), init);
    if (input && input.url) return _fetch.call(this, new Request(rewrite(input.url), input), init);
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    arguments[1] = rewrite(url);
    return _open.apply(this, arguments);
  };
  var _WS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /^wss?:\\/\\//i.test(url)) {
      try {
        var u = new URL(url);
        var wsPath = u.pathname;
        if (wsPath.slice(0, PREFIX.length) === PREFIX) wsPath = wsPath.slice(PREFIX.length) || '/';
        else if (wsPath.slice(0, STEM.length + 1) === STEM + '/') wsPath = wsPath.slice(STEM.length);
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

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}

function coldStartShell(): Response {
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="6">
  <title>Warming up Kohya…</title>
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
  <h1>Warming up Kohya on RunPod</h1>
  <p>The pod boot takes 60–150 seconds — RunPod schedules the GPU + our
     custom image starts the Kohya Gradio server. This page auto-refreshes
     every 6 seconds until the pod is ready.</p>
  <p class="meta">If you see this for more than 5 minutes, refresh manually
     or check the pod status in RunPod console.</p>
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
