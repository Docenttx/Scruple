// GET /api/iterations/stream?projectId=…
//
// Server-sent events stream of new iterations for the active workspace.
// Polls the iterations table internally (every 1.5s) and emits when a
// new row appears, scoped to the requesting user's project.
//
// Wire format: standard SSE (`data: {json}\n\n`).
// Event types:
//   ready    — connection established with current high-water mark
//   iter     — single iteration row (full JSON)
//   ping     — keep-alive every 30s

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import type { IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const POLL_MS = 1500;
const PING_MS = 30000;

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const projectIdRaw = new URL(req.url).searchParams.get('projectId');
  const projectId = Number(projectIdRaw);
  if (!projectIdRaw || !Number.isFinite(projectId)) {
    return new Response('projectId required', { status: 400 });
  }

  // Verify project ownership before opening the stream
  const owns = conn()
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId);
  if (!owns) {
    return new Response('Not found', { status: 404 });
  }

  let highWater = (conn()
    .prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM iterations WHERE project_id = ?`)
    .get(projectId) as { n: number }).n;

  const encoder = new TextEncoder();
  const aborted = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, payload: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      }
      send('ready', { highWater, projectId });

      const pingTimer = setInterval(() => {
        try {
          send('ping', { ts: Date.now() });
        } catch {
          /* */
        }
      }, PING_MS);

      const pollTimer = setInterval(() => {
        try {
          const rows = conn()
            .prepare(
              `SELECT * FROM iterations WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT 50`,
            )
            .all(projectId, highWater) as IterationRow[];
          for (const row of rows) {
            send('iter', row);
            highWater = row.id;
          }
        } catch (e) {
          send('error', { message: e instanceof Error ? e.message : String(e) });
        }
      }, POLL_MS);

      aborted.addEventListener('abort', () => {
        clearInterval(pingTimer);
        clearInterval(pollTimer);
        try {
          controller.close();
        } catch {
          /* */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
