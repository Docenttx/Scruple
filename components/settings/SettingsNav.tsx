'use client';

// Sticky left-side nav for the Settings page. Anchor-based — clicking
// a category scrolls to the corresponding section id. The active item
// is highlighted via IntersectionObserver as the user scrolls.

import { useEffect, useState } from 'react';

export interface NavItem {
  id: string;          // matches the section's html id
  label: string;
  description?: string;
}

export default function SettingsNav({ items }: { items: NavItem[] }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? '');

  useEffect(() => {
    const targets = items
      .map(i => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    const obs = new IntersectionObserver(
      entries => {
        // Pick the entry closest to the top of the viewport that is
        // still intersecting.
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      {
        // 25% from the top — feels natural when sections are tall
        rootMargin: '-25% 0px -60% 0px',
        threshold: 0,
      },
    );
    for (const t of targets) obs.observe(t);
    return () => obs.disconnect();
  }, [items]);

  return (
    <nav className="sticky top-2 flex w-48 shrink-0 flex-col gap-0.5 text-sm">
      {items.map(item => (
        <a
          key={item.id}
          href={`#${item.id}`}
          onClick={() => setActive(item.id)}
          className={
            'rounded-md px-3 py-1.5 transition-colors duration-fast ' +
            (active === item.id
              ? 'bg-scruple-accent-primary/10 text-scruple-accent-primary'
              : 'text-scruple-text-secondary hover:bg-scruple-bg-tertiary hover:text-scruple-text-primary')
          }
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
