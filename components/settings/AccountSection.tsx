// Settings → Account section. Displays the user's Google profile
// (the one NextAuth signed them in with) and a sign-out button.

import { auth, signOut } from '@/lib/auth/auth';

export default async function AccountSection() {
  const session = await auth();
  const user = session?.user;
  if (!user) return null;

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Account</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Signed in with Google. Your Scruple identity is tied to this account.
      </p>

      <div className="mt-3 flex items-center justify-between rounded-md border border-scruple-border bg-scruple-surface p-4">
        <div className="flex items-center gap-3">
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt={user.name ?? user.email ?? 'profile'}
              className="h-10 w-10 rounded-full border border-scruple-border"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-scruple-border bg-scruple-bg text-sm">
              {(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div>
            <div className="text-sm">{user.name ?? user.email}</div>
            <div className="text-[11px] text-scruple-muted">{user.email}</div>
            <div className="mt-0.5 text-[10px] font-mono text-scruple-muted">
              user id: {(user as { id?: string }).id ?? '—'}
            </div>
          </div>
        </div>

        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-danger hover:text-scruple-danger"
          >
            Sign out
          </button>
        </form>
      </div>
    </section>
  );
}
