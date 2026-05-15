// Settings page — post-clone-3 layout.
//
// Sections (in order):
//   1. Account     — Google profile + sign-out
//   2. Storage     — Drive (BYOS)
//   3. Payment Mode — Fiat / Blockchain toggle (server-persisted)
//   4. Stripe Account — read-only customer snapshot
//   5. RVN Wallet — wallet management (visible when mode = blockchain)
//   6. Provider Keys — fal + ComfyDeploy
//   7. Witness Server — read-only diagnostic

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';
import { getProviderKeyStatus } from '@/lib/settings/actions';
import ProviderKeyForm from './ProviderKeyForm';
import AccountSection from '@/components/settings/AccountSection';
import StorageSection from '@/components/settings/StorageSection';
import PaymentModeSection from '@/components/settings/PaymentModeSection';
import StripeCustomerSection from '@/components/settings/StripeCustomerSection';
import RvnWalletSection from '@/components/settings/RvnWalletSection';
import ProviderTokensSection from '@/components/settings/ProviderTokensSection';
import ModelLibrarySection from '@/components/settings/ModelLibrarySection';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const status = await getProviderKeyStatus();

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-8 py-10">
        <h1 className="text-2xl font-light">Settings</h1>

        <AccountSection />

        <StorageSection />

        <PaymentModeSection />

        <StripeCustomerSection />

        <RvnWalletSection />

        <ProviderTokensSection />

        <ModelLibrarySection />

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Provider keys</h2>
          <p className="mt-1 text-xs text-scruple-muted">
            Keys are encrypted at rest with AES-256-GCM (key derived from{' '}
            <code>AUTH_SECRET</code>).
          </p>
          <div className="mt-4 space-y-4">
            <ProviderKeyForm provider="fal" status={status.fal} />
            <ProviderKeyForm provider="comfydeploy" status={status.comfydeploy} />
          </div>
        </section>

        <section className="mt-8 mb-12">
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
