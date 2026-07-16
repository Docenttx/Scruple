export type PaidAction =
  | 'checkpoint'
  | 'finalize'
  | 'chain-lock-basic'
  | 'chain-lock-pinned';

export interface ActionPrice {
  action: PaidAction;
  amount_cents: number;
  currency: 'usd';
  label: string;
  short_label: string;
  description: string;
}

export const ACTION_CATALOG: Record<PaidAction, ActionPrice> = {
  checkpoint: {
    action: 'checkpoint',
    amount_cents: 500,
    currency: 'usd',
    label: 'Checkpoint',
    short_label: 'Checkpoint',
    description: 'Publish a per-iteration receipt page.',
  },
  finalize: {
    action: 'finalize',
    amount_cents: 1000,
    currency: 'usd',
    label: 'C2PA sign',
    short_label: 'C2PA',
    description: 'Emit a C2PA v2.x signed manifest for the export.',
  },
  'chain-lock-basic': {
    action: 'chain-lock-basic',
    amount_cents: 10000,
    currency: 'usd',
    label: 'Chain-lock (basic)',
    short_label: 'Chain-lock',
    description: 'Merkle root anchored to a public ledger.',
  },
  'chain-lock-pinned': {
    action: 'chain-lock-pinned',
    amount_cents: 15000,
    currency: 'usd',
    label: 'Chain-lock (pinned)',
    short_label: 'Chain-lock+',
    description: 'Merkle root anchored to a public ledger with IPFS + Arweave pinning.',
  },
};

export function priceFor(action: PaidAction): ActionPrice {
  return ACTION_CATALOG[action];
}

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
