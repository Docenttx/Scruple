// GET /api/provenance/active
//
// Returns the Provenance Terminal payload for the user's currently
// active project: the most-recent iteration's workflow JSON, extracted
// into a tidy list of ProvenanceRow entries. Used by the sidebar's
// <ProvenanceTerminal/> component, polled or pushed via SSE.
//
// Shape:
//   { active: false }                                 — no active project
//   { active: true, projectId, projectName, iterationId,
//     runSequence, leafHash, ts, rows: ProvenanceRow[] }
//   { active: true, ..., rows: [] }                   — active but no iterations yet

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { getActiveProject } from '@/lib/projects/actions';
import { extractProvenance } from '@/lib/provenance/extract';

export const dynamic = 'force-dynamic';

interface IterMetaRow {
  id: number;
  run_sequence: number;
  leaf_hash: string;
  timestamp: string;
  prompt: string | null;
  metadata: string | null;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ active: false, error: 'Unauthorized' }, { status: 401 });

  const active = await getActiveProject();
  if (!active) return NextResponse.json({ active: false });

  const iter = conn()
    .prepare(
      `SELECT id, run_sequence, leaf_hash, timestamp, prompt, metadata
         FROM iterations
         WHERE project_id = ?
         ORDER BY run_sequence DESC
         LIMIT 1`,
    )
    .get(active.id) as IterMetaRow | undefined;

  if (!iter) {
    return NextResponse.json({
      active: true,
      projectId: active.id,
      projectName: active.name,
      iterationId: null,
      rows: [],
    });
  }

  // The workflow JSON lives in metadata.generationSpec.providerExtras.workflowApiJson
  // for canvas-mode runs, and may be absent for manual/test ingest. Fall back
  // gracefully — show whatever fields we can derive.
  let rows: ReturnType<typeof extractProvenance> = [];
  try {
    if (iter.metadata) {
      const meta = JSON.parse(iter.metadata) as {
        generationSpec?: {
          providerExtras?: { workflowApiJson?: unknown };
          prompt?: string;
          negativePrompt?: string;
          width?: number;
          height?: number;
          seed?: number;
          steps?: number;
          cfgScale?: number;
        };
      };
      const wf = meta.generationSpec?.providerExtras?.workflowApiJson;
      if (wf && typeof wf === 'object') {
        rows = extractProvenance(wf);
      } else if (meta.generationSpec) {
        // Synthesize rows from the prompt-mode spec when no workflow JSON
        const spec = meta.generationSpec;
        if (spec.prompt) rows.push({ category: 'Prompt (+)', value: trim(spec.prompt, 36), checked: true, detail: spec.prompt });
        if (spec.negativePrompt) rows.push({ category: 'Prompt (−)', value: trim(spec.negativePrompt, 36), checked: true, detail: spec.negativePrompt });
        if (spec.steps != null) rows.push({ category: 'Steps', value: String(spec.steps), checked: true });
        if (spec.cfgScale != null) rows.push({ category: 'CFG', value: String(spec.cfgScale), checked: true });
        if (spec.seed != null) rows.push({ category: 'Seed', value: String(spec.seed), checked: true });
        if (spec.width != null && spec.height != null)
          rows.push({ category: 'Dimensions', value: `${spec.width}×${spec.height}`, checked: true });
      }
    }
  } catch {
    /* leave rows empty if metadata is malformed */
  }

  return NextResponse.json({
    active: true,
    projectId: active.id,
    projectName: active.name,
    iterationId: iter.id,
    runSequence: iter.run_sequence,
    leafHash: iter.leaf_hash,
    ts: iter.timestamp,
    rows,
  });
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
