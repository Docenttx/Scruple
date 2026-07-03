'use client';

// FusionPalette — the compact Scruple project card that lives inside
// Fusion 360 as a docked palette.
//
// Product model:
//   - Every open Fusion design is tracked as its own Scruple project.
//   - The palette shows THIS DESIGN's project state at a glance:
//     name, status pill, iteration count, last witnessed timestamp,
//     last few leaf hashes.
//   - Three actions: Witness now, Checkpoint, Lock & Anchor.
//   - Account setup, plan selection, payment method, receipt browsing,
//     cross-project management all happen on scruple.stooges.ai in the
//     user's real browser (via a Settings link at the bottom that opens
//     in the system browser). The palette itself never needs to become
//     the full dashboard.

import { useCallback, useEffect, useRef, useState } from 'react';

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
  scr_id: string | null;
  merkle_root: string | null;
}

interface Iteration {
  id: number;
  project_id: number;
  run_sequence: number;
  leaf_hash: string;
  output_kind: string;
  witnessed: number;
  timestamp: string;
}

interface ProjectDetail {
  project: Project;
  iterations: Iteration[];
  iterationCount: number;
}

type ConnectionState = 'connecting' | 'healthy' | 'retrying' | 'disconnected' | 'unauthorized';

const POLL_MS = 15_000;

// ----------------------------------------------------------- Fusion bridge

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

// ----------------------------------------------------------- auth

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('token');
  if (fromQuery) {
    try { localStorage.setItem('scruple.fusion.api_key', fromQuery); } catch {}
    return fromQuery;
  }
  try { return localStorage.getItem('scruple.fusion.api_key'); } catch { return null; }
}

