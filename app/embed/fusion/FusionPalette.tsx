'use client';

// Scruple Studio for Autodesk Fusion — the vertical fork of the ComfyUI
// Studio, styled to match but scoped to CAD projects and integrated with
// the Fusion Python bridge.
//
// Design principles (from the user session that established this fork):
//   1. Every Fusion design ↔ its own Scruple project. Project name = Fusion
//      file name. Auto-created on first save, via the Python side.
//   2. Palette is Studio. Sidebar (project list, CAD-only) + workspace.
//      No ComfyUI canvas. No "New Project" button (projects are created
//      by saving in Fusion). No user-visible "API key" field.
//   3. Auth is silent. Palette bounces through /api/auth/keys/fusion-mint
//      on first load to mint a key for the OAuth-authed user, stashes it,
//      hands it to Python via the bridge. User just sees "Sign in with
//      Google" once, ever.
//   4. Per-user isolation is enforced server-side (user_id scoping on
//      every query). Client-side, each Fusion install has its own Qt
//      WebEngine storage. No cross-user leak possible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ProjectStatus =
  | 'unlocked'
  | 'checkpointed'
  | 'local_locked'
  | 'chain_locked'
  | 'persistent_locked'
  | 'permanent_locked';

interface Project {
  id: number;
  name: string;
  type: string;
  status: ProjectStatus;
  iteration_count: number;
  witnessed_count: number;
  scr_id: string | null;
  pre_scr_id: string | null;
  merkle_root: string | null;
  created_at: string;
  updated_at: string;
}

interface Iteration {
  id: number;
  project_id: number;
  run_sequence: number;
  leaf_hash: string;
  timestamp: string;
  witnessed: number;
}

interface ProjectDetail {
  project: Project;
  iterations: Iteration[];
  iterationCount: number;
}

type ConnectionState = 'connecting' | 'healthy' | 'retrying' | 'disconnected' | 'unauthorized';

const POLL_MS = 15_000;

// -------------------------------------------------------------- bridge

interface FusionBridge {
  send: (action: string, payload: unknown) => void;
  onMessage: (handler: (action: string, payload: unknown) => void) => void;
}

function getFusionBridge(): FusionBridge | null {
  if (typeof window === 'undefined') return null;
  const adsk = (window as unknown as { adsk?: { fusionSendData?: (a: string, j: string) => void } }).adsk;
  if (!adsk?.fusionSendData) return null;
  return {
    send: (action, payload) => adsk.fusionSendData!(action, JSON.stringify(payload)),
    onMessage: (handler) => {
      (window as unknown as { fusionJavaScriptHandler?: (a: string, j: string) => void })
        .fusionJavaScriptHandler = (a, j) => {
          try { handler(a, JSON.parse(j)); }
          catch { handler(a, j); }
        };
    },
  };
}

// --------------------------------------------------------------- auth

const TOKEN_KEY = 'scruple.fusion.api_key';

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('token');
  if (fromQuery) {
    try { localStorage.setItem(TOKEN_KEY, fromQuery); } catch {}
    // Clean the token out of the URL so it doesn't stick around visibly.
    try {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('token');
      window.history.replaceState({}, '', cleanUrl.toString());
    } catch {}
    return fromQuery;
  }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

async function fetchWithAuth(url: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  return fetch(url, { ...init, headers, credentials: 'omit' });
}

// --------------------------------------------------------------- helpers

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusLabel(s: ProjectStatus): string {
  return {
    unlocked: 'Tracking',
    checkpointed: 'Checkpoint',
    local_locked: 'Locked',
    chain_locked: 'Anchored',
    persistent_locked: 'Persistent',
    permanent_locked: 'Permanent',
  }[s] || s;
}

function statusColor(s: ProjectStatus): string {
  return {
    unlocked: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    checkpointed: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    local_locked: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
    chain_locked: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
    persistent_locked: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
    permanent_locked: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
  }[s] || 'bg-neutral-500/20 text-neutral-300 border-neutral-500/40';
}

// --------------------------------------------------------------- component

