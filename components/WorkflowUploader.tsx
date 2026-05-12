'use client';

// Pivot polish · Workflow JSON uploader.
//
// Lets a power user drop a workflow_api_json file (the export from
// ComfyUI's "Save (API Format)" button, or one captured via the canvas)
// and submit it directly to /api/generate. Pre-validates via
// /api/workflow/validate so the user sees structural problems +
// missing-model warnings up front instead of a generic 500.
//
// Mounted alongside the prompt-mode GeneratePanel as a secondary
// affordance for advanced users. Most users will queue from the canvas.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addToast } from '@/lib/toast';

interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  nodeId?: string;
  nodeClass?: string;
  inputName?: string;
  message: string;
}

interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  summary: {
    nodeCount: number;
    referencedModels: string[];
    errorCount: number;
    warningCount: number;
  };
}

export default function WorkflowUploader({
  projectId,
  disabled,
}: {
  projectId: number;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [filename, setFilename] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Reading file…');
    setValidation(null);
    setParsed(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (typeof json !== 'object' || json === null) {
        throw new Error('File is not a JSON object');
      }
      setFilename(file.name);
      setParsed(json as Record<string, unknown>);
      // Validate
      setStatus('Validating…');
      const res = await fetch('/api/workflow/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowApiJson: json, checkModels: true }),
      });
      const result = (await res.json()) as ValidationResult;
      setValidation(result);
      setStatus(null);
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not parse workflow file',
        detail: e instanceof Error ? e.message : String(e),
      });
      setStatus(null);
    }
  }

  function submit() {
    if (!parsed || !validation?.ok) return;
    setStatus('Dispatching to ComfyDeploy…');
    startTransition(async () => {
      const started = Date.now();
      const tickId = setInterval(() => {
        setStatus(`Running… ${Math.round((Date.now() - started) / 1000)}s`);
      }, 1000);
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            workflowApiJson: parsed,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || data.error || `HTTP ${res.status}`);
        }
        setStatus(`✓ Iteration #${data.runSequence} captured`);
        router.refresh();
      } catch (e) {
        addToast({
          tone: 'error',
          title: 'Workflow run failed',
          detail: e instanceof Error ? e.message : String(e),
        });
        setStatus(null);
      } finally {
        clearInterval(tickId);
      }
    });
  }

  return (
    <section className="rounded-lg border border-scruple-border-color bg-scruple-bg-secondary p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-wider2 text-scruple-text-secondary">
          Workflow JSON
        </h3>
        <span className="text-3xs text-scruple-text-deep-muted">
          for ComfyUI &quot;Save (API Format)&quot; exports
        </span>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-scruple-border-color bg-scruple-bg-primary px-3 py-1.5 text-xs hover:border-scruple-accent-primary">
          📁 Pick file
          <input
            type="file"
            accept=".json,application/json"
            onChange={onPickFile}
            disabled={disabled || pending}
            className="hidden"
          />
        </label>
        {filename && (
          <span className="font-mono text-xs text-scruple-text-secondary">
            {filename}
          </span>
        )}
      </div>

      {validation && (
        <div
          className={
            'mt-3 rounded-md border p-3 text-xs ' +
            (validation.ok
              ? 'border-scruple-success/40 bg-scruple-success/5'
              : 'border-scruple-danger/40 bg-scruple-danger/5')
          }
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span
              className={
                'font-semibold ' +
                (validation.ok ? 'text-scruple-success' : 'text-scruple-danger')
              }
            >
              {validation.ok ? '✓ Ready to run' : '✕ Cannot run'}
            </span>
            <span className="text-3xs text-scruple-text-deep-muted">
              {validation.summary.nodeCount} nodes ·{' '}
              {validation.summary.referencedModels.length} model refs ·{' '}
              {validation.summary.errorCount}E / {validation.summary.warningCount}W
            </span>
          </div>
          {validation.issues.length > 0 && (
            <ul className="space-y-1 text-3xs">
              {validation.issues.map((i, idx) => (
                <li
                  key={idx}
                  className={
                    i.severity === 'error'
                      ? 'text-scruple-danger'
                      : i.severity === 'warning'
                        ? 'text-scruple-warn'
                        : 'text-scruple-text-secondary'
                  }
                >
                  [{i.severity.toUpperCase()}]
                  {i.nodeId && ` node ${i.nodeId}`}
                  {i.nodeClass && ` (${i.nodeClass})`}
                  {i.inputName && ` · ${i.inputName}`}: {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={!validation?.ok || pending || disabled}
          onClick={submit}
          className="rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/15 px-3 py-1.5 text-xs text-scruple-text-primary hover:bg-scruple-accent-primary/30 disabled:cursor-not-allowed disabled:border-scruple-border-color disabled:bg-transparent disabled:opacity-50"
        >
          {pending ? 'Running…' : '▸ Run workflow'}
        </button>
        {status && <span className="text-xs text-scruple-text-secondary">{status}</span>}
      </div>
    </section>
  );
}
