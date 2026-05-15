'use client';

// PreflightPanel — port of renderPreflightPanel from desktop
// renderer/render-workspace.js.
//
// Desktop version reads from a global State store updated by IPC messages
// from the kohya capture process. Web equivalent is the same UI shell
// driven by an SSE stream from /api/training/preflight/:runId.
//
// The runtime endpoint is not wired yet — clicking "Start Pre-Flight"
// hits the placeholder endpoint, which returns 501. Once the Modal
// training pipeline lands, the same endpoint will stream real progress.
// Until then this renders correctly with the empty/idle state, which is
// what every workspace will show for now.

import { useState } from 'react';

type ItemStatus = 'pending' | 'hashing' | 'complete';

interface PreflightItem {
  status: ItemStatus;
  progress?: number;        // 0..1 during hashing
  etaSeconds?: number;
  hash?: string | null;
  merkleRoot?: string | null;
  cached?: boolean;
}

interface PreflightStatus {
  baseModel?: PreflightItem;
  dataset?: PreflightItem;
  checkpoint?: PreflightItem;
  errors?: Array<{ type: string; error: string }>;
  verified?: boolean;
}

function truncateHash(h: string | null | undefined): string {
  if (!h) return '';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export default function PreflightPanel({ runId }: { runId: number | null }) {
  const [status, setStatus] = useState<PreflightStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!runId) {
      setError('No training run selected.');
      return;
    }
    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/training/preflight/${runId}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      }
      // SSE stream of PreflightStatus snapshots — wire when training
      // pipeline ships. For now the endpoint returns 501.
      const reader = res.body?.getReader();
      if (!reader) {
        setRunning(false);
        return;
      }
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const ev of events) {
          const line = ev.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            setStatus(JSON.parse(line.slice(6)) as PreflightStatus);
          } catch {
            // swallow malformed frames
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // Idle — nothing has run yet.
  if (!status && !running) {
    return (
      <div className="rounded-lg border border-scruple-border-color bg-scruple-bg-secondary p-4">
        <h4 className="text-2xs font-semibold uppercase tracking-widest text-scruple-text-secondary">
          Pre-Flight Checklist
        </h4>
        <p className="mt-1 text-2xs text-scruple-text-deep-muted">
          Pre-flight will verify all input files (base model, dataset, optional checkpoint) before training starts.
        </p>
        {error && (
          <pre className="mt-2 overflow-x-auto rounded border border-scruple-danger/30 bg-scruple-danger/5 p-2 text-3xs text-scruple-danger">
            {error}
          </pre>
        )}
        <button
          type="button"
          onClick={start}
          disabled={!runId}
          className="mt-3 rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/15 px-3 py-1.5 text-xs text-scruple-text-primary hover:bg-scruple-accent-primary/30 disabled:opacity-40"
        >
          Start Pre-Flight
        </button>
      </div>
    );
  }

  // Running / complete — render checklist
  return (
    <div className="rounded-lg border border-scruple-border-color bg-scruple-bg-secondary p-4">
      <h4 className="text-2xs font-semibold uppercase tracking-widest text-scruple-text-secondary">
        Pre-Flight Checklist
      </h4>
      <div className="mt-3 space-y-2">
        {status?.baseModel && <PreflightItemRow label="Base Model" item={status.baseModel} />}
        {status?.dataset && <PreflightItemRow label="Dataset" item={status.dataset} />}
        {status?.checkpoint && <PreflightItemRow label="Checkpoint" item={status.checkpoint} />}
      </div>
      {status?.errors && status.errors.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-2 text-3xs">
          {status.errors.map((e, i) => (
            <li key={i} className="text-scruple-danger">
              <strong>{e.type}:</strong> {e.error}
            </li>
          ))}
        </ul>
      )}
      {status?.verified !== undefined && (
        <div
          className={
            'mt-3 rounded-md border px-3 py-2 text-xs ' +
            (status.verified
              ? 'border-scruple-success/40 bg-scruple-success/5 text-scruple-success'
              : 'border-scruple-warn/40 bg-scruple-warn/5 text-scruple-warn')
          }
        >
          {status.verified ? '✓ All inputs verified' : '! Verification incomplete'}
        </div>
      )}
    </div>
  );
}

function PreflightItemRow({ label, item }: { label: string; item: PreflightItem }) {
  if (item.status === 'pending') {
    return (
      <div className="text-2xs text-scruple-text-deep-muted">
        <span className="font-mono">[ ]</span> {label} <span className="text-3xs">(waiting)</span>
      </div>
    );
  }
  if (item.status === 'hashing') {
    const percent = Math.round((item.progress ?? 0) * 100);
    const eta = item.etaSeconds ? ` (${Math.round(item.etaSeconds)}s remaining)` : '';
    return (
      <div className="text-2xs">
        <div className="flex items-center justify-between">
          <span className="text-scruple-text-primary">
            {label} <span className="text-scruple-text-deep-muted">{percent}%{eta}</span>
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-scruple-border-color">
          <div
            className="h-full bg-scruple-accent-primary transition-all duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }
  // complete
  const hash = item.hash || item.merkleRoot;
  return (
    <div className="flex items-center gap-2 text-2xs text-scruple-text-primary">
      <span className="font-mono text-scruple-success">[OK]</span>
      <span>{label}</span>
      {item.cached && (
        <span className="rounded bg-scruple-text-deep-muted/15 px-1 text-3xs uppercase tracking-wider2 text-scruple-text-deep-muted">
          cached
        </span>
      )}
      {hash && (
        <code className="ml-auto font-mono text-scruple-text-secondary">
          {truncateHash(hash)}
        </code>
      )}
    </div>
  );
}
