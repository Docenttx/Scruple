// Compute machine catalog — Stage 1 (fixed 4-entry list).
//
// A "machine" bundles a GPU class + a trust tier + a cost estimate +
// the env-var that names the Modal endpoint for it. Users pick a
// machine in Settings → Compute; /api/generate resolves to the
// matching endpoint at run time.
//
// Stage 2 (`docs/wo/2026-06-21-compute-stage2.md`) will move this
// catalog into a `machines` DB table and add user-created entries.
// Stage 3 adds per-Queue override in the canvas. Until then, this
// constant is the source of truth.
//
// Adding a new machine:
//   1) Add a row to MACHINES below.
//   2) Add the matching MODAL_RUNNER_ENDPOINT_<ID_UPPER> env var
//      to .env.local once `modal deploy` has registered the
//      endpoint URL for that GPU class.
//   3) Update modal/scruple_runner.py to define the new function
//      with the matching gpu= kwarg. See WO Stage 1 Appendix.

export type GpuClass = 'T4' | 'A10G' | 'A100-40GB' | 'A100-80GB' | 'H100' | 'H100-CC';

export type TrustTier = 'L1+L2' | 'L1+L2+L3';

export type UserPlan = 'free' | 'pro' | 'enterprise';

export interface Machine {
  /** Catalog id; stable string, used as the persisted choice value. */
  id: string;
  /** Human-friendly name shown in the UI. */
  name: string;
  /** One-line description shown under the name. */
  description: string;
  /** Marketing/UI grouping (Free / Pro / Premium). */
  tierLabel: 'Free' | 'Pro' | 'Premium';
  /** Hardware class. */
  gpuClass: GpuClass;
  /** Trust tier this machine produces in the provenance receipt. */
  trustTier: TrustTier;
  /** Plans whose users may select this machine. */
  allowedPlans: UserPlan[];
  /** Approx monthly $ if used 8h/day. Informational only. */
  monthlyEstimateUsd8hPerDay: number;
  /** First-request cold-start estimate, seconds. */
  coldStartSeconds: number;
  /** Env var holding the Modal HTTP endpoint URL for this machine. */
  endpointEnvVar: string;
  /** Short list of headline included custom nodes (UI display only). */
  includedNodes: string[];
}

export const MACHINES: readonly Machine[] = [
  {
    id: 't4-free',
    name: 'T4',
    description: 'NVIDIA T4 (16 GB). Default for every account.',
    tierLabel: 'Free',
    gpuClass: 'T4',
    trustTier: 'L1+L2',
    allowedPlans: ['free', 'pro', 'enterprise'],
    monthlyEstimateUsd8hPerDay: 143,
    coldStartSeconds: 30,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_T4_FREE',
    includedNodes: ['Easy-Use'],
  },
  {
    id: 'a10g-pro',
    name: 'A10G',
    description: 'NVIDIA A10G (24 GB). Larger models, faster sampling.',
    tierLabel: 'Pro',
    gpuClass: 'A10G',
    trustTier: 'L1+L2',
    allowedPlans: ['pro', 'enterprise'],
    monthlyEstimateUsd8hPerDay: 264,
    coldStartSeconds: 25,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_A10G_PRO',
    includedNodes: ['Easy-Use', 'VideoHelperSuite', 'SeedVR2'],
  },
  {
    id: 'a100-premium',
    name: 'A100 40GB',
    description: 'NVIDIA A100 (40 GB). Full-precision FLUX, large LoRAs.',
    tierLabel: 'Premium',
    gpuClass: 'A100-40GB',
    trustTier: 'L1+L2',
    allowedPlans: ['enterprise'],
    monthlyEstimateUsd8hPerDay: 743,
    coldStartSeconds: 20,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_A100_PREMIUM',
    includedNodes: ['Easy-Use', 'VideoHelperSuite', 'SeedVR2'],
  },
  {
    id: 'h100cc-enterprise',
    name: 'H100 (Confidential)',
    description:
      'NVIDIA H100 in Confidential Computing mode. TEE-attested execution; receipt carries L3 attestation.',
    tierLabel: 'Premium',
    gpuClass: 'H100-CC',
    trustTier: 'L1+L2+L3',
    allowedPlans: ['enterprise'],
    monthlyEstimateUsd8hPerDay: 1095,
    coldStartSeconds: 35,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_H100CC_ENTERPRISE',
    includedNodes: ['Easy-Use', 'VideoHelperSuite', 'SeedVR2'],
  },
] as const;

/** Default machine id per plan. */
export const DEFAULT_MACHINE_BY_PLAN: Record<UserPlan, string> = {
  free: 't4-free',
  pro: 'a10g-pro',
  enterprise: 'a100-premium',
} as const;

export function getMachineById(id: string): Machine | null {
  return MACHINES.find((m) => m.id === id) ?? null;
}

/** Catalog filtered by what the given plan is allowed to pick. */
export function getMachineCatalogForPlan(plan: UserPlan): Machine[] {
  return MACHINES.filter((m) => m.allowedPlans.includes(plan));
}

export function getDefaultMachineForPlan(plan: UserPlan): Machine {
  const id = DEFAULT_MACHINE_BY_PLAN[plan];
  const m = getMachineById(id);
  if (!m) throw new Error(`bad DEFAULT_MACHINE_BY_PLAN: ${plan} → ${id}`);
  return m;
}

/**
 * Read the Modal HTTP endpoint URL for a machine. Falls back to the
 * legacy single-endpoint `MODAL_RUNNER_ENDPOINT` if the per-machine
 * env var is unset. The fallback exists so Stage 1 can ship before
 * the multi-function `modal deploy` lands — every machine still
 * routes to the existing endpoint until the new ones are deployed.
 *
 * Returns `null` when neither the per-machine env var nor the
 * legacy fallback is set (the caller should surface a clear error).
 */
export function resolveEndpointForMachine(machine: Machine): {
  url: string | null;
  fellBackToLegacy: boolean;
} {
  const direct = process.env[machine.endpointEnvVar];
  if (direct) return { url: direct, fellBackToLegacy: false };
  const legacy = process.env.MODAL_RUNNER_ENDPOINT;
  if (legacy) return { url: legacy, fellBackToLegacy: true };
  return { url: null, fellBackToLegacy: false };
}
