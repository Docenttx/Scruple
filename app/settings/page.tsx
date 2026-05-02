import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';
import { getProviderKeyStatus } from '@/lib/settings/actions';
import ProviderKeyForm from './ProviderKeyForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const status = await getProviderKeyStatus();

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="text-2xl font-light">Settings</h1>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Account</h2>
          <div className="mt-2 rounded-md border border-scruple-border bg-scruple-surface p-4 text-sm">
            <div>{session.user.email}</div>
            <div className="mt-1 text-[10px] text-scruple-muted">User id: {(session.user as { id?: string }).id}</div>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Provider keys</h2>
          <p className="mt-1 text-xs text-scruple-muted">
            Keys are encrypted at rest with AES-256-GCM (key derived from <code>AUTH_SECRET</code>).
          </p>
          <div className="mt-4 space-y-4">
            <ProviderKeyForm provider="fal" status={status.fal} />
            <ProviderKeyForm provider="comfydeploy" status={status.comfydeploy} />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Witness server</h2>
          <div className="mt-2 rounded-md border border-scruple-border bg-scruple-surface p-4 text-xs">
            <div>
              URL:{' '}
              <span className="font-mono">
                {process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799'}
              </span>
            </div>
            <div className="mt-1 text-scruple-muted">
              Configured via <code>WITNESS_SERVER_URL</code>. Reuses the existing
              SCRUPLE Witness service — same hashing + signature conventions
              as desktop.
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
