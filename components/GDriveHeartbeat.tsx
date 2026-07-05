'use client';

// Silent background heartbeat for Google Drive tokens. Runs once per
// page mount:
//   - Confirms gdrive_tokens row exists for the current user
//   - If expires_at is within 24h, refreshes the access_token
//   - If refresh_token is revoked, surfaces a toast + link to reconnect
//   - If NO row exists, surfaces a toast prompting connection
// User never has to think about token freshness.

import { useEffect, useRef } from 'react';
import { useToast } from '@/lib/store/toast';

interface HeartbeatResp {
  connected?: boolean;
  refreshed?: boolean;
  refresh_failed?: boolean;
  expires_at?: number;
  seconds_to_expiry?: number;
  user_email?: string | null;
  error?: string;
  hint?: string;
}

export default function GDriveHeartbeat() {
  const done = useRef(false);
  const push = useToast((s) => s.push);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    (async () => {
      try {
        const res = await fetch('/api/auth/gdrive/heartbeat', { cache: 'no-store' });
        if (res.status === 401) return; // not signed in — no-op
        const data = (await res.json()) as HeartbeatResp;

        if (data.connected === false) {
          push({
            tone: 'warn',
            title: 'Google Drive not connected',
            body: 'Sign-in did not include Drive access. Reconnect to enable capture backups.',
            link: { href: '/api/auth/gdrive/connect', label: 'Connect Drive' },
          });
          return;
        }
        if (data.refresh_failed) {
          push({
            tone: 'error',
            title: 'Google Drive session expired',
            body: 'Your refresh token was revoked. Reconnect to keep captures backed up.',
            link: { href: '/api/auth/gdrive/connect', label: 'Reconnect Drive' },
          });
          return;
        }
        if (data.refreshed) {
          // Silent success — no user-facing toast. Just console log for dev.
          console.info('[gdrive] refreshed access_token', {
            seconds_to_expiry: data.seconds_to_expiry,
          });
        }
      } catch (e) {
        // Network hiccup — no-op. Next mount will retry.
        console.warn('[gdrive] heartbeat network error', e);
      }
    })();
  }, [push]);

  return null;
}
