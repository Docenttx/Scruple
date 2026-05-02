'use client';

import { useTransition } from 'react';
import { activateProject, deactivateProject } from '@/lib/projects/actions';
import { useInterlock } from '@/lib/store/interlock';

export default function TrackingButton({
  projectId,
  isActive,
  disabled,
}: {
  projectId: number;
  isActive: boolean;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const interlocked = useInterlock((s) => s.busy);
  return (
    <button
      type="button"
      disabled={pending || disabled || interlocked}
      onClick={() => {
        start(async () => {
          if (isActive) await deactivateProject();
          else await activateProject(projectId);
        });
      }}
      className={`rounded-md border px-4 py-2 text-sm transition disabled:opacity-40 ${
        isActive
          ? 'border-scruple-danger/40 bg-scruple-danger/10 text-scruple-danger hover:bg-scruple-danger/20'
          : 'border-scruple-success/40 bg-scruple-success/10 text-scruple-success hover:bg-scruple-success/20'
      }`}
      title={disabled ? 'Cannot track a locked project' : undefined}
    >
      {pending ? '…' : isActive ? 'Stop tracking' : 'Start tracking'}
    </button>
  );
}
