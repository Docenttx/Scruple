// Modal compute backend (Pivot E4; refactored to implement the
// ComputeBackend interface from lib/compute/backends.ts).
//
// Calls the deployed Scruple Runner web endpoint. The endpoint URL
// comes from `MODAL_RUNNER_ENDPOINT` env (set after `modal deploy`).
//
// Per D-016 the cloud backend is exclusively TEE-attested H100 once we
// flip the Modal function's GPU to H100 CC mode. On free tier
// (SCRUPLE_MODAL_GPU=T4) the response carries `attestation: null` —
// the trust ladder is honest about which tier ran the workflow.

import type { ComputeBackend, ComputeContext, ComputeResult } from './backends';
import { ComputeError } from './backends';

// Retained name for back-compat with callers that import ModalRunResult.
export type ModalRunResult = ComputeResult;

interface ModalResponse {
  ok: boolean;
  image_bytes_b64?: string;
  content_type?: string;
  output_kind?: 'image' | 'video' | 'checkpoint';
  output_filename?: string;
  prompt_id?: string;
  duration_ms?: number;
  gpu?: string;
  attestation?: Record<string, unknown> | null;
  // In-container fingerprints of every model file the workflow loaded.
  // Keyed by volume-relative path ('checkpoints/v1-5-...safetensors').
  // Pins the bytes that produced this run; later swap detection is
  // re-hashing the file at the same path.
  model_fingerprints?: Record<string, {
    content_hash?: string | null;
    header_hash?: string | null;
    header_size?: number | null;
    bytes?: number;
    mtime?: number;
  }>;
  // WO-B1 — container-side machine manifest (sha256 of canonical form).
  // When present, the web-side ingest prefers this over the DB-lookup
  // default because it pins the toolchain the runner ACTUALLY had, not
  // what the descriptor claimed. Null when the runner can't resolve it.
  container_machine_manifest?: Record<string, unknown> | null;
  container_machine_manifest_hash?: string | null;
  error?: string;
}

/** An input file shipped to the runner to place in ComfyUI's input dir. */
export interface RunnerInput {
  filename: string;
  bytes_b64: string;
}

const ENDPOINT = process.env.MODAL_RUNNER_ENDPOINT;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Back-compat alias for the old ModalError class. Throws are now
// ComputeError instances; the alias keeps any prior catch-blocks happy.
export { ComputeError as ModalError };

