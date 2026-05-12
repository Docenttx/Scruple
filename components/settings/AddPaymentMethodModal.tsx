'use client';

// Stripe SetupIntent → attach card to the user's customer.
// Mounts Stripe Elements with a SetupIntent client_secret; on submit,
// Stripe confirms the card + attaches it to the customer (off_session
// usage means future charges don't re-prompt). After success, parent
// component refreshes the saved-methods list.

import { useEffect, useState } from 'react';
import { loadStripe, type Stripe as StripeType } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import ModalShell, { ModalButton } from '@/components/wallet/ModalShell';
import { addToast } from '@/lib/toast';

let stripePromise: Promise<StripeType | null> | null = null;
function getStripe(pk: string) {
  if (!stripePromise) stripePromise = loadStripe(pk);
  return stripePromise;
}

export default function AddPaymentMethodModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const res = await fetch('/api/stripe/setup-intent', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.clientSecret || !data.publishableKey) {
          throw new Error(data.detail || data.error || 'no client secret');
        }
        if (aborted) return;
        setClientSecret(data.clientSecret);
        setPublishableKey(data.publishableKey);
      } catch (e) {
        if (aborted) return;
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { aborted = true; };
  }, []);

  if (bootError) {
    return (
      <ModalShell
        tone="danger"
        title="Could not open card form"
        onClose={onClose}
        footer={<ModalButton onClick={onClose}>Close</ModalButton>}
      >
        <pre className="rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-3 text-2xs text-scruple-danger">
          {bootError}
        </pre>
      </ModalShell>
    );
  }

  if (!clientSecret || !publishableKey) {
    return (
      <ModalShell tone="info" title="Add Payment Method" onClose={onClose}>
        <div className="flex items-center justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-scruple-border-color border-t-scruple-accent-primary" />
          <span className="ml-3 text-xs text-scruple-text-secondary">
            Preparing Stripe form…
          </span>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      tone="info"
      title="Add Payment Method"
      subtitle="Saved cards are stored on Stripe — Scruple never sees the card number."
      onClose={onClose}
      wide
    >
      <Elements
        stripe={getStripe(publishableKey)}
        options={{ clientSecret, appearance: { theme: 'night' } }}
      >
        <InnerForm onClose={onClose} onSuccess={onSuccess} />
      </Elements>
    </ModalShell>
  );
}

function InnerForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setErr(null);
    setSubmitting(true);

    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: typeof window !== 'undefined' ? window.location.href : 'https://scruple.stooges.ai/settings',
      },
      redirect: 'if_required',
    });

    if (error) {
      setErr(error.message ?? 'Card setup failed');
      setSubmitting(false);
      return;
    }
    addToast({ tone: 'success', title: 'Card saved' });
    onSuccess();
    onClose();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PaymentElement />
      {err && (
        <pre className="rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-2 text-2xs text-scruple-danger">
          {err}
        </pre>
      )}
      <div className="flex items-center justify-end gap-2">
        <ModalButton onClick={onClose} type="button" disabled={submitting}>
          Cancel
        </ModalButton>
        <ModalButton type="submit" variant="primary" disabled={!stripe || !elements || submitting}>
          {submitting ? 'Saving…' : 'Save card'}
        </ModalButton>
      </div>
    </form>
  );
}
