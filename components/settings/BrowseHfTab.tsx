'use client';

// Browse Hugging Face → Install. Search HF repos, expand to file list,
// install a chosen .safetensors / .ckpt / etc.

import { useEffect, useState } from 'react';

interface BrowseHfItem {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag: string | null;
  libraryName: string | null;
  tags: string[];
  pageUrl: string;
}

interface HfFile {
  path: string;
  size: number;
  downloadUrl: string;
  suggestedSubpath: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PIPELINES = [
  { value: '', label: 'any task' },
  { value: 'text-to-image', label: 'text-to-image' },
  { value: 'image-to-image', label: 'image-to-image' },
  { value: 'text-to-video', label: 'text-to-video' },
];

export default function BrowseHfTab({
  inflightUrls,
  installedFilenames,
  onInstall,
}: {
  inflightUrls: Set<string>;
  installedFilenames: Set<string>;
  onInstall: (sourceUrl: string, targetSubpath: string, trackingId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [pipeline, setPipeline] = useState('');
  const [items, setItems] = useState<BrowseHfItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByRepo, setFilesByRepo] = useState<Record<string, HfFile[] | 'loading' | 'error'>>({});

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (pipeline) sp.set('pipeline_tag', pipeline);
      sp.set('sort', 'downloads');
      sp.set('limit', '24');
      const res = await fetch(`/api/models/browse/hf?${sp.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setItems(data.items as BrowseHfItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => { void search(); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pipeline]);

  async function toggleFiles(repo: string) {
    if (expanded === repo) {
      setExpanded(null);
      return;
    }
    setExpanded(repo);
    if (filesByRepo[repo]) return; // cached
    setFilesByRepo(prev => ({ ...prev, [repo]: 'loading' }));
    try {
      const res = await fetch(`/api/models/browse/hf-files?repo=${encodeURIComponent(repo)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setFilesByRepo(prev => ({ ...prev, [repo]: data.files as HfFile[] }));
    } catch {
      setFilesByRepo(prev => ({ ...prev, [repo]: 'error' }));
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-12 gap-2">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search Hugging Face…"
          className="col-span-9 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
        />
        <select
          value={pipeline}
          onChange={e => setPipeline(e.target.value)}
          className="col-span-3 rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs"
        >
          {PIPELINES.map(p => (<option key={p.value || 'any'} value={p.value}>{p.label}</option>))}
        </select>
      </div>

      {loading && <p className="text-scruple-muted">Searching…</p>}
      {error && (
        <p className="rounded border border-scruple-danger/40 bg-scruple-danger/5 px-2 py-1 text-scruple-danger">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="text-scruple-muted">No results.</p>
      )}

      <ul className="space-y-1.5">
        {items.map(item => (
          <li key={item.id} className="rounded-md border border-scruple-border bg-scruple-bg">
            <button
              type="button"
              onClick={() => toggleFiles(item.id)}
              className="flex w-full items-start justify-between gap-2 px-2 py-1.5 text-left hover:bg-scruple-bg-hover"
            >
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold text-scruple-text">{item.id}</div>
                <div className="mt-0.5 text-2xs text-scruple-muted">
                  {item.pipelineTag ?? '—'}
                  {item.libraryName ? ` · ${item.libraryName}` : ''}
                  {` · ↓${item.downloads.toLocaleString()}  ♥${item.likes}`}
                </div>
              </div>
              <span className="text-[10px] text-scruple-muted">{expanded === item.id ? '▲' : '▼'}</span>
            </button>

            {expanded === item.id && (
              <div className="border-t border-scruple-border bg-scruple-bg-tertiary px-2 py-1.5">
                {filesByRepo[item.id] === 'loading' && (
                  <p className="text-2xs text-scruple-muted">Loading file list…</p>
                )}
                {filesByRepo[item.id] === 'error' && (
                  <p className="text-2xs text-scruple-danger">
                    Could not load repo files.{' '}
                    <a href={item.pageUrl} target="_blank" rel="noreferrer" className="underline">View on HF ↗</a>
                  </p>
                )}
                {Array.isArray(filesByRepo[item.id]) && (
                  ((filesByRepo[item.id] as HfFile[]).length === 0 ? (
                    <p className="text-2xs text-scruple-muted">No .safetensors / .ckpt / .pt files in this repo.</p>
                  ) : (
                    <ul className="space-y-1">
                      {(filesByRepo[item.id] as HfFile[]).map(f => {
                        const filename = f.path.split('/').pop() ?? f.path;
                        const installed = installedFilenames.has(filename);
                        const inflight = inflightUrls.has(f.downloadUrl);
                        return (
                          <li
                            key={f.path}
                            className="flex items-center justify-between gap-2 rounded border border-scruple-border-color bg-scruple-bg px-2 py-1"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[10px] text-scruple-text">{f.path}</div>
                              <div className="text-2xs text-scruple-muted">
                                {formatSize(f.size)} → <code>{f.suggestedSubpath}</code>
                              </div>
                            </div>
                            {installed ? (
                              <span className="rounded border border-scruple-success/40 bg-scruple-success/10 px-1.5 py-0.5 text-[9px] text-scruple-success">
                                installed
                              </span>
                            ) : inflight ? (
                              <span className="rounded border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-1.5 py-0.5 text-[9px] text-scruple-accent-primary">
                                fetching…
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onInstall(f.downloadUrl, f.suggestedSubpath, f.downloadUrl)}
                                className="rounded border border-scruple-accent-primary bg-scruple-accent-primary/15 px-1.5 py-0.5 text-[10px] text-scruple-text hover:bg-scruple-accent-primary/30"
                              >
                                Install
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ))
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
