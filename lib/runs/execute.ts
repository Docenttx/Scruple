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

import { modalRunner } from '@/lib/compute/modal';
import { ingestIteration, type OutputKind } from '@/lib/iterations/ingest';
import { resolveInput, type RunInputSpec, type ResolvedInput } from './inputs';
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
