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
import WorkspaceView from '@/components/WorkspaceView';
import type { ProjectRow, IterationRow } from '@/lib/types';

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
  thumbnail_b64: string | null;
  fusion_web_url: string | null;
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

// Fetch a fresh API key from fusion-mint via JSON API — no navigation, so
// Fusion's palette bridge stays intact. Returns null if the user needs to
// sign in first.
async function fetchTokenViaJson(): Promise<
  { token: string } | { signInRequired: true; loginUrl: string } | null
> {
  try {
    const r = await fetch('/api/auth/keys/fusion-mint?next=/embed/fusion', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j.token === 'string') return { token: j.token };
    if (j.signInRequired) return { signInRequired: true, loginUrl: j.loginUrl };
    return null;
  } catch {
    return null;
  }
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
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState<'witnessing' | 'checkpointing' | 'locking' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [designName, setDesignName] = useState<string | null>(null);
  const bridgeRef = useRef<FusionBridge | null>(null);
  const refreshRef = useRef<{ projects: () => Promise<void>; detail: () => Promise<void> } | null>(null);

  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  // Mount: discover token + bridge, register Python→JS handler.
  useEffect(() => {
    bridgeRef.current = getFusionBridge();

    // First, use whatever's already stored locally.
    const stored = readToken();
    if (stored) {
      setToken(stored);
    } else {
      // No stored token — fetch one via JSON API. This is a same-page XHR,
      // not a navigation, so it doesn't break the Fusion palette bridge.
      // (Loading fusion-mint as the palette URL WOULD navigate and kill the
      // bridge — do NOT go back to that pattern.)
      void (async () => {
        const result = await fetchTokenViaJson();
        if (result && 'token' in result) {
          try { localStorage.setItem(TOKEN_KEY, result.token); } catch {}
          setToken(result.token);
        } else if (result && 'signInRequired' in result) {
          setSignInUrl(result.loginUrl);
        }
      })();
    }

    // DIAGNOSTIC — record from browser side whether the JS→Python bridge
    // was found on mount so we can compare against Python-side diag pings.
    try {
      const w = window as unknown as Record<string, unknown>;
      fetch('/api/diag/fusion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'palette_mount_js',
          has_bridge: bridgeRef.current !== null,
          has_window_adsk: typeof w.adsk !== 'undefined',
          adsk_keys: w.adsk ? Object.keys(w.adsk as object) : [],
          has_fusionSendData: !!(w.adsk && (w.adsk as { fusionSendData?: unknown }).fusionSendData),
          user_agent: navigator.userAgent.slice(0, 200),
        }),
      }).catch(() => {});
    } catch {}

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

  // Bridge the token to Python whenever it changes. We RETRY several times
  // to bridge a race where the palette JS may load + send BEFORE Python's
  // `incomingFromHTML` handler is registered. Python re-receiving the same
  // key is idempotent (no-op after the first). Also send on every polling
  // tick as belt-and-suspenders.
  useEffect(() => {
    if (!token) return;
    const sendKey = (label: string) => {
      try {
        fetch('/api/diag/fusion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'js_sending_set_api_key',
            attempt: label,
            has_bridge: bridgeRef.current !== null,
            token_prefix: token.slice(0, 12),
          }),
        }).catch(() => {});
      } catch {}
      bridgeRef.current?.send('set_api_key', { key: token });
    };
    // Fire immediately, then re-fire at 500ms / 1500ms / 3000ms / 6000ms
    // so a slow Python-side handler registration still catches at least one.
    sendKey('t0');
    const timers = [
      setTimeout(() => sendKey('t500'), 500),
      setTimeout(() => sendKey('t1500'), 1500),
      setTimeout(() => sendKey('t3000'), 3000),
      setTimeout(() => sendKey('t6000'), 6000),
    ];

    // Backup path: POST the token to /api/fusion/handoff — Python's
    // background poller reads it even when the palette bridge is dead.
    // Session comes from the URL query on first load, then cached in
    // localStorage so it survives Fusion-driven palette reloads that
    // sometimes drop the URL query string.
    try {
      const SID_KEY = 'scruple.fusion.session';
      let sid = new URLSearchParams(window.location.search).get('session');
      if (sid) {
        try { localStorage.setItem(SID_KEY, sid); } catch {}
      } else {
        try { sid = localStorage.getItem(SID_KEY); } catch {}
      }
      // Also emit a diag so we can see the palette-side handoff attempt.
      fetch('/api/diag/fusion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'js_handoff_attempt',
          has_sid: !!sid,
          sid_prefix: sid ? sid.slice(0, 8) : null,
          has_token: !!token,
        }),
      }).catch(() => {});
      if (sid) {
        fetch('/api/fusion/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sid, key: token }),
        }).catch(() => {});
      }
    } catch {}

    return () => timers.forEach(clearTimeout);
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
      const [live, archived] = await Promise.all([
        fetchWithAuth('/api/projects?limit=500&archived=live', token),
        fetchWithAuth('/api/projects?limit=500&archived=only', token),
      ]);
      if (live.status === 401 || archived.status === 401) { setConnection('unauthorized'); return; }
      if (!live.ok || !archived.ok) { setConnection('retrying'); return; }
      const jLive = await live.json();
      const jArch = await archived.json();
      const liveCad = (jLive.projects ?? []).filter((p: Project) => p.type === 'cad');
      const archCad = (jArch.projects ?? []).filter((p: Project) => p.type === 'cad');
      setProjects(liveCad);
      setArchivedProjects(archCad);
      if (selectedId == null && liveCad.length > 0) setSelectedId(liveCad[0].id);
      setConnection('healthy');
    } catch { setConnection('disconnected'); }
  }, [token, selectedId]);

  const toggleArchive = useCallback(async (projectId: number, archive: boolean) => {
    if (!token) return;
    try {
      await fetchWithAuth(`/api/projects/${projectId}/archive`, token, {
        method: archive ? 'POST' : 'DELETE',
      });
      // If we just archived the selected one, drop the selection.
      if (archive && selectedId === projectId) setSelectedId(null);
      await refreshProjects();
    } catch {}
  }, [token, selectedId, refreshProjects]);

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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/scruple_wordmark_crimson.png" alt="Scruple" className="h-6 w-auto" />
          <p className="mt-1 text-xs text-scruple-muted">Studio for Autodesk Fusion</p>
          <p className="mt-6 text-sm text-scruple-muted">
            Sign in to start tracking your Fusion designs.
          </p>
          <button
            type="button"
            onClick={() => {
              // NOTE: this navigation kills the Fusion palette bridge (JS→Python)
              // for the current palette instance — Fusion binds the message channel
              // to the palette's original htmlFileURL. After returning here signed
              // in, the palette will need to be recreated for the bridge to work.
              // Acceptable trade-off for first-time sign-in only; subsequent opens
              // hit the JSON path with the stored cookie and never navigate.
              window.location.href = signInUrl ?? '/api/auth/keys/fusion-mint?next=/embed/fusion';
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/scruple_wordmark_crimson.png" alt="Scruple" className="h-4 w-auto" />
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
            {projects.map((p) => (
              <SidebarRow
                key={p.id}
                p={p}
                active={p.id === selectedId}
                archived={false}
                onSelect={() => setSelectedId(p.id)}
                onToggleArchive={() => toggleArchive(p.id, true)}
              />
            ))}
            {archivedProjects.length > 0 && (
              <li className="mt-2 border-t border-scruple-border">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-scruple-muted hover:bg-scruple-bg/50"
                >
                  <span>{showArchived ? '▼' : '▶'}</span>
                  <span>Archived ({archivedProjects.length})</span>
                </button>
              </li>
            )}
            {showArchived && archivedProjects.map((p) => (
              <SidebarRow
                key={`arch-${p.id}`}
                p={p}
                active={false}
                archived
                onSelect={() => setSelectedId(p.id)}
                onToggleArchive={() => toggleArchive(p.id, false)}
              />
            ))}
          </ul>
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
              {/* Workspace — identical layout to the ComfyUI Studio /projects/[id]
                  page. Header, stats, Merkle card, iteration list, lock buttons.
                  Fusion cloud viewer iframe rides on top via cadPreview. */}
              <div className="flex-1 overflow-y-auto">
                <WorkspaceView
                  project={activeProject as unknown as ProjectRow}
                  iterations={iterations as unknown as IterationRow[]}
                  trainingRuns={[]}
                  cadPreview={
                    <FusionThumbnail
                      thumb={(activeProject as { thumbnail_b64?: string | null }).thumbnail_b64 ?? null}
                      designName={activeProject.name}
                    />
                  }
                />
                {errorMsg && (
                  <div className="mx-6 mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
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

function SidebarRow({
  p,
  active,
  archived,
  onSelect,
  onToggleArchive,
}: {
  p: Project;
  active: boolean;
  archived: boolean;
  onSelect: () => void;
  onToggleArchive: () => void;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
          active
            ? 'border-scruple-accent-primary bg-scruple-bg'
            : 'border-transparent hover:bg-scruple-bg/50'
        } ${archived ? 'opacity-60' : ''}`}
      >
        {p.thumbnail_b64 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.thumbnail_b64}
            alt=""
            className="h-9 w-9 flex-shrink-0 rounded border border-scruple-border bg-black object-contain"
          />
        ) : (
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-dashed border-scruple-border bg-scruple-bg/50 text-[8px] text-scruple-muted">
            —
          </div>
        )}
        <div className="min-w-0 flex-1 pr-6">
          <div className="w-full truncate text-sm font-medium">{p.name}</div>
          <div className="flex items-center gap-2 text-[10px] text-scruple-muted">
            <span>{p.iteration_count} leaves</span>
            <span>·</span>
            <span>{relativeTime(p.updated_at)}</span>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
        title={archived ? 'Restore to live' : 'Archive'}
        className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-scruple-border bg-scruple-surface px-1.5 py-0.5 text-[10px] text-scruple-muted hover:border-scruple-accent hover:text-scruple-text group-hover:block"
      >
        {archived ? '↺' : '⊘'}
      </button>
    </li>
  );
}

function FusionThumbnail({ thumb, designName }: { thumb: string | null; designName: string }) {
  if (!thumb) {
    return (
      <div className="mb-4 flex h-[260px] w-full items-center justify-center rounded border border-dashed border-scruple-border bg-scruple-surface/50 text-center">
        <div className="max-w-sm px-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-scruple-muted">
            Fusion Preview
          </div>
          <div className="mt-2 text-xs text-scruple-text/70">
            Preview will appear here once the next sync completes.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4 overflow-hidden rounded border border-scruple-border bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumb}
        alt={`Fusion thumbnail — ${designName}`}
        className="block h-[260px] w-full object-contain"
      />
    </div>
  );
}

// TODO: Legacy iframe path — kept for reference during MVP; unused now.
function FusionViewer({
  url,
  designName,
  onOpenInBrowser,
}: {
  url: string | null;
  designName: string;
  onOpenInBrowser: (url: string) => void;
}) {
  if (!url) {
    return (
      <div className="mb-4 flex h-[260px] w-full items-center justify-center rounded border border-dashed border-scruple-border bg-scruple-surface/50 text-center">
        <div className="max-w-sm px-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-scruple-muted">
            Fusion Cloud Viewer
          </div>
          <div className="mt-2 text-xs text-scruple-text/70">
            Preview will appear here once the design finishes syncing.
          </div>
          <div className="mt-1 text-[11px] text-scruple-muted">
            Save once in Fusion so the add-in can pick it up on the next sync.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4 overflow-hidden rounded border border-scruple-border bg-black">
      <iframe
        src={url}
        title={`Fusion viewer — ${designName}`}
        className="block h-64 w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <div className="flex items-center justify-between border-t border-scruple-border bg-scruple-surface px-4 py-2 text-[11px] text-scruple-muted">
        <span>Fusion cloud viewer</span>
        <button
          type="button"
          onClick={() => onOpenInBrowser(url)}
          className="text-sky-400 hover:underline"
        >
          Open in browser ↗
        </button>
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
