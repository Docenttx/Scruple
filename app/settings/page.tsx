// Settings page — sidebar-nav layout.
//
// Categories (sidebar order):
//   Account       — Google profile + sign-out
//   Storage       — Drive (BYOS)
//   Billing       — Payment mode, Stripe customer, RVN wallet
//   Models        — Provider tokens (HF/Civitai), Model Library
//   API Keys      — fal + ComfyDeploy
//   Diagnostics   — Witness server status

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
import SettingsNav, { type NavItem } from '@/components/settings/SettingsNav';

export const dynamic = 'force-dynamic';

const NAV_ITEMS: NavItem[] = [
  { id: 'account',     label: 'Account' },
  { id: 'storage',     label: 'Storage' },
  { id: 'billing',     label: 'Billing' },
  { id: 'models',      label: 'Models' },
  { id: 'api-keys',    label: 'API Keys' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const status = await getProviderKeyStatus();

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl gap-8 px-8 py-10">
        <SettingsNav items={NAV_ITEMS} />

        <div className="min-w-0 flex-1">
          <h1 className="mb-8 text-2xl font-light">Settings</h1>

          {/* Account */}
          <section id="account" className="scroll-mt-12">
            <CategoryHeader>Account</CategoryHeader>
            <AccountSection />
          </section>

          {/* Storage */}
          <section id="storage" className="mt-10 scroll-mt-12">
            <CategoryHeader>Storage</CategoryHeader>
            <StorageSection />
          </section>

          {/* Billing — payment mode, Stripe customer, RVN wallet */}
          <section id="billing" className="mt-10 scroll-mt-12">
            <CategoryHeader>Billing</CategoryHeader>
            <PaymentModeSection />
            <StripeCustomerSection />
            <RvnWalletSection />
          </section>

          {/* Models — provider tokens + model library */}
          <section id="models" className="mt-10 scroll-mt-12">
            <CategoryHeader>Models</CategoryHeader>
            <ProviderTokensSection />
            <ModelLibrarySection />
          </section>

          {/* API Keys — provider keys for fal + comfydeploy */}
          <section id="api-keys" className="mt-10 scroll-mt-12">
            <CategoryHeader>API Keys</CategoryHeader>
            <div className="mt-3">
              <p className="text-xs text-scruple-muted">
                Keys are encrypted at rest with AES-256-GCM (key derived from{' '}
                <code>AUTH_SECRET</code>).
              </p>
              <div className="mt-4 space-y-4">
                <ProviderKeyForm provider="fal" status={status.fal} />
                <ProviderKeyForm provider="comfydeploy" status={status.comfydeploy} />
              </div>
            </div>
          </section>

          {/* Diagnostics — witness server status */}
          <section id="diagnostics" className="mt-10 mb-12 scroll-mt-12">
            <CategoryHeader>Diagnostics</CategoryHeader>
            <div className="mt-3">
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
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function CategoryHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-scruple-border-color pb-2">
      <h2 className="text-lg font-semibold text-scruple-text-primary">{children}</h2>
    </div>
  );
}
