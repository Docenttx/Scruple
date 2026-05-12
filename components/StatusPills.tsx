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
    // Desktop catalog §3 "Wallet connection flags": flex gap 12px,
    // 10px 16px padding, panel bg + border.
    <div className="flex items-center gap-2 border-b border-scruple-border-color bg-scruple-bg-secondary px-3 py-2">
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
      // .connection-flag: 4px 10px padding, 12px radius, --flag-bg, text-muted
      className="flex items-center gap-1.5 rounded-full bg-scruple-flag-bg px-2 py-0.5 text-2xs text-scruple-text-secondary transition-colors hover:text-scruple-text-primary disabled:opacity-50"
    >
      {/* .flag-dot: 8x8px, with subtle glow when connected per desktop */}
      <span
        className={`h-2 w-2 rounded-full ${dotClass}`}
        style={{
          boxShadow: data.ok === true ? '0 0 6px currentColor' : undefined,
        }}
      />
      <span>{data.label}</span>
    </button>
  );
}
