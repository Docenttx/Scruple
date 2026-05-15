// GET /api/models/job?call_id=fc-XXXX
//
// Polls a previously-spawned fetch_to_volume function call. Returns
// {pending: true} until complete, then {pending: false, result: {...}}.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { jobStatus, ModalAdminError } from '@/lib/modelLibrary/modal-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const callId = req.nextUrl.searchParams.get('call_id');
  if (!callId) {
    return NextResponse.json({ error: 'call_id required' }, { status: 400 });
  }
  try {
    const data = await jobStatus(callId);
    return NextResponse.json(data);
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'status_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
