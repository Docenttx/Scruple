'use client';

// WO-45 · Pre-lock confirmation modal.
//
// One component, action-aware copy. Drives the user through the
// pre-flight confirm step for each lock kind. In fiat mode displays
// the $ fee; in blockchain mode displays the RVN/asset cost and gates
// chain lock with a password input (when implemented).
//
// Tier selection (Basic / Pinned) is only shown for chain locks.

import { useState } from 'react';
import type { ProjectRow } from '@/lib/types';
import { useWallet } from '@/lib/store/wallet';
import ModalShell, { ModalButton } from './ModalShell';

export type LockKind = 'local' | 'checkpoint' | 'chain';
export type ChainTier = 'basic' | 'pinned';

const FIAT_FEES: Record<LockKind, string> = {
  local: '$5.00',
  checkpoint: '$5.00',
  chain: '$50.00 — $65.00',
};

const TITLES: Record<LockKind, string> = {
  local: 'Finalize Project',
  checkpoint: 'Checkpoint Project',
  chain: 'Chain Lock',
};

const DESCRIPTIONS: Record<LockKind, string> = {
  local:
    'Finalizing permanently seals this project — no more iterations can be captured. This cannot be undone.',
  checkpoint:
    'Your project progress is sealed and witnessed. You can resume adding iterations afterwards.',
  chain:
    'Anchors the project to Ravencoin, IPFS, and Arweave. Permanent on-chain record.',
};

export default function LockConfirmModal({
  project,
  kind,
  onClose,
  onConfirm,
}: {
  project: ProjectRow;
  kind: LockKind;
  onClose: () => void;
  onConfirm: (opts: { tier?: ChainTier; password?: string }) => void;
}) {
  const mode = useWallet(s => s.mode);
  const [tier, setTier] = useState<ChainTier>('basic');
  const [password, setPassword] = useState('');

  const isChain = kind === 'chain';
  const isBlockchain = mode === 'blockchain';

  // Tone per desktop:
  // - finalize / checkpoint (fiat) → info (blue)
  // - blockchain variants → warn (amber)
  // - chain lock → purple (tsd) or warn (blockchain rvn)
  const tone =
    isChain && !isBlockchain
      ? 'purple'
      : isBlockchain
        ? 'warn'
        : 'info';

  function submit() {
    const opts: { tier?: ChainTier; password?: string } = {};
    if (isChain && !isBlockchain) opts.tier = tier;
    if (isChain && isBlockchain) opts.password = password;
    onConfirm(opts);
  }

  const canSubmit = !(isChain && isBlockchain && password.length < 1);

  return (
    <ModalShell
      tone={tone}
      title={TITLES[kind]}
      subtitle={`Project: ${project.name}`}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" disabled={!canSubmit} onClick={submit}>
            {isChain
              ? isBlockchain
                ? 'Lock to Blockchain'
                : `${tier === 'basic' ? 'Basic Lock' : 'Pinned Lock'} →`
              : `${TITLES[kind]} →`}
          </ModalButton>
        </>
      }
    >
      <p className="text-scruple-muted">{DESCRIPTIONS[kind]}</p>

      <div className="mt-4 rounded-md border border-scruple-border bg-scruple-bg p-3 text-xs">
        {isBlockchain ? (
          <>
            <div className="mb-1 flex justify-between">
              <span className="text-scruple-muted">Mode</span>
              <span>Blockchain (no fee)</span>
            </div>
            {isChain && (
              <div className="flex justify-between">
                <span className="text-scruple-muted">RVN asset mint</span>
                <span className="font-mono">~500 RVN</span>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-1 flex justify-between">
              <span className="text-scruple-muted">Mode</span>
              <span>Fiat (Stripe / TSD)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-scruple-muted">Fee</span>
              <span className="font-mono">{FIAT_FEES[kind]}</span>
            </div>
          </>
        )}
      </div>

      {/* Chain-lock tier selector (fiat mode only) */}
      {isChain && !isBlockchain && (
        <div className="mt-4">
          <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
            Lock Tier
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <TierButton
              active={tier === 'basic'}
              onClick={() => setTier('basic')}
              label="Basic"
              fee="50 TSD"
              detail="RVN + IPFS"
            />
            <TierButton
              active={tier === 'pinned'}
              onClick={() => setTier('pinned')}
              label="Pinned"
              fee="65 TSD"
              detail="RVN + IPFS + Arweave"
            />
          </div>
        </div>
      )}

      {/* RVN password (blockchain mode, chain lock only) */}
      {isChain && isBlockchain && (
        <div className="mt-4">
          <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
            Wallet Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-sm focus:border-scruple-accent focus:outline-none"
            placeholder="Enter wallet password to sign the asset mint"
          />
        </div>
      )}
    </ModalShell>
  );
}

function TierButton({
  active,
  onClick,
  label,
  fee,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  fee: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex flex-col items-start rounded-md border bg-scruple-bg px-3 py-2 text-left transition ' +
        (active
          ? 'border-fuchsia-500 bg-fuchsia-500/10'
          : 'border-scruple-border hover:border-scruple-accent')
      }
    >
      <span className="text-sm">{label}</span>
      <span className="text-[11px] text-fuchsia-400">{fee}</span>
      <span className="mt-0.5 text-[10px] text-scruple-muted">{detail}</span>
    </button>
  );
}
