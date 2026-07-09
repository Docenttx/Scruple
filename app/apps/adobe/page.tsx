// /apps/adobe — dashboard listing the Scruple Adobe CC plugins + install
// instructions per host app.
//
// Reads heartbeat state from handoff_slots so we can show which plugins
// are actively installed for this user.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import AppShell from '@/components/AppShell';

interface Row {
  product: string;
  last_seen: string | null;
}

const APPS = [
  {
    id: 'photoshop',
    name: 'Photoshop',
    tagline: 'Every PSD save witnessed',
    minVersion: '24+',
    manifestUrl:
      'https://scruple.stooges.ai/downloads/scruple-adobe/photoshop.zip',
  },
  {
    id: 'illustrator',
    name: 'Illustrator',
    tagline: 'Every vector save witnessed',
    minVersion: '27+',
    manifestUrl:
      'https://scruple.stooges.ai/downloads/scruple-adobe/illustrator.zip',
  },
  {
    id: 'indesign',
    name: 'InDesign',
    tagline: 'Every layout save witnessed',
    minVersion: '18+',
    manifestUrl:
      'https://scruple.stooges.ai/downloads/scruple-adobe/indesign.zip',
  },
  {
    id: 'premiere',
    name: 'Premiere Pro',
    tagline: 'Coming soon',
    minVersion: '25+',
    manifestUrl: '',
  },
  {
    id: 'lightroom',
    name: 'Lightroom Classic',
    tagline: 'Coming soon (Lua plugin)',
    minVersion: '13+',
    manifestUrl: '',
  },
];

export default async function AdobeAppsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  // Which plugins have phoned home recently?
  const rows = conn()
    .prepare(
      `SELECT product, MAX(created_at) AS last_seen
         FROM handoff_slots
        WHERE user_id = ?
        GROUP BY product`,
    )
    .all(userId) as Row[];
  const lastSeen = new Map(rows.map((r) => [r.product, r.last_seen]));

  return (
    <AppShell>
      <div className="p-8">
        <h1 className="text-2xl font-bold text-scruple-accent-primary">
          Scruple for Adobe Creative Cloud
        </h1>
        <p className="mt-2 text-sm text-scruple-muted">
          One-consent install per host app. Every save gets a witnessed leaf,
          receipt-ready.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((a) => {
            const seen = lastSeen.get(a.id);
            const enabled = !!a.manifestUrl;
            return (
              <div
                key={a.id}
                className="rounded-md border border-scruple-border bg-scruple-surface p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-scruple-text">
                      {a.name}
                    </h3>
                    <p className="text-xs text-scruple-muted">
                      Adobe {a.name} {a.minVersion}
                    </p>
                  </div>
                  {seen ? (
                    <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-green-400">
                      Installed
                    </span>
                  ) : (
                    <span className="rounded-full bg-scruple-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-scruple-muted">
                      Not seen
                    </span>
                  )}
                </div>
                <p className="mt-3 text-xs text-scruple-text-secondary">
                  {a.tagline}
                </p>
                {enabled ? (
                  <a
                    href={a.manifestUrl}
                    className="mt-4 inline-block rounded bg-scruple-accent-primary px-3 py-1.5 text-xs font-semibold text-scruple-bg"
                  >
                    Download plugin
                  </a>
                ) : (
                  <button
                    disabled
                    className="mt-4 rounded bg-scruple-bg px-3 py-1.5 text-xs text-scruple-muted"
                  >
                    Coming soon
                  </button>
                )}
                {seen && (
                  <div className="mt-3 text-[10px] uppercase tracking-widest text-scruple-muted">
                    last heartbeat · {seen.slice(0, 19)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-10 rounded-md border border-scruple-border bg-scruple-surface p-5">
          <h3 className="text-sm font-semibold text-scruple-text">
            Install steps
          </h3>
          <ol className="mt-3 space-y-2 text-xs text-scruple-text-secondary">
            <li>
              1. Install the target Adobe app via Creative Cloud desktop
              (any subscription or trial works).
            </li>
            <li>
              2. Install <strong>UXP Developer Tool</strong> from the CC
              Marketplace (free).
            </li>
            <li>
              3. Download the plugin zip above. Unzip it.
            </li>
            <li>
              4. Open UDT → Add Plugin → select the unzipped folder&apos;s{' '}
              <code className="rounded bg-scruple-bg px-1">manifest.json</code>.
            </li>
            <li>
              5. Click <strong>Load</strong> next to the plugin. It appears in
              the host app under Window → Plugins → Scruple.
            </li>
            <li>
              6. Sign in from the panel — you&apos;ll come back to this page,
              then return to the host app. Panel switches to the active view.
            </li>
          </ol>
        </div>
      </div>
    </AppShell>
  );
}
