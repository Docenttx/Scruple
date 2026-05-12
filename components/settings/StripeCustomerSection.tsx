'use client';

// Settings → Stripe Account (when payment mode = Fiat).
//
// Read-only display tonight. The "Add payment method" CTA is wired to
// kick off the SetupIntent flow once the saved-card UI lands in a
// follow-up (clone-3-followup).

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

interface CustomerSnapshot {
  customerId: string;
  email: string | null;
  defaultPaymentMethodId: string | null;
  paymentMethods: PaymentMethod[];
}

export default function StripeCustomerSection() {
  const [snap, setSnap] = useState<CustomerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/customer', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setSnap(data.customer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function ensure() {
    setCreating(true);
    try {
      const res = await fetch('/api/stripe/customer', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setSnap(data.customer);
      addToast({ tone: 'success', title: 'Stripe customer ready', detail: data.customerId });
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not create Stripe customer',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Stripe Account</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Per-user Stripe customer. Lock fees charge against saved payment
        methods (saved-card management lands in the next build).
      </p>

      <div className="mt-3 rounded-md border border-scruple-border bg-scruple-surface p-4">
        {loading ? (
          <div className="text-xs text-scruple-muted">Loading…</div>
        ) : error ? (
          <div className="text-xs text-scruple-danger">Error: {error}</div>
        ) : !snap ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Not connected to Stripe yet</div>
              <div className="mt-1 text-[11px] text-scruple-muted">
                We create a Stripe customer for you the first time you need one
                (or you can create it now).
              </div>
            </div>
            <button
              type="button"
              onClick={ensure}
              disabled={creating}
              className="rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/15 px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-accent-primary/30 disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create Stripe Customer'}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">{snap.email ?? '(no email on file)'}</div>
                <div className="mt-0.5 text-[10px] font-mono text-scruple-muted">
                  {snap.customerId}
                </div>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-scruple-success/40 bg-scruple-success/10 px-2 py-0.5 text-[10px] text-scruple-success">
                ● connected
              </span>
            </div>

            <div className="mt-4 border-t border-scruple-border pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-scruple-muted">
                  Saved Payment Methods
                </span>
                <button
                  type="button"
                  disabled
                  title="Saved-card management lands in the next build"
                  className="rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-[10px] text-scruple-muted disabled:cursor-not-allowed"
                >
                  + Add (next build)
                </button>
              </div>

              {snap.paymentMethods.length === 0 ? (
                <div className="text-[11px] text-scruple-muted">
                  No saved cards. You&apos;ll be prompted to enter one the first
                  time you trigger a paid chain lock.
                </div>
              ) : (
                <ul className="space-y-1 text-xs">
                  {snap.paymentMethods.map(pm => (
                    <li
                      key={pm.id}
                      className="flex items-center justify-between rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono uppercase">{pm.brand}</span>
                        <span className="font-mono text-scruple-muted">•••• {pm.last4}</span>
                        <span className="text-[10px] text-scruple-muted">
                          {pm.expMonth.toString().padStart(2, '0')}/{pm.expYear.toString().slice(-2)}
                        </span>
                      </div>
                      {pm.isDefault && (
                        <span className="text-[9px] uppercase tracking-widest text-scruple-success">
                          default
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
