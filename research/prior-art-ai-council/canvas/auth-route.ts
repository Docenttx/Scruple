// app/api/canvas/auth/route.ts
// GET /api/canvas/auth — nginx auth_request subrequest handler
// Returns 200 if user has valid Scruple session, 401 otherwise.
// Called on every request to canvas.scruple.ai before proxying to ComfyUI.

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Check for session cookie or Authorization header
  const sessionToken =
    req.cookies.get('scruple-session')?.value ||
    req.headers.get('authorization')?.replace('Bearer ', '');

  if (!sessionToken) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const db = conn();
    const session = db.prepare(
      'SELECT user_id, expires_at FROM sessions WHERE token = ? AND expires_at > datetime("now")'
    ).get(sessionToken) as { user_id: string; expires_at: string } | undefined;

    if (!session) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // Return 200 with user context headers for downstream use
    return new NextResponse('OK', {
      status: 200,
      headers: {
        'X-Scruple-User-Id': session.user_id,
        'X-Scruple-Session': sessionToken,
      },
    });
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }
}
