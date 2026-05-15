'use client';

// Browse Civitai → Install. Search civitai.com from inside Scruple.
// Each result has thumbnail + name + creator + downloads + Install button.

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';

interface BrowseItem {
  id: number;
  name: string;
  type: string;
  creator: string;
  downloads: number;
  baseModel: string | null;
  thumbnail: string | null;
  pageUrl: string;
  primaryFile: string | null;
  sizeKB: number | null;
}

const TYPES = ['', 'LORA', 'Checkpoint', 'VAE', 'Controlnet', 'TextualInversion', 'Upscaler'] as const;
const BASE_MODELS = ['', 'Flux.1 D', 'Flux.1 S', 'SDXL 1.0', 'SD 1.5', 'SD 3', 'Pony'] as const;
const SORTS = ['Most Downloaded', 'Highest Rated', 'Newest'] as const;

function formatSize(kb: number | null): string {
  if (!kb) return '?';
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
}

export default function BrowseCivitaiTab({
  inflightUrls,
  installedFilenames,
  onInstall,
}: {
  inflightUrls: Set<string>;
  installedFilenames: Set<string>;
  onInstall: (pageUrl: string, trackingId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('LORA');
  const [baseModel, setBaseModel] = useState<(typeof BASE_MODELS)[number]>('Flux.1 D');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('Most Downloaded');
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (type) sp.set('types', type);
      if (baseModel) sp.set('baseModel', baseModel);
      sp.set('sort', sort);
      sp.set('limit', '24');
      const res = await fetch(`/api/models/browse/civitai?${sp.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setItems(data.items as BrowseItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-search on mount + when filters change (debounce 400ms on q)
  useEffect(() => {
    const t = setTimeout(() => { void search(); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type, baseModel, sort]);

  return (
    <div className="space-y-3 text-xs">
      {/* Search bar */}
      <div className="grid grid-cols-12 gap-2">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search Civitai…"
          className="col-span-5 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
        />
        <select
          value={type}
          onChange={e => setType(e.target.value as (typeof TYPES)[number])}
          className="col-span-3 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs"
        >
          {TYPES.map(t => (<option key={t || 'any'} value={t}>{t || 'any type'}</option>))}
        </select>
        <select
          value={baseModel}
          onChange={e => setBaseModel(e.target.value as (typeof BASE_MODELS)[number])}
          className="col-span-2 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs"
        >
          {BASE_MODELS.map(b => (<option key={b || 'any'} value={b}>{b || 'any base'}</option>))}
        </select>
        <select
          value={sort}
          onChange={e => setSort(e.target.value as (typeof SORTS)[number])}
          className="col-span-2 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs"
        >
          {SORTS.map(s => (<option key={s} value={s}>{s}</option>))}
        </select>
      </div>

      {loading && <p className="text-scruple-muted">Searching…</p>}
      {error && (
        <p className="rounded border border-scruple-danger/40 bg-scruple-danger/5 px-2 py-1 text-scruple-danger">
          {error}{error.includes('401') ? ' — add a Civitai token in Provider Tokens above.' : ''}
        </p>
      )}

      {/* Results grid */}
      {!loading && !error && items.length === 0 && (
        <p className="text-scruple-muted">No results. Try adjusting filters.</p>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {items.map(item => {
            const inflight = item.primaryFile ? inflightUrls.has(item.pageUrl) : false;
            const installed = item.primaryFile ? installedFilenames.has(item.primaryFile) : false;
            return (
              <div
                key={item.id}
                className="flex gap-3 rounded-md border border-scruple-border bg-scruple-bg p-2"
              >
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded bg-scruple-bg-tertiary">
                  {item.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-2xs text-scruple-muted">no preview</div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div>
                    <div className="truncate text-[11px] font-semibold text-scruple-text">{item.name}</div>
                    <div className="mt-0.5 truncate text-2xs text-scruple-muted">
                      {item.type}
                      {item.baseModel ? ` · ${item.baseModel}` : ''}
                      {` · @${item.creator}`}
                    </div>
                    <div className="mt-0.5 text-2xs text-scruple-muted">
                      {item.downloads.toLocaleString()} downloads
                      {item.sizeKB ? ` · ${formatSize(item.sizeKB)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {installed ? (
                      <span className="rounded border border-scruple-success/40 bg-scruple-success/10 px-1.5 py-0.5 text-[10px] text-scruple-success">
                        installed
                      </span>
                    ) : inflight ? (
                      <span className="rounded border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-1.5 py-0.5 text-[10px] text-scruple-accent-primary">
                        fetching…
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          if (!item.primaryFile) {
                            addToast({ tone: 'error', title: 'No installable file in this model' });
                            return;
                          }
                          onInstall(item.pageUrl, item.pageUrl);
                        }}
                        className="rounded border border-scruple-accent-primary bg-scruple-accent-primary/15 px-2 py-0.5 text-[10px] text-scruple-text hover:bg-scruple-accent-primary/30"
                      >
                        Install
                      </button>
                    )}
                    <a
                      href={item.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-scruple-muted hover:text-scruple-accent-primary"
                    >
                      ↗
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
