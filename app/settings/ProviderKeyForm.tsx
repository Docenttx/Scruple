'use client';

import { useState, useTransition } from 'react';
import { setProviderKey } from '@/lib/settings/actions';

export default function ProviderKeyForm({
  provider,
  status,
}: {
  provider: 'fal' | 'comfydeploy';
  status: { present: boolean; tail?: string };
}) {
  const [value, setValue] = useState('');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const labels = {
    fal: { name: 'fal.ai', placeholder: 'fal-key-xxxxxx', help: 'From fal.ai dashboard.' },
    comfydeploy: {
      name: 'ComfyDeploy',
      placeholder: 'cd-xxxxxx',
      help: 'From comfydeploy.com → API keys.',
    },
  } as const;
  const cfg = labels[provider];

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      try {
        await setProviderKey({ provider, value });
        setMsg(value.trim() === '' ? 'Cleared.' : 'Saved.');
        setValue('');
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed.');
      }
    });
  }

  return (
    <form onSubmit={save} className="rounded-md border border-scruple-border bg-scruple-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm">{cfg.name}</span>
        {status.present ? (
          <span className="text-[10px] text-scruple-success">
            ✓ set · ends …{status.tail ?? '????'}
          </span>
        ) : (
          <span className="text-[10px] text-scruple-muted">not set</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={cfg.placeholder}
          className="flex-1 rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-sm focus:border-scruple-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent disabled:opacity-40"
        >
          {pending ? '…' : 'Save'}
        </button>
        {status.present && (
          <button
            type="button"
            disabled={pending}
            onClick={() => start(() => setProviderKey({ provider, value: '' }))}
            className="rounded-md border border-scruple-danger/40 px-3 py-1.5 text-xs text-scruple-danger hover:border-scruple-danger disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </div>
      <p className="mt-2 text-[10px] text-scruple-muted">{cfg.help}</p>
      {msg && <p className="mt-2 text-[10px] text-scruple-text">{msg}</p>}
    </form>
  );
}
