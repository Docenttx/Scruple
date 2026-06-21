'use client';

// Settings → Compute. The user picks the machine that runs their
// workflows on Modal. Stage 1: fixed 4-entry catalog, tier-gated;
// Free users see a read-only card and an Upgrade CTA, paid users
// see a grid of allowed machines. Receipts cite the chosen
// machine_id so verifiers can see exactly which GPU class ran a
// given iteration. See docs/wo/2026-06-21-compute-stage1.md.

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';

type UserPlan = 'free' | 'pro' | 'enterprise';
type TrustTier = 'L1+L2' | 'L1+L2+L3';

interface Machine {
  id: string;
  name: string;
  description: string;
  tierLabel: 'Free' | 'Pro' | 'Premium';
  gpuClass: string;
  trustTier: TrustTier;
  allowedPlans: UserPlan[];
  monthlyEstimateUsd8hPerDay: number;
  coldStartSeconds: number;
  includedNodes: string[];
}

interface ComputeState {
  active: Machine;
  storedMachineId: string | null;
  fellBack: boolean;
  plan: UserPlan;
  allowed: Machine[];
}

export default function ComputeSection() {
  const [state, setState] = useState<ComputeState | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/compute', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: ComputeState | { error: string }) => {
        if ('error' in d) setErr(d.error);
        else setState(d);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function pick(machineId: string) {
    if (!state || saving || machineId === state.active.id) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine_id: machineId }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setState({ ...state, active: d.active, fellBack: d.fellBack });
      addToast({ tone: 'success', title: `Compute → ${d.active.name}` });
    } catch (e) {
      addToast({
        tone: 'error',
        title: 'Could not save machine',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  if (err) {
    return (
      <section id="compute" className="mt-8 scroll-mt-12">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Compute</h2>
        <p className="mt-1 text-xs text-red-400">Could not load compute settings: {err}</p>
      </section>
    );
  }
  if (!state) {
    return (
      <section id="compute" className="mt-8 scroll-mt-12">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Compute</h2>
        <p className="mt-1 text-xs text-scruple-muted">Loading…</p>
      </section>
    );
  }

  const isFree = state.plan === 'free';

  return (
    <section id="compute" className="mt-8 scroll-mt-12">
      <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Compute</h2>
      <p className="mt-1 text-xs text-scruple-muted">
        Pick the GPU class that runs your workflows. Every iteration is captured into
        provenance with the machine id so a third-party can verify which hardware
        produced the output.
      </p>

      {state.fellBack && state.storedMachineId && state.storedMachineId !== state.active.id && (
        <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-300">
          Your previously selected machine ({state.storedMachineId}) isn&apos;t available
          on your current plan. Showing the default for {state.plan} instead.
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {state.allowed.map((m) => (
          <MachineCard
            key={m.id}
            machine={m}
            active={m.id === state.active.id}
            disabled={isFree && m.id !== state.active.id}
            saving={saving}
            onClick={() => pick(m.id)}
          />
        ))}
      </div>

      {isFree && (
        <div className="mt-4 rounded-md border border-scruple-border bg-scruple-surface p-3 text-xs">
          <span className="text-scruple-muted">
            Pro and Enterprise tiers unlock larger GPUs and TEE-attested execution.{' '}
          </span>
          <a href="/account/redeem" className="text-scruple-accent-primary underline">
            Upgrade →
          </a>
        </div>
      )}
    </section>
  );
}

function MachineCard({
  machine,
  active,
  disabled,
  saving,
  onClick,
}: {
  machine: Machine;
  active: boolean;
  disabled: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  const accent = machine.trustTier === 'L1+L2+L3' ? 'fuchsia' : 'cyan';
  const activeCls =
    accent === 'fuchsia'
      ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-200'
      : 'border-scruple-accent-primary bg-scruple-accent-primary/10 text-scruple-accent-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || saving}
      className={
        'flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors disabled:opacity-40 ' +
        (active
          ? activeCls
          : 'border-scruple-border bg-scruple-surface hover:border-scruple-accent-primary/60')
      }
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-medium">{machine.name}</span>
        {active ? (
          <span className="text-[10px] uppercase tracking-widest opacity-80">active</span>
        ) : (
          <span className="text-[10px] uppercase tracking-widest opacity-50">
            {machine.tierLabel}
          </span>
        )}
      </div>
      <div className="text-[11px] opacity-70">{machine.description}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] opacity-60">
        <li>GPU: {machine.gpuClass}</li>
        <li>Trust tier: {machine.trustTier}</li>
        <li>Cold start: ~{machine.coldStartSeconds}s</li>
        <li>
          Est. cost (8h/day):{' '}
          <span className="font-mono">${machine.monthlyEstimateUsd8hPerDay}/mo</span>
        </li>
        <li>Nodes: {machine.includedNodes.join(', ')}</li>
      </ul>
    </button>
  );
}
