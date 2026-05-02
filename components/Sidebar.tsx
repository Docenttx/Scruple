// Sidebar — project list. WO-05 ships a placeholder; WO-07 wires it
// to the real project list. The placeholder shows the empty state and
// the create-project button.

import Link from 'next/link';

export default function Sidebar() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-scruple-border px-4 py-2">
        <span className="text-[10px] uppercase tracking-widest text-scruple-muted">Projects</span>
        <Link
          href="/projects/new"
          className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-0.5 text-xs hover:border-scruple-accent"
        >
          + New
        </Link>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <p className="text-xs text-scruple-muted">No projects yet.</p>
      </div>
    </div>
  );
}
