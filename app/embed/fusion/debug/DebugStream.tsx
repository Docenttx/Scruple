'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface DiagEvent {
  ts: number;
  event: string;
  fields: Record<string, unknown>;
}

// Color-code events by category so the eye can pattern-match on live flow.
function categorize(event: string): string {
  if (event.startsWith('handoff') || event.startsWith('ensure_api_key') || event.startsWith('js_')) return 'auth';
  if (event === 'documentSaved' || event === 'documentActivated' || event.startsWith('_do_witness') || event.startsWith('witness_') || event === 'auto_bind_success') return 'witness';
  if (event.startsWith('cmd_') || event.startsWith('command')) return 'command';
  if (event.startsWith('thumb') || event.startsWith('scan_') || event.startsWith('project_')) return 'sync';
  if (event.startsWith('palette') || event.startsWith('bridge_')) return 'palette';
  if (event.includes('_error') || event.includes('err')) return 'error';
  return 'misc';
}

const CATEGORY_COLOR: Record<string, string> = {
  auth: '#5af',
  witness: '#5f5',
  command: '#fc5',
  sync: '#f5c',
  palette: '#8ff',
  error: '#f55',
  misc: '#aaa',
};

export default function DebugStream() {
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [categoryFilters, setCategoryFilters] = useState<Set<string>>(new Set());
  const [autoscroll, setAutoscroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sinceRef = useRef<number>(0);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/diag/fusion?since=${sinceRef.current}`, { cache: 'no-store' });
      const j = await r.json();
      const incoming: DiagEvent[] = j.events ?? [];
      if (incoming.length) {
        sinceRef.current = incoming[incoming.length - 1].ts;
        setEvents((prev) => {
          const merged = [...prev, ...incoming];
          return merged.length > 3000 ? merged.slice(-3000) : merged;
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (paused) return;
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [paused, poll]);

  useEffect(() => {
    if (autoscroll && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'auto' });
  }, [events, autoscroll]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return events.filter((e) => {
      const cat = categorize(e.event);
      if (categoryFilters.size && !categoryFilters.has(cat)) return false;
      if (!q) return true;
      const hay = `${e.event} ${JSON.stringify(e.fields)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [events, filter, categoryFilters]);

  const toggleCat = (cat: string) => {
    setCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#0a0a0a', color: '#eee', minHeight: '100vh' }}>
      <div style={{ position: 'sticky', top: 0, background: '#111', padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Fusion diag stream</strong>
        <span style={{ opacity: 0.6 }}>{events.length} events · showing {filtered.length}</span>
        <button onClick={() => setPaused((p) => !p)} style={btn}>{paused ? '▶ resume' : '⏸ pause'}</button>
        <button onClick={() => { setEvents([]); sinceRef.current = Date.now(); }} style={btn}>clear</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          autoscroll
        </label>
        <input
          type="text"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ background: '#000', color: '#eee', border: '1px solid #333', padding: '4px 8px', minWidth: 180 }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {Object.keys(CATEGORY_COLOR).map((cat) => (
            <button
              key={cat}
              onClick={() => toggleCat(cat)}
              style={{
                ...btn,
                borderColor: categoryFilters.has(cat) ? CATEGORY_COLOR[cat] : '#333',
                color: CATEGORY_COLOR[cat],
                opacity: categoryFilters.size === 0 || categoryFilters.has(cat) ? 1 : 0.3,
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: 8 }}>
        {filtered.map((e, i) => {
          const cat = categorize(e.event);
          const color = CATEGORY_COLOR[cat];
          const t = new Date(e.ts);
          const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
          return (
            <div key={`${e.ts}-${i}`} style={{ padding: '2px 4px', borderLeft: `3px solid ${color}`, marginBottom: 2 }}>
              <span style={{ opacity: 0.5 }}>{ts}</span>{' '}
              <span style={{ color, fontWeight: 600 }}>{e.event}</span>{' '}
              <span style={{ opacity: 0.85 }}>{formatFields(e.fields)}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const btn = {
  background: '#222',
  color: '#eee',
  border: '1px solid #333',
  padding: '4px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
} as const;

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([k]) => k !== 'has_api_key' || fields[k] !== false)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}
