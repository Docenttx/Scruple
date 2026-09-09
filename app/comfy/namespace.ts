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
  /** ns → inode, for this process. `null` where the kernel would not say. */
  self: Record<string, string | null>;
  parent: Record<string, string | null>;
  parentPid: number;
  selfUid: number;
  parentUid: number | null;
  /** The namespaces that DIFFER. Empty means no boundary at all. */
  differing: string[];
  /**
   * FALSE when the gate shares every namespace and the uid of the process
   * that launched it. The component declares `isolated-namespace`; this says
   * whether anything is enforcing it.
   */
  enforcementPresent: boolean;
  note: string;
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
  const self = nsInodes('self');
  const parent = nsInodes(parentPid);
  const differing = NAMESPACES.filter((ns) => self[ns] !== null && parent[ns] !== null && self[ns] !== parent[ns]);
  const selfUid = process.getuid ? process.getuid() : -1;
  const parentUid = uidOf(parentPid);
  const sameUid = parentUid !== null && parentUid === selfUid;
  const enforcementPresent = differing.length > 0 || !sameUid;
  return {
    self, parent, parentPid, selfUid, parentUid, differing, enforcementPresent,
    note: enforcementPresent
      ? `the gate differs from its launcher in [${differing.join(', ') || 'uid'}]`
      : 'the gate shares every namespace and the uid of the process that launched it; ' +
        "the component's declared `isolated-namespace` enforcement is a string, not a boundary",
  };
}
