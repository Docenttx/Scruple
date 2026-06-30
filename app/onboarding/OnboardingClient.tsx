'use client';

import { useCallback, useEffect, useState } from 'react';

interface OnboardingClientProps {
  next: string;
  userEmail: string;
  userName: string;
}

type Plan = 'free' | 'starter' | 'pro' | 'enterprise';

const PLANS: Array<{
  id: Plan;
  name: string;
  price: string;
  blurb: string;
  features: string[];
  requiresPayment: boolean;
}> = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    blurb: 'For trying Scruple. Up to 3 projects, basic chain lock.',
    features: ['3 projects max', 'Basic chain lock (RVN testnet)', 'Public receipts'],
    requiresPayment: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$19/mo',
    blurb: 'For independent creators with regular provenance needs.',
    features: ['Unlimited projects', 'Pinned chain lock ($65/lock)', '90-day audit history'],
    requiresPayment: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$99/mo',
    blurb: 'For design firms and IP-conscious workflows.',
    features: [
      'Everything in Starter',
      '5 pinned chain locks included',
      'Priority witness queue',
      'Per-project audit reports',
    ],
    requiresPayment: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Contact us',
    blurb: 'For regulated industries (aerospace / medical / defense).',
    features: [
      'Unlimited pinned locks',
      'Hard Scruple availability (FPGA-rooted)',
      'Dedicated witness server',
      'Custom SLAs + on-prem option',
    ],
    requiresPayment: false, // Contact-sales — no card collected during onboarding
  },
];

