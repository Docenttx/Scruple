// Storage confinement — measured, per leaf, off raw stat(2).
//
// WO-C4, and it is IT Expert's finding, confirmed in the code by the council
// (round 8 §3): `stateDir` holds "sealed IK, ratchet counter, and the durable
// queue", `outputVolume`/`watchedVolumes` are separate config fields, and
// NOTHING requires them to be on different filesystems. So:
//
//   an uncaptured runaway write exhausts blocks on a shared filesystem
//     → the ratchet's local append cannot fsync()
//     → and because the MAC is the BLOCKING half of emit(), the gate
//       fails closed
//     → FAIL-CLOSED BECOMES FAIL-STOPPED, triggered by the very artifact
//       class the gate cannot see.
//
// The council settled two halves, and the second is the one a first pass
// misses.
//
// ---------------------------------------------------------------------------
// HALF 1 — STARTUP REFUSAL, BEFORE THE PROXY SOCKET IS BOUND
// ---------------------------------------------------------------------------
//
// IT Expert, round 8: "failing closed before accepting traffic beats entering
// a state where an uncaptured 50 GiB generation run exhausts the partition,
// fails fsync() on the ratchet state, and turns your MAC issuance into an
// unrecoverable runtime panic. The startup check should measure
// `stat(stateDir).st_dev !== stat(outputVolume).st_dev` and verify that
// `stateDir` has an enforced quota or minimum reservable capacity via
// `statvfs` before binding the proxy socket."
//
// ---------------------------------------------------------------------------
// HALF 2 — AND THE LEAF RE-READS IT AT EMISSION
// ---------------------------------------------------------------------------
//
// Architect, round 8: "a startup-only check is a CONFIG-INHERITED FACT by the
// time the leaf is emitted — volumes can be remounted or bind-mounted after
// boot, which is exactly the inheritance pattern we killed on `pinned_build`.
// Re-read the `stateDir`/`outputVolume` device identity at emission and carry
// it as `source: measured | unknown`; startup refusal then guards the boot
// case and the leaf guards the running case."
//
// ⚑ RAW stat(2), NEVER A CACHED PATH LOOKUP. IT Expert, round 9, taken
// without argument and named in the ruling as "the difference between the
// check working and looking like it works": a mid-session mount namespace
// rewrite or bind mount must drop the check directly. So every reading below
// issues `stat` on the CONFIGURED PATH at the moment it is asked. Nothing is
// memoised, no `realpath` cache is consulted, and no `fs.Stats` object
// outlives the call that produced it. A module-level cache added here later
// would silently convert this file back into the startup-only check it
// exists to replace — `test/v2/storage-confinement.test.ts` performs a real
// bind mount and fails if a second reading agrees with the first.
//
// ---------------------------------------------------------------------------
// WHY FOUR VALUES AND NOT TWO
// ---------------------------------------------------------------------------
//
// The council named ONE degraded tag — `degraded_shared_storage` — because it
// was arguing about one mechanism. There are two ways the ratchet's append can
// be starved, they have DIFFERENT FIXES, and this series has already refused
// to fold two operational conditions into one value once: WO-C1 kept `stale`
// out of `passthrough` because "those are different operational conditions
// with different fixes." The same argument applies here.
//
//   'confined'                 stateDir is on its own device, and that device
//                              has at least the reservable floor free.
//   'degraded_shared_storage'  stateDir shares a device with a watched volume.
//                              FIX: move the state onto its own mount.
//   'degraded_no_reservation'  the devices are separate, and the state device
//                              has less than the floor free. FIX: give the
//                              state volume a quota or more room. A separate
//                              filesystem that is already full stops fsync
//                              exactly as a shared one does.
//   'unknown'                  a reading failed. NOT a degraded state and not
//                              a clean one — nobody measured.
//
// ---------------------------------------------------------------------------
// WHAT `statvfs` CAN AND CANNOT SEE, SAID OUT LOUD
// ---------------------------------------------------------------------------
//
// The council's phrase was "an enforced quota OR minimum reservable capacity".
// An ENFORCED QUOTA is not readable from userspace portably — `quotactl(2)`
// has no Node binding, and a project quota on an overlay or a k8s
// `ephemeral-storage` limit is enforced by a layer `statvfs` cannot see. So
// this module measures the half it CAN measure — `f_bavail * f_frsize` on the
// state device — and refuses to let a configuration setting stand in for the
// half it cannot.
//
// ⚑ A DECLARED QUOTA IS NOT ACCEPTED AS EVIDENCE OF ONE. The design's own
// invariant is that "configuration, inheritance, prior certification, and
// defaults cannot populate facts", so an env var saying `QUOTA_ENFORCED=1`
// would be precisely the config-inherited fact class this WO exists to close.
// The only knob is the FLOOR, which is a policy (how much headroom this
// deployment considers enough), not a fact about the filesystem.

