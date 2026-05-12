// GET /api/auth/gdrive/connect
//
// Initiates the GDrive OAuth flow with `drive.file` scope only.
// Returns a 302 redirect to Google's consent screen.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL('/login', process.env.NEXTAUTH_URL!));
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/auth/gdrive/callback`;
  if (!clientId) {
    return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 });
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent'); // ensure refresh_token returned
  url.searchParams.set('include_granted_scopes', 'true');

  return NextResponse.redirect(url.toString());
}
