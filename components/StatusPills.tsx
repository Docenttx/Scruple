'use client';

// WO-32 · Sidebar connection-status pills.
//
// Polls /api/health every 10s and renders three pills:
//
//   Witness ●   RVN ●   Stripe ●
//
// Dot color:  green (ok) / red (down) / grey (unknown / not wired).
// Click a pill to force an immediate re-probe. Hover shows the detail
// returned by the server (HTTP code, error message).
//
// Pattern mirrors the desktop's connection indicator row in the sidebar
// (renderSidebar, status icons). Single fetch per tick (the route
// fans out internally) to keep the request count low.

import { useEffect, useState } from 'react';

type Health = { ok: boolean | null; label: string; detail?: string };
type Snapshot = {
  witness: Health;
  rvn: Health;
  stripe: Health;
  checkedAt: string;
};

const POLL_MS = 10_000;

const UNKNOWN: Health = { ok: null, label: '?', detail: 'pending' };
const INITIAL: Snapshot = {
  witness: { ...UNKNOWN, label: 'Witness' },
  rvn: { ...UNKNOWN, label: 'RVN' },
  stripe: { ...UNKNOWN, label: 'Stripe' },
  checkedAt: '',
};

export default function StatusPills() {
  const [snap, setSnap] = useState<Snapshot>(INITIAL);
  const [pending, setPending] = useState(false);

  async function refresh() {
    setPending(true);
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as Snapshot;
        setSnap(data);
      }
    } catch {
      // Network/server hiccup — leave the last snapshot in place.
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center gap-1 border-b border-scruple-border bg-scruple-surface px-3 py-1.5">
      <Pill data={snap.witness} onClick={refresh} pending={pending} />
      <Pill data={snap.rvn} onClick={refresh} pending={pending} />
      <Pill data={snap.stripe} onClick={refresh} pending={pending} />
    </div>
  );
}

function Pill({
  data,
  onClick,
  pending,
}: {
  data: Health;
  onClick: () => void;
  pending: boolean;
}) {
  const dotClass =
    data.ok === true
      ? 'bg-scruple-success'
      : data.ok === false
        ? 'bg-scruple-danger'
        : 'bg-scruple-muted';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={data.detail || (data.ok === true ? 'OK' : data.ok === false ? 'Down' : 'Unknown')}
      className="flex items-center gap-1 rounded-full border border-scruple-border bg-scruple-bg px-1.5 py-0.5 text-[10px] text-scruple-muted hover:border-scruple-accent disabled:opacity-50"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{data.label}</span>
    </button>
  );
}
