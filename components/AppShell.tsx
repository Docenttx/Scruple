import Link from 'next/link';
import { signOut, auth } from '@/lib/auth/auth';
import Sidebar from './Sidebar';

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const user = session?.user;

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] grid-rows-[48px_1fr]">
      {/* Top bar */}
      <header className="col-span-2 flex items-center justify-between border-b border-scruple-border bg-scruple-surface px-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-lg font-light tracking-wide">
            SCRUPLE
          </Link>
          <span className="text-[10px] uppercase tracking-widest text-scruple-muted">
            Provenance Middleware
          </span>
        </div>
        <div className="flex items-center gap-3">
          <WitnessStatusPill />
          {user && (
            <>
              <span className="text-xs text-scruple-muted">{user.email}</span>
              <form
                action={async () => {
                  'use server';
                  await signOut({ redirectTo: '/login' });
                }}
              >
                <button
                  type="submit"
                  className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs hover:border-scruple-accent"
                >
                  Sign out
                </button>
              </form>
            </>
          )}
        </div>
      </header>

      {/* Sidebar */}
      <aside className="row-span-1 border-r border-scruple-border bg-scruple-surface">
        <Sidebar />
      </aside>

      {/* Main content */}
      <main className="overflow-auto">{children}</main>
    </div>
  );
}

function WitnessStatusPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-scruple-border bg-scruple-bg px-2 py-0.5 text-[10px] text-scruple-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-scruple-success" />
      Witness :5799
    </span>
  );
}
