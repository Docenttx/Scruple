// GET /api/health
//
// Aggregated health check for the connection-status pills on the
// sidebar. Probes the three external services the desktop app
// monitors:
//
//   - Witness server (/health on :5799)
//   - Ravencoin daemon (RPC ping; stub if not wired)
//   - Stripe (proxied through witness: /api/stripe-config)
//
// Returns the same shape every time so the client pill component
// doesn't have to special-case missing services. Each entry has:
//   { ok: boolean | null, label: string, detail?: string }
// where null = unknown / not yet wired.

import { NextResponse } from 'next/server';

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
  const [witnessProbe, stripeProbe] = await Promise.all([
    probe(`${WITNESS_URL}/health`),
    probe(`${WITNESS_URL}/api/stripe-config`),
  ]);

  // RVN: we don't have an RPC client wired yet (that's WO-42). Stub as
  // unknown until then; the pill renders grey.
  return NextResponse.json({
    witness: { ok: witnessProbe.ok, label: 'Witness', detail: witnessProbe.detail },
    rvn: { ok: null, label: 'RVN', detail: 'not wired' },
    stripe: { ok: stripeProbe.ok, label: 'Stripe', detail: stripeProbe.detail },
    checkedAt: new Date().toISOString(),
  });
}
