// /api/apps/[appId]/session — generic app-session mint + revoke.
//
// Parallels /api/canvas/session but for the new session-backend
// abstraction. Currently only 'kohya' is enabled (Canvas keeps using
// /api/canvas/session for continuity).
//
// POST /api/apps/kohya/session
//   { machineId: string }
//   → { sessionId, expiresAt, hourlyRateCents, backendMessage? }
//
// DELETE /api/apps/kohya/session/:sessionId → { revoked: bool }

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import {
  getActiveAppSession,
  mintAppSession,
  revokeAppSession,
} from '@/lib/apps/session';
import { getApp } from '@/lib/apps/registry';
import type { AppId } from '@/lib/apps/session-backends';

const KNOWN_APP_IDS: readonly AppId[] = ['canvas', 'kohya', 'forge'];

function isValidAppId(x: string): x is AppId {
  return (KNOWN_APP_IDS as readonly string[]).includes(x);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ appId: string }> },
) {
  const { appId } = await ctx.params;
  if (!isValidAppId(appId)) {
    return NextResponse.json({ error: 'unknown app' }, { status: 404 });
  }
  const app = getApp(appId);
  if (!app || !app.enabled) {
    return NextResponse.json(
      { error: `App '${appId}' disabled — backend '${app?.backend}' not configured` },
      { status: 503 },
    );
  }

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as { machineId?: string };
  if (!body.machineId) {
    return NextResponse.json({ error: 'machineId required' }, { status: 400 });
  }

  // If the user already has an active session for this app, return it
  // (idempotent). Client can DELETE first to force a fresh one.
  const existing = getActiveAppSession(userId, appId);
  if (existing) {
    return NextResponse.json({
      sessionId: existing.id,
      expiresAt: existing.expires_at,
      hourlyRateCents: existing.hourly_rate_cents,
      reused: true,
    });
  }

  try {
    const minted = await mintAppSession(userId, appId, body.machineId);
    return NextResponse.json({
      sessionId: minted.id,
      expiresAt: minted.expiresAt,
      hourlyRateCents: minted.hourlyRateCents,
      backendMessage: minted.backendMessage,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ appId: string }> },
) {
  const { appId } = await ctx.params;
  if (!isValidAppId(appId)) {
    return NextResponse.json({ error: 'unknown app' }, { status: 404 });
  }
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId query required' }, { status: 400 });
  }

  const revoked = await revokeAppSession(sessionId, userId);
  return NextResponse.json({ revoked });
}