import fs from 'node:fs';

/** What a leaf says about the filesystem its ratchet state lives on. */
export type StorageConfinement =
  | 'confined'
  | 'degraded_shared_storage'
  | 'degraded_no_reservation'
  | 'unknown';

/** Every factual field carries exactly one of these. There is no third. */
export type ConfinementSource = 'measured' | 'unknown';

const CONFINEMENTS: readonly StorageConfinement[] = [
  'confined',
  'degraded_shared_storage',
  'degraded_no_reservation',
  'unknown',
];

export function isStorageConfinement(v: unknown): v is StorageConfinement {
  return typeof v === 'string' && (CONFINEMENTS as readonly string[]).includes(v);
}

export function isConfinementSource(v: unknown): v is ConfinementSource {
  return v === 'measured' || v === 'unknown';
}

/** True when the value names a state that is not clean and not unmeasured. */
export function isDegraded(c: StorageConfinement): boolean {
  return c === 'degraded_shared_storage' || c === 'degraded_no_reservation';
}

/**
 * 64 MiB. Not a benchmark — a floor beneath which the durable queue plus the
 * sealed state plus whatever the journal needs to commit them is not
 * comfortably placeable. A deployment with a real number for its own workload
 * raises it; nothing may lower it to zero, because zero is the state this
 * whole check exists to refuse.
 */
export const DEFAULT_MIN_RESERVABLE_BYTES = 64 * 1024 * 1024;

export interface DeviceReading {
  path: string;
  /** st_dev as a decimal string — BigInt, so no 53-bit truncation, and a
   *  string so it survives JSON and a MAC preimage intact. */
  dev: string | null;
  error: string | null;
}

export interface CapacityReading {
  path: string;
  available_bytes: number | null;
  error: string | null;
}

export interface StorageMeasurement {
  confinement: StorageConfinement;
  source: ConfinementSource;
  state: DeviceReading;
  volumes: DeviceReading[];
  capacity: CapacityReading;
  /** The paths whose device is the state device. Empty when confined. */
  shared_with: string[];
  min_reservable_bytes: number;
  /** Why the value is what it is. Logged and reported; never sent on the
   *  wire — an explanation on the wire is a field to be forged. */
  reason: string;
}

/**
 * ONE raw `stat(2)` on the path as configured. Symlinks are followed, because
 * following them is what the component's own I/O does and a check that
 * disagreed with the I/O it protects would be measuring a different file.
 */
export function readDevice(p: string): DeviceReading {
  try {
    const st = fs.statSync(p, { bigint: true });
    return { path: p, dev: st.dev.toString(), error: null };
  } catch (e) {
    return { path: p, dev: null, error: errCode(e) };
  }
}

/** `statvfs`, via Node's statfs. Available blocks to an unprivileged writer. */
export function readCapacity(p: string): CapacityReading {
  try {
    const st = fs.statfsSync(p, { bigint: true });
    // bavail, not bfree: bfree includes the root-reserved blocks a component
    // running as a service user cannot actually write into, and counting them
    // is how a "there is room" check passes on a filesystem with no room.
    const bytes = st.bavail * st.bsize;
    return { path: p, available_bytes: Number(bytes), error: null };
  } catch (e) {
    return { path: p, available_bytes: null, error: errCode(e) };
  }
}

function errCode(e: unknown): string {
  const c = (e as { code?: string } | null)?.code;
  return c ? String(c) : String(e);
}

export interface MeasureRequest {
  stateDir: string;
  /** Every watched root. C-8 declares three; the pre-C-8 form declares one. */
  volumes: readonly string[];
  minReservableBytes?: number;
}

/**
 * Measure, now. Call this at startup AND again on every emission — the second
 * call is the whole of Architect's condition, and a caller that stores the
 * first result and reuses it has reintroduced the defect.
 */
