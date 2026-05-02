import { signIn, auth } from '@/lib/auth/auth';
import { redirect } from 'next/navigation';

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect('/');

  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-lg border border-scruple-border bg-scruple-surface p-8">
        <h1 className="text-2xl font-light tracking-tight">SCRUPLE</h1>
        <p className="mt-1 text-xs text-scruple-muted">AI Provenance Middleware</p>

        <div className="mt-8 space-y-4">
          {hasGoogle ? (
            <form
              action={async () => {
                'use server';
                await signIn('google', { redirectTo: '/' });
              }}
            >
              <button
                type="submit"
                className="w-full rounded-md border border-scruple-border bg-scruple-bg px-4 py-2 text-sm transition hover:border-scruple-accent"
              >
                Continue with Google
              </button>
            </form>
          ) : (
            <div className="rounded-md border border-scruple-warn/40 bg-scruple-warn/10 p-3 text-xs text-scruple-warn">
              Google OAuth not configured. Set <code>GOOGLE_CLIENT_ID</code> and{' '}
              <code>GOOGLE_CLIENT_SECRET</code> in <code>.env.local</code>.
            </div>
          )}
        </div>

        <p className="mt-8 text-[10px] text-scruple-muted">Patent Pending — All Rights Reserved</p>
      </div>
    </main>
  );
}
