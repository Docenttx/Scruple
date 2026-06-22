// GET  /api/settings/compute → { active, fellBack, storedMachineId, allowed }
// POST /api/settings/compute { machine_id } → { ok, active, fellBack }
//
// scruple-web is paid-only (Canvas v2) — every signed-in user with a
// Stripe card may pick any machine. No tier validation. The catalog
// is the full MACHINES list; user picks one, server persists, /api/generate
// + /api/canvas/session both resolve to the stored choice.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { writeUserSettings } from '@/lib/settings/user';
import { resolveActiveMachine } from '@/lib/compute/getActiveMachine';
import { getMachineById, MACHINES } from '@/lib/compute/machines';

export const dynamic = 'force-dynamic';

const Body = z.object({ machine_id: z.string().min(1).max(64) });

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return unauthorized();

  const resolved = resolveActiveMachine(userId);
  return NextResponse.json({
    active: resolved.machine,
    storedMachineId: resolved.storedMachineId,
    fellBack: resolved.fellBack,
    allowed: MACHINES,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return unauthorized();

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const machine = getMachineById(body.machine_id);
  if (!machine) {
    return NextResponse.json({ error: 'Unknown machine_id' }, { status: 400 });
  }

  writeUserSettings(userId, { compute: { machine_id: machine.id } });
  const resolved = resolveActiveMachine(userId);
  return NextResponse.json({
    ok: true,
    active: resolved.machine,
    fellBack: resolved.fellBack,
  });
}
