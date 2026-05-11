// GET /api/wallet/tsd       → current TSD balance
// POST /api/wallet/tsd      { amount } → fund testnet TSD
//
// TSD is the desktop's test-mode payment token, gated by the witness
// server. Endpoints proxy through with the user's installation id
// (we use their NextAuth user id).

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';
const PROBE_TIMEOUT_MS = 3000;

async function witnessFetch(path: string, init?: RequestInit) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(`${WITNESS_URL}${path}`, { ...init, signal: ac.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ ok: false, detail: 'Unauthorized' }, { status: 401 });
  }

  try {
    const res = await witnessFetch(`/api/tsd/balance/${encodeURIComponent(userId)}`);
    if (!res.ok) {
      return NextResponse.json({ ok: false, detail: `witness HTTP ${res.status}` });
    }
    const data = (await res.json()) as { balance?: number };
    return NextResponse.json({ ok: true, balance: data.balance ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ ok: false, detail: 'Unauthorized' }, { status: 401 });
  }

  let amount: number;
  try {
    const body = (await req.json()) as { amount?: number };
    amount = Number(body?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ ok: false, detail: 'amount must be a positive number' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ ok: false, detail: 'Invalid body' }, { status: 400 });
  }

  try {
    const res = await witnessFetch('/api/tsd/fund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: userId, amount }),
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, detail: `witness HTTP ${res.status}` });
    }
    const data = (await res.json()) as { newBalance?: number };
    return NextResponse.json({ ok: true, balance: data.newBalance ?? null });
  } catch (e) {
    return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