export function measureStorageConfinement(req: MeasureRequest): StorageMeasurement {
  const floor = req.minReservableBytes ?? DEFAULT_MIN_RESERVABLE_BYTES;
  const state = readDevice(req.stateDir);
  const volumes = req.volumes.map(readDevice);
  const capacity = readCapacity(req.stateDir);

  const base = {
    state,
    volumes,
    capacity,
    min_reservable_bytes: floor,
  };

  // A reading that failed is UNKNOWN, and unknown is not a pass. It is also
  // not a degraded state: nobody measured, and saying `degraded_shared_storage`
  // when the stat failed would report a mechanism nobody observed.
  const unreadable = [state, ...volumes].filter((d) => d.dev === null);
  if (unreadable.length > 0) {
    return {
      ...base,
      confinement: 'unknown',
      source: 'unknown',
      shared_with: [],
      reason:
        'a device identity could not be read: ' +
        unreadable.map((d) => `${d.path} (${d.error})`).join(', '),
    };
  }

  const shared = volumes.filter((v) => v.dev === state.dev).map((v) => v.path);
  if (shared.length > 0) {
    return {
      ...base,
      confinement: 'degraded_shared_storage',
      source: 'measured',
      shared_with: shared,
      reason:
        `st_dev ${state.dev} is shared by the ratchet state (${state.path}) and ` +
        `${shared.join(', ')}. An uncaptured write into a watched volume can exhaust the ` +
        'blocks the ratchet needs to fsync its counter, and the MAC is the blocking half ' +
        'of emit() — fail-closed becomes fail-stopped.',
    };
  }

  if (capacity.available_bytes === null) {
    return {
      ...base,
      confinement: 'unknown',
      source: 'unknown',
      shared_with: [],
      reason: `statfs(${capacity.path}) failed (${capacity.error}); reservable capacity unmeasured.`,
    };
  }

  if (capacity.available_bytes < floor) {
    return {
      ...base,
      confinement: 'degraded_no_reservation',
      source: 'measured',
      shared_with: [],
      reason:
        `${capacity.path} is on its own device (st_dev ${state.dev}) but has ` +
        `${capacity.available_bytes} bytes available, below the ${floor}-byte floor. A ` +
        'separate filesystem with no room stops fsync exactly as a shared one does.',
    };
  }

  return {
    ...base,
    confinement: 'confined',
    source: 'measured',
    shared_with: [],
    reason:
      `ratchet state on st_dev ${state.dev}, watched volumes on ` +
      `${[...new Set(volumes.map((v) => v.dev))].join(', ')}, ` +
      `${capacity.available_bytes} bytes available (floor ${floor}).`,
  };
}

export interface StartupDecision {
  ok: boolean;
  measurement: StorageMeasurement;
  message: string;
}

/**
 * THE STARTUP GATE — call it before binding the proxy socket, and refuse to
 * bind if it says no.
 *
 * `allowDegraded` is the one escape, and it is deliberately not a way to make
 * the finding go away: a session started under it emits leaves tagged with the
 * measured degraded value, so the degradation travels with every artifact the
 * session produced. The council's condition, verbatim: "degraded diagnostic
 * mode is acceptable only if the resulting session leaves are explicitly
 * tagged `confinement: "degraded_shared_storage"` with `source: measured`."
 *
 * ⚑ IT DOES NOT WAIVE `unknown`. A component that could not read its own
 * device identity cannot tag its leaves with what it measured, because it
 * measured nothing — so the waiver has nothing to attach the visibility
 * requirement to, and the start is refused whether or not the flag is set.
 */
export function startupDecision(
  m: StorageMeasurement,
  opts: { allowDegraded: boolean },
): StartupDecision {
  if (m.confinement === 'confined') {
    return { ok: true, measurement: m, message: `storage confinement: confined — ${m.reason}` };
  }

  if (m.confinement === 'unknown') {
    return {
      ok: false,
      measurement: m,
      message:
        'REFUSING TO BIND THE PROXY SOCKET: storage confinement is UNMEASURED. ' +
        m.reason +
        ' This is refused even with the degraded-mode declaration, because degraded ' +
        'operation is permitted only when the session\'s leaves carry the measured ' +
        'degraded value — and there is no measurement to carry.',
    };
  }

  if (!opts.allowDegraded) {
    return {
      ok: false,
      measurement: m,
      message:
        `REFUSING TO BIND THE PROXY SOCKET: storage confinement is ${m.confinement}. ` +
        m.reason +
        ' Put the component state on its own filesystem with a quota, or declare degraded ' +
        'operation explicitly (SCRUPLE_CAPTURE_ALLOW_DEGRADED_STORAGE=1) and accept that ' +
        'every leaf this session emits will be tagged with the degraded value. Failing ' +
        'closed before accepting traffic beats a runtime panic in the MAC path triggered ' +
        'by an artifact class this component cannot see.',
    };
  }

  return {
    ok: true,
    measurement: m,
    message:
      `DEGRADED STORAGE, DECLARED: ${m.confinement}. ` +
      m.reason +
      ' Every leaf this session emits carries this value with source=measured. This is a ' +
      'degraded capture session and it is not silent.',
  };
}
