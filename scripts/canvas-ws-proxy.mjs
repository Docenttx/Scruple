#!/usr/bin/env node
// Canvas WebSocket proxy sidecar — Canvas v2 (WO-4), re-platformed onto the
// capture component (WO-10).
//
// Next.js route handlers cannot terminate WebSocket connections, so the HTTP
// proxy at /canvas-proxy/[sessionId]/[[...path]] handles HTTP only and this
// Node sidecar handles WS. Together they form the full gate.
//
// Path convention (Cloudflare tunnel routes this hostname to :8190):
//   wss://canvas-ws.scruple.stooges.ai/<sessionId>/<comfyui ws path>
// Browser opens the WS, sidecar resolves sessionId → Modal URL +
// shared-secret header → upstream WS → bidirectional pipe.
//
// ── WHAT CHANGED, AND WHY THE OLD COMMENT WAS THE FINDING ─────────────
//
// This file used to say: "WS frames carry ComfyUI's live status events ...
// WS frames here are pass-through with optional debug logging." That was
// true of the pinned ComfyUI and is a property of the upstream application,
// not of our code — `STUDIO_P1-P8_GRADE.md` makes it condition 1 on canvas's
// P1 PASS and says it needs "an assertion in the baseline, not a comment in
// a file". H-4 §2 path 2 is the same finding from the other side: ComfyUI
// ships an example client whose entire purpose is retrieving images over
// this socket without them ever becoming files.
//
// The socket is now gated. `lib/canvas/ws-capture.ts` decodes each binary
// frame with the COMPONENT's decoder, correlates it against the executing
// prompt, and witnesses the ones the graph declares as WebSocket artifacts.
// The condition is now asserted in `lib/canvas/baseline.ts`, which is what
// the grade asked for.
//
// ── RUN ────────────────────────────────────────────────────────────────
//
//   node --import tsx scripts/canvas-ws-proxy.mjs
//
// `--import tsx` IS REQUIRED and is not incidental: this file imports
// lib/canvas/*.ts so that the WS leg and the HTTP leg share one correlator,
// one route table and one capture path. Two implementations of a gate are
// two gates. (managed by pm2 or systemd; see deploy notes in
// docs/sessions/2026-06-22-v2-overnight.md)

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { getSessionRow, buildUpstreamUrl, KEEPALIVE_INTERVAL_MS } from '../lib/canvas/gate.ts';
import {
  observeUpstreamBinary,
  observeUpstreamText,
  clearWsFrameTally,
} from '../lib/canvas/ws-capture.ts';

const PORT = Number(process.env.CANVAS_WS_PROXY_PORT ?? 8190);
const SHARED_SECRET = process.env.SCRUPLE_CANVAS_SHARED_SECRET ?? '';

/**
 * THE KEEPALIVE. 30 seconds, both legs, and it is a provenance control.
 *
 * Cloudflare and Modal close an idle tunnel at roughly 100-125 seconds. A
 * long generation is minutes of silence on this socket. Without a ping in
 * BOTH directions the tunnel closes mid-run, the browser reconnects with a
 * fresh clientId, and ComfyUI's `executing` / `execution_success` messages —
 * which route with broadcast=False to the ORIGINAL clientId — arrive at a
 * socket nobody is reading. Correlation stops, no leaf is written, and the
 * symptom presents as a provenance bug rather than as the timeout it is.
 *
 * The `ws` library answers upstream pings automatically; it does not
 * originate them, and the tunnel needs traffic in both directions, so both
 * legs are pinged explicitly.
 *
 * The interval is overridable ONLY so that test/v2/canvas-retrofit.test.ts
 * can prove the pings actually leave in both directions without waiting 30
 * seconds. The default is the constant in lib/canvas/gate.ts and the test
 * asserts that too.
 */
const KEEPALIVE_MS = Number(process.env.CANVAS_WS_KEEPALIVE_MS ?? KEEPALIVE_INTERVAL_MS);

