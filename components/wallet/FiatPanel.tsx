'use client';

// WO-38/39 · Fiat-mode wallet panel.
//
// Port of renderStripePanel() — payment methods card, fee schedule,
// TSD (Test SCRUPLE Dollar) balance + Add buttons, and the IPFS
// configuration card. Stripe is the only "ACTIVE" payment method; the
// others are SOON placeholders matching the desktop.

import { useEffect, useState } from 'react';
import { useWallet } from '@/lib/store/wallet';
import { addToast } from '@/lib/toast';

interface TsdBalance {
  ok: boolean;
  balance?: number;
  detail?: string;
}

const FEES = [
  { label: 'Checkpoint Project', fiat: '$5.00', tsd: '5 TSD' },
  { label: 'Finalize Project', fiat: '$5.00', tsd: '5 TSD' },
  { label: 'Basic Chain Lock', fiat: '$50.00', tsd: '50 TSD' },
  { label: 'Pinned Chain Lock', fiat: '$65.00', tsd: '65 TSD' },
];

export default function FiatPanel() {
  const openModal = useWallet(s => s.openModal);
  const [tsd, setTsd] = useState<TsdBalance | null>(null);

  useEffect(() => {
    fetch('/api/wallet/tsd', { cache: 'no-store' })
      .then(r => r.json())
      .then(setTsd)
      .catch(() => setTsd({ ok: false, detail: 'fetch failed' }));
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Payment methods card */}
      <section className="rounded-lg border border-scruple-border bg-scruple-surface p-5">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">
          Payment Method
        </h2>
        <div className="space-y-2">
          <PaymentMethod label="Stripe" status="ACTIVE" detail="Card · Google Pay · Apple Pay · Link" />
          <PaymentMethod label="PayPal" status="SOON" />
          <PaymentMethod label="Google Pay" status="SOON" />
          <PaymentMethod label="Apple Pay" status="SOON" />
        </div>
      </section>

      {/* TSD balance */}
      <section className="rounded-lg border border-scruple-border bg-scruple-surface p-5">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">
          Test SCRUPLE Dollar (TSD)
        </h2>
        <div className="mb-4 flex items-baseline gap-2">
          <span className="text-3xl font-light text-scruple-text">
            {tsd?.ok ? (tsd.balance ?? 0).toFixed(2) : '—'}
          </span>
          <span className="text-xs text-scruple-muted">TSD</span>
        </div>
        {tsd && !tsd.ok && (
          <p className="mb-3 text-[11px] text-scruple-warn">
            TSD balance unavailable: {tsd.detail}
          </p>
        )}
        <div className="flex gap-2">
          {[10, 50, 100].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => {
                fetch('/api/wallet/tsd', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ amount: n }),
                })
                  .then(r => r.json())
                  .then(d => {
                    if (d.ok) {
                      setTsd(d);
                      addToast({ tone: 'success', title: `+${n} TSD added` });
                    } else {
                      addToast({ tone: 'error', title: 'TSD fund failed', detail: d.detail });
                    }
                  })
                  .catch(e => addToast({ tone: 'error', title: 'TSD fund failed', detail: String(e) }));
              }}
              className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-fuchsia-500"
            >
              Add {n} TSD
            </button>
          ))}
        </div>
      </section>

      {/* Fee schedule */}
      <section className="rounded-lg border border-scruple-border bg-scruple-surface p-5 lg:col-span-2">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">
          Fee Schedule
        </h2>
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-widest text-scruple-muted">
            <tr>
              <th className="pb-2 text-left font-normal">Action</th>
              <th className="pb-2 text-right font-normal">Fiat</th>
              <th className="pb-2 text-right font-normal">TSD</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-scruple-border">
            {FEES.map(f => (
              <tr key={f.label}>
                <td className="py-2">{f.label}</td>
                <td className="py-2 text-right font-mono">{f.fiat}</td>
                <td className="py-2 text-right font-mono text-fuchsia-400">{f.tsd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* IPFS config */}
      <section className="rounded-lg border border-scruple-border bg-scruple-surface p-5 lg:col-span-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
              IPFS Configuration
            </h2>
            <p className="mt-1 text-xs text-scruple-muted">
              Gateway and pinning service for persistent-lock uploads.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openModal('ipfs-config')}
            className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent"
          >
            Configure
          </button>
        </div>
      </section>
    </div>
  );
}

function PaymentMethod({
  label,
  status,
  detail,
}: {
  label: string;
  status: 'ACTIVE' | 'SOON';
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-scruple-border bg-scruple-bg px-3 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {detail && <div className="text-[11px] text-scruple-muted">{detail}</div>}
      </div>
      <span
        className={
          'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-widest ' +
          (status === 'ACTIVE'
            ? 'border border-scruple-success/40 bg-scruple-success/10 text-scruple-success'
            : 'border border-scruple-border text-scruple-muted')
        }
      >
        {status}
      </span>
    </div>
  );
}
