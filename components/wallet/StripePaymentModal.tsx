'use client';

// WO-40 · Stripe Payment Element modal.
//
// Full Stripe Element-driven payment flow.
//
//   1. On open: fetch /api/stripe/config for the publishableKey;
//      fetch /api/stripe/payment-intent for clientSecret + amount.
//   2. Mount <Elements stripe={...} options={{ clientSecret }}>.
//   3. PaymentElement renders Stripe's card / Apple Pay / Google Pay /
//      Link UI.
//   4. On submit, call stripe.confirmPayment({ confirmParams }) and
//      block redirect (we handle success in-app).
//   5. On success, POST /api/stripe/confirm to verify + execute the
//      lock action on the witness server.
//   6. Hand the lock result back via onSuccess prop.

import { useEffect, useState } from 'react';
import { loadStripe, type Stripe as StripeType } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import ModalShell, { ModalButton } from './ModalShell';
import type { LockKind, ChainTier } from './LockConfirmModal';
import type { LockResult } from './LockResultModal';

type StripeAction = 'finalize' | 'checkpoint' | 'chain-lock-basic' | 'chain-lock-pinned';

function stripeAction(kind: LockKind, tier?: ChainTier): StripeAction {
  if (kind === 'local') return 'finalize';
  if (kind === 'checkpoint') return 'checkpoint';
  return tier === 'pinned' ? 'chain-lock-pinned' : 'chain-lock-basic';
}

// Re-use the loaded Stripe instance across modal mounts (Stripe.js docs
// recommend hoisting the loadStripe call to module scope).
let stripePromise: Promise<StripeType | null> | null = null;
function getStripe(publishableKey: string) {
  if (!stripePromise) {
    stripePromise = loadStripe(publishableKey);
  }
  return stripePromise;
}

export default function StripePaymentModal({
  projectId,
  projectName,
  kind,
  tier,
  onClose,
  onSuccess,
}: {
  projectId: number;
  projectName: string;
  kind: LockKind;
  tier?: ChainTier;
  onClose: () => void;
  onSuccess: (result: LockResult) => void;
}) {
  const action = stripeAction(kind, tier);

  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Bootstrap: fetch publishable key + create payment intent in parallel.
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const [cfgRes, piRes] = await Promise.all([
          fetch('/api/stripe/config', { cache: 'no-store' }),
          fetch('/api/stripe/payment-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, projectId }),
          }),
        ]);
        const cfg = (await cfgRes.json()) as { publishableKey?: string; error?: string };
        const pi = (await piRes.json()) as {
          clientSecret?: string;
          paymentIntentId?: string;
          amount?: number;
          error?: string;
        };
        if (!cfgRes.ok || !cfg.publishableKey) {
          throw new Error(cfg.error ?? 'Stripe config unavailable');
        }
        if (!piRes.ok || !pi.clientSecret) {
          throw new Error(pi.error ?? 'PaymentIntent creation failed');
        }
        if (aborted) return;
        setPublishableKey(cfg.publishableKey);
        setClientSecret(pi.clientSecret);
        setPaymentIntentId(pi.paymentIntentId ?? null);
        setAmountCents(pi.amount ?? null);
      } catch (e) {
        if (aborted) return;
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      aborted = true;
    };
  }, [action, projectId]);

  const titleByAction: Record<StripeAction, string> = {
    finalize: 'Finalize Project — Payment',
    checkpoint: 'Checkpoint Project — Payment',
    'chain-lock-basic': 'Chain Lock (Basic) — Payment',
    'chain-lock-pinned': 'Chain Lock (Pinned) — Payment',
  };

  if (bootError) {
    return (
      <ModalShell
        tone="danger"
        title="Payment unavailable"
        onClose={onClose}
        footer={<ModalButton onClick={onClose}>Close</ModalButton>}
      >
        <p className="text-scruple-muted">Could not start the payment flow.</p>
        <pre className="mt-3 rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-3 text-[11px] text-scruple-danger">
          {bootError}
        </pre>
      </ModalShell>
    );
  }

  if (!publishableKey || !clientSecret) {
    return (
      <ModalShell tone="purple" title={titleByAction[action]} onClose={onClose}>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-scruple-border border-t-scruple-accent" />
          <span className="ml-3 text-xs text-scruple-muted">
            Connecting to payment provider…
          </span>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      tone="purple"
      title={titleByAction[action]}
      subtitle={
        amountCents != null
          ? `${projectName} · $${(amountCents / 100).toFixed(2)}`
          : projectName
      }
      onClose={onClose}
      wide
    >
      <Elements
        stripe={getStripe(publishableKey)}
        options={{ clientSecret, appearance: { theme: 'night' } }}
      >
        <InnerForm
          projectId={projectId}
          kind={kind}
          action={action}
          paymentIntentId={paymentIntentId!}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </Elements>
    </ModalShell>
  );
}

function InnerForm({
  projectId,
  kind,
  action,
  paymentIntentId,
  onClose,
  onSuccess,
}: {
  projectId: number;
  kind: LockKind;
  action: StripeAction;
  paymentIntentId: string;
  onClose: () => void;
  onSuccess: (result: LockResult) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'card' | 'verifying' | 'executing'>('card');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setErr(null);
    setSubmitting(true);
    setPhase('card');

    // 1. Confirm the payment on the client.
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // The witness server will trigger the redirect-less branch by
        // verifying intent status; we don't need a return_url.
        return_url: typeof window !== 'undefined' ? window.location.href : 'https://scruple.stooges.ai/',
      },
      redirect: 'if_required',
    });
    if (error) {
      setErr(error.message ?? 'Payment failed');
      setSubmitting(false);
      return;
    }

    // 2. Server-side verify + execute the lock action.
    setPhase('verifying');
    try {
      const res = await fetch('/api/stripe/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId, action, projectId }),
      });
      const data = (await res.json()) as Partial<LockResult> & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setPhase('executing');
      onSuccess({
        ok: true,
        kind,
        scrId: data.scrId,
        merkleRoot: data.merkleRoot,
        rvnTxId: data.rvnTxId,
        ipfsCid: data.ipfsCid,
        arweaveTxId: data.arweaveTxId,
        paymentRef: paymentIntentId,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PaymentElement />
      {err && (
        <pre className="rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-2 text-[11px] text-scruple-danger">
          {err}
        </pre>
      )}
      <div className="flex items-center justify-end gap-2">
        <ModalButton onClick={onClose} type="button" disabled={submitting}>
          Cancel
        </ModalButton>
        <ModalButton
          type="submit"
          variant="primary"
          disabled={!stripe || !elements || submitting}
        >
          {submitting
            ? phase === 'verifying'
              ? 'Verifying…'
              : phase === 'executing'
                ? 'Executing lock…'
                : 'Processing…'
            : 'Pay Now'}
        </ModalButton>
      </div>
    </form>
  );
}
