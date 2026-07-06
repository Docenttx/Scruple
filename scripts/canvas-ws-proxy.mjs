#!/usr/bin/env node
// Canvas WebSocket proxy sidecar — Canvas v2 (WO-4).
//
// Next.js route handlers can't terminate WebSocket connections, so the
// HTTP proxy at /canvas-proxy/[sessionId]/[...path] handles HTTP only
// and this Node sidecar handles WS. Together they form the full gate.
//
// Path convention (Cloudflare tunnel routes this hostname to :8190):
//   wss://canvas-ws.scruple.stooges.ai/<sessionId>/<comfyui ws path>
// Browser opens the WS, sidecar resolves sessionId → Modal URL +
// shared-secret header → upstream WS → bidirectional pipe.
//
// WS frames carry ComfyUI's live status events (executing,
// execution_success, progress). The HTTP path captures the
// authoritative provenance bytes (workflow JSON on POST /prompt,
// output bytes on GET /view); WS frames here are pass-through with
// optional debug logging.
//
// Run: node scripts/canvas-ws-proxy.mjs (managed by pm2 or systemd;
// see deploy notes in docs/sessions/2026-06-22-v2-overnight.md).

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import path from 'node:path';

const PORT = Number(process.env.CANVAS_WS_PROXY_PORT ?? 8190);
const DB_PATH = process.env.SCRUPLE_DB_PATH ?? path.resolve('data/scruple.db');
const SHARED_SECRET = process.env.SCRUPLE_CANVAS_SHARED_SECRET ?? '';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const lookupSession = db.prepare(
  `SELECT id, user_id, machine_id, modal_url, status
     FROM canvas_sessions
    WHERE id = ?
      AND status = 'active'
      AND expires_at > datetime('now')`,
);

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('canvas-ws-proxy ok\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientWs, req) => {
  // URL: /<sessionId>/<rest>  e.g. /cs_abc123/ws
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 1) {
    clientWs.close(1008, 'missing sessionId');
    return;
  }
  const sessionId = segments[0];
  const rest = '/' + segments.slice(1).join('/');

  const sessRow = lookupSession.get(sessionId);
  if (!sessRow) {
    console.warn(`[canvas-ws-proxy] reject ${sessionId} — no active session`);
    clientWs.close(1008, 'invalid session');
    return;
  }

  // Build upstream WS URL — strip legacy ?t= token, swap https → wss
  const upstreamHttp = new URL(sessRow.modal_url);
  upstreamHttp.search = '';
  const wsUrl =
    (upstreamHttp.protocol === 'https:' ? 'wss:' : 'ws:') +
    '//' +
    upstreamHttp.host +
    rest +
    url.search;

  console.log(
    `[canvas-ws-proxy] open session=${sessionId} user=${sessRow.user_id} → ${wsUrl}`,
  );

  const upstream = new WebSocket(wsUrl, {
    headers: SHARED_SECRET
      ? { 'X-Scruple-Shared-Secret': SHARED_SECRET }
      : undefined,
  });

  let downFrames = 0;
  let upFrames = 0;
  const startedAt = Date.now();

  upstream.on('open', () => {
    clientWs.send(JSON.stringify({ type: 'scruple-ws-ready' }));
  });
  upstream.on('message', (data) => {
    downFrames++;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });
  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      const forwardable =
        typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
      if (forwardable) {
        try { clientWs.close(code, reason); } catch { clientWs.close(); }
      } else {
        clientWs.close();
      }
    }
  });
  upstream.on('error', (e) => {
    console.warn(`[canvas-ws-proxy] upstream error ${sessionId}: ${e.message}`);
  });

  clientWs.on('message', (data) => {
    upFrames++;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    }
  });
  clientWs.on('close', (code, reason) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[canvas-ws-proxy] close session=${sessionId} ${elapsed}s up=${upFrames} down=${downFrames}`,
    );
    if (upstream.readyState === WebSocket.OPEN) {
      // Only forward the code if it's in the valid user range; reserved
      // codes like 1005 (no status) / 1006 (abnormal) throw
      // "First argument must be a valid error code number" when passed
      // to ws.close(). Fall back to a plain close.
      const forwardable =
        typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
      if (forwardable) {
        try { upstream.close(code, reason); } catch { upstream.close(); }
      } else {
        upstream.close();
      }
    }
  });
  clientWs.on('error', (e) => {
    console.warn(`[canvas-ws-proxy] client error ${sessionId}: ${e.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[canvas-ws-proxy] listening on :${PORT}`);
});

function shutdown(signal) {
  console.log(`[canvas-ws-proxy] ${signal}; shutting down`);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
