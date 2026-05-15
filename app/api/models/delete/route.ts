// DELETE /api/models/delete  body { targetSubpath }
//
// Removes a file from the Modal scruple-models Volume. Used by the
// "remove" button in the Settings → Model Library list.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { deleteFromVolume, ModalAdminError } from '@/lib/modelLibrary/modal-admin';

export const dynamic = 'force-dynamic';

const Body = z.object({ targetSubpath: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body', detail: String(e) }, { status: 400 });
  }

  try {
    const result = await deleteFromVolume(body.targetSubpath);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'delete_failed' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, removed: result.removed });
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'delete_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
