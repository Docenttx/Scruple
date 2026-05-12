// POST /api/generate
//
// Two modes:
//
//   1. Prompt mode (workspace GeneratePanel)
//      { projectId, prompt, ...spec }
//      → comfyDeployProvider.submit({prompt}, {apiKey, workflowId=project.comfy_workflow_id})
//
//   2. Workflow-JSON mode (Canvas Queue intercept)
//      { projectId?, workflowApiJson, machineId? }
//      → comfyDeployProvider.submitWorkflow(workflowApiJson, machineId, {apiKey})
//
// In workflow mode the projectId is optional — if absent we look up
// the user's currently-active project. machineId defaults to the
// per-user `comfy_machine_id` saved in user_settings.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { comfyDeployProvider } from '@/lib/providers/comfydeploy';
import { ProviderError } from '@/lib/providers/types';
import { getDecryptedProviderKey } from '@/lib/settings/actions';
import { ingestIteration } from '@/lib/iterations/ingest';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import { getActiveProject } from '@/lib/projects/actions';
import type { GenerationSpec, ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PromptBody = z.object({
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

const WorkflowBody = z.object({
  projectId: z.number().int().positive().optional(),
  workflowApiJson: z.record(z.unknown()),
  workflow: z.unknown().optional(),
  machineId: z.string().optional(),
});

type PromptInput = z.infer<typeof PromptBody>;
type WorkflowInput = z.infer<typeof WorkflowBody>;

const POLL_SCHEDULE_MS = [
  1_000, 1_000, 1_500, 2_000, 2_500, 3_000,
  ...Array<number>(80).fill(3_000),
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface UserSettingsRow {
  settings: string;
}

function getUserMachineId(userId: string): string | null {
  const row = conn()
    .prepare(`SELECT settings FROM user_settings WHERE user_id = ?`)
    .get(userId) as UserSettingsRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.settings) as { comfy_machine_id?: string };
    return parsed.comfy_machine_id ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (e) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const isWorkflowMode =
    typeof rawBody === 'object' &&
    rawBody !== null &&
    'workflowApiJson' in rawBody;

  let workflowBody: WorkflowInput | null = null;
  let promptBody: PromptInput | null = null;
  try {
    if (isWorkflowMode) {
      workflowBody = WorkflowBody.parse(rawBody);
    } else {
      promptBody = PromptBody.parse(rawBody);
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const projectId = workflowBody?.projectId ?? promptBody?.projectId;

  // Resolve project: explicit projectId wins; else active project.
  let project: ProjectRow | undefined;
  if (projectId) {
    project = conn()
      .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
      .get(projectId, userId) as ProjectRow | undefined;
  } else {
    project = (await getActiveProject()) ?? undefined;
  }
  if (!project) {
    return NextResponse.json(
      { error: 'No project — pass projectId or activate one in scruple-web first' },
      { status: 400 },
    );
  }
  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json(
      { error: 'Project is locked; new iterations rejected' },
      { status: 409 },
    );
  }

  const apiKey = await getDecryptedProviderKey('comfydeploy');
  if (!apiKey) {
    return NextResponse.json(
      { error: 'No ComfyDeploy API key on file. Add one in /settings.' },
      { status: 400 },
    );
  }

  const startedAt = Date.now();

  // Build spec + submit.
  let jobId: string;
  let spec: GenerationSpec;
  let promptForRecord: string;

  try {
    if (workflowBody) {
      const machineId = workflowBody.machineId ?? getUserMachineId(userId);
      if (!machineId) {
        return NextResponse.json(
          {
            error:
              'No ComfyDeploy machine_id configured. Set comfy_machine_id in your user settings.',
          },
          { status: 400 },
        );
      }
      spec = {
        prompt: '(canvas workflow)',
        providerExtras: { workflowApiJson: workflowBody.workflowApiJson, machineId },
      };
      promptForRecord = '(canvas workflow)';
      if (!comfyDeployProvider.submitWorkflow) {
        return NextResponse.json(
          { error: 'submitWorkflow not implemented for this provider' },
          { status: 501 },
        );
      }
      const submitResult = await comfyDeployProvider.submitWorkflow(
        workflowBody.workflowApiJson,
        machineId,
        { apiKey },
      );
      jobId = submitResult.jobId;
    } else if (promptBody) {
      if (!project.comfy_workflow_id) {
        return NextResponse.json(
          { error: 'Project has no ComfyDeploy workflow configured. Set one in the workspace.' },
          { status: 400 },
        );
      }
      spec = {
        prompt: promptBody.prompt,
        negativePrompt: promptBody.negativePrompt,
        width: promptBody.width,
        height: promptBody.height,
        seed: promptBody.seed,
        steps: promptBody.steps,
        cfgScale: promptBody.cfgScale,
        providerExtras: promptBody.providerExtras,
      };
      promptForRecord = promptBody.prompt;
      const submitResult = await comfyDeployProvider.submit(spec, {
        apiKey,
        workflowId: project.comfy_workflow_id,
      });
      jobId = submitResult.jobId;
    } else {
      return NextResponse.json({ error: 'No valid body' }, { status: 400 });
    }
  } catch (e) {
    const detail = e instanceof ProviderError ? e.message : String(e);
    try {
      logTelemetry({
        userId,
        projectId: project.id,
        provider: 'comfydeploy',
        prompt: promptBody?.prompt ?? '(canvas workflow)',
        spec: {} as Record<string, unknown>,
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
      const polled = await comfyDeployProvider.poll(jobId, { apiKey });
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
        projectId: project.id,
        provider: 'comfydeploy',
        providerJobId: jobId,
        prompt: promptForRecord,
        spec: spec as unknown as Record<string, unknown>,
        costCents: estimateCostCents('comfydeploy'),
        durationMs: Date.now() - startedAt,
        success: false,
        error: detail,
      });
    } catch {}
    return NextResponse.json({ error: 'generation_failed', detail }, { status: 502 });
  }

  if (!result.result) {
    return NextResponse.json({ error: 'generation_failed', detail: 'no result payload' }, { status: 502 });
  }
  const { imageBytes, contentType } = result.result;
  const { iteration, leafHash, runSequence } = ingestIteration({
    userId,
    projectId: project.id,
    provider: 'comfydeploy',
    providerJobId: jobId,
    prompt: promptForRecord,
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
