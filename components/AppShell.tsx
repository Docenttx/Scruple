import Link from 'next/link';
import { signOut, auth } from '@/lib/auth/auth';
import Sidebar from './Sidebar';

export default async function AppShell({
  children,
  activeProjectId,
  search,
  page,
}: {
  children: React.ReactNode;
  activeProjectId?: number;
  search?: string;
  page?: number;
}) {
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
              <Link
                href="/settings"
                aria-label="Settings"
                title="Settings"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-scruple-border bg-scruple-bg text-scruple-muted hover:border-scruple-accent hover:text-scruple-text"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </Link>
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
        <Sidebar activeId={activeProjectId} search={search} page={page} />
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
