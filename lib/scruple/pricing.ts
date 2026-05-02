// Lock pricing tiers in cents. Mirrors witness server's STRIPE_FEES so
// the displayed price and the charged price match.
//
// Source: research/sessions/04-market-pricing.md (consumer $10–30/mo,
// enterprise $50–200/seat). v1 keeps it conservative + non-recurring.

export const LOCK_PRICES_USD_CENTS = {
  finalize: 500,            // $5  — local lock + witness
  checkpoint: 500,          // $5  — soft lock, retains capture
  'chain-lock-basic': 5000, // $50 — witness + RVN
  'chain-lock-pinned': 6500,// $65 — witness + RVN + IPFS pin + Arweave commit
} as const;

export type LockAction = keyof typeof LOCK_PRICES_USD_CENTS;

export function priceFor(action: LockAction): number {
  return LOCK_PRICES_USD_CENTS[action];
}

export function priceLabel(action: LockAction): string {
  const cents = LOCK_PRICES_USD_CENTS[action];
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
