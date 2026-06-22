// Compute machine catalog — Canvas v2 (no tiers).
//
// A "machine" bundles a GPU class + a trust tier + a per-hour cost +
// the env-var that names the Modal endpoint for it. scruple-web is
// paid-only: every signed-in user with a Stripe card on file can pick
// any machine. Tier-gating was removed in WO-2 (2026-06-22-v2-02);
// per-user customization lives on a `machines` DB row when WO-7 lands
// (Custom Machine setting); the constants below remain the catalog
// for default/built-in machines.
//
// Adding a new machine:
//   1) Add a row to MACHINES below.
//   2) Add the matching MODAL_RUNNER_ENDPOINT_<ID_UPPER> env var to
//      .env.local once `modal deploy` has registered the endpoint URL
//      for that GPU class.
//   3) Update modal/scruple_runner.py to define the new function with
//      the matching gpu= kwarg.

export type GpuClass = 'T4' | 'A10G' | 'A100-40GB' | 'A100-80GB' | 'H100' | 'H100-CC';

export type TrustTier = 'L1+L2' | 'L1+L2+L3';

export interface Machine {
  /** Catalog id; stable string, used as the persisted choice value. */
  id: string;
  /** Human-friendly name shown in the UI. */
  name: string;
  /** One-line description shown under the name. */
  description: string;
  /** Hardware class. */
  gpuClass: GpuClass;
  /** Trust tier this machine produces in the provenance receipt. */
  trustTier: TrustTier;
  /** Per-hour cost in USD cents. Drives Stripe pre-auth (1h hold) +
   *  capture-actual (cents = ceil(elapsed * rate / 3600)). */
  hourlyRateCents: number;
  /** Approx monthly $ if used 8h/day. Informational only — derived from
   *  hourlyRateCents but stored for UI display without recomputing. */
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
    description: 'NVIDIA T4 (16 GB). Cheapest option; good for SD 1.5 and small models.',
    gpuClass: 'T4',
    trustTier: 'L1+L2',
    hourlyRateCents: 59,
    monthlyEstimateUsd8hPerDay: 143,
    coldStartSeconds: 30,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_T4_FREE',
    includedNodes: ['Easy-Use', 'VHS', 'SeedVR2'],
  },
  {
    id: 'a10g-pro',
    name: 'A10G',
    description: 'NVIDIA A10G (24 GB). Larger models, faster sampling.',
    gpuClass: 'A10G',
    trustTier: 'L1+L2',
    hourlyRateCents: 110,
    monthlyEstimateUsd8hPerDay: 264,
    coldStartSeconds: 25,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_A10G_PRO',
    includedNodes: ['Easy-Use', 'VHS', 'SeedVR2'],
  },
  {
    id: 'a100-premium',
    name: 'A100 40GB',
    description: 'NVIDIA A100 (40 GB). Full-precision FLUX, large LoRAs.',
    gpuClass: 'A100-40GB',
    trustTier: 'L1+L2',
    hourlyRateCents: 309,
    monthlyEstimateUsd8hPerDay: 743,
    coldStartSeconds: 20,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_A100_PREMIUM',
    includedNodes: ['Easy-Use', 'VHS', 'SeedVR2'],
  },
  {
    id: 'h100cc-enterprise',
    name: 'H100 (Confidential)',
    description:
      'NVIDIA H100 in Confidential Computing mode. TEE-attested execution; receipt carries L3 attestation.',
    gpuClass: 'H100-CC',
    trustTier: 'L1+L2+L3',
    hourlyRateCents: 456,
    monthlyEstimateUsd8hPerDay: 1095,
    coldStartSeconds: 35,
    endpointEnvVar: 'MODAL_RUNNER_ENDPOINT_H100CC_ENTERPRISE',
    includedNodes: ['Easy-Use', 'VHS', 'SeedVR2'],
  },
] as const;

/** First-use default — the cheapest machine. Users override in Settings → Compute. */
export const DEFAULT_MACHINE_ID = 't4-free';

export function getMachineById(id: string): Machine | null {
  return MACHINES.find((m) => m.id === id) ?? null;
}

export function getDefaultMachine(): Machine {
  const m = getMachineById(DEFAULT_MACHINE_ID);
  if (!m) throw new Error(`DEFAULT_MACHINE_ID ${DEFAULT_MACHINE_ID} not in catalog`);
  return m;
}

/**
 * Read the Modal HTTP endpoint URL for a machine. Falls back to the
 * legacy single-endpoint `MODAL_RUNNER_ENDPOINT` if the per-machine
 * env var is unset. The fallback exists so older deploys still route
 * everything through one endpoint until the multi-function
 * `modal deploy` lands.
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
