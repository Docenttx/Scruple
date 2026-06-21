// Resolve a user's effective compute machine.
//
//   1) Look up the user's plan (free / pro / enterprise).
//   2) Read settings.compute.machine_id from user_settings.
//   3) If that machine exists in the catalog AND the plan is allowed
//      to pick it → return it.
//   4) Otherwise → fall back to the plan's default machine.
//
// This is the single source of truth that /api/generate and the
// Settings → Compute UI both read from. Tier downgrades are handled
// transparently: a user who picked A10G on Pro and downgrades to Free
// stops seeing A10G the next read (we return T4 instead of erroring),
// without rewriting their stored choice. If they re-upgrade later
// their original pick comes back.

import { readUserSettings } from '@/lib/settings/user';
import { getUserPlan } from './userPlan';
import {
  getMachineById,
  getDefaultMachineForPlan,
  type Machine,
  type UserPlan,
} from './machines';

export interface ActiveMachineResolution {
  /** The machine that will actually run the user's next workflow. */
  machine: Machine;
  /** The user's current plan tier. */
  plan: UserPlan;
  /** True when getActiveMachine fell back to the plan default
   *  (either because no choice was stored, or the stored choice
   *  isn't allowed for the current plan). */
  fellBack: boolean;
  /** The id the user had stored, if any (for UI/debug). */
  storedMachineId: string | null;
}

export function resolveActiveMachine(userId: string): ActiveMachineResolution {
  const plan = getUserPlan(userId);
  const settings = readUserSettings(userId);
  const storedId = settings.compute?.machine_id ?? null;
  const fallback = getDefaultMachineForPlan(plan);

  if (!storedId) {
    return { machine: fallback, plan, fellBack: true, storedMachineId: null };
  }
  const stored = getMachineById(storedId);
  if (!stored) {
    return { machine: fallback, plan, fellBack: true, storedMachineId: storedId };
  }
  if (!stored.allowedPlans.includes(plan)) {
    return { machine: fallback, plan, fellBack: true, storedMachineId: storedId };
  }
  return { machine: stored, plan, fellBack: false, storedMachineId: storedId };
}

/** Convenience wrapper for callers that only need the machine. */
export function getActiveMachine(userId: string): Machine {
  return resolveActiveMachine(userId).machine;
}
