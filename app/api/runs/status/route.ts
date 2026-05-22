// GET /api/runs/status?jobId=...
//
// Polls an async run job (executeRunAsync). While the Modal call is in
// flight returns {status:'running'}; on completion ingests the result
// (hash/store/manifest/witness inputs + typed output) and returns the
// captured iteration. Idempotent.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { pollRunJob } from '@/lib/runs/execute';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  const status = await pollRunJob(userId, jobId);
  if (!status) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  return NextResponse.json(status);
}
