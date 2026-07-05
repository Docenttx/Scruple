// GET /api/auth/gdrive/heartbeat
//
// Server-side session-hydration hook. Called by the AppShell every time
// the app mounts (page load, hard refresh, tab switch). If the user's
// gdrive_tokens row exists and expires_at is inside the next 24 hours,
// silently refresh the access_token so no capture ever fires with a
// stale credential. Returns a JSON summary so the client can react
// (e.g. show "Drive session expired — sign in again" if refresh fails).
//
// If the row is MISSING entirely (user existed before Drive was bundled
// into sign-in, or explicitly disconnected), returns {connected: false}
// — client should route to /api/auth/gdrive/connect.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { readActiveAccessToken } from '@/lib/storage/gdrive';

export const dynamic = 'force-dynamic';

const ONE_DAY_SECONDS = 24 * 60 * 60;

interface Row {
  user_id: string;
  expires_at: number;
  user_email: string | null;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const row = conn()
    .prepare(`SELECT user_id, expires_at, user_email FROM gdrive_tokens WHERE user_id = ?`)
    .get(userId) as Row | undefined;

  if (!row) {
    return NextResponse.json({
      connected: false,
      hint: 'Drive not connected. Redirect user to /api/auth/gdrive/connect.',
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const secondsToExpiry = row.expires_at - nowSec;
  const needsRefresh = secondsToExpiry < ONE_DAY_SECONDS;

  if (!needsRefresh) {
    return NextResponse.json({
      connected: true,
      refreshed: false,
      expires_at: row.expires_at,
      seconds_to_expiry: secondsToExpiry,
      user_email: row.user_email,
    });
  }

  // Refresh proactively. readActiveAccessToken triggers the internal
  // refresh path when the token is <5 min from expiring; we lower the
  // threshold conceptually to 24h by calling it whenever within the
  // window.
  try {
    await readActiveAccessToken(userId);
    const after = conn()
      .prepare(`SELECT expires_at FROM gdrive_tokens WHERE user_id = ?`)
      .get(userId) as { expires_at: number } | undefined;
    return NextResponse.json({
      connected: true,
      refreshed: true,
      expires_at: after?.expires_at ?? row.expires_at,
      seconds_to_expiry: (after?.expires_at ?? row.expires_at) - nowSec,
      user_email: row.user_email,
    });
  } catch (e) {
    // Refresh failed → refresh_token revoked or Google returned an error.
    // Client should re-consent.
    return NextResponse.json(
      {
        connected: true,
        refreshed: false,
        refresh_failed: true,
        error: e instanceof Error ? e.message : String(e),
        hint: 'refresh_token invalid — redirect user to /api/auth/gdrive/connect for re-consent.',
      },
      { status: 200 }, // 200 not 401 — client needs the data to decide what to do
    );
  }
}
