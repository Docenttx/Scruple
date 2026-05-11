// GET /api/wallet/rvn?network=mainnet|testnet
//
// Surfaces ravend wallet state for the wallet view. Read-only — no
// transactions, no key material exposed. Per D-012 the per-user wallet
// architecture is deferred; for now this reports the on-box wallet
// loaded into ravend.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { ravend, type RavenNetwork } from '@/lib/scruple/ravend';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const networkRaw = url.searchParams.get('network') ?? 'mainnet';
  const network: RavenNetwork = networkRaw === 'testnet' ? 'testnet' : 'mainnet';

  if (!ravend.isConfigured(network)) {
    return NextResponse.json({
      network,
      ok: false,
      detail: `ravend ${network} not configured`,
    });
  }

  const health = await ravend.health(network);
  if (!health.ok) {
    return NextResponse.json({ network, ok: false, detail: health.detail });
  }

  // Wallet info — guarded individually so one failure doesn't blank
  // the whole response.
  let wallets: string[] | null = null;
  let balance: number | null = null;
  let assets: string[] = [];
  try {
    wallets = await ravend.listWallets(network);
  } catch { /* ignore */ }
  try {
    balance = await ravend.getBalance(network);
  } catch { /* ignore */ }
  try {
    const assetMap = await ravend.listMyAssets(network);
    assets = Object.keys(assetMap);
  } catch { /* ignore */ }

  return NextResponse.json({
    network,
    ok: true,
    chain: health.chain,
    blockHeight: health.height,
    wallets,
    balance,
    assetCount: assets.length,
    scrupleAssets: assets.filter(a => a.startsWith('SCR_')),
  });
}
