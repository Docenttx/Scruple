// fal.ai adapter — see research/prior-art-ai-council/fal/lib-fal.ts for the
// production-tested ai-council version. This rewrite slots into our
// GenerationProvider interface.

import type { GenerationProvider, SubmitResult, PollResult, ProviderContext } from './types';
import { ProviderError } from './types';
import type { GenerationSpec } from '@/lib/types';

const FAL_QUEUE = 'https://queue.fal.run';
const DEFAULT_MODEL = 'fal-ai/fast-sdxl';

function fetchOptions(apiKey: string | undefined): RequestInit {
  if (!apiKey) {
    throw new ProviderError('fal', 'auth', 'FAL_KEY missing — set in user settings or .env');
  }
  return {
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
}

export const falProvider: GenerationProvider = {
  name: 'fal',

  async submit(spec: GenerationSpec, ctx: ProviderContext): Promise<SubmitResult> {
    const opts = fetchOptions(ctx.apiKey);
    const model =
      (spec.providerExtras?.model as string | undefined) ?? DEFAULT_MODEL;

    const body = {
      prompt: spec.prompt,
      negative_prompt: spec.negativePrompt,
      image_size:
        spec.width && spec.height ? { width: spec.width, height: spec.height } : 'square_hd',
      num_inference_steps: spec.steps ?? 25,
      guidance_scale: spec.cfgScale ?? 7.5,
      seed: spec.seed,
      ...(spec.providerExtras as Record<string, unknown> | undefined),
    };

    const res = await fetch(`${FAL_QUEUE}/${model}`, {
      ...opts,
      method: 'POST',
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
      throw new ProviderError('fal', code, `submit failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { request_id: string; status_url?: string };
    return { jobId: data.request_id, statusUrl: data.status_url };
  },

  async poll(jobId: string, ctx: ProviderContext): Promise<PollResult> {
    const opts = fetchOptions(ctx.apiKey);
    const model =
      (ctx as ProviderContext & { model?: string }).model ?? DEFAULT_MODEL;
    const statusUrl = `${FAL_QUEUE}/${model}/requests/${jobId}/status`;
    const res = await fetch(statusUrl, opts);
    if (!res.ok) {
      return { status: 'failed', error: `status ${res.status}` };
    }
    const data = (await res.json()) as { status: string };
    if (data.status === 'COMPLETED') {
      const responseUrl = `${FAL_QUEUE}/${model}/requests/${jobId}`;
      const r = await fetch(responseUrl, opts);
      if (!r.ok) return { status: 'failed', error: `result ${r.status}` };
      const result = (await r.json()) as {
        images?: Array<{ url: string; content_type?: string }>;
      };
      const first = result.images?.[0];
      if (!first?.url) return { status: 'failed', error: 'no images returned' };

      const imgRes = await fetch(first.url);
      if (!imgRes.ok) return { status: 'failed', error: `download ${imgRes.status}` };
      const buf = Buffer.from(await imgRes.arrayBuffer());

      return {
        status: 'completed',
        result: {
          jobId,
          imageBytes: buf,
          contentType: first.content_type ?? imgRes.headers.get('content-type') ?? 'image/png',
          providerMetadata: result,
        },
      };
    }
    if (data.status === 'IN_QUEUE') return { status: 'queued' };
    if (data.status === 'IN_PROGRESS') return { status: 'in_progress' };
    return { status: 'failed', error: `unknown status: ${data.status}` };
  },
};
