'use client';

// Fusion palette Settings → Payment section. Lists the user's saved
// Stripe cards, lets them add / remove / set default. Uses the existing
// AddPaymentMethodModal component under the hood.

import { useCallback, useEffect, useState } from 'react';
import AddPaymentMethodModal from '@/components/settings/AddPaymentMethodModal';

interface SavedCard {
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
  paymentMethods: SavedCard[];
}

export default function PaymentSettingsPanel({
  onChange,
}: {
  onChange?: (hasDefault: boolean) => void;
}) {
  const [snap, setSnap] = useState<CustomerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      let res = await fetch('/api/stripe/customer', { cache: 'no-store' });
      let data = (await res.json().catch(() => ({}))) as { customer?: CustomerSnapshot | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (!data.customer) {
        const created = await fetch('/api/stripe/customer', { method: 'POST' });
        const cd = (await created.json().catch(() => ({}))) as { customer?: CustomerSnapshot | null; error?: string };
        if (!created.ok) throw new Error(cd.error ?? `HTTP ${created.status}`);
        data = { customer: cd.customer ?? null };
      }
      setSnap(data.customer ?? null);
      onChange?.(!!data.customer?.defaultPaymentMethodId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setDefault = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/stripe/payment-method/${id}/default`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const removeCard = useCallback(async (id: string) => {
    if (!confirm('Remove this card?')) return;
    try {
      const res = await fetch(`/api/stripe/payment-method/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-scruple-muted">
        Loading payment methods…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-scruple-text">Payment</h2>
        <p className="mt-1 text-[11px] text-scruple-muted">
          Saved cards charged per action. No subscription. Cards are stored on Stripe;
          Scruple never sees the card number.
        </p>
      </div>

      {err && (
        <pre className="rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-2 text-[11px] text-scruple-danger">
          {err}
        </pre>
      )}

      {(snap?.paymentMethods ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-scruple-border p-4 text-center">
          <p className="text-xs text-scruple-muted">No payment methods on file.</p>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="mt-3 rounded border border-scruple-border bg-scruple-surface px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-hover"
          >
            Add card
          </button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {snap!.paymentMethods.map((pm) => (
              <li
                key={pm.id}
                className="flex items-center justify-between rounded-md border border-scruple-border bg-scruple-surface px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="text-[11px] uppercase tracking-wider text-scruple-muted">{pm.brand}</span>
                  <span className="font-mono text-xs text-scruple-text">•••• {pm.last4}</span>
                  <span className="text-[10px] text-scruple-muted">
                    {String(pm.expMonth).padStart(2, '0')}/{String(pm.expYear).slice(-2)}
                  </span>
                  {pm.isDefault && (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                      DEFAULT
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  {!pm.isDefault && (
                    <button
                      type="button"
                      onClick={() => void setDefault(pm.id)}
                      className="text-scruple-muted hover:text-scruple-text"
                    >
                      Set default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeCard(pm.id)}
                    className="text-scruple-danger/70 hover:text-scruple-danger"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="self-start rounded border border-scruple-border bg-scruple-surface px-3 py-1.5 text-xs text-scruple-text hover:bg-scruple-hover"
          >
            Add another card
          </button>
        </>
      )}

      {showAdd && (
        <AddPaymentMethodModal
          onClose={() => setShowAdd(false)}
          onSuccess={() => { void refresh(); }}
        />
      )}
    </div>
  );
}
