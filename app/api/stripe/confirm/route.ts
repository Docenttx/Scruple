// POST /api/stripe/confirm
//
// After the user confirms a Stripe Payment Element on the client,
// this route verifies the payment + executes the lock action via the
// witness server's /api/confirm-and-execute. The witness server holds
// the Stripe secret + verifies the payment intent before firing the
// lock executor.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import type { ProjectRow } from '@/lib/types';

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

const Body = z.object({
  paymentIntentId: z.string(),
  action: z.enum(['finalize', 'checkpoint', 'chain-lock-basic', 'chain-lock-pinned']),
  projectId: z.number().int().positive(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Ownership check + merkle root pull-through.
  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const witnessProjectId = `sw:${userId}:${body.projectId}`;
  const res = await fetch(`${WITNESS_URL}/api/confirm-and-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentIntentId: body.paymentIntentId,
      action: body.action,
      projectId: witnessProjectId,
      installationId: userId,
      merkleRoot: project.merkle_root ?? null,
      preScrId: project.pre_scr_id ?? null,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  return NextResponse.json(data);
}
