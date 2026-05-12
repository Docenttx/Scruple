// POST /api/workflow/validate
//
// Sanity-checks a workflow_api_json before submitting it to /api/generate.
// Returns structural issues + a list of referenced model files.
//
// Body: { workflowApiJson: object, checkModels?: boolean }
// When checkModels=true, we cross-check referenced model filenames
// against the canvas stub directory (the same listing the user's
// dropdowns reflect).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { auth } from '@/lib/auth/auth';
import { validateWorkflow } from '@/lib/provenance/validate';

export const dynamic = 'force-dynamic';

const CANVAS_MODELS_DIR =
  process.env.SCRUPLE_CANVAS_MODELS_DIR ||
  '/data/reference/ui-inspire/ComfyUI/models';

const Body = z.object({
  workflowApiJson: z.record(z.unknown()),
  checkModels: z.boolean().optional().default(true),
});

function listAvailableFiles(): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(CANVAS_MODELS_DIR)) return out;
  function walk(dir: string, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i.test(name)) {
        out.add(rel);
      }
    }
  }
  walk(CANVAS_MODELS_DIR);
  return out;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
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

  const availableFiles = body.checkModels ? listAvailableFiles() : undefined;
  const result = validateWorkflow(body.workflowApiJson, { availableFiles });

  return NextResponse.json({
    ...result,
    checkedModels: body.checkModels,
    availableFileCount: availableFiles?.size ?? null,
  });
}
