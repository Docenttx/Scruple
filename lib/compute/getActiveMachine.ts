// Resolve a user's effective compute machine.
//
//   1) Read settings.compute.machine_id from user_settings.
//   2) If that machine exists in the catalog → return it.
//   3) Otherwise → fall back to DEFAULT_MACHINE_ID (cheapest).
//
// scruple-web is paid-only (Canvas v2) — every signed-in user with a
// Stripe card may pick any machine. No tier validation here.

import { readUserSettings } from '@/lib/settings/user';
import {
  getMachineById,
  getDefaultMachine,
  type Machine,
} from './machines';

export interface ActiveMachineResolution {
  /** The machine that will actually run the user's next workflow. */
  machine: Machine;
  /** True when we fell back to the default
   *  (either because no choice was stored, or the stored choice
   *  isn't in the catalog). */
  fellBack: boolean;
  /** The id the user had stored, if any (for UI/debug). */
  storedMachineId: string | null;
}

export function resolveActiveMachine(userId: string): ActiveMachineResolution {
  const settings = readUserSettings(userId);
  const storedId = settings.compute?.machine_id ?? null;
  const fallback = getDefaultMachine();

  if (!storedId) {
    return { machine: fallback, fellBack: true, storedMachineId: null };
  }
  const stored = getMachineById(storedId);
  if (!stored) {
    return { machine: fallback, fellBack: true, storedMachineId: storedId };
  }
  return { machine: stored, fellBack: false, storedMachineId: storedId };
}

/** Convenience wrapper for callers that only need the machine. */
export function getActiveMachine(userId: string): Machine {
  return resolveActiveMachine(userId).machine;
}
