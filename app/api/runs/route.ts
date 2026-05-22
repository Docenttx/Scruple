// POST /api/runs
//
// Source-agnostic workflow run entry point. Drives the shared executeRun
// service: resolve inputs (inline/local/iteration/storage) → run on Modal
// → capture (hash/store/manifest/witness) the inputs + typed output.
//
// This is the "dev pipeline" entry point the CC wrapper uses to pump source
// materials into sophisticated workflows the canvas can't yet drive. The
// canvas becomes just another caller of executeRun later.
//
// Body:
//   {
//     projectId: number,
//     workflowApiJson: object,            // run settings (ComfyUI API graph)
//     inputs?: RunInputSpec[],            // source materials
//     outputKind?: 'image'|'video'|'checkpoint',
//     prompt?: string
//   }

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { executeRun } from '@/lib/runs/execute';
import type { RunInputSpec } from '@/lib/runs/inputs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const InputSpec = z.object({
  kind: z.enum(['init_image', 'control_image', 'source_image', 'training_image', 'base_checkpoint', 'other']),
  filename: z.string().min(1),
  contentType: z.string().optional(),
  inlineBase64: z.string().optional(),
  localPath: z.string().optional(),
  iterationHash: z.string().optional(),
  storagePointer: z.any().optional(),
});

const Body = z.object({
  projectId: z.number().int().positive(),
  workflowApiJson: z.record(z.unknown()),
  inputs: z.array(InputSpec).optional(),
  outputKind: z.enum(['image', 'video', 'checkpoint']).optional(),
  prompt: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    .prepare(`SELECT id, status FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as { id: number; status: string } | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json({ error: `Project is ${project.status}; new iterations rejected` }, { status: 409 });
  }

  const result = await executeRun({
    userId,
    projectId: body.projectId,
    workflowApiJson: body.workflowApiJson,
    inputs: body.inputs as RunInputSpec[] | undefined,
    outputKind: body.outputKind,
    prompt: body.prompt,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
