'use client';

// Compact Start/Stop Tracking button — sits in the .project-footer row
// of each project in the sidebar. Matches desktop render-main.js
// .activate-btn / .stop-btn small.

import { useTransition } from 'react';
import { activateProject, deactivateProject } from '@/lib/projects/actions';
import { useInterlock } from '@/lib/store/interlock';

export default function SidebarTrackingButton({
  projectId,
  isActive,
}: {
  projectId: number;
  isActive: boolean;
}) {
  const [pending, start] = useTransition();
  const interlocked = useInterlock((s) => s.busy);
  const disabled = pending || interlocked;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        start(async () => {
          if (isActive) await deactivateProject();
          else await activateProject(projectId);
        });
      }}
      className={
        isActive
          ? 'rounded-md border border-scruple-danger/40 bg-scruple-danger/15 px-2 py-0.5 text-2xs font-medium text-scruple-danger transition-colors hover:bg-scruple-danger/25 disabled:opacity-40'
          : 'rounded-md border border-scruple-success/40 bg-scruple-success/15 px-2 py-0.5 text-2xs font-medium text-scruple-success transition-colors hover:bg-scruple-success/25 disabled:opacity-40'
      }
      title={isActive ? 'Stop tracking this project' : 'Start tracking this project'}
    >
      {pending ? '…' : isActive ? 'Stop Tracking' : 'Start'}
    </button>
  );
}
