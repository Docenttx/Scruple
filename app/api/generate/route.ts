// POST /api/generate
//
// Workflow-JSON mode only (Canvas Queue intercept).
//   { projectId?, workflowApiJson, machineId? }
//   → modalRunner.runWorkflow(workflowApiJson)   [pivot default]
//   → comfyDeployProvider.submitWorkflow(...)    [legacy / BYO]
//
// Project-page "prompt mode" was removed in migration 012 — the
// workspace tab is now a passive observer; prompts live in canvas
// nodes. Project rows no longer carry comfy_workflow_id.
//
// projectId is optional in this body — if absent we resolve to the
// user's currently-active project. machineId defaults to the per-user
// `comfy_machine_id` saved in user_settings.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { comfyDeployProvider } from '@/lib/providers/comfydeploy';
import { ProviderError } from '@/lib/providers/types';
import { getDecryptedProviderKey } from '@/lib/settings/actions';
import { ingestIteration } from '@/lib/iterations/ingest';
import { modalRunner, ModalError, spawnWorkflow } from '@/lib/compute/modal';
import { resolveActiveMachine } from '@/lib/compute/getActiveMachine';
import { resolveEndpointForMachine } from '@/lib/compute/machines';
import { nanoid } from 'nanoid';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import { getActiveProject } from '@/lib/projects/actions';
import type { GenerationSpec, ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const WorkflowBody = z.object({
  projectId: z.number().int().positive().optional(),
  workflowApiJson: z.record(z.unknown()),
  workflow: z.unknown().optional(),
  machineId: z.string().optional(),
});

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

  let workflowBody: WorkflowInput;
  try {
    workflowBody = WorkflowBody.parse(rawBody);
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body — workflowApiJson is required', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const projectId = workflowBody.projectId;

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

  // Workflow mode + Modal configured → cloud GPU via Modal (pivot default).
  // Falls through to ComfyDeploy path if no Modal endpoint set OR user
  // is on explicit BYO path (passed an explicit comfyDeploy machineId).
  const startedAt = Date.now();
  const url = new URL(req.url);
  const forceBackend = url.searchParams.get('backend');
  const wantsModal =
    forceBackend === 'modal' ||
    (forceBackend !== 'comfydeploy' && !workflowBody.machineId && modalRunner.isConfigured());

  // Resolve the user's Settings → Compute choice. Drives:
  //   - which Modal HTTP endpoint we POST the workflow to (via the
  //     per-machine env var, with graceful fallback to the legacy
  //     single MODAL_RUNNER_ENDPOINT)
  //   - which catalog id we persist on the iteration row, so the
  //     receipt and audit can report exactly which GPU class ran the
  //     run
  // For non-Modal backends (BYO ComfyDeploy) the machine selection
  // is informational only — the receipt still cites the chosen
  // catalog entry but BYO Comfy decides its own GPU.
  const activeMachine = resolveActiveMachine(userId);
  const machineEndpoint = wantsModal
    ? resolveEndpointForMachine(activeMachine.machine)
    : { url: null, fellBackToLegacy: false };
  if (wantsModal && machineEndpoint.fellBackToLegacy) {
    console.warn(
      `[generate] user ${userId} machine=${activeMachine.machine.id} — per-machine endpoint ` +
      `(${activeMachine.machine.endpointEnvVar}) not set, falling back to MODAL_RUNNER_ENDPOINT`,
    );
  }

  // Pre-flight provenance capture — write the workflow JSON to disk
  // BEFORE we ship it to Modal/Comfy. Survives any downstream failure.
  // Path: /tmp/scruple-dispatch/<projectId>/<unix-ms>.json
  // Returned in both success and error responses as `dispatchLogPath`.
  let dispatchLogPath: string | null = null;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join('/tmp/scruple-dispatch', String(project.id));
    fs.mkdirSync(dir, { recursive: true });
    dispatchLogPath = path.join(dir, `${Date.now()}.json`);
    fs.writeFileSync(
      dispatchLogPath,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          userId,
          projectId: project.id,
          projectName: project.name,
          backend: wantsModal ? 'modal' : 'comfydeploy',
          machineId: workflowBody.machineId,
          // Both formats — API (what Modal/Comfy executes) AND UI (the
          // intent-bearing graph with control_after_generate, widget
          // titles, node positions, etc.). A future verifier can prove
          // exact bytes executed AND the user's authoring intent.
          workflowApiJson: workflowBody.workflowApiJson,
          workflow: workflowBody.workflow ?? null,
        },
        null,
        2,
      ),
    );
  } catch {
    // Best-effort — don't fail dispatch if log write breaks.
    dispatchLogPath = null;
  }

  // Async dispatch (default): spawn Modal call, insert generation_jobs row,
  // return 202 with jobId. Client (CanvasBridge) polls /api/generate/status.
  // Avoids Cloudflare's 100s response timeout and enables clean
  // preemption-retry. Sync path preserved behind `?sync=1` for tests.
  const wantsSync = url.searchParams.get('sync') === '1';

  if (wantsModal && !wantsSync) {
    const spawn = await spawnWorkflow(workflowBody.workflowApiJson);
    if (!spawn.ok || !spawn.callId) {
      return NextResponse.json(
        { error: 'spawn_failed', detail: spawn.error ?? 'unknown', dispatchLogPath },
        { status: 502 },
      );
    }
    const jobId = nanoid();
    conn().prepare(
      `INSERT INTO generation_jobs
         (id, user_id, project_id, status, modal_call_id, dispatch_log_path)
        VALUES (?, ?, ?, 'running', ?, ?)`,
    ).run(jobId, userId, project.id, spawn.callId, dispatchLogPath);
    return NextResponse.json(
      {
        ok: true,
        jobId,
        modalCallId: spawn.callId,
        dispatchLogPath,
        status: 'running',
      },
      { status: 202 },
    );
  }

  if (wantsModal) {
    try {
      const modalResult = await modalRunner.runWorkflow(
        workflowBody.workflowApiJson,
        machineEndpoint.url ? { endpointUrl: machineEndpoint.url, userId } : { userId },
      );
      if (!modalResult.ok) {
        try {
          logTelemetry({
            userId,
            projectId: project.id,
            provider: 'comfydeploy',
            providerJobId: modalResult.jobId,
            prompt: '(canvas workflow / modal)',
            spec: {} as Record<string, unknown>,
            success: false,
            error: modalResult.rawError ?? 'modal_failed',
          });
        } catch {}
        return NextResponse.json(
          { error: 'generation_failed', detail: modalResult.rawError, backend: 'modal', dispatchLogPath },
          { status: 502 },
        );
      }
      const { iteration, leafHash, runSequence, inputHash, unboundInputs, c2pa } = await ingestIteration({
        userId,
        projectId: project.id,
        provider: 'comfydeploy', // stays in the ProviderName union; backend distinction is via execution_backend
        providerJobId: modalResult.jobId,
        prompt: '(canvas workflow / modal)',
        spec: {
          prompt: '(canvas workflow)',
          providerExtras: { workflowApiJson: workflowBody.workflowApiJson },
        },
        imageBytes: modalResult.imageBytes,
        imageContentType: modalResult.contentType,
        // ── WO-27: STOP DISCARDING WHAT THE RUNNER ALREADY COMPUTED ──
        //
        // Every field below was already sitting on `modalResult` and was
        // simply not named here. Nothing new is computed; three separate
        // losses close by passing values that had already been paid for:
        //
        //   outputKind      — the default is 'image'. The runner said
        //                     "video" and nobody read it, so extFor() chose
        //                     the extension from a kind that was wrong and
        //                     a video/webm landed on the user's Drive as a
        //                     .png. The stored bytes were always the video;
        //                     the NAME lied about them.
        //   modelFingerprints — model_fingerprints_hash was NULL on every
        //                     leaf this door ever wrote. Four of the five
        //                     hashes, on the door the canvas UI uses.
        //   containerMachineManifest{,Hash} — WO-B1's measurement, rung ONE
        //                     of ingest's own trust ladder, which had zero
        //                     callers anywhere in the repo. Without it the
        //                     leaf's machine_manifest_hash is a DB
        //                     descriptor: what the catalogue CLAIMS the
        //                     machine is, not what the container HAD.
        //   imageFilename   — the runner's own filename, which is also the
        //                     only in-band evidence of the container when
        //                     the content type is generic.
        outputKind: modalResult.outputKind,
        imageFilename: modalResult.outputFilename ?? null,
        modelFingerprints: modalResult.modelFingerprints,
        containerMachineManifestHash: modalResult.containerMachineManifestHash ?? null,
        containerMachineManifest: modalResult.containerMachineManifest ?? null,
        executionBackend: modalResult.attestation ? 'modal-tee' : 'modal-test',
        executionAttestation: modalResult.attestation,
        computeMachineId: activeMachine.machine.id,
      });
      return NextResponse.json({
        ok: true,
        iteration,
        leafHash,
        runSequence,
        durationMs: Date.now() - startedAt,
        backend: 'modal',
        gpu: modalResult.gpu,
        attested: !!modalResult.attestation,
        // Surfaced rather than merely persisted, for the reason IngestResult
        // gives about `witnessed`: a response that says nothing about a
        // declined input_hash lets the client report success identically
        // whether the run's inputs were bound or unknown.
        outputKind: modalResult.outputKind ?? 'image',
        inputHash,
        unboundInputs,
        modelFingerprinted: !!modalResult.modelFingerprints
          && Object.keys(modalResult.modelFingerprints).length > 0,
        containerManifest: !!modalResult.containerMachineManifestHash,
        c2pa,
      });
    } catch (e) {
      const detail = e instanceof ModalError ? e.message : e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: 'modal_error', detail }, { status: 502 });
    }
  }

  // ── Legacy / BYO ComfyDeploy path ─────────────────────────────────────
  const apiKey = await getDecryptedProviderKey('comfydeploy');
  if (!apiKey) {
    return NextResponse.json(
      { error: 'No ComfyDeploy API key on file. Add one in /settings.' },
      { status: 400 },
    );
  }

  // Build spec + submit.
  let jobId: string;
  let spec: GenerationSpec;
  let promptForRecord: string;

  try {
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
  } catch (e) {
    const detail = e instanceof ProviderError ? e.message : String(e);
    try {
      logTelemetry({
        userId,
        projectId: project.id,
        provider: 'comfydeploy',
        prompt: '(canvas workflow)',
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
  const { iteration, leafHash, runSequence } = await ingestIteration({
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
