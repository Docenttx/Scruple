// Canvas proxy → witness pipeline (internal API).
//
// scruple-web HTTP/WS proxy (app/canvas-proxy/[sessionId]/[...path]/route.ts)
// intercepts every POST /prompt and GET /view going to/from the user's
// Modal-hosted ComfyUI container. Those interceptions land here and
// route into the same `ingestIteration` pipeline used by /api/generate
// — leaf hash, witness signature, machine-id provenance, all unified.
//
// Why server-side: the previous design (COM-6/7) had a browser JS
// intercept POSTing to /api/canvas/witness/*. That was bypassable —
// anyone with a session token could call the endpoints directly with
// crafted bodies. Canvas v2 (WO-4) closes the gap by routing all
// canvas traffic THROUGH the proxy; provenance capture is the
// natural side-effect of the bytes going past us.
//
// See docs/architecture/canvas-v2.md decision 2.

import { conn } from '@/lib/db/sqlite';
import { ingestIteration, type OutputKind } from '@/lib/iterations/ingest';

interface PendingRow {
  prompt_id: string;
  session_id: string;
  user_id: string;
  project_id: number;
  workflow_api_json: string;
  status: 'pending' | 'done' | 'lost';
}

/**
 * Record that a workflow has been queued. Called the moment the
 * proxy sees a POST /prompt come back with a prompt_id. The pending
 * row pairs prompt_id ↔ workflow JSON for when /view's output bytes
 * arrive later.
 */
export function startWorkflow(opts: {
  sessionId: string;
  userId: string;
  promptId: string;
  projectId: number;
  workflowApiJson: Record<string, unknown>;
}): void {
  conn()
    .prepare(
      `INSERT OR REPLACE INTO canvas_pending_iterations
         (prompt_id, session_id, user_id, project_id, workflow_api_json, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      opts.promptId,
      opts.sessionId,
      opts.userId,
      opts.projectId,
      JSON.stringify(opts.workflowApiJson),
    );
}

/**
 * Output bytes captured on GET /view. Pair with the most recent
 * pending row for this session that isn't done yet, then run the
 * standard ingest pipeline.
 *
 * The pairing strategy uses "most recent pending" rather than parsing
 * prompt_id out of the filename — ComfyUI's output filenames don't
 * include prompt_id by default, and the proxy doesn't see the
 * /history side-channel the JS intercept used to use. This is
 * accurate when sessions are single-user and queue depth is 1
 * (concurrency_limit=1 on the Modal class enforces this).
 *
 * If no pending row exists → log + drop. Not an error path; happens
 * on /view fetches that aren't tied to a queued workflow (e.g.,
 * thumbnail reloads).
 */
export async function captureOutput(opts: {
  sessionId: string;
  userId: string;
  machineId: string;
  filename: string;
  bytes: Buffer;
  contentType: string;
}): Promise<void> {
  const pending = conn()
    .prepare(
      `SELECT * FROM canvas_pending_iterations
        WHERE session_id = ? AND status = 'pending'
        ORDER BY ROWID DESC LIMIT 1`,
    )
    .get(opts.sessionId) as PendingRow | undefined;

  if (!pending) {
    console.warn(
      `[canvas/witness] /view ${opts.filename} but no pending iteration on session ${opts.sessionId}`,
    );
    return;
  }

  let workflow: Record<string, unknown> = {};
  try {
    workflow = JSON.parse(pending.workflow_api_json);
  } catch {
    /* keep empty */
  }

  const outputKind: OutputKind = /\.(mp4|webm|mov)$/i.test(opts.filename)
    ? 'video'
    : /\.(safetensors|ckpt)$/i.test(opts.filename)
      ? 'checkpoint'
      : 'image';

  try {
    const result = await ingestIteration({
      userId: opts.userId,
      projectId: pending.project_id,
      provider: 'comfydeploy',
      providerJobId: pending.prompt_id,
      prompt: '(canvas workflow / modal)',
      spec: {
        prompt: '(canvas workflow)',
        providerExtras: { workflowApiJson: workflow },
      },
      imageBytes: opts.bytes,
      imageContentType: opts.contentType,
      imageFilename: opts.filename,
      outputKind,
      executionBackend: 'modal-test',
      executionAttestation: null,
      computeMachineId: opts.machineId,
    });

    conn()
      .prepare(
        `UPDATE canvas_pending_iterations SET status = 'done'
          WHERE session_id = ? AND prompt_id = ?`,
      )
      .run(opts.sessionId, pending.prompt_id);

    console.log(
      `[canvas/witness] iter=${result.iteration.id} run=${result.runSequence} leaf=${result.leafHash.slice(0, 12)}…`,
    );
  } catch (e) {
    console.error('[canvas/witness] ingest failed', e);
  }
}

/** Resolve the active project for a user (matches getActiveProject() but
 *  callable from the proxy without the AsyncLocalStorage userId() wrap). */
export function resolveActiveProjectId(userId: string): number | null {
  const row = conn()
    .prepare(`SELECT id FROM projects WHERE user_id = ? AND is_active = 1 LIMIT 1`)
    .get(userId) as { id: number } | undefined;
  return row?.id ?? null;
}
