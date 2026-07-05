'use client';

// Lock buttons — three direct actions matching desktop:
//
//   ◇ Checkpoint   → seal progress, keep working (yellow hover)
//   ◆ Finalize     → permanently seal locally  (orange hover)
//   ⛓ Chain Lock   → anchor on-chain           (blue hover)
//
// Hover color of each button matches the destination status colour
// (checkpointed=yellow, local_locked=orange, chain_locked=blue), so
// the button visually telegraphs the state it produces.
//
// Chain-lock tier (basic = RVN-only, pinned = RVN+IPFS+Arweave) and
// payment rail (fiat vs RVN wallet) are user preferences set in
// Settings — the workspace buttons are dumb triggers.
//
// Click flow:
//   button → setConfirmKind
//   LockConfirmModal opens
//   onConfirm → fiat: StripePaymentModal | blockchain: /api/lock/{kind}

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

type ButtonSpec = {
  kind: LockKind | 'c2pa';
  title: string;
  desc: string;
  icon: string;
  hoverBorder: string;
};

const BUTTONS: ButtonSpec[] = [
  {
    kind: 'checkpoint',
    title: 'Checkpoint',
    desc: 'Seal progress, keep working',
    icon: '◇',
    hoverBorder: 'hover:enabled:border-[#ffc107]',
  },
  {
    kind: 'local',
    title: 'Finalize Project',
    desc: 'Permanently seal locally',
    icon: '◆',
    hoverBorder: 'hover:enabled:border-[#ff9800]',
  },
  {
    kind: 'chain',
    title: 'Chain Lock',
    desc: 'Anchor on-chain (RVN + Arweave)',
    icon: '⛓',
    hoverBorder: 'hover:enabled:border-[#2196f3]',
  },
  {
    kind: 'c2pa',
    title: 'Sign with C2PA',
    desc: 'Industry-standard signed asset',
    icon: '✍',
    hoverBorder: 'hover:enabled:border-[#e53935]',
  },
];

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
  // Chain-lock tier comes from user settings (Settings → Payment Mode).
  // The workspace button is "dumb" — it always uses the preference.
  const chainTier = useWallet(s => s.chainTier);
  const [confirmKind, setConfirmKind] = useState<LockKind | null>(null);
  const [payment, setPayment] = useState<PendingPayment | null>(null);
  const [result, setResult] = useState<LockResult | null>(null);
  const disabled = !hasContent || pending || interlocked;

  function onConfirm(kind: LockKind, opts: { tier?: ChainTier; password?: string }) {
    setConfirmKind(null);
    // Resolution order: explicit tier from modal → user setting → 'basic'.
    const tier = kind === 'chain' ? (opts.tier ?? chainTier) : undefined;
    if (walletMode === 'fiat') {
      setPayment({ kind, tier });
      return;
    }
    fireBlockchain(kind, tier);
  }

  function fireBlockchain(kind: LockKind, tier?: ChainTier) {
    start(async () => {
      setInterlock(true, `Locking project (${kind}${tier ? `, ${tier}` : ''})`);
      try {
        const res = await fetch(`/api/lock/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.id, tier }),
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

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {BUTTONS.map(spec => (
          <LockButton
            key={spec.kind}
            spec={spec}
            disabled={disabled}
            onClick={() => {
              if (spec.kind === 'c2pa') {
                // Stub picker for now — surface a coming-soon note.
                // Full tier picker + POST /api/scruple/c2pa/sign wires in a
                // follow-up commit; button is functional as a demo signal.
                alert('C2PA signing pipeline: pick tier (bare / witnessed / local / chain) — full picker lands in the next iteration.');
                return;
              }
              setConfirmKind(spec.kind as LockKind);
            }}
          />
        ))}
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
  spec,
  disabled,
  onClick,
}: {
  spec: ButtonSpec;
  disabled: boolean;
  onClick: () => void;
}) {
  // Desktop main.css .lock-btn-large — 2px border, 8px radius, bg-secondary,
  // 24px 16px padding, flex column center. Hover border = destination status.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex flex-col items-center rounded-lg border-2 border-scruple-border-color ' +
        'bg-scruple-bg-secondary px-4 py-6 text-center transition-colors duration-fast ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        spec.hoverBorder
      }
    >
      <span className="mb-3 text-3xl">{spec.icon}</span>
      <span className="text-sm font-semibold text-scruple-text-primary">{spec.title}</span>
      <span className="mt-1 text-2xs text-scruple-text-secondary">{spec.desc}</span>
    </button>
  );
}
