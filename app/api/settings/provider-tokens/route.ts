// GET  /api/settings/provider-tokens
//      → { hf: { set: boolean }, civitai: { set: boolean } }
//      (the token values themselves are never returned)
//
// POST /api/settings/provider-tokens
//      body { provider: 'hf' | 'civitai', token: string }  → save
//      body { provider: 'hf' | 'civitai', token: '' }      → clear

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { readUserSettings, writeUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['hf', 'civitai']),
  token: z.string().max(512),
});

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const s = readUserSettings(userId);
  return NextResponse.json({
    hf: { set: !!s.hf_token },
    civitai: { set: !!s.civitai_token },
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const token = body.token.trim();
  const value = token === '' ? undefined : token;
  if (body.provider === 'hf') {
    writeUserSettings(userId, { hf_token: value });
  } else {
    writeUserSettings(userId, { civitai_token: value });
  }

  return NextResponse.json({
    ok: true,
    provider: body.provider,
    set: value !== undefined,
  });
}
