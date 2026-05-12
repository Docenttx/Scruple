'use client';

// Pivot S7 · Settings → Storage tab. Lets the user connect Google
// Drive as their content storage. Mirrors the Stooges pattern: one
// provider per account, no scruple-managed storage.

import { useEffect, useState } from 'react';

interface Status {
  connected: boolean;
  email?: string;
  name?: string;
  connectedAt?: string;
  provider?: string;
}

export default function StorageSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    try {
      const res = await fetch('/api/auth/gdrive/status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function disconnect() {
    setLoading(true);
    try {
      await fetch('/api/auth/gdrive/disconnect', { method: 'POST' });
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Storage (BYOS)</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Scruple records hashes and provenance metadata. Your actual image bytes
        live in your own Drive — we don&apos;t store them. (Pivot D-017.)
      </p>

      <div className="mt-4 rounded-md border border-scruple-border bg-scruple-surface p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm">
              <span className="font-medium">Google Drive</span>
              {status?.connected && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-scruple-success/40 bg-scruple-success/10 px-2 py-0.5 text-[10px] text-scruple-success">
                  ● connected
                </span>
              )}
            </div>
            {status?.connected ? (
              <div className="mt-1 text-[11px] text-scruple-muted">
                {status.email ?? '(no email)'} — connected {status.connectedAt}
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-scruple-muted">
                Not connected. Iterations fall back to local storage until you connect.
              </div>
            )}
            <div className="mt-2 text-[10px] text-scruple-muted">
              Scope: <code>drive.file</code> — Scruple can only see files it created.
            </div>
          </div>

          <div className="flex gap-2">
            {status?.connected ? (
              <button
                type="button"
                onClick={disconnect}
                disabled={loading}
                className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-danger hover:text-scruple-danger disabled:opacity-50"
              >
                Disconnect
              </button>
            ) : (
              <a
                href="/api/auth/gdrive/connect"
                className="rounded-md border border-scruple-accent bg-scruple-accent/15 px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-accent/30"
              >
                Connect Google Drive
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 opacity-50">
        <div className="rounded-md border border-scruple-border bg-scruple-surface p-3 text-xs">
          <div className="text-sm">Microsoft OneDrive</div>
          <div className="mt-1 text-[10px] text-scruple-muted">Coming next (Pivot S4)</div>
        </div>
        <div className="rounded-md border border-scruple-border bg-scruple-surface p-3 text-xs">
          <div className="text-sm">GitHub</div>
          <div className="mt-1 text-[10px] text-scruple-muted">Coming next (Pivot S5)</div>
        </div>
      </div>
    </section>
  );
}
