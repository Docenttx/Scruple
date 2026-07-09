'use client';

// WO-33 · Top-level view toggle (Workspace / Canvas / Wallet).
//
// Port of the desktop's view-toggle-header row. Sits inside the
// AppShell topbar, just left of the user menu. Active pill is
// determined by the current URL via usePathname() — link-driven
// navigation rather than client state, so deep links work.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Pill = { label: string; href: string; match: (p: string) => boolean };

// Wallet was a top-level pill; per the clone-2 refactor, payment-mode
// + saved-method management now live under /settings. Settings is
// reachable via the gear icon in the topbar — not a view pill.
// App pills — Kohya is conditionally visible only when its RunPod
// backend is configured. NEXT_PUBLIC_KOHYA_ENABLED is set by the
// build step from the same env that lib/apps/registry.ts checks.
const kohyaEnabled = process.env.NEXT_PUBLIC_KOHYA_ENABLED === '1';

const PILLS: Pill[] = [
  { label: 'Workspace', href: '/', match: p => p === '/' || p.startsWith('/projects/') },
  { label: 'Canvas', href: '/canvas', match: p => p.startsWith('/canvas') },
  ...(kohyaEnabled
    ? [{ label: 'Kohya', href: '/apps/kohya', match: (p: string) => p.startsWith('/apps/kohya') }]
    : []),
];

export default function ViewToggle() {
  const pathname = usePathname() ?? '/';
  return (
    <div className="flex items-center gap-0.5">
      {PILLS.map(p => {
        const active = p.match(pathname);
        return (
          <Link
            key={p.label}
            href={p.href}
            className={
              'rounded-md px-3 py-1 text-xs uppercase tracking-widest transition-colors ' +
              (active
                ? 'border border-scruple-accent bg-scruple-accent/20 text-scruple-text'
                : 'border border-transparent text-scruple-muted hover:text-scruple-text')
            }
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}
