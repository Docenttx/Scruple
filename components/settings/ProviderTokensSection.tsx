'use client';

// Settings → Provider Tokens.
//
// Two password-style inputs for the external-provider tokens used by
// the Model Library:
//   - HF token (HuggingFace)        — used for gated HF repos
//   - Civitai token                 — required for any Civitai download
//
// Token VALUES never round-trip to the browser. Server returns only
// {set: boolean}; the UI shows "set" / "not set". Submitting replaces.
// Empty submit clears.

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';

interface TokenStatus { set: boolean }
interface TokensSnapshot { hf: TokenStatus; civitai: TokenStatus; }

export default function ProviderTokensSection() {
  const [snap, setSnap] = useState<TokensSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [hfDraft, setHfDraft] = useState('');
  const [civitaiDraft, setCivitaiDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch('/api/settings/provider-tokens', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setSnap(data as TokensSnapshot);
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not load token status',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function save(provider: 'hf' | 'civitai', token: string) {
    setBusy(provider);
    try {
      const res = await fetch('/api/settings/provider-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      addToast({
        tone: 'success',
        title: token ? `${provider} token saved` : `${provider} token cleared`,
      });
      if (provider === 'hf') setHfDraft('');
      else setCivitaiDraft('');
      await refresh();
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not save',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="provider-tokens" className="mt-8 scroll-mt-12">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Provider Tokens</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Personal tokens for the Model Library. HF is optional (only needed
        for gated repos). Civitai is required to fetch any Civitai LoRA or
        checkpoint.
      </p>

      <div className="mt-3 space-y-3">
        <TokenRow
          label="Hugging Face token"
          hint="Settings → Access Tokens at huggingface.co. Required only for gated repos."
          status={snap?.hf}
          loading={loading}
          busy={busy === 'hf'}
          draft={hfDraft}
          setDraft={setHfDraft}
          onSave={() => save('hf', hfDraft)}
          onClear={() => save('hf', '')}
        />
        <TokenRow
          label="Civitai API token"
          hint="User → Account → API Keys at civitai.com. Required for any Civitai download."
          status={snap?.civitai}
          loading={loading}
          busy={busy === 'civitai'}
          draft={civitaiDraft}
          setDraft={setCivitaiDraft}
          onSave={() => save('civitai', civitaiDraft)}
          onClear={() => save('civitai', '')}
        />
      </div>
    </section>
  );
}

function TokenRow({
  label, hint, status, loading, busy, draft, setDraft, onSave, onClear,
}: {
  label: string;
  hint: string;
  status?: TokenStatus;
  loading: boolean;
  busy: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-md border border-scruple-border bg-scruple-surface p-3">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-semibold text-scruple-text">{label}</label>
        {loading ? (
          <span className="text-[10px] text-scruple-muted">…</span>
        ) : status?.set ? (
          <span className="rounded border border-scruple-success/40 bg-scruple-success/10 px-1.5 py-0.5 text-[10px] text-scruple-success">
            set
          </span>
        ) : (
          <span className="rounded border border-scruple-border px-1.5 py-0.5 text-[10px] text-scruple-muted">
            not set
          </span>
        )}
      </div>
      <p className="mt-1 text-[10px] text-scruple-muted">{hint}</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={status?.set ? '••• already set — paste new to replace' : 'Paste token here'}
          className="flex-1 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
        />
        <button
          type="button"
          disabled={!draft || busy}
          onClick={onSave}
          className="rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/15 px-2.5 py-1 text-[11px] text-scruple-text hover:bg-scruple-accent-primary/30 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {status?.set && (
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className="rounded-md border border-scruple-border bg-scruple-bg px-2.5 py-1 text-[11px] text-scruple-muted hover:border-scruple-danger hover:text-scruple-danger disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