export function startWsProxy({ port = PORT, sharedSecret = SHARED_SECRET, keepaliveMs = KEEPALIVE_MS } = {}) {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('canvas-ws-proxy ok\n');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (clientWs, req) => {
    // URL: /<sessionId>/<rest>  e.g. /cs_abc123/ws?clientId=X
    const rawReqUrl = req.url ?? '/';
    const url = new URL(rawReqUrl, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 1) {
      clientWs.close(1008, 'missing sessionId');
      return;
    }
    const sessionId = segments[0];
    const rest = '/' + segments.slice(1).join('/');

    // (1) PER-SESSION ROUTING. One shared lookup with the HTTP leg —
    // lib/canvas/gate.ts getSessionRow — so the two legs cannot drift on
    // what an active session is.
    const sessRow = getSessionRow(sessionId);
    if (!sessRow) {
      console.warn(`[canvas-ws-proxy] reject ${sessionId} — no active session`);
      clientWs.close(1008, 'invalid session');
      return;
    }

    // (4) `?t=` STRIP, and (1) again: buildUpstreamUrl drops the legacy
    // session token and preserves clientId. clientId is load-bearing —
    // ComfyUI keys its socket map by it and routes execution_start /
    // executing / executed / execution_success with broadcast=False; drop it
    // and those events silently stop arriving, which is the same failure the
    // keepalive prevents, reached by a different route.
    const httpUpstream = buildUpstreamUrl(sessRow.modal_url, rest.replace(/^\//, ''), url.searchParams);
    const wsUrl = httpUpstream.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

    const clientId = url.searchParams.get('clientId');
    console.log(
      `[canvas-ws-proxy] open session=${sessionId} user=${sessRow.user_id} clientId=${clientId ?? '(none)'} rawIn=${rawReqUrl} → ${wsUrl}`,
    );

    // (2) THE SHARED SECRET. Held by the proxy and this sidecar, both
    // server-side. The browser gets a session id, not a credential, and
    // never the upstream URL — that is canvas's P3.
    const upstream = new WebSocket(wsUrl, {
      headers: sharedSecret ? { 'X-Scruple-Shared-Secret': sharedSecret } : undefined,
    });

    const ctx = {
      sessionId,
      userId: sessRow.user_id,
      machineId: sessRow.machine_id,
    };

    let downFrames = 0;
    let upFrames = 0;
    const startedAt = Date.now();

    // (5) THE KEEPALIVE — see the block comment above.
    const keepaliveInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.ping(); } catch {}
      }
      if (upstream.readyState === WebSocket.OPEN) {
        try { upstream.ping(); } catch {}
      }
    }, keepaliveMs);

    upstream.on('open', () => {
      clientWs.send(JSON.stringify({ type: 'scruple-ws-ready' }));
    });

    // Downstream: upstream → tenant. This is the direction artifacts travel,
    // and it is SERIALISED, one frame at a time, for the component's reason
    // (surfaces/ws-gate.ts): capturing a binary frame awaits the capture row,
    // so two frames arriving together would otherwise race and could reach
    // the tenant in the opposite order to the one ComfyUI sent them in.
    let tail = Promise.resolve();
    upstream.on('message', (data, isBinary) => {
      downFrames++;
      tail = tail
        .then(() => onUpstreamMessage(ctx, clientWs, data, isBinary))
        .catch((e) => console.error(`[canvas-ws-proxy] downstream frame failed: ${String(e)}`));
    });

    upstream.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        if (isForwardableCode(code)) {
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
      clearInterval(keepaliveInterval);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const tally = clearWsFrameTally(sessionId);
      // The tally is logged rather than discarded because it is the count of
      // binary frames this socket carried that were NOT witnessed. See
      // lib/canvas/ws-capture.ts — a custom node returning artifact bytes
      // without declaring itself a WS writer lands in `previews`, and a hole
      // you can count is a hole you can see.
      console.log(
        `[canvas-ws-proxy] close session=${sessionId} ${elapsed}s up=${upFrames} down=${downFrames} ` +
          `binary=${tally.binaryFrames} witnessed=${tally.artifacts} not-witnessed=${tally.previews} ` +
          `undecodable=${tally.undecodable}`,
      );
      if (upstream.readyState === WebSocket.OPEN) {
        // Only forward the code if it is in the valid user range; reserved
        // codes like 1005 (no status) / 1006 (abnormal) throw "First argument
        // must be a valid error code number" when passed to ws.close().
        if (isForwardableCode(code)) {
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

  const listening = new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`[canvas-ws-proxy] listening on :${httpServer.address().port} keepalive=${keepaliveMs}ms`);
      resolve(httpServer.address().port);
    });
  });

  return {
    httpServer,
    wss,
    listening,
    async close() {
      wss.close();
      await new Promise((r) => httpServer.close(r));
    },
  };
}

async function onUpstreamMessage(ctx, clientWs, data, isBinary) {
  if (!isBinary) {
    // Control plane — and the CORRELATION SOURCE. `executing` and
    // `execution_success` are the only messages that say which prompt is
    // live, and this process is the only one that sees them.
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    observeUpstreamText(ctx.sessionId, text);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(text);
    return;
  }

  const frame = toBuffer(data);
  const disposition = await observeUpstreamBinary(ctx, frame);
  if (disposition.kind === 'refuse') {
    // FAIL CLOSED, and only on the local half. The capture row could not be
    // written, so nothing recorded these bytes, so they do not leave.
    // Closing the socket is visible to the tenant, which is the point — a
    // capture failure must not be quieter than a capture.
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'scruple: could not record this frame');
    }
    return;
  }
  if (clientWs.readyState === WebSocket.OPEN) clientWs.send(frame, { binary: true });
}

function toBuffer(d) {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

function isForwardableCode(code) {
  return (
    typeof code === 'number' &&
    code >= 1000 &&
    code < 5000 &&
    code !== 1004 &&
    code !== 1005 &&
    code !== 1006 &&
    code !== 1015
  );
}

const isMain = process.argv[1] && process.argv[1].endsWith('canvas-ws-proxy.mjs');
if (isMain) {
  const proxy = startWsProxy();
  const shutdown = (signal) => {
    console.log(`[canvas-ws-proxy] ${signal}; shutting down`);
    proxy.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
