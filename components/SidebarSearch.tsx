'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

export default function SidebarSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [, start] = useTransition();

  function update(value: string) {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set('q', value);
    else next.delete('q');
    next.delete('page');
    start(() => router.replace(`/?${next.toString()}`));
  }

  return (
    <div className="flex items-center gap-2 border-b border-scruple-border px-4 py-2">
      <input
        defaultValue={initial}
        placeholder="Search…"
        onChange={(e) => update(e.target.value)}
        className="flex-1 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
      />
      <Link
        href="/projects/new"
        className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-0.5 text-xs hover:border-scruple-accent"
      >
        + New
      </Link>
    </div>
  );
}