export default function FusionPalette() {
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState<'witnessing' | 'checkpointing' | 'locking' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [designName, setDesignName] = useState<string | null>(null);
  const bridgeRef = useRef<FusionBridge | null>(null);
  const refreshRef = useRef<{ projects: () => Promise<void>; detail: () => Promise<void> } | null>(null);

  // Mount: discover token + bridge, register Python→JS handler.
  useEffect(() => {
    bridgeRef.current = getFusionBridge();
    setToken(readToken());

    if (bridgeRef.current) {
      bridgeRef.current.onMessage((action, payload) => {
        const p = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        if (action === 'design_state') {
          if (typeof p.name === 'string') setDesignName(p.name);
          if (typeof p.project_id === 'number') setSelectedId(p.project_id);
        } else if (action === 'witness_started') { setBusy('witnessing'); setErrorMsg(null); }
        else if (action === 'witness_done') {
          setBusy(null); setErrorMsg(null);
          void refreshRef.current?.projects();
          void refreshRef.current?.detail();
        }
        else if (action === 'witness_error') { setBusy(null); setErrorMsg(`Witness failed: ${p.message ?? 'unknown'}`); }
        else if (action === 'checkpoint_started') { setBusy('checkpointing'); setErrorMsg(null); }
        else if (action === 'checkpoint_done') {
          setBusy(null); setErrorMsg(null);
          void refreshRef.current?.projects();
          void refreshRef.current?.detail();
        }
        else if (action === 'checkpoint_error') { setBusy(null); setErrorMsg(`Checkpoint failed: ${p.message ?? 'unknown'}`); }
        else if (action === 'lock_started') { setBusy('locking'); setErrorMsg(null); }
        else if (action === 'lock_done') {
          setBusy(null); setErrorMsg(null);
          void refreshRef.current?.projects();
          void refreshRef.current?.detail();
        }
        else if (action === 'lock_error') { setBusy(null); setErrorMsg(`Lock failed: ${p.message ?? 'unknown'}`); }
      });
      // Poke Python for current design state.
      bridgeRef.current.send('get_design_state', {});
    }
  }, []);

  // Bridge the token to Python whenever it changes.
  useEffect(() => {
    if (!token) return;
    bridgeRef.current?.send('set_api_key', { key: token });
  }, [token]);

  // Bridge selected project to Python.
  useEffect(() => {
    if (!selectedId) return;
    bridgeRef.current?.send('project_changed', { project_id: selectedId });
  }, [selectedId]);

  // ---- Data
  const refreshProjects = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetchWithAuth('/api/projects?limit=100', token);
      if (r.status === 401) { setConnection('unauthorized'); return; }
      if (!r.ok) { setConnection('retrying'); return; }
      const j = await r.json();
      const cad = (j.projects ?? []).filter((p: Project) => p.type === 'cad');
      setProjects(cad);
      if (selectedId == null && cad.length > 0) setSelectedId(cad[0].id);
      setConnection('healthy');
    } catch { setConnection('disconnected'); }
  }, [token, selectedId]);

  const refreshDetail = useCallback(async () => {
    if (!token || !selectedId) return;
    try {
      const r = await fetchWithAuth(`/api/projects/${selectedId}`, token);
      if (r.status === 401) { setConnection('unauthorized'); return; }
      if (!r.ok) { setConnection('retrying'); return; }
      setDetail(await r.json());
      setConnection('healthy');
    } catch { setConnection('disconnected'); }
  }, [token, selectedId]);

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  useEffect(() => {
    refreshRef.current = { projects: refreshProjects, detail: refreshDetail };
    void refreshDetail();
    const t = setInterval(() => { void refreshProjects(); void refreshDetail(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refreshProjects, refreshDetail]);

  // ---- Actions
  const triggerWitness = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('witness_now', { project_id: selectedId });
  }, [selectedId]);

  const triggerCheckpoint = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    if (!selectedId) { setErrorMsg('No project selected.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('checkpoint', { project_id: selectedId });
  }, [selectedId]);

  const triggerLock = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    if (!selectedId) { setErrorMsg('No project selected.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('lock_chain', { project_id: selectedId, tier: 'pinned' });
  }, [selectedId]);

  const openInSystemBrowser = useCallback((path: string) => {
    bridgeRef.current?.send('open_browser', { url: path });
  }, []);

  // ---- Render: not signed in
  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-scruple-bg p-6">
        <div className="w-full max-w-sm rounded-lg border border-scruple-border bg-scruple-surface p-8">
          <h1 className="text-lg font-bold tracking-widest text-scruple-accent-primary">SCRUPLE</h1>
          <p className="mt-1 text-xs text-scruple-muted">Studio for Autodesk Fusion</p>
          <p className="mt-6 text-sm text-scruple-muted">
            Sign in to start tracking your Fusion designs.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.href = '/api/auth/keys/fusion-mint?next=/embed/fusion';
            }}
            className="mt-4 flex h-10 w-full items-center justify-center gap-3 rounded border border-[#8e918f] bg-[#131314] px-3 font-['Roboto',_'Inter',_system-ui,_sans-serif] text-sm font-medium text-white hover:bg-[#1f2123]"
            style={{ letterSpacing: '0.25px' }}
          >
            Sign in with Google
          </button>
          <p className="mt-6 text-[10px] text-scruple-muted">
            One-time sign-in. Scruple stays live in Fusion after that.
          </p>
        </div>
      </div>
    );
  }

  // ---- Render: signed in — Studio-style shell
  const activeProject = detail?.project;
  const iterations = detail?.iterations ?? [];
  const isLocked = activeProject &&
    activeProject.status !== 'unlocked' &&
    activeProject.status !== 'checkpointed';

  return (
    <div className="grid h-screen grid-rows-[40px_1fr] bg-scruple-bg text-scruple-text">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-scruple-border bg-scruple-surface px-4">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-widest text-scruple-accent-primary">SCRUPLE</span>
          <span className="text-[10px] text-scruple-muted">Studio for Autodesk Fusion</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-scruple-muted">
          <ConnectionDot state={connection} />
          {designName && (
            <>
              <span className="text-scruple-muted">·</span>
              <span>Fusion doc: <span className="text-scruple-text">{designName}</span></span>
            </>
          )}
        </div>
      </header>

      {/* Two-pane body: sidebar + workspace */}
      <div className="grid grid-cols-[240px_1fr] overflow-hidden">
        {/* Sidebar: CAD projects */}
        <aside className="flex flex-col overflow-hidden border-r border-scruple-border bg-scruple-surface">
          <div className="border-b border-scruple-border px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-scruple-muted">
              Fusion projects
            </div>
            <div className="mt-1 text-xs text-scruple-muted">
              {projects.length} tracked
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto">
            {projects.length === 0 && (
              <li className="px-4 py-6 text-xs text-scruple-muted">
                No Fusion projects yet.
                <div className="mt-2 text-[11px] leading-relaxed">
                  Save a design in Fusion (Ctrl+S). It'll appear here automatically.
                </div>
              </li>
            )}
            {projects.map((p) => {
              const active = p.id === selectedId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className={`flex w-full flex-col items-start gap-1 border-l-2 px-4 py-2 text-left transition-colors ${
                      active
                        ? 'border-scruple-accent-primary bg-scruple-bg'
                        : 'border-transparent hover:bg-scruple-bg/50'
                    }`}
                  >
                    <div className="w-full truncate text-sm font-medium">{p.name}</div>
                    <div className="flex items-center gap-2 text-[10px] text-scruple-muted">
                      <span>{p.iteration_count} leaves</span>
                      <span>·</span>
                      <span>{relativeTime(p.updated_at)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-scruple-border px-4 py-3">
            <a
              href="/settings/billing"
              onClick={(e) => { e.preventDefault(); openInSystemBrowser('/settings/billing'); }}
              className="block text-[11px] text-sky-400 hover:underline"
            >
              Payment & plan ↗
            </a>
          </div>
        </aside>

        {/* Workspace: active project detail */}
        <main className="flex flex-col overflow-hidden">
          {!activeProject ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md text-center">
                <h2 className="text-lg font-light">
                  {projects.length === 0 ? 'No projects yet' : 'No project selected'}
                </h2>
                <p className="mt-2 text-sm text-scruple-muted">
                  {projects.length === 0
                    ? 'Save a design in Fusion — Scruple will pick it up automatically.'
                    : 'Pick a project from the sidebar.'}
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Project header */}
              <div className="flex items-center justify-between border-b border-scruple-border bg-scruple-surface px-6 py-3">
                <div>
                  <h1 className="text-base font-medium">{activeProject.name}</h1>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-scruple-muted">
                    <span className={`inline-block rounded border px-2 py-[1px] font-mono ${statusColor(activeProject.status)}`}>
                      {statusLabel(activeProject.status)}
                    </span>
                    {activeProject.pre_scr_id && (
                      <span>
                        SCR-ID: <span className="font-mono text-scruple-text">{activeProject.pre_scr_id}</span>
                      </span>
                    )}
                    {activeProject.scr_id && activeProject.scr_id !== activeProject.pre_scr_id && (
                      <a
                        href={`/receipt/${activeProject.scr_id}`}
                        onClick={(e) => { e.preventDefault(); openInSystemBrowser(`/receipt/${activeProject.scr_id}`); }}
                        className="font-mono text-sky-400 hover:underline"
                      >
                        Locked: {activeProject.scr_id} ↗
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ActionBtn
                    label={busy === 'witnessing' ? 'Witnessing…' : 'Witness'}
                    onClick={triggerWitness}
                    disabled={busy !== null || !!isLocked}
                    variant="secondary"
                  />
                  <ActionBtn
                    label={busy === 'checkpointing' ? 'Checkpointing…' : 'Checkpoint'}
                    onClick={triggerCheckpoint}
                    disabled={busy !== null || !!isLocked}
                    variant="secondary"
                  />
                  <ActionBtn
                    label={busy === 'locking' ? 'Locking…' : 'Lock & Anchor'}
                    onClick={triggerLock}
                    disabled={busy !== null || !!isLocked || (activeProject.iteration_count === 0)}
                    variant="primary"
                  />
                </div>
              </div>

              {/* Iteration grid — witness leaves */}
              <div className="flex-1 overflow-y-auto p-6">
                {iterations.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-center text-sm text-scruple-muted">
                    No leaves yet. Save in Fusion or add a feature to record the first one.
                  </div>
                ) : (
                  <div>
                    <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-scruple-muted">
                      Witnessed leaves ({iterations.length})
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {iterations.slice().reverse().map((it) => (
                        <div
                          key={it.id}
                          className="flex items-center justify-between rounded border border-scruple-border bg-scruple-surface px-4 py-2 text-xs"
                        >
                          <div className="flex items-center gap-3">
                            <span className="w-10 text-right font-mono text-scruple-muted">#{it.run_sequence}</span>
                            <code className="font-mono text-scruple-text">{it.leaf_hash.slice(0, 24)}…</code>
                            {it.witnessed ? (
                              <span className="rounded bg-emerald-500/20 px-1.5 py-[1px] text-[9px] text-emerald-300">
                                signed
                              </span>
                            ) : (
                              <span className="rounded bg-amber-500/20 px-1.5 py-[1px] text-[9px] text-amber-300">
                                unsigned
                              </span>
                            )}
                          </div>
                          <span className="text-scruple-muted">{relativeTime(it.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {errorMsg && (
                  <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
                    {errorMsg}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function ConnectionDot({ state }: { state: ConnectionState }) {
  const cls = {
    connecting: 'bg-neutral-500',
    healthy: 'bg-emerald-500',
    retrying: 'bg-amber-500',
    disconnected: 'bg-red-500',
    unauthorized: 'bg-violet-500',
  }[state];
  const label = {
    connecting: 'Connecting',
    healthy: 'Connected',
    retrying: 'Retrying',
    disconnected: 'Offline',
    unauthorized: 'Sign in',
  }[state];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${cls}`} />
      {label}
    </span>
  );
}

function ActionBtn({
  label, onClick, disabled, variant,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const base = 'rounded px-3 py-1.5 text-xs font-medium transition-colors';
  const enabled = variant === 'primary'
    ? 'bg-scruple-accent-primary text-black hover:opacity-90'
    : 'border border-scruple-border text-scruple-text hover:border-scruple-accent';
  const disabledCls = 'cursor-not-allowed border border-scruple-border bg-scruple-surface text-scruple-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${disabled ? disabledCls : enabled}`}
    >
      {label}
    </button>
  );
}
