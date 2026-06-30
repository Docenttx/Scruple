'use client';

// Client component — the palette UI.
//
// Narrow layout (~400px wide). Sections:
//   - Header: connection status pill + project picker
//   - Iteration counter + last-leaf summary
//   - Recent iterations list (top 5, descending)
//   - Action row: "Witness now" + "Lock & Anchor"
//   - Footer: open full dashboard in system browser

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

const POLL_MS = 30_000;

// ----------------------------------------------------------- Fusion bridge

interface FusionBridge {
  send: (action: string, payload: unknown) => void;
  onMessage: (handler: (action: string, payload: unknown) => void) => void;
}

function getFusionBridge(): FusionBridge | null {
  if (typeof window === 'undefined') return null;
  // Real Fusion sets window.adsk on the embedded WebEngine.
  const adsk = (window as unknown as { adsk?: { fusionSendData?: (a: string, j: string) => void } }).adsk;
  if (!adsk?.fusionSendData) return null;
  // Palette → JS messages arrive via window.fusionJavaScriptHandler hook;
  // Fusion will call window.fusionJavaScriptHandler(action, dataString).
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
  try {
    return localStorage.getItem('scruple.fusion.api_key');
  } catch {
    return null;
  }
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

// ----------------------------------------------------------- component

export default function FusionPalette() {
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState<'witnessing' | 'locking' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const bridgeRef = useRef<FusionBridge | null>(null);

  // Mount: discover token + bridge + register Python→JS handler.
  useEffect(() => {
    bridgeRef.current = getFusionBridge();
    const initial = readToken();
    setToken(initial);
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
    }
  }, []);

  // Tell Python the API key whenever it changes.
  useEffect(() => {
    if (!token) return;
    bridgeRef.current?.send('set_api_key', { key: token });
  }, [token]);

  // Tell Python which project the user has selected.
  useEffect(() => {
    if (!selectedId) return;
    bridgeRef.current?.send('project_changed', { project_id: selectedId });
  }, [selectedId]);

  // refreshDetail is defined further down — capture a ref so the
  // Python→JS handler above can call it without ordering hazards.
  const refreshDetailRef = useRef<(() => Promise<void>) | null>(null);

  // ---- Project list refresh
  const refreshProjects = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetchWithAuth('/api/projects?limit=50', token);
      if (r.status === 401) {
        setConnection('unauthorized');
        return;
      }
      if (!r.ok) {
        setConnection('retrying');
        return;
      }
      const j = await r.json();
      setProjects(j.projects ?? []);
      if (selectedId == null && j.activeId) setSelectedId(j.activeId);
      setConnection('healthy');
    } catch (e) {
      setConnection('disconnected');
    }
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
    } catch {
      setConnection('disconnected');
    }
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
    if (!bridgeRef.current) {
      setErrorMsg('Witness must be triggered from inside Fusion.');
      return;
    }
    // Python sets busy via witness_started callback; we don't optimistically
    // set busy here because the real signal comes back via the bridge.
    setErrorMsg(null);
    bridgeRef.current.send('witness_now', { project_id: selectedId });
  }, [selectedId]);

  const triggerLock = useCallback(() => {
    if (!bridgeRef.current) {
      setErrorMsg('Lock must be triggered from inside Fusion.');
      return;
    }
    if (!selectedId) {
      setErrorMsg('Select a project first.');
      return;
    }
    setErrorMsg(null);
    bridgeRef.current.send('lock_chain', { project_id: selectedId, tier: 'pinned' });
  }, [selectedId]);

  // ---- Render helpers

  const statusPill = useMemo(() => {
    const color: Record<ConnectionState, string> = {
      connecting: '#888',
      healthy: '#22c55e',
      retrying: '#eab308',
      disconnected: '#ef4444',
      unauthorized: '#a855f7',
    };
    const label: Record<ConnectionState, string> = {
      connecting: 'Connecting…',
      healthy: 'Connected',
      retrying: 'Retrying',
      disconnected: 'Offline',
      unauthorized: 'Sign in',
    };
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color[connection] }} />
        {label[connection]}
      </span>
    );
  }, [connection]);

  if (!token) {
    return (
      <div style={style.pane}>
        <header style={style.header}>
          <strong style={{ fontSize: 14 }}>Scruple for Fusion</strong>
        </header>
        <p style={{ ...style.muted, marginTop: 24 }}>
          Sign in to start witnessing your Fusion designs.
        </p>
        <button
          style={{ ...style.primaryBtn, marginTop: 12 }}
          onClick={() => {
            // Auto-mint flow: server bounces through /login if no session,
            // then mints an API key and redirects back here with ?token=<key>
            // in the URL. We pick it up via readToken() on mount.
            window.location.href = '/api/auth/keys/fusion-mint?next=/embed/fusion';
          }}
        >
          Sign in with Scruple
        </button>
        <p style={{ ...style.muted, marginTop: 24, fontSize: 11 }}>
          Choose your sign-in method on the next screen — Autodesk SSO
          recommended for Fusion users.
        </p>

        <details style={{ marginTop: 32 }}>
          <summary style={{ ...style.muted, cursor: 'pointer', fontSize: 11 }}>
            Developer: paste an API key directly
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

  return (
    <div style={style.pane}>
      <header style={style.header}>
        <strong style={{ fontSize: 14 }}>Scruple for Fusion</strong>
        {statusPill}
      </header>

      <section style={style.section}>
        <label style={style.label}>Project</label>
        <select
          style={style.select}
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(Number(e.target.value) || null)}
        >
          <option value="">— select —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} {p.status !== 'unlocked' ? `• ${p.status}` : ''}
            </option>
          ))}
        </select>
      </section>

      {detail && (
        <>
          <section style={style.section}>
            <div style={style.statRow}>
              <span style={style.muted}>Iterations</span>
              <strong>{detail.iterationCount}</strong>
            </div>
            <div style={style.statRow}>
              <span style={style.muted}>Status</span>
              <strong>{detail.project.status}</strong>
            </div>
            {detail.project.scr_id && (
              <div style={style.statRow}>
                <span style={style.muted}>SCR-ID</span>
                <a
                  href={`/receipt/${detail.project.scr_id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    window.location.href = `/receipt/${detail.project.scr_id}`;
                  }}
                  style={style.link}
                >
                  {detail.project.scr_id.slice(0, 16)}…
                </a>
              </div>
            )}
          </section>

          <section style={style.section}>
            <label style={style.label}>Recent leaves</label>
            <ul style={style.leafList}>
              {detail.iterations.slice(-5).reverse().map((it) => (
                <li key={it.id} style={style.leafItem}>
                  <span style={style.seq}>#{it.run_sequence}</span>
                  <code style={style.hash}>{it.leaf_hash.slice(0, 16)}…</code>
                </li>
              ))}
              {detail.iterations.length === 0 && (
                <li style={style.muted}>No leaves yet. Save your design to create the first one.</li>
              )}
            </ul>
          </section>

          <section style={style.actions}>
            <button
              style={busy === 'witnessing' ? style.disabledBtn : style.primaryBtn}
              disabled={busy !== null || !selectedId}
              onClick={triggerWitness}
            >
              {busy === 'witnessing' ? 'Witnessing…' : 'Witness now'}
            </button>
            <button
              style={busy === 'locking' ? style.disabledBtn : style.secondaryBtn}
              disabled={busy !== null || !selectedId || (detail.project.status !== 'unlocked' && detail.project.status !== 'checkpointed')}
              onClick={triggerLock}
            >
              {busy === 'locking' ? 'Locking…' : 'Lock & Anchor'}
            </button>
          </section>
        </>
      )}

      {errorMsg && <p style={style.error}>{errorMsg}</p>}

      <footer style={style.footer}>
        {/* Navigate the palette itself to the full Scruple Studio dashboard.
            The user can drag the palette wider to see the dashboard at a
            usable size. Restarting the add-in brings them back to this
            palette view. */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            window.location.href = '/';
          }}
          style={style.link}
        >
          Open full dashboard in palette →
        </a>
        <br />
        <a
          href="https://scruple.stooges.ai"
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...style.link, fontSize: 11, opacity: 0.7 }}
        >
          (or open in system browser)
        </a>
      </footer>
    </div>
  );
}

// ----------------------------------------------------------- inline styles
// Inline so the palette doesn't depend on Tailwind classes loading. Once
// we're confident the palette's WebEngine respects our Tailwind build,
// these can migrate to className.

const style = {
  pane: {
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    padding: 12,
    maxWidth: 420,
    background: '#0b0b0c',
    color: '#e6e6e6',
    minHeight: '100vh',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottom: '1px solid #232325',
    marginBottom: 12,
  } as React.CSSProperties,
  h2: { fontSize: 18, margin: '0 0 8px' } as React.CSSProperties,
  section: { marginBottom: 12 } as React.CSSProperties,
  label: {
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    color: '#9a9a9c',
    display: 'block',
    marginBottom: 4,
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
  statRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    fontSize: 13,
  } as React.CSSProperties,
  muted: { color: '#9a9a9c', fontSize: 12 } as React.CSSProperties,
  leafList: { listStyle: 'none', padding: 0, margin: 0 } as React.CSSProperties,
  leafItem: {
    display: 'flex',
    gap: 8,
    padding: '3px 0',
    fontSize: 12,
    borderBottom: '1px dashed #1f1f22',
  } as React.CSSProperties,
  seq: { color: '#9a9a9c', minWidth: 32 } as React.CSSProperties,
  hash: { fontFamily: 'ui-monospace, Menlo, monospace', color: '#e6e6e6' } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 16,
  } as React.CSSProperties,
  primaryBtn: {
    flex: 1,
    padding: '8px 12px',
    background: '#1f6feb',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
  } as React.CSSProperties,
  secondaryBtn: {
    flex: 1,
    padding: '8px 12px',
    background: 'transparent',
    color: '#e6e6e6',
    border: '1px solid #2a2a2d',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
  } as React.CSSProperties,
  disabledBtn: {
    flex: 1,
    padding: '8px 12px',
    background: '#2a2a2d',
    color: '#5a5a5d',
    border: 'none',
    borderRadius: 4,
    cursor: 'not-allowed',
    fontWeight: 600,
  } as React.CSSProperties,
  error: {
    background: '#3b1010',
    color: '#fca5a5',
    padding: 8,
    borderRadius: 4,
    fontSize: 12,
    margin: '8px 0 0',
  } as React.CSSProperties,
  footer: {
    marginTop: 24,
    paddingTop: 12,
    borderTop: '1px solid #232325',
    textAlign: 'center' as const,
    fontSize: 12,
  } as React.CSSProperties,
  link: { color: '#7dd3fc', textDecoration: 'none' } as React.CSSProperties,
};
