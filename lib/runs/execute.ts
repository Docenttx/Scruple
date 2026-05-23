// executeRun — the single capture/provenance entry point for a workflow run.
//
// Source-agnostic: inputs are resolved from inline/local/iteration/storage,
// settings come in as a ComfyUI workflow_api_json, execution goes to the
// Modal runner, and the result flows through ingestIteration so the output
// (image/video/checkpoint) AND every input are hashed, stored, manifested,
// and witnessed. Lock/mint then operate on the captured iterations exactly
// as for canvas runs.
//
// Today this is driven by the CC dev pipeline (/api/runs + CLI). Later the
// canvas becomes just another caller — "turn the valve" — with no change to
// capture/provenance.

import { modalRunner, spawnWorkflow, getWorkflowStatus } from '@/lib/compute/modal';
import { ingestIteration, type OutputKind } from '@/lib/iterations/ingest';
import { resolveInput, type RunInputSpec, type ResolvedInput } from './inputs';
import { conn } from '@/lib/db/sqlite';
import { nanoid } from 'nanoid';
import type { IterationRow } from '@/lib/types';

export interface ExecuteRunParams {
  userId: string;
  projectId: number;
  /** ComfyUI API-format workflow (the run conditions/settings). */
  workflowApiJson: Record<string, unknown>;
  /** Source materials for the run. Resolved server-side to bytes. */
  inputs?: RunInputSpec[];
  /** Override output kind; otherwise taken from the runner's detection. */
  outputKind?: OutputKind;
  /** Denormalized label for the iteration row. */
  prompt?: string;
}

export interface ExecuteRunResult {
  ok: boolean;
  iteration?: IterationRow;
  leafHash?: string;
  runSequence?: number;
  outputKind?: OutputKind;
  inputHashes?: Array<{ kind: string; hash: string; filename: string | null }>;
  durationMs?: number;
  gpu?: string;
  error?: string;
  detail?: string;
}

export async function executeRun(p: ExecuteRunParams): Promise<ExecuteRunResult> {
  // 1. Resolve every input to bytes (source-agnostic).
  let resolved: ResolvedInput[] = [];
  try {
    resolved = await Promise.all((p.inputs ?? []).map((s) => resolveInput(p.userId, s)));
  } catch (e) {
    return { ok: false, error: 'input_resolve_failed', detail: e instanceof Error ? e.message : String(e) };
  }

  // 2. Ship image/video inputs to the runner so LoadImage/LoadVideo resolve
  //    them by filename, then execute on Modal.
  const runnerInputs = resolved.map((r) => ({
    filename: r.filename,
    bytes_b64: r.bytes.toString('base64'),
  }));

  let result;
  try {
    result = await modalRunner.runWorkflow(p.workflowApiJson, { userId: p.userId }, runnerInputs);
  } catch (e) {
    return { ok: false, error: 'modal_run_failed', detail: e instanceof Error ? e.message : String(e) };
  }
  if (!result.ok) {
    return { ok: false, error: 'generation_failed', detail: result.rawError ?? 'unknown' };
  }

  // 3. Capture: inputs + typed output → hashed, stored, manifested, witnessed.
  const outputKind: OutputKind = p.outputKind ?? result.outputKind ?? 'image';
  const ingest = await ingestIteration({
    userId: p.userId,
    projectId: p.projectId,
    provider: 'comfydeploy',
    providerJobId: result.jobId,
    prompt: p.prompt ?? '(cc dev run)',
    spec: { prompt: p.prompt ?? '(cc dev run)', providerExtras: { workflowApiJson: p.workflowApiJson } } as never,
    imageBytes: result.imageBytes,
    imageContentType: result.contentType,
    outputKind,
    imageFilename: result.outputFilename ?? null,
    inputs: resolved.map((r) => ({
      kind: r.kind,
      bytes: r.bytes,
      filename: r.filename,
      contentType: r.contentType,
    })),
    executionBackend: result.attestation ? 'modal-tee' : 'modal-test',
    executionAttestation: result.attestation,
    modelFingerprints: result.modelFingerprints,
  });

  return {
    ok: true,
    iteration: ingest.iteration,
    leafHash: ingest.leafHash,
    runSequence: ingest.runSequence,
    outputKind,
    inputHashes: ingest.inputArtifacts.map((a) => ({ kind: a.kind, hash: a.hash, filename: a.filename })),
    durationMs: result.durationMs,
    gpu: result.gpu,
  };
}

// ── Async path ────────────────────────────────────────────────────────────
// Long workflows (LoRA training) can't finish inside a synchronous request
// (Next maxDuration + undici header timeout). executeRunAsync spawns the run
// on Modal and records a generation_jobs row; /api/runs/status polls and
// calls completeRun to ingest the result when the run finishes.

export interface SpawnRunResult {
  ok: boolean;
  jobId?: string;
  callId?: string;
  error?: string;
  detail?: string;
}