export const modalRunner: ComputeBackend = {
  name: 'modal',
  // Free-tier T4 is L1+L2 (no hardware attestation). When SCRUPLE_MODAL_GPU
  // flips to H100 CC mode we'll add a sibling backend `modalRunnerAttested`
  // with trustTier='L1+L2+L3'.
  trustTier: 'L1+L2',

  isConfigured(ctx?: ComputeContext): boolean {
    return !!(ctx?.endpointUrl || ENDPOINT);
  },

  async runWorkflow(
    workflowApiJson: Record<string, unknown>,
    ctx?: ComputeContext,
    inputs?: RunnerInput[],
  ): Promise<ComputeResult> {
    const endpoint = ctx?.endpointUrl || ENDPOINT;
    if (!endpoint) {
      throw new ComputeError(
        'modal',
        'no_endpoint',
        'MODAL_RUNNER_ENDPOINT not set. Run `modal deploy modal/scruple_runner.py` and copy the printed web URL into .env.local.',
      );
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_api_json: workflowApiJson,
          ...(inputs && inputs.length ? { inputs } : {}),
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ComputeError('modal', 'transport', `HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as ModalResponse;
      if (!data.ok || !data.image_bytes_b64) {
        return {
          ok: false,
          jobId: data.prompt_id ?? 'unknown',
          imageBytes: Buffer.alloc(0),
          contentType: 'application/octet-stream',
          durationMs: data.duration_ms ?? 0,
          attestation: null,
          gpu: data.gpu ?? '?',
          rawError: data.error ?? 'unknown',
        };
      }
      return {
        ok: true,
        jobId: data.prompt_id!,
        imageBytes: Buffer.from(data.image_bytes_b64, 'base64'),
        contentType: data.content_type ?? 'image/png',
        durationMs: data.duration_ms ?? 0,
        attestation: data.attestation ?? null,
        gpu: data.gpu ?? '?',
        modelFingerprints: data.model_fingerprints ?? {},
        outputKind: data.output_kind ?? 'image',
        outputFilename: data.output_filename,
        containerMachineManifestHash: data.container_machine_manifest_hash ?? null,
        containerMachineManifest: data.container_machine_manifest ?? null,
      };
    } finally {
      clearTimeout(t);
    }
  },
};

// ── Async spawn + poll (Replicate-style) ──────────────────────────────────
//
// Workflow:
//   const { callId } = await spawnWorkflow(json);          // fire async
//   const status     = await getWorkflowStatus(callId);    // poll until done
//
// Modal-side endpoints: admin-spawn-workflow + admin-workflow-status.
// Auth via SCRUPLE_MODAL_ADMIN_TOKEN (same shared secret as the model
// library admin endpoints).

const MODAL_WORKSPACE = process.env.MODAL_WORKSPACE ?? 'aquanomous';
const ADMIN_TOKEN = process.env.SCRUPLE_MODAL_ADMIN_TOKEN ?? '';

function adminUrl(label: string): string {
  return `https://${MODAL_WORKSPACE}--${label}.modal.run/`;
}

export interface SpawnResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export interface WorkflowStatusRunning {
  status: 'running';
}
export interface WorkflowStatusDone {
  status: 'done';
  result: {
    ok: boolean;
    image_bytes_b64?: string;
    content_type?: string;
    output_kind?: 'image' | 'video' | 'checkpoint';
    output_filename?: string;
    prompt_id?: string;
    duration_ms?: number;
    gpu?: string;
    attestation?: Record<string, unknown> | null;
    model_fingerprints?: Record<string, {
      content_hash?: string | null;
      header_hash?: string | null;
      header_size?: number | null;
      bytes?: number;
      mtime?: number;
    }>;
    // WO-B1 / WO-27 — the runner has returned both of these since WO-B1
    // (modal/scruple_runner.py:664-676) and the SYNC result type declared
    // them, but WorkflowStatusDone did not. So the ASYNC path — the one
    // CanvasBridge and /api/runs?async=1 actually use — could not pass the
    // container manifest through even if a caller wanted to, because the
    // field did not exist to read. Undeclared is how a value that is on the
    // wire ends up with zero consumers.
    container_machine_manifest?: Record<string, unknown> | null;
    container_machine_manifest_hash?: string | null;
    error?: string;
  };
}
export interface WorkflowStatusFailed {
  status: 'failed';
  error: string;
  preempted: boolean;
}
export type WorkflowStatus = WorkflowStatusRunning | WorkflowStatusDone | WorkflowStatusFailed;

export async function spawnWorkflow(
  workflowApiJson: Record<string, unknown>,
  inputs?: RunnerInput[],
): Promise<SpawnResult> {
  if (!ADMIN_TOKEN) {
    return { ok: false, error: 'SCRUPLE_MODAL_ADMIN_TOKEN not set' };
  }
  const res = await fetch(adminUrl('admin-spawn-workflow'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
    body: JSON.stringify({
      workflow_api_json: workflowApiJson,
      ...(inputs && inputs.length ? { inputs } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = (await res.json()) as { ok: boolean; call_id?: string; error?: string };
  if (!data.ok || !data.call_id) {
    return { ok: false, error: data.error ?? 'spawn returned no call_id' };
  }
  return { ok: true, callId: data.call_id };
}

export async function getWorkflowStatus(callId: string): Promise<WorkflowStatus> {
  if (!ADMIN_TOKEN) {
    return { status: 'failed', error: 'SCRUPLE_MODAL_ADMIN_TOKEN not set', preempted: false };
  }
  const url = new URL(adminUrl('admin-workflow-status'));
  url.searchParams.set('call_id', callId);
  const res = await fetch(url.toString(), {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      status: 'failed',
      error: `status_endpoint_${res.status}: ${text.slice(0, 200)}`,
      preempted: false,
    };
  }
  return (await res.json()) as WorkflowStatus;
}
