// ComfyDeploy adapter — BYO ComfyDeploy account.
// API surface: https://comfydeploy.com (REST). User pays ComfyDeploy
// directly for GPU; Scruple Web witnesses outputs only.
//
// Endpoints used (verified at time of writing):
//   POST https://api.comfydeploy.com/api/run        — submit a workflow run
//   GET  https://api.comfydeploy.com/api/run/{id}   — fetch run status + outputs

import type { GenerationProvider, SubmitResult, PollResult, ProviderContext } from './types';
import { ProviderError } from './types';
import type { GenerationSpec } from '@/lib/types';

const CD_BASE = 'https://api.comfydeploy.com';

function authHeaders(apiKey: string | undefined): HeadersInit {
  if (!apiKey) {
    throw new ProviderError(
      'comfydeploy',
      'auth',
      'ComfyDeploy API key missing — add in /settings',
    );
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export const comfyDeployProvider: GenerationProvider = {
  name: 'comfydeploy',

  async submit(spec: GenerationSpec, ctx: ProviderContext): Promise<SubmitResult> {
    if (!ctx.workflowId) {
      throw new ProviderError(
        'comfydeploy',
        'invalid_input',
        'workflowId required (configure per-project)',
      );
    }
    const headers = authHeaders(ctx.apiKey);

    const body = {
      deployment_id: ctx.workflowId,
      inputs: {
        prompt: spec.prompt,
        negative_prompt: spec.negativePrompt,
        width: spec.width,
        height: spec.height,
        seed: spec.seed,
        steps: spec.steps,
        cfg: spec.cfgScale,
        ...(spec.providerExtras as Record<string, unknown> | undefined),
      },
    };

    const res = await fetch(`${CD_BASE}/api/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const code =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : 'provider_failure';
      throw new ProviderError(
        'comfydeploy',
        code,
        `submit failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const data = (await res.json()) as { run_id: string };
    return { jobId: data.run_id };
  },

  async poll(jobId: string, ctx: ProviderContext): Promise<PollResult> {
    const headers = authHeaders(ctx.apiKey);
    const res = await fetch(`${CD_BASE}/api/run/${jobId}`, { headers });
    if (!res.ok) {
      return { status: 'failed', error: `status ${res.status}` };
    }
    const data = (await res.json()) as {
      status: string;
      outputs?: Array<{ data: { images?: Array<{ url: string }> } }>;
    };
    if (data.status === 'success') {
      const first = data.outputs?.[0]?.data.images?.[0];
      if (!first?.url) return { status: 'failed', error: 'no image in outputs' };
      const imgRes = await fetch(first.url);
      if (!imgRes.ok) return { status: 'failed', error: `download ${imgRes.status}` };
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return {
        status: 'completed',
        result: {
          jobId,
          imageBytes: buf,
          contentType: imgRes.headers.get('content-type') ?? 'image/png',
          providerMetadata: data,
        },
      };
    }
    if (data.status === 'queued') return { status: 'queued' };
    if (data.status === 'running' || data.status === 'started') return { status: 'in_progress' };
    if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'timeout') {
      return { status: 'failed', error: data.status };
    }
    return { status: 'failed', error: `unknown status: ${data.status}` };
  },
};
