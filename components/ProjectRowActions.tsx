'use client';

import { useTransition } from 'react';
import { archiveProject } from '@/lib/projects/actions';

export default function ProjectRowActions({ projectId }: { projectId: number }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm('Archive this project?')) return;
        start(() => archiveProject(projectId));
      }}
      className="rounded-md border border-scruple-border bg-scruple-surface px-1.5 py-0.5 text-[9px] hover:border-scruple-danger hover:text-scruple-danger"
      title="Archive"
    >
      ⤓
    </button>
  );
}
