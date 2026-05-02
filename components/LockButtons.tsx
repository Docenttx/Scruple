'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectRow } from '@/lib/types';

export default function LockButtons({
  project,
  hasContent,
}: {
  project: ProjectRow;
  hasContent: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const disabled = !hasContent || pending;

  function fire(kind: 'local' | 'checkpoint' | 'chain') {
    start(async () => {
      const res = await fetch(`/api/lock/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (!res.ok) {
        const body = await res.text();
        alert(`Lock failed: ${body}`);
        return;
      }
      router.refresh();
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
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <LockButton
        title="Finalize Project"
        desc="Permanently seal this project"
        icon="◆"
        kind="local"
        disabled={disabled}
        onClick={() => fire('local')}
      />
      <LockButton
        title="Checkpoint"
        desc="Seal progress, keep working"
        icon="◇"
        kind="checkpoint"
        disabled={disabled}
        onClick={() => fire('checkpoint')}
      />
      <LockButton
        title="Chain Lock"
        desc="RVN + IPFS + Arweave"
        icon="⛓"
        kind="chain"
        disabled={disabled}
        onClick={() => fire('chain')}
      />
    </div>
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
  kind: 'local' | 'checkpoint' | 'chain';
  disabled: boolean;
  onClick: () => void;
}) {
  const accent =
    kind === 'local'
      ? 'border-scruple-success/40 hover:border-scruple-success'
      : kind === 'checkpoint'
        ? 'border-scruple-warn/40 hover:border-scruple-warn'
        : 'border-scruple-accent/40 hover:border-scruple-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start gap-1 rounded-md border bg-scruple-surface p-4 text-left transition disabled:opacity-30 ${accent}`}
    >
      <span className="text-2xl">{icon}</span>
      <span className="text-sm">{title}</span>
      <span className="text-[10px] text-scruple-muted">{desc}</span>
    </button>
  );
}
