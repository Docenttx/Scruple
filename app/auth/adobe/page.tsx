// /auth/adobe — handshake page opened by Adobe UXP plugins.
//
// Plugin calls uxp.shell.openExternal to bring the user here with
// ?session=<uuid>&product=<host_app>. If the user is signed in, we
// mint an API key scoped to that host_app and drop it into the
// /api/scruple/handoff slot, then show a "Return to <Host>" confirmation.
// If not signed in, we redirect to /login and come back after auth.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';

const HOST_LABELS: Record<string, string> = {
  photoshop: 'Photoshop',
  illustrator: 'Illustrator',
  indesign: 'InDesign',
  premiere: 'Premiere Pro',
  after_effects: 'After Effects',
  lightroom: 'Lightroom Classic',
};

export default async function AdobeAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; product?: string }>;
}) {
  const params = await searchParams;
  const sessionArg = params.session ?? '';
  const product = params.product ?? 'photoshop';
  const label = HOST_LABELS[product] ?? 'Adobe';

  if (!sessionArg) {
    return (
      <div style={{ padding: 40 }}>
        <h1>Scruple × {label}</h1>
        <p>Missing session parameter. Restart the sign-in from the plugin panel.</p>
      </div>
    );
  }

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    // Send to login, then back here
    const back = encodeURIComponent(`/auth/adobe?session=${sessionArg}&product=${product}`);
    redirect(`/login?callbackUrl=${back}`);
  }

  // Mint API key scoped to this Adobe host_app + drop into handoff slot.
  // Existing keys for the same (user, product) are revoked to keep
  // one-key-per-app invariant.
  conn()
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now')
        WHERE user_id = ? AND product = ? AND revoked_at IS NULL`,
    )
    .run(userId, product);

  const rawKey = `sk_${product}_${nanoid(32)}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  conn()
    .prepare(
      `INSERT INTO api_keys (user_id, key_hash, product, created_at)
        VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(userId, keyHash, product);

  // Drop into handoff slot the plugin poll will pick up
  conn()
    .prepare(
      `INSERT INTO handoff_slots (session_id, product, user_id, api_key, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(session_id, product) DO UPDATE SET
          user_id    = excluded.user_id,
          api_key    = excluded.api_key,
          created_at = excluded.created_at`,
    )
    .run(sessionArg, product, userId, rawKey);

  return (
    <div style={{ padding: 40, maxWidth: 480, margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1 style={{ color: '#c94a4a' }}>Scruple × {label}</h1>
      <p style={{ fontSize: 14, color: '#666' }}>
        Signed in as <strong>{session?.user?.email}</strong>.
      </p>
      <p style={{ marginTop: 24, padding: 16, background: '#f5f5f5', borderRadius: 6 }}>
        Return to <strong>{label}</strong>. The Scruple panel should switch to
        the active view within a few seconds — the plugin is polling for
        the newly-minted API key.
      </p>
      <p style={{ marginTop: 24, fontSize: 12, color: '#999' }}>
        You can close this tab.
      </p>
    </div>
  );
}
