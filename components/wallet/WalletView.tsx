'use client';

// WO-36 · Wallet shell.
//
// Port of the desktop's renderWallet() — top-level mode toggle (Fiat /
// Blockchain) and two distinct panels. Fiat surfaces Stripe + TSD +
// IPFS configuration; Blockchain surfaces RVN wallet status + network
// selector + IPFS. Mode persists in localStorage (matches desktop's
// `walletMode` state).

import { useEffect } from 'react';
import { useWallet } from '@/lib/store/wallet';
import FiatPanel from './FiatPanel';
import BlockchainPanel from './BlockchainPanel';
import WalletModals from './WalletModals';

const LS_MODE = 'scruple.wallet.mode';
const LS_NETWORK = 'scruple.wallet.network';

export default function WalletView() {
  const mode = useWallet(s => s.mode);
  const setMode = useWallet(s => s.setMode);
  const setNetwork = useWallet(s => s.setNetwork);

  // Restore from localStorage on mount
  useEffect(() => {
    const m = window.localStorage.getItem(LS_MODE);
    if (m === 'fiat' || m === 'blockchain') setMode(m);
    const n = window.localStorage.getItem(LS_NETWORK);
    if (n === 'mainnet' || n === 'testnet') setNetwork(n);
  }, [setMode, setNetwork]);

  return (
    <div className="flex h-full flex-col">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 border-b border-scruple-border bg-scruple-surface px-6 py-2">
        <ModePill
          active={mode === 'fiat'}
          accent="text-fuchsia-400 border-fuchsia-500/40 bg-fuchsia-500/10"
          onClick={() => {
            setMode('fiat');
            window.localStorage.setItem(LS_MODE, 'fiat');
          }}
        >
          💳 Fiat
        </ModePill>
        <ModePill
          active={mode === 'blockchain'}
          accent="text-scruple-accent border-scruple-accent/40 bg-scruple-accent/10"
          onClick={() => {
            setMode('blockchain');
            window.localStorage.setItem(LS_MODE, 'blockchain');
          }}
        >
          ⛓ Blockchain
        </ModePill>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {mode === 'fiat' ? <FiatPanel /> : <BlockchainPanel />}
      </div>

      <WalletModals />
    </div>
  );
}

function ModePill({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border px-3 py-1 text-xs uppercase tracking-widest transition-colors ' +
        (active
          ? `${accent}`
          : 'border-transparent text-scruple-muted hover:text-scruple-text')
      }
    >
      {children}
    </button>
  );
}
