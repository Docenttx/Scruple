'use client';

// Server-action wrapped button. Pulled out of the banner so the banner
// can be a server component (so it can use revalidatePath cleanly).

import { useTransition } from 'react';
import { deactivateProject } from '@/lib/projects/actions';

export default function StopTrackingButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => deactivateProject())}
      disabled={pending}
      className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-scruple-muted hover:border-scruple-danger hover:text-scruple-danger disabled:opacity-50"
    >
      {pending ? '…' : 'Stop'}
    </button>
  );
}
