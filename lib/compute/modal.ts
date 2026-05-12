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
  prompt_id?: string;
  duration_ms?: number;
  gpu?: string;
  attestation?: Record<string, unknown> | null;
  error?: string;
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
        body: JSON.stringify({ workflow_api_json: workflowApiJson }),
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
      };
    } finally {
      clearTimeout(t);
    }
  },
};
