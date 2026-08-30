// Session-based compute backends — WO-KOHYA Phase 1.
//
// Studio apps (Canvas, Kohya, Forge) all follow the same shape:
//   1. User picks a machine tier
//   2. We spawn a container/pod for that user + app + tier
//   3. Get back a public HTTPS endpoint
//   4. Our HTTP+WS proxy forwards to that endpoint for the session
//   5. Terminate when the user leaves or after N minutes idle
//
// Different apps run on different providers because economics differ:
//   - Canvas   → Modal   (interactive, per-second, snappy cold-start)
//   - Kohya    → RunPod  (hours-long training, 3× cheaper)
//   - Forge    → Modal or RunPod (TBD when Forge lands)
//   - Fusion   → local   (user's own machine; no session)
//
// This abstraction is DIFFERENT from `lib/compute/backends.ts`, which
// is the per-workflow (runWorkflow) runner abstraction used by
// /api/generate. That one is one-shot. This one is session-based.
//
// Every backend implements:
//   - spawnEndpoint(userId, machineId, appId) → { endpointId, url, backend }
//   - terminateEndpoint(endpointId) → void
//   - pricePerHourCents(machineId) → number
//
// The billing helpers in `lib/stripe/*` read the per-hour rate from
// this interface, so subscription entitlement math is backend-neutral.

export type SessionBackendId = 'modal' | 'runpod' | 'local';

export type AppId = 'canvas' | 'kohya' | 'forge';

export interface SpawnRequest {
  userId: string;
  /** Catalog machine id (see lib/compute/machines.ts + upcoming
   *  runpod-machines.ts). */
  machineId: string;
  appId: AppId;
  /** Optional caller-supplied session id — the backend records it in
   *  its own bookkeeping so a later terminate can find the pod. */
  sessionId?: string;
  /**
   * The session's own credential (WO-12), minted before the spawn so the
   * backend can hand it to the workload.
   *
   * IT REPLACES A GLOBAL SECRET AND IS NOT A FIX FOR P3. The workload runs in
   * a shell the tenant controls, so anything given to it is held by the party
   * being measured; P3 is about custody, not scope
   * (docs/canon/STUDIO_P1-P8_GRADE.md, Path B, P3). What changes is blast
   * radius and forgeability across tenants: `SCRUPLE_APPS_WITNESS_SECRET` was
   * one value injected into every pod, so any customer running `env` held the
   * credential authenticating everyone else. This is one session's.
   *
   * A backend that has no workload to hand it to simply ignores it.
   */
  sessionToken?: string;
}

export interface SpawnedEndpoint {
  /** Provider-native identifier. For Modal: the URL itself works as
   *  the id (Modal keeps the container alive per-request). For RunPod:
   *  the pod id, needed to call terminate. */
  endpointId: string;
  /** Public HTTPS URL the HTTP+WS proxy layer forwards requests to. */
  url: string;
  /** Provider label — persisted so the terminate path knows which
   *  backend to call. */
  backend: SessionBackendId;
  /** Optional startup message to surface in the loader overlay. */
  message?: string;
}

export interface SessionBackend {
  readonly id: SessionBackendId;
  spawnEndpoint(req: SpawnRequest): Promise<SpawnedEndpoint>;
  terminateEndpoint(endpointId: string): Promise<void>;
  /** Per-hour price in USD cents for a machine on this backend. Used by
   *  Stripe pre-auth hold + capture-actual + subscription math.
   *  Returns 0 for free tiers (Stripe skipped). */
  pricePerHourCents(machineId: string): number;
}

/** Backend registry — populated by adapter modules on import. */
const registry = new Map<SessionBackendId, SessionBackend>();

export function registerSessionBackend(backend: SessionBackend): void {
  registry.set(backend.id, backend);
}

export function getSessionBackend(id: SessionBackendId): SessionBackend {
  const b = registry.get(id);
  if (!b) {
    throw new Error(
      `No session backend registered for '${id}'. Import the adapter module (lib/apps/backends/${id}.ts).`,
    );
  }
  return b;
}

export function hourlyCentsToPerSecond(hourlyCents: number): number {
  // Round up so the customer never pays less than the ledger records.
  return Math.ceil((hourlyCents / 3600) * 100) / 100;
}