export default function OnboardingClient({ next, userEmail, userName }: OnboardingClientProps) {
  const [step, setStep] = useState<'plan' | 'payment' | 'tos' | 'finalizing'>('plan');
  const [selectedPlan, setSelectedPlan] = useState<Plan>('free');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Payment-method state (only used when selectedPlan requires payment).
  const [paymentReady, setPaymentReady] = useState(false);

  const planMeta = PLANS.find((p) => p.id === selectedPlan)!;

  const advanceFromPlan = useCallback(() => {
    if (planMeta.requiresPayment) setStep('payment');
    else setStep('tos');
  }, [planMeta]);

  const advanceFromPayment = useCallback(() => {
    if (!paymentReady) {
      setError('Add a payment method or pick the Free plan.');
      return;
    }
    setStep('tos');
  }, [paymentReady]);

  const finalize = useCallback(async () => {
    if (!tosAccepted) {
      setError('You must accept the Terms of Service to continue.');
      return;
    }
    setBusy(true);
    setError(null);
    setStep('finalizing');
    try {
      const r = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan: selectedPlan, tosAccepted: true }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      // Server-side redirect would normally handle this; we navigate ourselves.
      window.location.href = next;
    } catch (e) {
      setBusy(false);
      setStep('tos');
      setError(`Could not complete onboarding: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedPlan, tosAccepted, next]);

  return (
    <main className="min-h-screen bg-scruple-bg text-scruple-text">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-2xl font-bold tracking-widest2 text-scruple-accent-primary">SCRUPLE</h1>
          <p className="mt-2 text-sm text-scruple-muted">
            Welcome{userName ? `, ${userName}` : ''}. Let's set up your account.
          </p>
          <p className="mt-1 text-xs text-scruple-muted">{userEmail}</p>
        </header>

        <StepIndicator step={step} requiresPayment={planMeta.requiresPayment} />

        {step === 'plan' && (
          <section className="mt-10 space-y-4">
            <h2 className="text-lg font-semibold">Pick a plan</h2>
            <p className="text-sm text-scruple-muted">
              You can change this any time in Settings. Pilot access is available
              for firms with legal-evidentiary use cases — contact support.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {PLANS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPlan(p.id)}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    selectedPlan === p.id
                      ? 'border-scruple-accent-primary bg-scruple-accent-primary/10'
                      : 'border-scruple-border hover:border-scruple-muted'
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-sm text-scruple-muted">{p.price}</span>
                  </div>
                  <p className="mt-2 text-xs text-scruple-muted">{p.blurb}</p>
                  <ul className="mt-3 space-y-1 text-xs">
                    {p.features.map((f) => (
                      <li key={f} className="text-scruple-muted">
                        • {f}
                      </li>
                    ))}
                  </ul>
                </button>
              ))}
            </div>
            <div className="flex justify-end pt-4">
              <button
                type="button"
                onClick={advanceFromPlan}
                className="rounded bg-scruple-accent-primary px-6 py-2 text-sm font-semibold text-black hover:opacity-90"
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 'payment' && (
          <PaymentStep
            onReady={() => setPaymentReady(true)}
            onError={setError}
            onContinue={advanceFromPayment}
            onBack={() => setStep('plan')}
          />
        )}

        {step === 'tos' && (
          <section className="mt-10 space-y-4">
            <h2 className="text-lg font-semibold">Accept Terms of Service</h2>
            <div className="max-h-64 overflow-y-auto rounded border border-scruple-border bg-scruple-surface p-4 text-xs leading-relaxed text-scruple-muted">
              <p className="font-semibold text-scruple-text">Scruple Terms of Service — Summary</p>
              <p className="mt-2">
                By using Scruple, you agree that: (1) you own or have rights to the
                content you witness; (2) you understand that Scruple records
                cryptographic commitments to public blockchains and these commitments
                are permanent and cannot be revoked; (3) you accept the claim boundary —
                Scruple proves that an exact file existed in a specific state at
                witness-time, not that it was created in any particular way; (4) your
                use is consistent with applicable laws including export controls and
                IP rights.
              </p>
              <p className="mt-2">
                Full terms at <a href="/terms" className="underline">scruple.ai/terms</a>.
                Privacy policy at <a href="/privacy" className="underline">scruple.ai/privacy</a>.
                You can revoke API keys, delete projects, and close your account at any
                time via Settings.
              </p>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-1"
              />
              <span>
                I accept the Scruple Terms of Service and Privacy Policy, and I
                understand that on-chain commitments are permanent.
              </span>
            </label>
            <div className="flex justify-between pt-4">
              <button
                type="button"
                onClick={() => setStep(planMeta.requiresPayment ? 'payment' : 'plan')}
                className="rounded border border-scruple-border px-4 py-2 text-sm text-scruple-muted hover:text-scruple-text"
              >
                Back
              </button>
              <button
                type="button"
                onClick={finalize}
                disabled={!tosAccepted || busy}
                className="rounded bg-scruple-accent-primary px-6 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Setting up…' : 'Complete setup'}
              </button>
            </div>
          </section>
        )}

        {step === 'finalizing' && (
          <section className="mt-10 text-center text-sm text-scruple-muted">
            Finalizing your account…
          </section>
        )}

        {error && (
          <div className="mt-6 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}

function StepIndicator({
  step,
  requiresPayment,
}: {
  step: 'plan' | 'payment' | 'tos' | 'finalizing';
  requiresPayment: boolean;
}) {
  const steps = requiresPayment
    ? [
        { key: 'plan', label: '1. Plan' },
        { key: 'payment', label: '2. Payment' },
        { key: 'tos', label: '3. Terms' },
      ]
    : [
        { key: 'plan', label: '1. Plan' },
        { key: 'tos', label: '2. Terms' },
      ];
  const activeIdx = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex items-center gap-3 text-xs text-scruple-muted">
      {steps.map((s, i) => (
        <span
          key={s.key}
          className={i === activeIdx ? 'font-semibold text-scruple-accent-primary' : ''}
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

function PaymentStep({
  onReady,
  onError,
  onContinue,
  onBack,
}: {
  onReady: () => void;
  onError: (msg: string | null) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    // Mint a SetupIntent so Stripe Elements can attach a card.
    (async () => {
      try {
        const r = await fetch('/api/stripe/setup-intent', {
          method: 'POST',
          credentials: 'include',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setClientSecret(j.clientSecret);
      } catch (e) {
        onError(`Could not start payment setup: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [onError]);

  // For now we use a placeholder — full Stripe Elements wiring lives in
  // a follow-up so we can ship the onboarding skeleton tonight. Users
  // can confirm "I'll add a payment method later" and complete onboarding
  // on the free plan, or click "Open billing" to navigate to a separate
  // page that handles the real Stripe Elements integration.
  return (
    <section className="mt-10 space-y-4">
      <h2 className="text-lg font-semibold">Add a payment method</h2>
      <p className="text-sm text-scruple-muted">
        We collect your card now but don't charge until you actually lock
        a chain or hit a plan threshold.
      </p>

      {bootstrapping && (
        <p className="text-xs text-scruple-muted">Preparing secure payment form…</p>
      )}

      {clientSecret && (
        <div className="rounded border border-scruple-border bg-scruple-surface p-4 text-xs text-scruple-muted">
          <p>
            <strong className="text-scruple-text">Stripe payment-method capture is wired
            (SetupIntent ready, client_secret minted)</strong> — but the full Stripe
            Elements card form is in a follow-up commit. For tonight you can either:
          </p>
          <ul className="mt-3 space-y-2">
            <li>
              • Click <strong>"I'll add it later"</strong> below to complete onboarding now
              and add a card from Settings → Billing afterward.
            </li>
            <li>
              • Or open the <a href="/settings/billing" className="underline">Settings →
              Billing</a> page in another tab, add your card there, then come back and
              click "I'll add it later" — your card will be on file before you can lock
              a chain.
            </li>
          </ul>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-scruple-border px-4 py-2 text-sm text-scruple-muted hover:text-scruple-text"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            onReady();
            onContinue();
          }}
          className="rounded bg-scruple-accent-primary px-6 py-2 text-sm font-semibold text-black hover:opacity-90"
        >
          I'll add it later — continue
        </button>
      </div>
    </section>
  );
}
