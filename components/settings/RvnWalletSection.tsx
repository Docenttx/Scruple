'use client';

// Settings → RVN Wallet (visible only when payment mode = Blockchain).
// Wraps the existing BlockchainPanel + WalletModals so the wallet
// management flow is available in-place on the Settings page rather
// than at a separate /wallet route.

import { useWallet } from '@/lib/store/wallet';
import BlockchainPanel from '@/components/wallet/BlockchainPanel';
import WalletModals from '@/components/wallet/WalletModals';

export default function RvnWalletSection() {
  const mode = useWallet(s => s.mode);
  if (mode !== 'blockchain') return null;

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">RVN Wallet</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Native Ravencoin wallet for non-custodial chain locks. Mint
        SCR_ assets directly without a service fee.
      </p>
      <div className="mt-3">
        <BlockchainPanel />
      </div>
      <WalletModals />
    </section>
  );
}
