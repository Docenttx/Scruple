'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createProject } from '@/lib/projects/actions';

export default function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [type, setType] = useState<'txt2img' | 'training'>('txt2img');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const project = await createProject({ name: name.trim(), type });
        router.push(`/projects/${project.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <label className="block text-xs uppercase tracking-widest text-scruple-muted">Name</label>
        <input
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Hero image batch — Q3 campaign"
          className="mt-2 w-full rounded-md border border-scruple-border bg-scruple-bg px-3 py-2 text-sm focus:border-scruple-accent focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-widest text-scruple-muted">Type</label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setType('txt2img')}
            className={`rounded-md border px-3 py-2 text-left text-sm transition ${
              type === 'txt2img'
                ? 'border-scruple-accent bg-scruple-accent/10'
                : 'border-scruple-border bg-scruple-bg hover:border-scruple-accent/40'
            }`}
          >
            <div>txt2img</div>
            <div className="text-[10px] text-scruple-muted">Image generation iterations</div>
          </button>
          <button
            type="button"
            disabled
            title="Training capture is deferred to v2 (requires desktop bridge or hosted Kohya)"
            className="cursor-not-allowed rounded-md border border-scruple-border bg-scruple-bg px-3 py-2 text-left text-sm opacity-40"
          >
            <div>training</div>
            <div className="text-[10px] text-scruple-muted">deferred to v2</div>
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-scruple-danger/40 bg-scruple-danger/10 p-2 text-xs text-scruple-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="rounded-md border border-scruple-accent bg-scruple-accent/20 px-4 py-2 text-sm hover:bg-scruple-accent/30 disabled:opacity-40"
        >
          {pending ? 'Creating…' : 'Create project'}
        </button>
        <a
          href="/"
          className="rounded-md border border-scruple-border bg-scruple-bg px-4 py-2 text-sm hover:border-scruple-muted"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
