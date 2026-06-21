// GET  /api/settings/compute → { active, fellBack, allowed, plan }
// POST /api/settings/compute { machine_id } → { ok, active, fellBack, plan }
//
// Stage 1 of the Settings → Compute work (see docs/wo/2026-06-21-
// compute-stage1.md). Persists the user's machine choice in
// user_settings.settings.compute.machine_id and returns the
// resolved active machine + the catalog filtered by the user's
// plan so the UI can render a picker that only offers permitted
// options.
//
// POST tier-validates the requested machine id before writing.
// A 403 here is a real signal — somebody tried to set a machine
// outside their tier. Log it.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { writeUserSettings } from '@/lib/settings/user';
import { getUserPlan } from '@/lib/compute/userPlan';
import { resolveActiveMachine } from '@/lib/compute/getActiveMachine';
import {
  getMachineById,
  getMachineCatalogForPlan,
} from '@/lib/compute/machines';

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
    plan: resolved.plan,
    allowed: getMachineCatalogForPlan(resolved.plan),
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

  const plan = getUserPlan(userId);
  if (!machine.allowedPlans.includes(plan)) {
    console.warn(
      `[settings/compute] user ${userId} (plan=${plan}) tried to select ${machine.id} (allowed=${machine.allowedPlans.join('|')})`,
    );
    return NextResponse.json(
      { error: 'Machine not available on your plan' },
      { status: 403 },
    );
  }

  writeUserSettings(userId, { compute: { machine_id: machine.id } });
  const resolved = resolveActiveMachine(userId);
  return NextResponse.json({
    ok: true,
    active: resolved.machine,
    fellBack: resolved.fellBack,
    plan: resolved.plan,
  });
}
