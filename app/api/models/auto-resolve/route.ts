// POST /api/models/auto-resolve
//
// Body: { workflowApiJson: { ... } }
// Returns: {
//   ok, missing: string[],
//   resolvable: CatalogModel[],
//   unknown: string[],
//   workflow: ValidationResult
// }
//
// The frontend uses `resolvable` to render a "Fetch N missing models"
// CTA. Clicking it fires /api/models/fetch with {catalogId} once per
// entry.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { listVolume, ModalAdminError } from '@/lib/modelLibrary/modal-admin';
import { autoResolveWorkflow } from '@/lib/modelLibrary/auto-resolve';

export const dynamic = 'force-dynamic';

const Body = z.object({ workflowApiJson: z.record(z.unknown()) });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body', detail: String(e) }, { status: 400 });
  }

  try {
    const listing = await listVolume();
    const result = autoResolveWorkflow(body.workflowApiJson, listing);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'auto_resolve_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
