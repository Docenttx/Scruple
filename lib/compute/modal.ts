// Modal compute backend (Pivot E4).
//
// Calls the deployed Scruple Runner web endpoint. The endpoint URL
// comes from `MODAL_RUNNER_ENDPOINT` env (set after `modal deploy`).
//
// Per D-016 the cloud backend is exclusively TEE-attested H100 once we
// flip the Modal function's GPU to H100 CC mode. On free tier
// (SCRUPLE_MODAL_GPU=T4) the response carries `attestation: null` —
// the trust ladder is honest about which tier ran the workflow.

export interface ModalRunResult {
  ok: boolean;
  jobId: string;
  imageBytes: Buffer;
  contentType: string;
  durationMs: number;
  attestation: Record<string, unknown> | null;
  gpu: string;
  rawError?: string;
}

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

export class ModalError extends Error {
  constructor(public readonly code: 'no_endpoint' | 'transport' | 'remote_error', message: string) {
    super(`[modal:${code}] ${message}`);
  }
}

export const modalRunner = {
  isConfigured(): boolean {
    return !!ENDPOINT;
  },

  async runWorkflow(workflowApiJson: Record<string, unknown>): Promise<ModalRunResult> {
    if (!ENDPOINT) {
      throw new ModalError(
        'no_endpoint',
        'MODAL_RUNNER_ENDPOINT not set. Run `modal deploy modal/scruple_runner.py` and copy the printed web URL into .env.local.',
      );
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_api_json: workflowApiJson }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ModalError('transport', `HTTP ${res.status}: ${detail.slice(0, 300)}`);
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
