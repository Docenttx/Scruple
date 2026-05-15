'use client';

// Settings → Model Library.
//
// Three tabs:
//   - Installed: what's on the Modal scruple-models Volume right now
//   - Catalog:   one-click installs from CATALOG
//   - Add URL:   paste an arbitrary HF/Civitai/direct URL + target subpath
//
// All paths fire /api/models/fetch which spawns a Modal admin_fetch.
// We poll /api/models/list every 4s while at least one job is pending.

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';
import { CATALOG, type CatalogModel, type ModelCategory } from '@/lib/modelLibrary/catalog';

interface VolumeFile { path: string; size: number; mtime: number; }
interface VolumeListing { by_category: Record<string, VolumeFile[]>; }

const TAB_LABELS = { installed: 'Installed', catalog: 'Catalog', custom: 'Add URL' } as const;
type Tab = keyof typeof TAB_LABELS;

const CATEGORY_LABEL: Record<string, string> = {
  checkpoints:      'Checkpoints',
  diffusion_models: 'Diffusion models (Flux)',
  text_encoders:    'Text encoders',
  vae:              'VAE',
  loras:            'LoRAs',
  controlnet:       'ControlNet',
  upscale_models:   'Upscalers',
  embeddings:       'Embeddings',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function ModelLibrarySection() {
  const [tab, setTab] = useState<Tab>('installed');
  const [listing, setListing] = useState<VolumeListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inflightIds, setInflightIds] = useState<Set<string>>(new Set());

  async function refresh() {
    try {
      const res = await fetch('/api/models/list', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setListing({ by_category: data.by_category ?? {} });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Poll while any fetch is in flight.
  useEffect(() => {
    if (inflightIds.size === 0) return;
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [inflightIds.size]);

  async function startFetch(payload: object, trackingId: string) {
    setInflightIds(prev => new Set(prev).add(trackingId));
    try {
      const res = await fetch('/api/models/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      addToast({
        tone: 'success',
        title: 'Fetch started',
        detail: `Downloading to ${data.target_subpath}. This will appear in the Installed list when done.`,
      });
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not start fetch',
        detail: e instanceof Error ? e.message : String(e),
      });
      setInflightIds(prev => {
        const next = new Set(prev);
        next.delete(trackingId);
        return next;
      });
    }
  }

  // When a file appears in the listing under an inflight target, drop
  // it from the inflight set so polling can stop.
  useEffect(() => {
    if (!listing || inflightIds.size === 0) return;
    const allPaths = new Set<string>();
    for (const files of Object.values(listing.by_category)) {
      for (const f of files) allPaths.add(f.path);
    }
    const stillInflight = new Set<string>();
    for (const id of inflightIds) {
      if (!allPaths.has(id)) stillInflight.add(id);
    }
    if (stillInflight.size !== inflightIds.size) {
      setInflightIds(stillInflight);
    }
  }, [listing, inflightIds]);

  async function detach(target_subpath: string) {
    if (!confirm(`Remove ${target_subpath} from the Modal Volume? This frees storage but breaks any workflow that references it.`)) return;
    try {
      const res = await fetch('/api/models/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSubpath: target_subpath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      addToast({ tone: 'success', title: 'Removed', detail: target_subpath });
      await refresh();
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not remove',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <section id="model-library" className="mt-8 scroll-mt-12">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Model Library</h2>
          <p className="mt-1 text-xs text-scruple-muted">
            Shared model cache on Modal. Files live in <code>scruple-models</code> Volume,
            mounted into the canvas + the runner container.
          </p>
        </div>
        {inflightIds.size > 0 && (
          <span className="rounded-full border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-2 py-0.5 text-[10px] text-scruple-accent-primary">
            {inflightIds.size} fetching…
          </span>
        )}
      </div>

      <div className="mt-3 flex gap-1 border-b border-scruple-border">
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              'rounded-t-md px-3 py-1.5 text-xs transition ' +
              (tab === t
                ? 'border-x border-t border-scruple-border bg-scruple-surface text-scruple-text'
                : 'text-scruple-muted hover:text-scruple-text')
            }
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="rounded-b-md border-x border-b border-scruple-border bg-scruple-surface p-3">
        {tab === 'installed' && (
          <InstalledTab
            listing={listing}
            loading={loading}
            error={error}
            inflightIds={inflightIds}
            onDelete={detach}
          />
        )}
        {tab === 'catalog' && (
          <CatalogTab
            listing={listing}
            inflightIds={inflightIds}
            onInstall={item => startFetch({ catalogId: item.id }, item.target_subpath)}
          />
        )}
        {tab === 'custom' && (
          <CustomUrlTab
            onSubmit={(payload, target) => startFetch(payload, target)}
          />
        )}
      </div>
    </section>
  );
}

function InstalledTab({
  listing, loading, error, inflightIds, onDelete,
}: {
  listing: VolumeListing | null;
  loading: boolean;
  error: string | null;
  inflightIds: Set<string>;
  onDelete: (path: string) => void;
}) {
  if (loading) return <p className="text-xs text-scruple-muted">Loading…</p>;
  if (error) return <p className="text-xs text-scruple-danger">Error: {error}</p>;
  if (!listing || Object.keys(listing.by_category).length === 0) {
    return <p className="text-xs text-scruple-muted">No models on the Volume yet. Use Catalog or Add URL to install one.</p>;
  }

  return (
    <div className="space-y-4 text-xs">
      {Object.entries(listing.by_category).map(([cat, files]) => (
        <div key={cat}>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-scruple-muted">
            {CATEGORY_LABEL[cat] ?? cat}  ·  {files.length}
          </div>
          <ul className="space-y-1">
            {files.map(f => (
              <li
                key={f.path}
                className="flex items-center justify-between rounded border border-scruple-border bg-scruple-bg px-2 py-1"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-scruple-text">{f.path.split('/').slice(1).join('/')}</div>
                  <div className="text-[10px] text-scruple-muted">{formatSize(f.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(f.path)}
                  className="rounded border border-scruple-border px-1.5 py-0.5 text-[10px] text-scruple-muted hover:border-scruple-danger hover:text-scruple-danger"
                  title="Remove from Volume"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {inflightIds.size > 0 && (
        <ul className="mt-2 space-y-1">
          {Array.from(inflightIds).map(id => (
            <li
              key={id}
              className="flex items-center justify-between rounded border border-scruple-accent-primary/30 bg-scruple-accent-primary/5 px-2 py-1 text-[11px]"
            >
              <span className="font-mono text-scruple-accent-primary">{id}</span>
              <span className="text-[10px] text-scruple-accent-primary">downloading…</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogTab({
  listing, inflightIds, onInstall,
}: {
  listing: VolumeListing | null;
  inflightIds: Set<string>;
  onInstall: (m: CatalogModel) => void;
}) {
  // Group catalog entries by category for display
  const grouped: Record<ModelCategory, CatalogModel[]> = {} as never;
  for (const m of CATALOG) {
    (grouped[m.category] ||= []).push(m);
  }
  const installedPaths = new Set<string>();
  if (listing) {
    for (const files of Object.values(listing.by_category)) {
      for (const f of files) installedPaths.add(f.path);
    }
  }

  return (
    <div className="space-y-4 text-xs">
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat}>
          <div className="mb-2 text-[10px] uppercase tracking-widest text-scruple-muted">
            {CATEGORY_LABEL[cat] ?? cat}
          </div>
          <ul className="space-y-1.5">
            {items.map(m => {
              const installed = installedPaths.has(m.target_subpath);
              const inflight = inflightIds.has(m.target_subpath);
              return (
                <li
                  key={m.id}
                  className="rounded-md border border-scruple-border bg-scruple-bg p-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-scruple-text">{m.name}</div>
                      <div className="mt-0.5 text-[10px] text-scruple-muted">{m.description}</div>
                      <div className="mt-1 text-[10px] text-scruple-muted">
                        <span className="font-mono">{m.target_subpath}</span>
                        <span> · {(m.size_mb >= 1000 ? `${(m.size_mb / 1024).toFixed(1)} GB` : `${m.size_mb} MB`)}</span>
                        {m.license && <span> · {m.license}</span>}
                      </div>
                    </div>
                    {installed ? (
                      <span className="rounded border border-scruple-success/40 bg-scruple-success/10 px-2 py-0.5 text-[10px] text-scruple-success">
                        installed
                      </span>
                    ) : inflight ? (
                      <span className="rounded border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-2 py-0.5 text-[10px] text-scruple-accent-primary">
                        fetching…
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onInstall(m)}
                        className="rounded border border-scruple-accent-primary bg-scruple-accent-primary/15 px-2 py-0.5 text-[10px] text-scruple-text hover:bg-scruple-accent-primary/30"
                      >
                        Install
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CustomUrlTab({
  onSubmit,
}: {
  onSubmit: (payload: object, target: string) => void;
}) {
  const [source, setSource] = useState<'hf' | 'civitai'>('hf');
  const [url, setUrl] = useState('');
  const [subpath, setSubpath] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (source === 'hf') {
      if (!url || !subpath) return;
      onSubmit({ sourceUrl: url, targetSubpath: subpath }, subpath);
    } else {
      if (!url) return;
      onSubmit({ civitaiUrl: url, targetSubpath: subpath || undefined }, subpath || `civitai:${url}`);
    }
    setUrl('');
    setSubpath('');
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setSource('hf')}
          className={
            'rounded px-2.5 py-1 text-[11px] transition ' +
            (source === 'hf'
              ? 'border border-scruple-accent-primary bg-scruple-accent-primary/15 text-scruple-text'
              : 'border border-scruple-border bg-scruple-bg text-scruple-muted hover:text-scruple-text')
          }
        >
          Hugging Face / direct URL
        </button>
        <button
          type="button"
          onClick={() => setSource('civitai')}
          className={
            'rounded px-2.5 py-1 text-[11px] transition ' +
            (source === 'civitai'
              ? 'border border-scruple-accent-primary bg-scruple-accent-primary/15 text-scruple-text'
              : 'border border-scruple-border bg-scruple-bg text-scruple-muted hover:text-scruple-text')
          }
        >
          Civitai
        </button>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
          {source === 'civitai' ? 'Civitai model page URL' : 'Source URL'}
        </label>
        <input
          type="url"
          required
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder={
            source === 'civitai'
              ? 'https://civitai.com/models/773439/body-flux-fix'
              : 'https://huggingface.co/<repo>/resolve/<branch>/<file>.safetensors'
          }
          className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
          Target subpath {source === 'civitai' && <span>(optional — autodetected from Civitai)</span>}
        </label>
        <input
          type="text"
          required={source === 'hf'}
          value={subpath}
          onChange={e => setSubpath(e.target.value)}
          placeholder="loras/my-cool-lora.safetensors"
          className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 font-mono text-[11px] focus:border-scruple-accent focus:outline-none"
        />
        <p className="mt-1 text-[10px] text-scruple-muted">
          Relative to <code>/opt/ComfyUI/models/</code>. First segment must be one of
          <code className="ml-1">checkpoints | diffusion_models | text_encoders | vae | loras | controlnet | upscale_models | embeddings</code>.
        </p>
      </div>

      <button
        type="submit"
        disabled={!url}
        className="rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/15 px-3 py-1.5 text-xs hover:bg-scruple-accent-primary/30 disabled:opacity-50"
      >
        Start fetch
      </button>

      {source === 'civitai' && (
        <p className="text-[10px] text-scruple-warn">
          Civitai requires an API token. Add one above (Provider Tokens) before submitting.
        </p>
      )}
    </form>
  );
}
