import { signIn, auth } from '@/lib/auth/auth';
import { redirect } from 'next/navigation';

interface LoginPageProps {
  searchParams: { callbackUrl?: string };
}

// Allow only relative-path callback URLs to prevent open-redirect.
function safeCallback(raw: string | undefined): string {
  const fallback = '/';
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('..')) return fallback;
  return raw;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const callbackUrl = safeCallback(searchParams.callbackUrl);
  const session = await auth();
  if (session?.user) redirect(callbackUrl);

  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hasAutodesk = !!(process.env.AUTODESK_CLIENT_ID && process.env.AUTODESK_CLIENT_SECRET);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-lg border border-scruple-border bg-scruple-surface p-8">
        <h1 className="text-2xl font-bold tracking-widest2 text-scruple-accent-primary">SCRUPLE</h1>
        <p className="mt-1 text-xs text-scruple-muted">Studio Web</p>

        <div className="mt-8 space-y-3">
          {hasAutodesk && (
            <form
              action={async () => {
                'use server';
                await signIn('autodesk', { redirectTo: callbackUrl });
              }}
            >
              <AutodeskSignInButton />
            </form>
          )}
          {hasGoogle ? (
            <form
              action={async () => {
                'use server';
                await signIn('google', { redirectTo: callbackUrl });
              }}
            >
              <GoogleSignInButton />
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

// Official "Sign in with Google" button per Google brand guidelines.
function GoogleSignInButton() {
  return (
    <button
      type="submit"
      className="flex h-10 w-full items-center justify-center gap-3 rounded border border-[#8e918f] bg-[#131314] px-3 font-['Roboto',_'Inter',_system-ui,_sans-serif] text-sm font-medium leading-none text-white transition-colors duration-200 hover:border-[#a8aaa8] hover:bg-[#1f2123] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:bg-[#2a2d30]"
      style={{ letterSpacing: '0.25px' }}
    >
      <GoogleGLogo />
      <span>Sign in with Google</span>
    </button>
  );
}

// "Sign in with Autodesk" button. Styling intentionally similar to the
// Google button for visual parity. Autodesk doesn't publish a strict
// branding spec for third-party signin buttons; we use the Autodesk
// black-on-white palette as a recognizable signal.
function AutodeskSignInButton() {
  return (
    <button
      type="submit"
      className="flex h-10 w-full items-center justify-center gap-3 rounded border border-[#222] bg-white px-3 font-['Inter',_system-ui,_sans-serif] text-sm font-medium leading-none text-[#0d0d0d] transition-colors duration-200 hover:bg-[#f3f3f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 active:bg-[#e8e8e8]"
      style={{ letterSpacing: '0.25px' }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#0d0d0d"
          d="M22 5L7 14h7l-3 5 10-9h-7l3-5z"
        />
      </svg>
      <span>Sign in with Autodesk</span>
    </button>
  );
}

function GoogleGLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
      />
      <path
        fill="#FF3D00"
        d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
      />
      <path
        fill="#1976D2"
        d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"
      />
    </svg>
  );
}
