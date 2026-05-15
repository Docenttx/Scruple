// GET /api/models/list → { ok, by_category: { checkpoints: VolumeFile[], ... } }
//
// Lists every file on the Modal scruple-models Volume. Used by Settings →
// Model Library to render what's installed.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { listVolume, ModalAdminError } from '@/lib/modelLibrary/modal-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const data = await listVolume();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'list_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
