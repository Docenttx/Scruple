// GET /api/health
//
// Aggregated health check for the connection-status pills on the
// sidebar. Probes the three external services the desktop app
// monitors:
//
//   - Witness server (/health on :5799)
//   - Ravencoin daemon (mainnet RPC ping via lib/scruple/ravend)
//   - Stripe (proxied through witness: /api/stripe-config)
//
// Returns the same shape every time. Each entry:
//   { ok: boolean | null, label: string, detail?: string }
// where null = unknown / not yet wired.

import { NextResponse } from 'next/server';
import { ravend } from '@/lib/scruple/ravend';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';
const PROBE_TIMEOUT_MS = 1500;

async function probe(url: string, init?: RequestInit): Promise<{ ok: boolean; detail?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' });
    return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  const [witnessProbe, stripeProbe, rvnProbe] = await Promise.all([
    probe(`${WITNESS_URL}/health`),
    probe(`${WITNESS_URL}/api/stripe-config`),
    ravend.health('mainnet'),
  ]);

  return NextResponse.json({
    witness: { ok: witnessProbe.ok, label: 'Witness', detail: witnessProbe.detail },
    rvn: {
      ok: rvnProbe.ok,
      label: 'RVN',
      detail: rvnProbe.ok ? `${rvnProbe.chain} @ ${rvnProbe.height}` : rvnProbe.detail,
    },
    stripe: { ok: stripeProbe.ok, label: 'Stripe', detail: stripeProbe.detail },
    checkedAt: new Date().toISOString(),
  });
}
