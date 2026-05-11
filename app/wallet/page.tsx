// /wallet — top-level Wallet view (Fiat + Blockchain modes).
//
// Placeholder stub. WO-36 onward fills this in with the mode toggle,
// the Stripe + TSD panels (fiat), and the RVN wallet management UI
// (blockchain mode).

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';
import WalletView from '@/components/wallet/WalletView';

export default async function WalletPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <AppShell>
      <WalletView />
    </AppShell>
  );
}
