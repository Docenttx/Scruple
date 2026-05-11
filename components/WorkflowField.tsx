'use client';

// Workspace UI for setting the project's ComfyDeploy deployment_id.
// Displays the current id (or "—" if unset) and an inline edit form.
// Server action handles persistence + revalidation.

import { useState, useTransition } from 'react';
import { setProjectWorkflow } from '@/lib/projects/actions';

export default function WorkflowField({
  projectId,
  initialWorkflowId,
  disabled,
}: {
  projectId: number;
  initialWorkflowId: string | null;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialWorkflowId ?? '');
  const [pending, startTransition] = useTransition();

  function save() {
    const next = value.trim();
    startTransition(async () => {
      await setProjectWorkflow(projectId, next === '' ? null : next);
      setEditing(false);
    });
  }

  function cancel() {
    setValue(initialWorkflowId ?? '');
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
          placeholder="deployment_id from comfydeploy.com"
          className="w-72 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs font-mono focus:border-scruple-accent focus:outline-none"
          disabled={pending}
        />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs hover:border-scruple-accent disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="text-xs text-scruple-muted hover:text-scruple-text"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-widest text-scruple-muted">Workflow</span>
      <code className="rounded bg-scruple-bg px-1.5 py-0.5 text-xs">
        {initialWorkflowId ?? '—'}
      </code>
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={disabled}
        className="text-xs text-scruple-muted hover:text-scruple-accent disabled:opacity-40"
      >
        {initialWorkflowId ? 'edit' : 'set'}
      </button>
    </div>
  );
}
