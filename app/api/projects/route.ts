// GET  /api/projects                  → list this user's projects (lightweight)
// POST /api/projects                  → create a project
//
// Used by the scrupel CLI + any UI that wants the project list as JSON
// (the home page uses the server action directly).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import {
  getProjects,
  createProject,
  getActiveProject,
} from '@/lib/projects/actions';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const search = url.searchParams.get('q') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? '200');

  const [projects, active] = await Promise.all([
    getProjects({ search, limit, offset: 0 }),
    getActiveProject(),
  ]);

  return NextResponse.json({
    projects,
    activeId: active?.id ?? null,
    count: projects.length,
  });
}

const CreateBody = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(['txt2img', 'training']).default('txt2img'),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  try {
    const project = await createProject(body);
    return NextResponse.json({ ok: true, project });
  } catch (e) {
    return NextResponse.json(
      { error: 'Create failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
