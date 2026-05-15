// GET /api/generate/status?jobId=X
//
// Polls a Modal-spawned workflow job. Behaviour:
//   - Job not found / not owned by user        → 404
//   - Job already done                          → return cached result
//   - Job already failed                        → return cached error
//   - Modal call still running                  → return {status:'running', elapsedSec}
//   - Modal call done                           → ingestIteration, update job row,
//                                                  return {status:'done', leafHash, ...}
//   - Modal call failed with preemption flag    → respawn, update job's modal_call_id,
//                                                  retry_count++, return 'running'
//   - Modal call failed otherwise               → mark job failed, return failure

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { getWorkflowStatus, spawnWorkflow } from '@/lib/compute/modal';
import { ingestIteration } from '@/lib/iterations/ingest';

export const dynamic = 'force-dynamic';

interface JobRow {
  id: string;
  user_id: string;
  project_id: number;
  status: 'running' | 'done' | 'failed' | 'preempted';
  modal_call_id: string | null;
  started_at: string;
  completed_at: string | null;
  iteration_id: number | null;
  leaf_hash: string | null;
  run_sequence: number | null;
  error_detail: string | null;
  dispatch_log_path: string | null;
  retry_count: number;
}

// Max number of times we'll re-spawn after a preemption before giving up.
// Modal preemption is fairly common on free tier; 3 retries gives ~6 min
// of cumulative attempts before declaring genuine failure.
const MAX_PREEMPTION_RETRIES = 3;

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  const job = conn()
    .prepare(
      `SELECT id, user_id, project_id, status, modal_call_id, started_at,
              completed_at, iteration_id, leaf_hash, run_sequence,
              error_detail, dispatch_log_path, retry_count
         FROM generation_jobs
        WHERE id = ? AND user_id = ?`,
    )
    .get(jobId, userId) as JobRow | undefined;
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Terminal states — return cached result without re-polling Modal.
  if (job.status === 'done') {
    return NextResponse.json({
      status: 'done',
      jobId: job.id,
      iterationId: job.iteration_id,
      leafHash: job.leaf_hash,
      runSequence: job.run_sequence,
      retryCount: job.retry_count,
    });
  }
  if (job.status === 'failed') {
    return NextResponse.json({
      status: 'failed',
      jobId: job.id,
      error: job.error_detail ?? 'unknown',
      retryCount: job.retry_count,
    });
  }

  if (!job.modal_call_id) {
    return NextResponse.json({
      status: 'failed',
      jobId: job.id,
      error: 'no modal_call_id on job row',
    });
  }

  // Poll Modal
  const modalStatus = await getWorkflowStatus(job.modal_call_id);

  if (modalStatus.status === 'running') {
    const elapsedSec = Math.round(
      (Date.now() - new Date(job.started_at).getTime()) / 1000,
    );
    return NextResponse.json({
      status: 'running',
      jobId: job.id,
      elapsedSec,
      retryCount: job.retry_count,
    });
  }

  if (modalStatus.status === 'failed') {
    // Preempted? Retry by re-spawning with the original workflow.
    if (modalStatus.preempted && job.retry_count < MAX_PREEMPTION_RETRIES) {
      const workflow = readWorkflowFromDispatchLog(job.dispatch_log_path);
      if (workflow) {
        const spawn = await spawnWorkflow(workflow);
        if (spawn.ok && spawn.callId) {
          conn().prepare(
            `UPDATE generation_jobs
                SET modal_call_id = ?, retry_count = retry_count + 1
              WHERE id = ?`,
          ).run(spawn.callId, job.id);
          return NextResponse.json({
            status: 'running',
            jobId: job.id,
            elapsedSec: 0,
            retryCount: job.retry_count + 1,
            note: 'Retried after Modal preemption',
          });
        }
      }
    }
    // Otherwise terminal failure
    conn().prepare(
      `UPDATE generation_jobs
          SET status = 'failed',
              error_detail = ?,
              completed_at = datetime('now')
        WHERE id = ?`,
    ).run(modalStatus.error, job.id);
    return NextResponse.json({
      status: 'failed',
      jobId: job.id,
      error: modalStatus.error,
      preempted: modalStatus.preempted,
      retryCount: job.retry_count,
    });
  }

  // status === 'done'
  const result = modalStatus.result;
  if (!result.ok || !result.image_bytes_b64) {
    const errMsg = result.error ?? 'modal returned no image';
    conn().prepare(
      `UPDATE generation_jobs
          SET status = 'failed',
              error_detail = ?,
              completed_at = datetime('now')
        WHERE id = ?`,
    ).run(errMsg, job.id);
    return NextResponse.json({
      status: 'failed',
      jobId: job.id,
      error: errMsg,
      retryCount: job.retry_count,
    });
  }

  // Success — ingest, write iteration row + artifact, update job row.
  try {
    const workflow = readWorkflowFromDispatchLog(job.dispatch_log_path) ?? {};
    const { iteration, leafHash, runSequence } = await ingestIteration({
      userId,
      projectId: job.project_id,
      provider: 'comfydeploy',
      providerJobId: result.prompt_id ?? job.modal_call_id,
      prompt: '(canvas workflow / modal)',
      spec: {
        prompt: '(canvas workflow)',
        providerExtras: { workflowApiJson: workflow },
      },
      imageBytes: Buffer.from(result.image_bytes_b64, 'base64'),
      imageContentType: result.content_type ?? 'image/png',
      executionBackend: result.attestation ? 'modal-tee' : 'modal-test',
      executionAttestation: result.attestation ?? null,
    });
    conn().prepare(
      `UPDATE generation_jobs
          SET status = 'done',
              iteration_id = ?,
              leaf_hash = ?,
              run_sequence = ?,
              completed_at = datetime('now')
        WHERE id = ?`,
    ).run(iteration.id, leafHash, runSequence, job.id);
    return NextResponse.json({
      status: 'done',
      jobId: job.id,
      iterationId: iteration.id,
      leafHash,
      runSequence,
      retryCount: job.retry_count,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    conn().prepare(
      `UPDATE generation_jobs
          SET status = 'failed',
              error_detail = ?,
              completed_at = datetime('now')
        WHERE id = ?`,
    ).run(`ingest_failed: ${errMsg}`, job.id);
    return NextResponse.json({
      status: 'failed',
      jobId: job.id,
      error: `ingest_failed: ${errMsg}`,
      retryCount: job.retry_count,
    });
  }
}

// Read the workflowApiJson from the dispatch log we wrote in /api/generate.
// Used for both ingestion (so the iteration row carries the workflow it
// actually came from) and preemption retry (we re-spawn the same bytes).
function readWorkflowFromDispatchLog(path: string | null): Record<string, unknown> | null {
  if (!path) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const text = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as { workflowApiJson?: Record<string, unknown> };
    return parsed.workflowApiJson ?? null;
  } catch {
    return null;
  }
}
