'use client';

// WO-46 · Mid-flight lock progress modal.
//
// Replaces the generic InterlockOverlay with a richer per-step
// indicator during chain locks. Step list reflects the executor's
// stage: witness → RVN mint → IPFS pin → Arweave commit. For local
// or checkpoint locks only "Sealing" is shown.

import ModalShell from './ModalShell';

export type LockStep = 'witnessing' | 'sealing' | 'rvn' | 'ipfs' | 'arweave';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

const STEP_LABEL: Record<LockStep, string> = {
  witnessing: 'Witnessing iterations',
  sealing: 'Sealing Merkle tree',
  rvn: 'Anchoring to Ravencoin',
  ipfs: 'Pinning to IPFS',
  arweave: 'Committing to Arweave',
};

export default function LockProgressModal({
  steps,
  title = 'Locking project',
  subtitle,
  onClose,
}: {
  steps: Array<{ key: LockStep; status: StepStatus; detail?: string }>;
  title?: string;
  subtitle?: string;
  onClose?: () => void;
}) {
  return (
    <ModalShell
      tone="info"
      title={title}
      subtitle={subtitle ?? 'This may take a minute. Please don’t close this window.'}
      onClose={onClose ?? (() => {})}
      // No footer — the modal closes itself when complete.
    >
      <ol className="space-y-2">
        {steps.map(s => (
          <li
            key={s.key}
            className="flex items-center gap-3 rounded-md border border-scruple-border bg-scruple-bg px-3 py-2"
          >
            <StatusDot status={s.status} />
            <div className="flex-1">
              <div className="text-sm">{STEP_LABEL[s.key]}</div>
              {s.detail && <div className="text-[11px] text-scruple-muted">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </ModalShell>
  );
}

function StatusDot({ status }: { status: StepStatus }) {
  if (status === 'running') {
    return <div className="h-3 w-3 animate-spin rounded-full border-2 border-scruple-border border-t-scruple-accent" />;
  }
  if (status === 'done') {
    return <span className="text-scruple-success">✓</span>;
  }
  if (status === 'failed') {
    return <span className="text-scruple-danger">✕</span>;
  }
  return <span className="h-3 w-3 rounded-full bg-scruple-border" />;
}
