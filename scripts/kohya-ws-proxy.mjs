#!/usr/bin/env node
// Kohya WebSocket proxy sidecar — WO-KOHYA Phase 3.
//
// Mirrors canvas-ws-proxy.mjs but reads from app_sessions instead of
// canvas_sessions. Listens on :8191, exposed via Cloudflare tunnel at
// scruple-kohya-ws.stooges.ai (Universal SSL — level-2 subdomain).
//
// Path convention: /<sessionId>/<gradio-ws-path>
//
// Kohya's Gradio uses `/queue/join` + `/queue/data` (SSE) + WebSockets
// for live logs. This sidecar is transparent — it just pipes frames.
//
// Run: node scripts/kohya-ws-proxy.mjs (managed by pm2)

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import path from 'node:path';

const PORT = Number(process.env.KOHYA_WS_PROXY_PORT || 8191);
const DB_PATH =
  process.env.SCRUPLE_DB_PATH ??
  path.join(process.cwd(), 'data', 'scruple.db');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const lookupSession = db.prepare(
  `SELECT id, user_id, backend, endpoint_url, status
     FROM app_sessions
    WHERE id = ?
      AND app_id = 'kohya'
      AND status = 'active'
      AND expires_at > datetime('now')`,
);

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('kohya-ws-proxy ok\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientWs, req) => {
  const rawReqUrl = req.url ?? '/';
  const url = new URL(rawReqUrl, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 1) {
    clientWs.close(1008, 'missing sessionId');
    return;
  }
  const sessionId = segments[0];
  const rest = '/' + segments.slice(1).join('/');
  const sessRow = lookupSession.get(sessionId);
  if (!sessRow) {
    console.warn(`[kohya-ws-proxy] reject ${sessionId} — no active session`);
    clientWs.close(1008, 'invalid session');
    return;
  }

  const upstreamHttp = new URL(sessRow.endpoint_url);
  upstreamHttp.search = '';
  const wsUrlObj = new URL(
    rest,
    `${upstreamHttp.protocol === 'https:' ? 'wss:' : 'ws:'}//${upstreamHttp.host}`,
  );
  url.searchParams.forEach((v, k) => wsUrlObj.searchParams.set(k, v));
  const wsUrl = wsUrlObj.toString();

  console.log(
    `[kohya-ws-proxy] open session=${sessionId} user=${sessRow.user_id} rawIn=${rawReqUrl} → ${wsUrl}`,
  );

  const upstream = new WebSocket(wsUrl);

  let downFrames = 0;
  let upFrames = 0;
  const startedAt = Date.now();

  const keepaliveInterval = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.ping();
      } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.ping();
      } catch {}
    }
  }, 30 * 1000);

  upstream.on('open', () => {
    clientWs.send(JSON.stringify({ type: 'scruple-ws-ready' }));
  });
  upstream.on('message', (data) => {
    downFrames++;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });
  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      const forwardable =
        typeof code === 'number' &&
        code >= 1000 &&
        code < 5000 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006 &&
        code !== 1015;
      if (forwardable) {
        try {
          clientWs.close(code, reason);
        } catch {
          clientWs.close();
        }
      } else clientWs.close();
    }
  });
  upstream.on('error', (e) => {
    console.warn(`[kohya-ws-proxy] upstream error ${sessionId}: ${e.message}`);
  });

  clientWs.on('message', (data) => {
    upFrames++;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });
  clientWs.on('close', (code, reason) => {
    clearInterval(keepaliveInterval);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[kohya-ws-proxy] close session=${sessionId} ${elapsed}s up=${upFrames} down=${downFrames}`,
    );
    if (upstream.readyState === WebSocket.OPEN) {
      const forwardable =
        typeof code === 'number' &&
        code >= 1000 &&
        code < 5000 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006 &&
        code !== 1015;
      if (forwardable) {
        try {
          upstream.close(code, reason);
        } catch {
          upstream.close();
        }
      } else upstream.close();
    }
  });
  clientWs.on('error', (e) => {
    console.warn(`[kohya-ws-proxy] client error ${sessionId}: ${e.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[kohya-ws-proxy] listening on :${PORT}`);
});
