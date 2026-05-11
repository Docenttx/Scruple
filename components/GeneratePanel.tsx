'use client';

// GeneratePanel — fires a ComfyDeploy run via /api/generate. The
// resulting iteration is captured server-side; the live iteration grid
// (SSE while the project is active, otherwise next refresh) renders it.
//
// Minimal v1: prompt + collapsed advanced (negative, seed, steps, w/h).
// Per-request cost = a single ComfyDeploy run on the project's workflow.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface GenerateBody {
  projectId: number;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
}

export default function GeneratePanel({
  projectId,
  workflowReady,
  disabled,
}: {
  projectId: number;
  workflowReady: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [seed, setSeed] = useState('');
  const [steps, setSteps] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [cfg, setCfg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const blocked = disabled || !workflowReady || prompt.trim() === '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus('Submitting…');

    const body: GenerateBody = { projectId, prompt: prompt.trim() };
    if (negativePrompt.trim()) body.negativePrompt = negativePrompt.trim();
    if (seed.trim() && !Number.isNaN(Number(seed))) body.seed = Number(seed);
    if (steps.trim() && !Number.isNaN(Number(steps))) body.steps = Number(steps);
    if (width.trim() && !Number.isNaN(Number(width))) body.width = Number(width);
    if (height.trim() && !Number.isNaN(Number(height))) body.height = Number(height);
    if (cfg.trim() && !Number.isNaN(Number(cfg))) body.cfgScale = Number(cfg);

    startTransition(async () => {
      const startedAt = Date.now();
      const tickId = setInterval(() => {
        setStatus(`Running… ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }, 1000);
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || data.error || `HTTP ${res.status}`);
        }
        setStatus(`✓ Iteration #${data.runSequence} captured`);
        setPrompt('');
        // Refresh server components (iteration grid)
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus(null);
      } finally {
        clearInterval(tickId);
      }
    });
  }

  return (
    <section className="rounded-lg border border-scruple-border bg-scruple-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Generate</h2>
        {!workflowReady && (
          <span className="text-[11px] text-scruple-muted">
            Set a workflow id above before generating
          </span>
        )}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Prompt"
          rows={3}
          disabled={pending || disabled}
          className="w-full rounded-md border border-scruple-border bg-scruple-bg p-2 text-sm focus:border-scruple-accent focus:outline-none disabled:opacity-50"
        />

        <button
          type="button"
          onClick={() => setAdvanced(v => !v)}
          className="self-start text-[11px] uppercase tracking-widest text-scruple-muted hover:text-scruple-text"
        >
          {advanced ? '▾ Advanced' : '▸ Advanced'}
        </button>

        {advanced && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Field label="Negative prompt" value={negativePrompt} onChange={setNegativePrompt} wide />
            <Field label="Width" value={width} onChange={setWidth} placeholder="1024" />
            <Field label="Height" value={height} onChange={setHeight} placeholder="1024" />
            <Field label="Seed" value={seed} onChange={setSeed} placeholder="random" />
            <Field label="Steps" value={steps} onChange={setSteps} placeholder="30" />
            <Field label="CFG" value={cfg} onChange={setCfg} placeholder="7" />
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={blocked || pending}
            className="rounded-md border border-scruple-accent bg-scruple-accent/20 px-3 py-1.5 text-sm text-scruple-text hover:bg-scruple-accent/40 disabled:cursor-not-allowed disabled:border-scruple-border disabled:bg-transparent disabled:opacity-50"
          >
            {pending ? 'Generating…' : 'Generate'}
          </button>
          {status && <span className="text-xs text-scruple-muted">{status}</span>}
          {error && <span className="text-xs text-scruple-danger">{error}</span>}
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? 'col-span-2 md:col-span-3' : ''}`}>
      <span className="text-[10px] uppercase tracking-widest text-scruple-muted">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
      />
    </label>
  );
}
