// IS THE ENFORCEMENT ACTUALLY THERE? — a reading, not a declaration.
//
// `CaptureComponent` declares `placement: 'sidecar-gate'` with
// `enforcement: 'isolated-namespace'`, and `resolvePlacement()` in
// lib/capture/surface.ts honours that pair — but read what it does: it
// compares the enforcement STRING against the string the placement requires.
// It has to, because the SDK runs in containers it cannot introspect and its
// own header is blunt about the model's limits.
//
// ON THIS DESKTOP THE STRING IS NOT TRUE. The gate is a child of the Electron
// main process: same user, same namespaces, same machine, and the measured
// party has root on all of it. `unattested-client` is what that earns —
// which is exactly what the vault surface declares for itself in
// app/vault/run.ts, and it earns it honestly.
//
// So this file MEASURES the gap rather than arguing about it. It compares the
// gate's own namespace inodes and uid against its parent's. When they are
// identical there is no boundary between the measurer and the measured, and
// `enforcementPresent` is false — recorded on the gate's own record, where a
// reader can see it beside the placement the component claims.
//
// ⚑ WHAT THIS DOES NOT DO. It does not rewrite the leaf. The placement the
// SDK sends is the SDK's, and a desktop host quietly downgrading somebody
// else's field would be a second implementation of the assurance model — the
// thing WO-D3 forbade for the preimage, for the same reason. The right fix is
// a `declaredPlacement` that comes from configuration rather than a constant
// in `CaptureComponent.start`, and that is a change to the SDK's contract
// affecting every deployment that already claims `sidecar-gate`. It is named
// in docs/STATE.md as needing a decision, not taken here.

import fs from 'node:fs';

export interface NamespaceReading {
  /**
   * WO-W1/WO-D5: measured · unavailable · refused. Present ALWAYS, including
   * when measured, so a reader never infers the state from a null.
   *
   * ⚑ `enforcementPresent: false` is a claim: "there is no boundary between the
   * measurer and the measured" — finding D4-1's whole substance. On a platform
   * with no /proc that claim would be produced by the catch blocks below rather
   * than by any reading, and D4-1 would appear to reproduce on a box where
   * nothing was ever measured. So when the state is not `measured`,
   * `enforcementPresent` is **null**.
   */
  state: 'measured' | 'unavailable' | 'refused';
  /** Machine-readable. null when measured. */
  reasonCode: string | null;
  /** Human-readable. null when measured. */
  reason: string | null;
  /** ns → inode, for this process. `null` where the kernel would not say. */
  self: Record<string, string | null>;
  parent: Record<string, string | null>;
  parentPid: number;
  selfUid: number | null;
  parentUid: number | null;
  /** The namespaces that DIFFER. Empty means no boundary at all; `null` when
   *  nothing was read. */
  differing: string[] | null;
  /**
   * FALSE when the gate shares every namespace and the uid of the process
   * that launched it. The component declares `isolated-namespace`; this says
   * whether anything is enforcing it. NULL when it could not be read at all.
   */
  enforcementPresent: boolean | null;
  note: string;
}

/** Is /proc/<pid>/ns readable here, and if not, exactly why. */
function nsAvailability(pid: number | 'self'): { state: 'measured' | 'unavailable' | 'refused'; code: string | null; reason: string | null } {
  const probe = `/proc/${pid}/ns/net`;
  try {
    fs.readlinkSync(probe);
    return { state: 'measured', code: null, reason: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        state: 'refused',
        code,
        reason: `${probe} exists but this process may not read it (${code}); the isolation measurement needs to compare the gate's namespaces against its launcher's`,
      };
    }
    return {
      state: 'unavailable',
      code: code === 'ENOENT' ? 'procfs_absent' : code,
      reason: `${probe} is not present (${code}); platform ${process.platform} has no procfs, so namespace isolation cannot be measured here at all — not by this reading and not by any other`,
    };
  }
}

const NAMESPACES = ['net', 'pid', 'mnt', 'user', 'ipc', 'uts'] as const;

function nsInodes(pid: number | 'self'): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const ns of NAMESPACES) {
    try {
      // 'net:[4026531840]' — the inode is the namespace's identity.
      out[ns] = fs.readlinkSync(`/proc/${pid}/ns/${ns}`);
    } catch {
      out[ns] = null;
    }
  }
  return out;
}

function uidOf(pid: number | 'self'): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^Uid:\s+(\d+)/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function readNamespaceIsolation(): NamespaceReading {
  const parentPid = process.ppid;

  const avail = nsAvailability('self');
  if (avail.state !== 'measured') {
    const empty: Record<string, string | null> = {};
    for (const ns of NAMESPACES) empty[ns] = null;
    return {
      state: avail.state,
      reasonCode: avail.code,
      reason: avail.reason,
      self: empty,
      parent: empty,
      parentPid,
      // process.getuid does not exist on Windows. -1 would be a uid; null is
      // the absence of one.
      selfUid: typeof process.getuid === 'function' ? process.getuid() : null,
      parentUid: null,
      differing: null,
      enforcementPresent: null,
      note:
        `namespace isolation was NOT measured: ${avail.reason}. ` +
        'This is not the same as finding no isolation — D4-1 records a measured absence of a boundary, ' +
        'and nothing here may be read as reproducing it.',
    };
  }

  const self = nsInodes('self');
  const parent = nsInodes(parentPid);
  const differing = NAMESPACES.filter((ns) => self[ns] !== null && parent[ns] !== null && self[ns] !== parent[ns]);
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const parentUid = uidOf(parentPid);
  const sameUid = parentUid !== null && selfUid !== null && parentUid === selfUid;
  const enforcementPresent = differing.length > 0 || !sameUid;
  return {
    state: 'measured',
    reasonCode: null,
    reason: null,
    self, parent, parentPid, selfUid, parentUid, differing, enforcementPresent,
    note: enforcementPresent
      ? `the gate differs from its launcher in [${differing.join(', ') || 'uid'}]`
      : 'the gate shares every namespace and the uid of the process that launched it; ' +
        "the component's declared `isolated-namespace` enforcement is a string, not a boundary",
  };
}
