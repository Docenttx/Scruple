'use client';

// Settings → Payment Mode. The user picks Fiat (Stripe) or Blockchain
// (RVN). The choice persists server-side via /api/settings/payment-mode
// and is read by the workspace's LockButtons + LockConfirmModal to
// route chain-lock through the right path.
//
// Visual cue: the active mode's pill picks up the desktop's purple
// (Fiat → --accent-purple #8b5cf6) or cyan (Blockchain →
// --accent-primary #00d9ff). Matches the desktop's view-toggle styling
// for these modes.

import { useEffect, useState } from 'react';
import { useWallet, type WalletMode, type ChainTier } from '@/lib/store/wallet';
import { addToast } from '@/lib/toast';

export default function PaymentModeSection() {
  const mode = useWallet(s => s.mode);
  const setMode = useWallet(s => s.setMode);
  const chainTier = useWallet(s => s.chainTier);
  const setChainTier = useWallet(s => s.setChainTier);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Pull server-side state on mount so this device matches the user's
  // current setting regardless of localStorage.
  useEffect(() => {
    Promise.all([
      fetch('/api/settings/payment-mode', { cache: 'no-store' })
        .then(r => r.json())
        .then((d: { mode?: WalletMode }) => { if (d.mode) setMode(d.mode); })
        .catch(() => { /* default ok */ }),
      fetch('/api/settings/chain-tier', { cache: 'no-store' })
        .then(r => r.json())
        .then((d: { tier?: ChainTier }) => { if (d.tier) setChainTier(d.tier); })
        .catch(() => { /* default ok */ }),
    ]).finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickMode(next: WalletMode) {
    if (next === mode) return;
    setSaving(true);
    setMode(next);
    try {
      const res = await fetch('/api/settings/payment-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${res.status}`);
      }
      addToast({ tone: 'success', title: `Payment mode → ${next}` });
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not save payment mode',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  async function pickTier(next: ChainTier) {
    if (next === chainTier) return;
    setSaving(true);
    setChainTier(next);
    try {
      const res = await fetch('/api/settings/chain-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${res.status}`);
      }
      addToast({ tone: 'success', title: `Chain-lock tier → ${next}` });
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not save chain tier',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="payment" className="mt-8 scroll-mt-12">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Payment Mode</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Choose how you pay for chain locks. Switches lock-flow defaults
        across the workspace. You can change this any time.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <ModeCard
          active={mode === 'fiat'}
          loading={!loaded || saving}
          accent="fuchsia"
          icon="💳"
          label="Fiat"
          tagline="Stripe-managed card payments"
          features={['$5 checkpoint / finalize', '$50 basic chain lock', '$65 pinned chain lock']}
          onClick={() => pickMode('fiat')}
        />
        <ModeCard
          active={mode === 'blockchain'}
          loading={!loaded || saving}
          accent="cyan"
          icon="⛓"
          label="Blockchain"
          tagline="RVN-native wallet (non-custodial)"
          features={['No service fee', '~500 RVN per asset mint', 'Direct on-chain anchoring']}
          onClick={() => pickMode('blockchain')}
        />
      </div>

      {/* Chain-lock tier preference — applies when the user clicks
          "Chain Lock" in the workspace. */}
      <div className="mt-6">
        <h3 className="text-xs uppercase tracking-widest text-scruple-muted">Chain-Lock Tier</h3>
        <p className="mt-1 text-xs text-scruple-muted">
          What "Chain Lock" in the workspace does. Pinned costs more but
          adds IPFS + Arweave anchors on top of the Ravencoin record.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <TierCard
            active={chainTier === 'basic'}
            loading={!loaded || saving}
            accent="cyan"
            label="Basic"
            tagline="RVN anchor only"
            features={[
              mode === 'fiat' ? '$50 per chain lock' : '~500 RVN per asset',
              'Ravencoin asset mint',
              'Single-chain anchor',
            ]}
            onClick={() => pickTier('basic')}
          />
          <TierCard
            active={chainTier === 'pinned'}
            loading={!loaded || saving}
            accent="purple"
            label="Pinned (3-chain)"
            tagline="RVN + IPFS + Arweave"
            features={[
              mode === 'fiat' ? '$65 per chain lock' : '~500 RVN + IPFS pin',
              'IPFS pin via Pinata',
              'Arweave permanent anchor',
            ]}
            onClick={() => pickTier('pinned')}
          />
        </div>
      </div>
    </section>
  );
}

function ModeCard({
  active,
  loading,
  accent,
  icon,
  label,
  tagline,
  features,
  onClick,
}: {
  active: boolean;
  loading: boolean;
  accent: 'cyan' | 'fuchsia' | 'purple';
  icon: string;
  label: string;
  tagline: string;
  features: string[];
  onClick: () => void;
}) {
  const activeCls =
    accent === 'fuchsia'
      ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-300'
      : accent === 'purple'
        ? 'border-[#9c27b0] bg-[#9c27b0]/10 text-[#c98ed8]'
        : 'border-scruple-accent-primary bg-scruple-accent-primary/10 text-scruple-accent-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={
        'flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors disabled:opacity-50 ' +
        (active
          ? activeCls
          : 'border-scruple-border bg-scruple-surface hover:border-scruple-accent-primary/60')
      }
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-2xl">{icon}</span>
        {active && (
          <span className="text-[10px] uppercase tracking-widest opacity-80">active</span>
        )}
      </div>
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] opacity-70">{tagline}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] opacity-60">
        {features.map(f => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </button>
  );
}

// Same shape as ModeCard but without an icon (chain tier is a sub-pref).
function TierCard({
  active,
  loading,
  accent,
  label,
  tagline,
  features,
  onClick,
}: {
  active: boolean;
  loading: boolean;
  accent: 'cyan' | 'purple';
  label: string;
  tagline: string;
  features: string[];
  onClick: () => void;
}) {
  return (
    <ModeCard
      active={active}
      loading={loading}
      accent={accent}
      icon=""
      label={label}
      tagline={tagline}
      features={features}
      onClick={onClick}
    />
  );
}
