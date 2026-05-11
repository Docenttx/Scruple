// POST /api/generate
//
// Bridges the ComfyDeploy adapter to the iteration ingest pipeline.
// Loads the user's encrypted ComfyDeploy key + the project's
// configured workflow id, submits the run, polls until terminal, and
// hands the resulting image bytes to ingestIteration().
//
// Body (all optional except prompt):
//   {
//     projectId: number,
//     prompt: string,
//     negativePrompt?: string,
//     width?: number, height?: number,
//     seed?: number, steps?: number, cfgScale?: number,
//     providerExtras?: Record<string, unknown>
//   }
//
// Response (success): { ok: true, iteration, leafHash, runSequence }
// Response (error):   { error, detail? }
//
// Failures emit a telemetry row with success=0 so /settings rollups
// reflect attempted spend even when ComfyDeploy fails.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { comfyDeployProvider } from '@/lib/providers/comfydeploy';
import { ProviderError } from '@/lib/providers/types';
import { getDecryptedProviderKey } from '@/lib/settings/actions';
import { ingestIteration } from '@/lib/iterations/ingest';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import type { GenerationSpec, ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
// Provider polling can take a couple of minutes for heavy workflows.
export const maxDuration = 300;

const Body = z.object({
  projectId: z.number().int().positive(),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  steps: z.number().int().positive().optional(),
  cfgScale: z.number().positive().optional(),
  providerExtras: z.record(z.unknown()).optional(),
});

// Poll cadence: fast at first, then back off. Max ~4 minutes total.
const POLL_SCHEDULE_MS = [
  1_000, 1_000, 1_500, 2_000, 2_500, 3_000,
  ...Array<number>(80).fill(3_000),
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json(
      { error: 'Project is locked; new iterations rejected' },
      { status: 409 },
    );
  }
  if (!project.comfy_workflow_id) {
    return NextResponse.json(
      { error: 'Project has no ComfyDeploy workflow configured. Set one in the workspace.' },
      { status: 400 },
    );
  }

  const apiKey = await getDecryptedProviderKey('comfydeploy');
  if (!apiKey) {
    return NextResponse.json(
      { error: 'No ComfyDeploy API key on file. Add one in /settings.' },
      { status: 400 },
    );
  }

  const spec: GenerationSpec = {
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    width: body.width,
    height: body.height,
    seed: body.seed,
    steps: body.steps,
    cfgScale: body.cfgScale,
    providerExtras: body.providerExtras,
  };

  const ctx = { apiKey, workflowId: project.comfy_workflow_id };

  const startedAt = Date.now();
  let jobId: string;
  try {
    const submitResult = await comfyDeployProvider.submit(spec, ctx);
    jobId = submitResult.jobId;
  } catch (e) {
    const detail = e instanceof ProviderError ? e.message : String(e);
    try {
      logTelemetry({
        userId,
        projectId: body.projectId,
        provider: 'comfydeploy',
        prompt: body.prompt,
        spec: spec as unknown as Record<string, unknown>,
        success: false,
        error: detail,
      });
    } catch {}
    return NextResponse.json({ error: 'submit_failed', detail }, { status: 502 });
  }

  // Poll until terminal.
  let result: Awaited<ReturnType<typeof comfyDeployProvider.poll>> | null = null;
  for (const delay of POLL_SCHEDULE_MS) {
    await sleep(delay);
    try {
      const polled = await comfyDeployProvider.poll(jobId, ctx);
      if (polled.status === 'completed' || polled.status === 'failed') {
        result = polled;
        break;
      }
    } catch (e) {
      result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      break;
    }
  }

  if (!result || result.status === 'failed') {
    const detail = result?.status === 'failed' ? result.error ?? 'unknown' : 'timeout';
    try {
      logTelemetry({
        userId,
        projectId: body.projectId,
        provider: 'comfydeploy',
        providerJobId: jobId,
        prompt: body.prompt,
        spec: spec as unknown as Record<string, unknown>,
        costCents: estimateCostCents('comfydeploy'),
        durationMs: Date.now() - startedAt,
        success: false,
        error: detail,
      });
    } catch {}
    return NextResponse.json({ error: 'generation_failed', detail }, { status: 502 });
  }

  // result.status === 'completed'
  if (!result.result) {
    return NextResponse.json({ error: 'generation_failed', detail: 'no result payload' }, { status: 502 });
  }
  const { imageBytes, contentType } = result.result;
  const { iteration, leafHash, runSequence } = ingestIteration({
    userId,
    projectId: body.projectId,
    provider: 'comfydeploy',
    providerJobId: jobId,
    prompt: body.prompt,
    spec,
    imageBytes,
    imageContentType: contentType,
  });

  return NextResponse.json({
    ok: true,
    iteration,
    leafHash,
    runSequence,
    durationMs: Date.now() - startedAt,
  });
}
