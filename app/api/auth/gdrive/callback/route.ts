// GET /api/auth/gdrive/callback?code=...&state=...
//
// Receives Google's OAuth redirect, exchanges code for tokens,
// fetches the user's profile, persists to gdrive_tokens, and lands
// the user back on /settings.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { exchangeCodeForTokens, fetchUserProfile, persistGDriveTokens } from '@/lib/storage/gdrive';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.redirect(new URL('/login', process.env.NEXTAUTH_URL!));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings?gdrive=error&detail=${encodeURIComponent(error)}`, process.env.NEXTAUTH_URL!),
    );
  }
  if (!code) {
    return NextResponse.redirect(
      new URL('/settings?gdrive=error&detail=missing_code', process.env.NEXTAUTH_URL!),
    );
  }

  try {
    const redirectUri = `${process.env.NEXTAUTH_URL}/api/auth/gdrive/callback`;
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const profile = await fetchUserProfile(tokens.access_token);
    persistGDriveTokens(userId, tokens, profile);
    return NextResponse.redirect(new URL('/settings?gdrive=connected', process.env.NEXTAUTH_URL!));
  } catch (e) {
    const detail = encodeURIComponent(e instanceof Error ? e.message : String(e));
    return NextResponse.redirect(
      new URL(`/settings?gdrive=error&detail=${detail}`, process.env.NEXTAUTH_URL!),
    );
  }
}