function readPresetProjectId(): number | null {
  if (typeof window === 'undefined') return null;
  const fromQuery = new URLSearchParams(window.location.search).get('project_id');
  if (fromQuery) {
    const n = Number(fromQuery);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchWithAuth(url: string, token: string | null, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  return fetch(url, { ...init, headers, credentials: token ? 'omit' : 'include' });
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function shortHash(h: string): string {
  if (!h) return '';
  return h.length > 12 ? `${h.slice(0, 10)}…` : h;
}

function statusLabel(s: ProjectStatus): string {
  return {
    unlocked: 'Tracking',
    checkpointed: 'Checkpointed',
    local_locked: 'Locally locked',
    chain_locked: 'Chain locked',
    persistent_locked: 'Persistent lock',
    permanent_locked: 'Permanent lock',
  }[s] || s;
}

function statusColor(s: ProjectStatus): string {
  return {
    unlocked: '#22c55e',
    checkpointed: '#eab308',
    local_locked: '#f59e0b',
    chain_locked: '#7dd3fc',
    persistent_locked: '#a78bfa',
    permanent_locked: '#f472b6',
  }[s] || '#888';
}

// ----------------------------------------------------------- component

export default function FusionPalette() {
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState<'witnessing' | 'checkpointing' | 'locking' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [designName, setDesignName] = useState<string | null>(null);
  const bridgeRef = useRef<FusionBridge | null>(null);
  const refreshDetailRef = useRef<(() => Promise<void>) | null>(null);

  // Mount: discover token + bridge, register Python→JS handler.
  useEffect(() => {
    bridgeRef.current = getFusionBridge();
    setToken(readToken());
    const preset = readPresetProjectId();
    if (preset) setSelectedId(preset);

    if (bridgeRef.current) {
      bridgeRef.current.onMessage((action, payload) => {
        const p = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        if (action === 'auth_token') {
          const tok = typeof p.token === 'string' ? p.token : null;
          if (tok) {
            try { localStorage.setItem('scruple.fusion.api_key', tok); } catch {}
            setToken(tok);
          }
        } else if (action === 'design_state') {
          // Python tells us: current Fusion document's name + bound project_id
          if (typeof p.name === 'string') setDesignName(p.name);
          if (typeof p.project_id === 'number') setSelectedId(p.project_id);
          if (typeof p.last_saved_at === 'string') setLastSavedAt(p.last_saved_at);
        } else if (action === 'witness_started') {
          setBusy('witnessing');
          setErrorMsg(null);
        } else if (action === 'witness_done') {
          setBusy(null);
          setErrorMsg(null);
          void refreshDetailRef.current?.();
        } else if (action === 'witness_error') {
          setBusy(null);
          setErrorMsg(`Witness failed: ${p.message ?? 'unknown'}`);
        } else if (action === 'checkpoint_started') {
          setBusy('checkpointing');
          setErrorMsg(null);
        } else if (action === 'checkpoint_done') {
          setBusy(null);
          setErrorMsg(null);
          void refreshDetailRef.current?.();
        } else if (action === 'checkpoint_error') {
          setBusy(null);
          setErrorMsg(`Checkpoint failed: ${p.message ?? 'unknown'}`);
        } else if (action === 'lock_started') {
          setBusy('locking');
          setErrorMsg(null);
        } else if (action === 'lock_done') {
          setBusy(null);
          setErrorMsg(null);
          void refreshDetailRef.current?.();
        } else if (action === 'lock_error') {
          setBusy(null);
          setErrorMsg(`Lock failed: ${p.message ?? 'unknown'}`);
        }
      });
      // Ask Python for the current design state (name + project binding).
      bridgeRef.current.send('get_design_state', {});
    }
  }, []);

  // Tell Python the API key whenever it changes.
  useEffect(() => {
    if (!token) return;
    bridgeRef.current?.send('set_api_key', { key: token });
  }, [token]);

  // Tell Python which project is selected.
  useEffect(() => {
    if (!selectedId) return;
    bridgeRef.current?.send('project_changed', { project_id: selectedId });
  }, [selectedId]);

  // ---- Project list refresh
  const refreshProjects = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetchWithAuth('/api/projects?limit=50', token);
      if (r.status === 401) { setConnection('unauthorized'); return; }
      if (!r.ok) { setConnection('retrying'); return; }
      const j = await r.json();
      setProjects(j.projects ?? []);
      if (selectedId == null && j.activeId) setSelectedId(j.activeId);
      setConnection('healthy');
    } catch { setConnection('disconnected'); }
  }, [token, selectedId]);

  const refreshDetail = useCallback(async () => {
    if (!token || !selectedId) return;
    try {
      const r = await fetchWithAuth(`/api/projects/${selectedId}`, token);
      if (r.status === 401) { setConnection('unauthorized'); return; }
      if (!r.ok) { setConnection('retrying'); return; }
      const j = await r.json();
      setDetail(j);
      setConnection('healthy');
    } catch { setConnection('disconnected'); }
  }, [token, selectedId]);

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  useEffect(() => {
    refreshDetailRef.current = refreshDetail;
    void refreshDetail();
    const t = setInterval(refreshDetail, POLL_MS);
    return () => clearInterval(t);
  }, [refreshDetail]);

  // ---- Actions

  const triggerWitness = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('witness_now', { project_id: selectedId });
  }, [selectedId]);

  const triggerCheckpoint = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    if (!selectedId) { setErrorMsg('No project bound.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('checkpoint', { project_id: selectedId });
  }, [selectedId]);

  const triggerLock = useCallback(() => {
    if (!bridgeRef.current) { setErrorMsg('Fusion bridge not detected.'); return; }
    if (!selectedId) { setErrorMsg('No project bound.'); return; }
    setErrorMsg(null);
    bridgeRef.current.send('lock_chain', { project_id: selectedId, tier: 'pinned' });
  }, [selectedId]);

  const openInSystemBrowser = useCallback((path: string) => {
    // Payment / plan / receipts / account management all go through the
    // user's real browser — Stripe Elements + Google/Autodesk OAuth need
    // a proper browser (embedded webviews are blocked or degraded).
    bridgeRef.current?.send('open_browser', { url: path });
  }, []);

  const startTracking = useCallback(async () => {
    if (!token) return;
    const name = designName || `Fusion design ${new Date().toISOString().slice(0, 10)}`;
    try {
      const r = await fetchWithAuth('/api/projects', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind: 'cad' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const newId = j.project?.id ?? j.id;
      if (newId) {
        setSelectedId(newId);
        bridgeRef.current?.send('bind_project', { project_id: newId });
        await refreshProjects();
      }
    } catch (e) {
      setErrorMsg(`Could not start tracking: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [token, designName, refreshProjects]);

  // -------------------------------------------------------- render

  // NOT SIGNED IN — show simple signin CTA
  if (!token) {
    return (
      <div style={style.pane}>
        <header style={style.header}>
          <strong style={{ fontSize: 14 }}>Scruple</strong>
        </header>
        <p style={{ ...style.muted, marginTop: 20 }}>
          Sign in to track your Fusion designs.
        </p>
        <button
          style={{ ...style.primaryBtn, marginTop: 12 }}
          onClick={() => {
            window.location.href = '/api/auth/keys/fusion-mint?next=/embed/fusion';
          }}
        >
          Sign in with Scruple
        </button>
        <p style={{ ...style.muted, marginTop: 20, fontSize: 11 }}>
          Signing in creates a Scruple account. Payment methods and plan
          setup happen at scruple.ai in your browser.
        </p>
        <details style={{ marginTop: 24 }}>
          <summary style={{ ...style.muted, cursor: 'pointer', fontSize: 11 }}>
            Developer: paste API key
          </summary>
          <input
            type="password"
            placeholder="sk_test_…"
            style={{ ...style.input, marginTop: 8 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v.startsWith('sk_')) {
                  try { localStorage.setItem('scruple.fusion.api_key', v); } catch {}
                  setToken(v);
                }
              }
            }}
          />
        </details>
      </div>
    );
  }

  // NO PROJECT BOUND — show "start tracking" CTA
  if (!selectedId) {
    return (
      <div style={style.pane}>
        <PaletteHeader connection={connection} />
        <section style={{ marginTop: 20 }}>
          <div style={{ ...style.muted, fontSize: 11 }}>Current design</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {designName || '(no active design)'}
          </div>
        </section>
        <p style={{ ...style.muted, marginTop: 20 }}>
          This design isn't being tracked yet.
        </p>
        <button
          style={{ ...style.primaryBtn, marginTop: 8 }}
          disabled={!designName}
          onClick={startTracking}
        >
          Start tracking this design
        </button>
        <div style={{ marginTop: 24 }}>
          <div style={{ ...style.muted, fontSize: 11 }}>
            Or select an existing project:
          </div>
          <select
            style={{ ...style.select, marginTop: 6 }}
            value=""
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) {
                setSelectedId(n);
                bridgeRef.current?.send('bind_project', { project_id: n });
              }
            }}
          >
            <option value="">— pick project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <Footer openInSystemBrowser={openInSystemBrowser} />
      </div>
    );
  }

  // BOUND — the main project card view
  const project = detail?.project;
  const iterations = detail?.iterations ?? [];
  const lastWitnessed = iterations.length > 0 ? iterations[iterations.length - 1] : null;
  const lastLeafTimestamp = lastWitnessed?.timestamp ?? null;
  const status: ProjectStatus = project?.status ?? 'unlocked';
  const isLocked = status !== 'unlocked' && status !== 'checkpointed';

  return (
    <div style={style.pane}>
      <PaletteHeader connection={connection} />

      {/* Project card */}
      <section style={style.card}>
        <div style={style.projectName}>
          {project?.name ?? designName ?? 'Loading…'}
        </div>
        <div style={{ ...style.pill, background: statusColor(status), color: '#0b0b0c' }}>
          {statusLabel(status)}
        </div>
      </section>

      {/* Stats row */}
      <section style={style.statsRow}>
        <div style={style.statCell}>
          <div style={style.statValue}>{detail?.iterationCount ?? 0}</div>
          <div style={style.statLabel}>Leaves</div>
        </div>
        <div style={style.statCell}>
          <div style={style.statValue}>{relativeTime(lastLeafTimestamp)}</div>
          <div style={style.statLabel}>Last witnessed</div>
        </div>
        <div style={style.statCell}>
          <div style={style.statValue}>{relativeTime(lastSavedAt)}</div>
          <div style={style.statLabel}>Last save</div>
        </div>
      </section>

      {/* Recent leaves */}
      {iterations.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <div style={style.sectionLabel}>Recent leaves</div>
          <ul style={style.leafList}>
            {iterations.slice(-4).reverse().map((it) => (
              <li key={it.id} style={style.leafItem}>
                <span style={style.seq}>#{it.run_sequence}</span>
                <code style={style.hash}>{shortHash(it.leaf_hash)}</code>
                <span style={style.leafTime}>{relativeTime(it.timestamp)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* SCR-ID if chain locked */}
      {project?.scr_id && (
        <section style={{ marginTop: 12 }}>
          <div style={style.sectionLabel}>SCR-ID</div>
          <a
            href={`/receipt/${project.scr_id}`}
            onClick={(e) => {
              e.preventDefault();
              openInSystemBrowser(`/receipt/${project.scr_id}`);
            }}
            style={{ ...style.link, fontFamily: 'ui-monospace, Menlo, monospace' }}
          >
            {project.scr_id} ↗
          </a>
        </section>
      )}

      {/* Action buttons */}
      <section style={style.actions}>
        <button
          style={busy === 'witnessing' ? style.disabledBtn : style.primaryBtn}
          disabled={busy !== null || isLocked}
          onClick={triggerWitness}
          title="Export the design + record a witness leaf now"
        >
          {busy === 'witnessing' ? 'Witnessing…' : 'Witness now'}
        </button>
        <button
          style={busy === 'checkpointing' ? style.disabledBtn : style.secondaryBtn}
          disabled={busy !== null || isLocked}
          onClick={triggerCheckpoint}
          title="Mid-chain checkpoint — snapshots the chain state locally"
        >
          {busy === 'checkpointing' ? 'Checkpointing…' : 'Checkpoint'}
        </button>
        <button
          style={busy === 'locking' ? style.disabledBtn : style.secondaryBtn}
          disabled={busy !== null || isLocked || (detail?.iterationCount ?? 0) === 0}
          onClick={triggerLock}
          title="Lock the chain to public ledgers — permanent"
        >
          {busy === 'locking' ? 'Locking…' : 'Lock & Anchor'}
        </button>
      </section>

      {errorMsg && <div style={style.error}>{errorMsg}</div>}

      <Footer openInSystemBrowser={openInSystemBrowser} />
    </div>
  );
}

function PaletteHeader({ connection }: { connection: ConnectionState }) {
  const label: Record<ConnectionState, string> = {
    connecting: 'Connecting',
    healthy: 'Connected',
    retrying: 'Retrying',
    disconnected: 'Offline',
    unauthorized: 'Sign in',
  };
  const color: Record<ConnectionState, string> = {
    connecting: '#888',
    healthy: '#22c55e',
    retrying: '#eab308',
    disconnected: '#ef4444',
    unauthorized: '#a855f7',
  };
  return (
    <header style={style.header}>
      <strong style={{ fontSize: 13, letterSpacing: 0.3 }}>SCRUPLE</strong>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.85 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color[connection] }} />
        {label[connection]}
      </span>
    </header>
  );
}

function Footer({ openInSystemBrowser }: { openInSystemBrowser: (path: string) => void }) {
  return (
    <footer style={style.footer}>
      <a
        href="/settings/billing"
        onClick={(e) => { e.preventDefault(); openInSystemBrowser('/settings/billing'); }}
        style={style.link}
      >
        Payment & plan ↗
      </a>
      <a
        href="/projects"
        onClick={(e) => { e.preventDefault(); openInSystemBrowser('/projects'); }}
        style={style.link}
      >
        All projects ↗
      </a>
    </footer>
  );
}

// ------------------------------------------------------------------ styles

const style = {
  pane: {
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    padding: 14,
    background: '#0b0b0c',
    color: '#e6e6e6',
    minHeight: '100vh',
    fontSize: 13,
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 10,
    borderBottom: '1px solid #232325',
  } as React.CSSProperties,
  card: {
    marginTop: 14,
    padding: 12,
    background: '#141416',
    border: '1px solid #232325',
    borderRadius: 6,
  } as React.CSSProperties,
  projectName: {
    fontSize: 15,
    fontWeight: 600,
    marginBottom: 6,
    lineHeight: 1.3,
    wordBreak: 'break-word' as const,
  } as React.CSSProperties,
  pill: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as const,
    padding: '2px 8px',
    borderRadius: 999,
  } as React.CSSProperties,
  statsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 6,
    marginTop: 12,
  } as React.CSSProperties,
  statCell: {
    background: '#141416',
    border: '1px solid #232325',
    borderRadius: 6,
    padding: '8px 6px',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  statValue: { fontSize: 13, fontWeight: 700 } as React.CSSProperties,
  statLabel: { fontSize: 10, color: '#7a7a7c', marginTop: 2 } as React.CSSProperties,
  sectionLabel: {
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    color: '#7a7a7c',
    marginBottom: 6,
  } as React.CSSProperties,
  leafList: { listStyle: 'none', padding: 0, margin: 0 } as React.CSSProperties,
  leafItem: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: 8,
    padding: '4px 0',
    fontSize: 11,
    borderBottom: '1px dashed #1f1f22',
    alignItems: 'center',
  } as React.CSSProperties,
  seq: { color: '#7a7a7c', fontVariantNumeric: 'tabular-nums' as const } as React.CSSProperties,
  hash: { fontFamily: 'ui-monospace, Menlo, monospace', color: '#c4c4c8', fontSize: 11 } as React.CSSProperties,
  leafTime: { color: '#7a7a7c', fontSize: 10 } as React.CSSProperties,
  actions: { display: 'grid', gap: 6, marginTop: 16 } as React.CSSProperties,
  primaryBtn: {
    padding: '10px 12px',
    background: '#00e5aa',
    color: '#0b0b0c',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: 13,
  } as React.CSSProperties,
  secondaryBtn: {
    padding: '10px 12px',
    background: 'transparent',
    color: '#e6e6e6',
    border: '1px solid #3a3a3d',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
  } as React.CSSProperties,
  disabledBtn: {
    padding: '10px 12px',
    background: '#2a2a2d',
    color: '#5a5a5d',
    border: 'none',
    borderRadius: 4,
    cursor: 'not-allowed',
    fontWeight: 600,
    fontSize: 13,
  } as React.CSSProperties,
  select: {
    width: '100%',
    padding: '6px 8px',
    background: '#1a1a1d',
    color: '#e6e6e6',
    border: '1px solid #2a2a2d',
    borderRadius: 4,
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '6px 8px',
    background: '#1a1a1d',
    color: '#e6e6e6',
    border: '1px solid #2a2a2d',
    borderRadius: 4,
    boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  muted: { color: '#9a9a9c', fontSize: 12 } as React.CSSProperties,
  error: {
    marginTop: 10,
    background: '#3b1010',
    color: '#fca5a5',
    padding: 8,
    borderRadius: 4,
    fontSize: 11,
  } as React.CSSProperties,
  footer: {
    marginTop: 24,
    paddingTop: 12,
    borderTop: '1px solid #232325',
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
  } as React.CSSProperties,
  link: { color: '#7dd3fc', textDecoration: 'none' } as React.CSSProperties,
};
