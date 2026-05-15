// POST /api/models/sync
//
// Mirror the Modal scruple-models Volume's filenames into the local canvas
// ComfyUI install. Run after fetch/delete so the canvas dropdowns reflect
// reality. Idempotent — safe to call frequently.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { listVolume, ModalAdminError } from '@/lib/modelLibrary/modal-admin';
import { syncCanvasStubs } from '@/lib/modelLibrary/stub-sync';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const listing = await listVolume();
    const report = syncCanvasStubs(listing);
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'sync_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
