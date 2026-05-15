// StatusBadgeSolid — matches desktop main.css .status-badge.{state}.
// Solid background fill (not outlined) with white text.
//
//   unlocked          → solid green
//   checkpointed      → solid yellow
//   local_locked      → solid orange
//   chain_locked      → solid blue
//   persistent_locked → solid purple
//   permanent_locked  → solid purple

import { LOCK_STATE_LABELS, type LockState } from '@/lib/types';

const STYLES: Record<LockState, { bg: string; fg: string }> = {
  unlocked:           { bg: '#4caf50', fg: '#ffffff' },
  checkpointed:       { bg: '#ffc107', fg: '#1a1a1a' },
  local_locked:       { bg: '#ff9800', fg: '#ffffff' },
  chain_locked:       { bg: '#2196f3', fg: '#ffffff' },
  persistent_locked:  { bg: '#9c27b0', fg: '#ffffff' },
  permanent_locked:   { bg: '#9c27b0', fg: '#ffffff' },
};

export default function StatusBadgeSolid({ status }: { status: LockState }) {
  const { bg, fg } = STYLES[status];
  return (
    <span
      className="inline-block rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: bg, color: fg }}
    >
      {LOCK_STATE_LABELS[status]}
    </span>
  );
}
