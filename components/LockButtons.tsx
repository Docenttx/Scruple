'use client';

// WO-45/46/40 · Lock buttons + confirm → (Stripe payment in fiat) →
// result flow.
//
// Click → LockConfirmModal (fee display, RVN password or TSD tier).
// Fiat mode: → StripePaymentModal (Stripe Element). On success, the
// witness server's confirm-and-execute fires the lock; we surface
// SCR-ID + per-network status in LockResultModal.
// Blockchain mode: → direct POST /api/lock/{kind}, then LockResultModal.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectRow } from '@/lib/types';
import { useInterlock } from '@/lib/store/interlock';
import { useToast } from '@/lib/store/toast';
import { useWallet } from '@/lib/store/wallet';
import LockConfirmModal, { type LockKind, type ChainTier } from './wallet/LockConfirmModal';
import LockResultModal, { type LockResult } from './wallet/LockResultModal';
import StripePaymentModal from './wallet/StripePaymentModal';

type PendingPayment = {
  kind: LockKind;
  tier?: ChainTier;
};

export default function LockButtons({
  project,
  hasContent,
}: {
  project: ProjectRow;
  hasContent: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const interlocked = useInterlock(s => s.busy);
  const setInterlock = useInterlock(s => s.set);
  const walletMode = useWallet(s => s.mode);
  const [confirmKind, setConfirmKind] = useState<LockKind | null>(null);
  const [payment, setPayment] = useState<PendingPayment | null>(null);
  const [result, setResult] = useState<LockResult | null>(null);
  const disabled = !hasContent || pending || interlocked;

  function onConfirm(kind: LockKind, opts: { tier?: ChainTier; password?: string }) {
    setConfirmKind(null);
    // Fiat mode → route through Stripe Element for paid actions.
    if (walletMode === 'fiat') {
      setPayment({ kind, tier: opts.tier });
      return;
    }
    // Blockchain mode → direct lock executor.
    fireBlockchain(kind);
  }

  function fireBlockchain(kind: LockKind) {
    start(async () => {
      setInterlock(true, `Locking project (${kind})`);
      try {
        const res = await fetch(`/api/lock/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.id }),
        });
        const data = (await res.json()) as Partial<LockResult> & { error?: string };
        if (!res.ok) {
          setResult({ ok: false, kind, error: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setResult({
          ok: true,
          kind,
          scrId: data.scrId,
          merkleRoot: data.merkleRoot,
          rvnTxId: data.rvnTxId,
          ipfsCid: data.ipfsCid,
          arweaveTxId: data.arweaveTxId,
        });
        router.refresh();
      } catch (e) {
        setResult({ ok: false, kind, error: e instanceof Error ? e.message : String(e) });
        useToast.getState().push({
          tone: 'error',
          title: 'Lock failed',
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setInterlock(false);
      }
    });
  }

  if (!hasContent) {
    return (
      <p className="rounded-md border border-scruple-border bg-scruple-surface/50 p-3 text-xs text-scruple-muted">
        Capture at least one iteration to enable locking.
      </p>
    );
  }

  return (
    <>
      {/* Desktop: .lock-buttons-row grid-template-columns repeat(3,1fr),
          collapses to 1fr at 900px. Tailwind md:= 768px is close. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-locks">
        <LockButton
          title="Finalize Project"
          desc="Permanently seal this project"
          icon="◆"
          kind="local"
          disabled={disabled}
          onClick={() => setConfirmKind('local')}
        />
        <LockButton
          title="Checkpoint"
          desc="Seal progress, keep working"
          icon="◇"
          kind="checkpoint"
          disabled={disabled}
          onClick={() => setConfirmKind('checkpoint')}
        />
        <LockButton
          title="Chain Lock"
          desc="RVN + IPFS + Arweave"
          icon="⛓"
          kind="chain"
          disabled={disabled}
          onClick={() => setConfirmKind('chain')}
        />
      </div>

      {confirmKind && (
        <LockConfirmModal
          project={project}
          kind={confirmKind}
          onClose={() => setConfirmKind(null)}
          onConfirm={opts => onConfirm(confirmKind, opts)}
        />
      )}

      {payment && (
        <StripePaymentModal
          projectId={project.id}
          projectName={project.name}
          kind={payment.kind}
          tier={payment.tier}
          onClose={() => setPayment(null)}
          onSuccess={r => {
            setPayment(null);
            setResult(r);
            router.refresh();
          }}
        />
      )}

      {result && (
        <LockResultModal result={result} onClose={() => setResult(null)} />
      )}
    </>
  );
}

function LockButton({
  title,
  desc,
  icon,
  kind,
  disabled,
  onClick,
}: {
  title: string;
  desc: string;
  icon: string;
  kind: LockKind;
  disabled: boolean;
  onClick: () => void;
}) {
  // Desktop styling per catalog §3 "Lock Buttons":
  //   .lock-btn-large — flex column center, 24px 16px padding, 2px
  //   border, 8px radius, secondary bg, text-align center.
  // Per-kind hover border:
  //   .lock-btn-large.local:hover     → border --accent-warning  (#f59e0b)
  //   .lock-btn-large.chain:hover     → border --accent-secondary (#3b82f6)
  //   .lock-btn-large.persistent:hover → border --accent-purple (#8b5cf6)
  // checkpoint is treated as local on desktop.
  const accent =
    kind === 'local' || kind === 'checkpoint'
      ? 'hover:border-scruple-warn'
      : 'hover:border-scruple-accent-secondary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex flex-col items-center rounded-lg border-2 border-scruple-border-color ' +
        'bg-scruple-bg-secondary px-4 py-6 text-center transition-colors duration-fast ' +
        'disabled:opacity-30 ' +
        accent
      }
    >
      <span className="mb-3 text-3xl">{icon}</span>
      <span className="text-sm font-semibold text-scruple-text-primary">{title}</span>
      <span className="mt-1 text-2xs text-scruple-text-secondary">{desc}</span>
    </button>
  );
}
