// POST /api/auth/keys → issue an API key for the current (cookie-authed) user
// GET  /api/auth/keys → list (non-secret metadata only) for the current user
//
// Issuance returns the plaintext ONCE. The server keeps only sha256(plain).
//
// Plaintext format: "sk_test_<base64url(32 bytes)>" (or sk_live_ in prod).
//
// Auth: must be a cookie-authed user (NextAuth session). API keys cannot
// issue API keys — closes off a privilege escalation path if a key leaks.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { issueApiKey, listApiKeys } from '@/lib/auth/apiKey';

export const dynamic = 'force-dynamic';

const IssueBody = z.object({
  label: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string().min(1)).max(32).optional(),
  expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 365 * 2).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof IssueBody> = {};
  try {
    if (req.headers.get('content-type')?.includes('application/json')) {
      body = IssueBody.parse(await req.json());
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const expiresAt = body.expiresInSeconds
    ? Math.floor(Date.now() / 1000) + body.expiresInSeconds
    : undefined;

  const issued = issueApiKey(userId, { label: body.label, scopes: body.scopes, expiresAt });
  return NextResponse.json({
    id: issued.id,
    prefix: issued.prefix,
    plaintext: issued.plaintext, // shown ONCE; client must store immediately
    label: body.label ?? null,
    scopes: body.scopes ?? null,
    expiresAt: expiresAt ?? null,
  });
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const keys = listApiKeys(userId).map((k) => ({
    id: k.id,
    prefix: k.key_prefix,
    label: k.label,
    scopes: k.scopes_json ? JSON.parse(k.scopes_json) : null,
    createdAt: k.created_at,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
  }));
  return NextResponse.json({ keys });
}