export async function executeRunAsync(p: ExecuteRunParams): Promise<SpawnRunResult> {
  let resolved: ResolvedInput[] = [];
  try {
    resolved = await Promise.all((p.inputs ?? []).map((s) => resolveInput(p.userId, s)));
  } catch (e) {
    return { ok: false, error: 'input_resolve_failed', detail: e instanceof Error ? e.message : String(e) };
  }

  const runnerInputs = resolved.map((r) => ({ filename: r.filename, bytes_b64: r.bytes.toString('base64') }));
  const spawn = await spawnWorkflow(p.workflowApiJson, runnerInputs);
  if (!spawn.ok || !spawn.callId) {
    return { ok: false, error: 'spawn_failed', detail: spawn.error ?? 'unknown' };
  }

  const jobId = nanoid();
  conn().prepare(
    `INSERT INTO generation_jobs
       (id, user_id, project_id, status, modal_call_id,
        run_inputs, run_output_kind, run_prompt, run_workflow)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    p.userId,
    p.projectId,
    spawn.callId,
    JSON.stringify(p.inputs ?? []),
    p.outputKind ?? null,
    p.prompt ?? null,
    JSON.stringify(p.workflowApiJson),
  );

  return { ok: true, jobId, callId: spawn.callId };
}

interface RunJobRow {
  id: string;
  user_id: string;
  project_id: number;
  status: string;
  modal_call_id: string | null;
  iteration_id: number | null;
  leaf_hash: string | null;
  run_sequence: number | null;
  error_detail: string | null;
  run_inputs: string | null;
  run_output_kind: string | null;
  run_prompt: string | null;
  run_workflow: string | null;
}

export interface RunJobStatus {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  outputKind?: OutputKind;
  leafHash?: string | null;
  runSequence?: number | null;
  iterationId?: number | null;
  inputHashes?: Array<{ kind: string; hash: string; filename: string | null }>;
  error?: string;
}

/**
 * Poll a run job; ingest + finalize when the Modal call completes.
 * Idempotent — once status='done'/'failed' it just returns the stored row.
 */
export async function pollRunJob(userId: string, jobId: string): Promise<RunJobStatus | null> {
  const job = conn()
    .prepare(`SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?`)
    .get(jobId, userId) as RunJobRow | undefined;
  if (!job) return null;

  if (job.status === 'done') {
    return { jobId, status: 'done', leafHash: job.leaf_hash, runSequence: job.run_sequence, iterationId: job.iteration_id };
  }
  if (job.status === 'failed') {
    return { jobId, status: 'failed', error: job.error_detail ?? 'unknown' };
  }
  if (!job.modal_call_id) {
    return { jobId, status: 'running' };
  }

  const st = await getWorkflowStatus(job.modal_call_id);
  if (st.status === 'running') {
    return { jobId, status: 'running' };
  }
  if (st.status === 'failed') {
    conn().prepare(`UPDATE generation_jobs SET status='failed', error_detail=?, completed_at=datetime('now') WHERE id=?`)
      .run(st.error.slice(0, 1000), jobId);
    return { jobId, status: 'failed', error: st.error };
  }

  // done — ingest the result through the shared capture path.
  const r = st.result;
  if (!r.ok || !r.image_bytes_b64) {
    const err = r.error ?? 'modal returned no output';
    conn().prepare(`UPDATE generation_jobs SET status='failed', error_detail=?, completed_at=datetime('now') WHERE id=?`)
      .run(String(err).slice(0, 1000), jobId);
    return { jobId, status: 'failed', error: err };
  }

  const specs = job.run_inputs ? (JSON.parse(job.run_inputs) as RunInputSpec[]) : [];
  let resolved: ResolvedInput[] = [];
  try {
    resolved = await Promise.all(specs.map((s) => resolveInput(userId, s)));
  } catch (e) {
    const err = `input_reresolve_failed: ${e instanceof Error ? e.message : String(e)}`;
    conn().prepare(`UPDATE generation_jobs SET status='failed', error_detail=?, completed_at=datetime('now') WHERE id=?`)
      .run(err.slice(0, 1000), jobId);
    return { jobId, status: 'failed', error: err };
  }

  const outputKind = (r.output_kind ?? (job.run_output_kind as OutputKind | null) ?? 'image') as OutputKind;
  // Bind the producing workflow into spec so input_hash + workflow_hash
  // cover it — parity with the sync executeRun path. Without this, async
  // runs anchor only the prompt and the workflow is unwitnessed (T4
  // regression introduced when run_workflow moved to generation_jobs).
  let workflowApiJson: Record<string, unknown> | null = null;
  if (job.run_workflow) {
    try { workflowApiJson = JSON.parse(job.run_workflow) as Record<string, unknown>; }
    catch { workflowApiJson = null; }
  }
  const ingest = await ingestIteration({
    userId,
    projectId: job.project_id,
    provider: 'comfydeploy',
    providerJobId: r.prompt_id ?? jobId,
    prompt: job.run_prompt ?? '(cc dev run)',
    spec: {
      prompt: job.run_prompt ?? '(cc dev run)',
      providerExtras: workflowApiJson ? { workflowApiJson } : {},
    } as never,
    imageBytes: Buffer.from(r.image_bytes_b64, 'base64'),
    imageContentType: r.content_type ?? 'application/octet-stream',
    outputKind,
    imageFilename: r.output_filename ?? null,
    inputs: resolved.map((x) => ({ kind: x.kind, bytes: x.bytes, filename: x.filename, contentType: x.contentType })),
    executionBackend: r.attestation ? 'modal-tee' : 'modal-test',
    executionAttestation: r.attestation,
    modelFingerprints: r.model_fingerprints,
  });

  conn().prepare(
    `UPDATE generation_jobs SET status='done', iteration_id=?, leaf_hash=?, run_sequence=?, completed_at=datetime('now') WHERE id=?`,
  ).run(ingest.iteration.id, ingest.leafHash, ingest.runSequence, jobId);

  return {
    jobId,
    status: 'done',
    outputKind,
    leafHash: ingest.leafHash,
    runSequence: ingest.runSequence,
    iterationId: ingest.iteration.id,
    inputHashes: ingest.inputArtifacts.map((a) => ({ kind: a.kind, hash: a.hash, filename: a.filename })),
  };
}
