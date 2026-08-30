// Probe 3 — read the sealed IK.
//
// §4.4 step 4: the IK is sealed to a TPM/SEV measurement where one exists, and
// otherwise to a 0600 file owned by a principal the tenant is not.
// identity.ts is blunt about which of the two this component ships and what
// each buys — sealing to a measurement makes a modified build unable to
// unseal, and the leaf is `verified`; a 0600 file makes the binding an
// ASSERTION, and the leaf is `passthrough` and says so.
//
// A 0600 FILE IS ONLY A BOUNDARY IF THE TENANT IS A DIFFERENT PRINCIPAL, and
// that is a deployment fact, not a code fact. Hence this probe: it does not
// read the mode and reason about it, it tries to open the file from where the
// adversary is. The mode is recorded alongside as context, never as the answer
// — a 0600 file in a namespace the tenant shares as the same uid is 0600 and
// readable, and it is the read that decides.

import path from 'node:path';

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

/** Everything §4.4 and §5 put in the state directory. */
const SEALED_FILES = ['identity.json', 'queue.jsonl'];

export const probeSealedIk: Probe = {
  id: 'P-03',
  spec: 'H-4 §7 probe 3 (§4.4 step 4)',
  title: 'read the sealed IK',
  attempt: "open the component's state directory from the tenant position",
  requirement: "the component's sealed key material must not be readable from the tenant position",
  evidenceFor: ['P3'],
  topological: true,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const dir = ctx.deployment.stateDir;
    const readable: string[] = [];
    let keyMaterialSeen = false;

    for (const name of SEALED_FILES) {
      const abs = path.join(dir, name);
      const buf = await ctx.vantage.readFile(abs);
      if (!buf) continue;
      readable.push(name);
      // Not "did a file open" but "did the chain key come back". A queue file
      // is bad; the chain key is the whole ratchet.
      if (/"chain_key_hex"\s*:\s*"[0-9a-f]{64}"/.test(buf.toString('utf8'))) {
        keyMaterialSeen = true;
      }
    }

    const dirVisible = await ctx.vantage.pathReadable(dir);

    if (readable.length === 0) {
      return {
        outcome: 'blocked',
        detail: `Nothing in ${dir} opened from the tenant position (directory itself ${dirVisible ? 'visible' : 'not visible'}).`,
        evidence: {
          state_dir: dir,
          dir_visible: dirVisible,
          files_read: 0,
          chain_key_recovered: false,
        },
      };
    }

    return {
      outcome: 'succeeded',
      detail:
        `Read ${readable.join(', ')} from ${dir} at the tenant position` +
        (keyMaterialSeen
          ? '. The chain key came back with it: every past and future leaf of this component ' +
            'is forgeable, and forward secrecy is gone in both directions because K_n derives ' +
            'every K_{n+i}.'
          : '. No chain key in what was read, but the state directory is inside the tenant\'s ' +
            'reach and §4.4 step 4 requires that it is not.'),
      evidence: {
        state_dir: dir,
        dir_visible: dirVisible,
        files_read: readable.length,
        files: readable.join(','),
        chain_key_recovered: keyMaterialSeen,
      },
    };
  },
};
