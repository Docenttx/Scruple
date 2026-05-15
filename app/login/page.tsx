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
// https://developers.google.com/identity/branding-guidelines
// Dark theme: #131314 bg, white text, #8e918f border, 40px min height,
// Roboto/system font with letter-spacing 0.25px, 18px logo, 12px gap.
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

// Official Google G logo, 4-color SVG. Provided under Google's branding
// guidelines for use in sign-in buttons. Do not recolor or restyle.
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
