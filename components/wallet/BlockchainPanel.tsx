'use client';

// WO-37/43 · Blockchain-mode wallet panel.
//
// Port of renderWalletBlockchain() — RVN wallet status + network
// selector (with testnet 🧪 banner) + IPFS config card. Wallet
// management buttons (Create / Import / Unlock / Settings) all open
// modals from WalletModals.

import { useEffect, useState } from 'react';
import { useWallet, type RvnNetwork } from '@/lib/store/wallet';

interface RvnStatus {
  network: RvnNetwork;
  ok: boolean;
  chain?: string;
  blockHeight?: number;
  wallets?: string[] | null;
  balance?: number | null;
  assetCount?: number;
  scrupleAssets?: string[];
  detail?: string;
}

const LS_NETWORK = 'scruple.wallet.network';

export default function BlockchainPanel() {
  const network = useWallet(s => s.network);
  const setNetwork = useWallet(s => s.setNetwork);
  const openModal = useWallet(s => s.openModal);
  const [status, setStatus] = useState<RvnStatus | null>(null);
  const [reloading, setReloading] = useState(false);

  function refresh() {
    setReloading(true);
    fetch(`/api/wallet/rvn?network=${network}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ network, ok: false, detail: 'fetch failed' }))
      .finally(() => setReloading(false));
  }

  useEffect(refresh, [network]);

  const isTestnet = network === 'testnet';
  const hasWallet = Boolean(status?.wallets?.length);

  return (
    <div className="space-y-6">
      {isTestnet && (
        <div className="rounded-md border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-xs text-orange-300">
          🧪 TESTNET MODE ACTIVE — operations are non-binding
        </div>
      )}

      {/* RVN wallet card */}
      <section
        className={
          'rounded-lg border bg-scruple-surface p-5 ' +
          (isTestnet ? 'border-orange-500/40' : 'border-scruple-border')
        }
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
              Ravencoin Wallet
            </h2>
            <p className="mt-1 text-[11px] text-scruple-muted">
              {status?.ok ? (
                <>
                  {status.chain ?? '—'} · block {status.blockHeight ?? '—'}
                </>
              ) : (
                <span className="text-scruple-danger">
                  Connection failed: {status?.detail ?? '…'}
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={reloading}
            className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-[10px] uppercase tracking-widest text-scruple-muted hover:border-scruple-accent disabled:opacity-50"
          >
            {reloading ? '…' : 'Refresh'}
          </button>
        </div>

        {/* Balance + asset count */}
        <div className="mb-5 grid grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-scruple-muted">Balance</div>
            <div className="mt-1 text-2xl font-light">
              {status?.balance != null ? status.balance.toFixed(8) : '—'}{' '}
              <span className="text-xs text-scruple-muted">RVN</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-scruple-muted">Scruple assets</div>
            <div className="mt-1 text-2xl font-light">
              {status?.scrupleAssets?.length ?? 0}
              <span className="ml-1 text-xs text-scruple-muted">SCR_*</span>
            </div>
          </div>
        </div>

        {/* Wallet actions */}
        <div className="flex flex-wrap gap-2">
          {hasWallet ? (
            <>
              <button
                type="button"
                onClick={() => openModal('rvn-unlock')}
                className="rounded-md border border-scruple-accent bg-scruple-accent/15 px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-accent/30"
              >
                Unlock
              </button>
              <button
                type="button"
                onClick={() => openModal('rvn-settings')}
                className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent"
              >
                Settings
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => openModal('rvn-create')}
                className="rounded-md border border-scruple-accent bg-scruple-accent/15 px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-accent/30"
              >
                Create New Wallet
              </button>
              <button
                type="button"
                onClick={() => openModal('rvn-import')}
                className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent"
              >
                Import from Phrase
              </button>
            </>
          )}
        </div>

        {/* Scruple asset list */}
        {status?.scrupleAssets && status.scrupleAssets.length > 0 && (
          <div className="mt-5 border-t border-scruple-border pt-4">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-scruple-muted">
              SCR_ Assets ({status.scrupleAssets.length})
            </div>
            <div className="space-y-1 font-mono text-xs">
              {status.scrupleAssets.slice(0, 20).map(a => (
                <div key={a} className="flex items-center justify-between rounded bg-scruple-bg px-2 py-1">
                  <span>{a}</span>
                  <button
                    type="button"
                    className="text-[10px] text-scruple-muted hover:text-scruple-accent"
                  >
                    Verify
                  </button>
                </div>
              ))}
              {status.scrupleAssets.length > 20 && (
                <div className="pt-1 text-[10px] text-scruple-muted">
                  + {status.scrupleAssets.length - 20} more…
                </div>
              )}
            </div>
          </div>
        )}

        {/* Network selector */}
        <div className="mt-5 border-t border-scruple-border pt-4">
          <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
            RVN Network
          </label>
          <select
            value={network}
            onChange={e => {
              const v = e.target.value as RvnNetwork;
              setNetwork(v);
              window.localStorage.setItem(LS_NETWORK, v);
            }}
            className="mt-1 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
          >
            <option value="mainnet">Mainnet</option>
            <option value="testnet">Testnet</option>
          </select>
        </div>
      </section>

      {/* IPFS config — same panel as fiat */}
      <section className="rounded-lg border border-scruple-border bg-scruple-surface p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
              IPFS Configuration
            </h2>
            <p className="mt-1 text-xs text-scruple-muted">
              Gateway and pinning service for persistent-lock uploads.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openModal('ipfs-config')}
            className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent"
          >
            Configure
          </button>
        </div>
      </section>
    </div>
  );
}
