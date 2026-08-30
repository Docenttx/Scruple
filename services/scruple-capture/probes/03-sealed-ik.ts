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

/** A chain key, wherever it is found. §4.1's K_n is 32 bytes, hex-encoded. */
const CHAIN_KEY = /"chain_key_hex"\s*:\s*"[0-9a-f]{64}"/;

/** Credential-shaped environment variables, whatever they are called today. */
const CREDENTIAL_ENV = /\bSCRUPLE_[A-Z0-9_]*(SECRET|TOKEN|KEY|CREDENTIAL|PASSWORD)[A-Z0-9_]*=/;

export const probeSealedIk: Probe = {
  id: 'P-03',
  spec: 'H-4 §7 probe 3 (§4.4 step 4)',
  title: 'read the sealed IK',
  attempt:
    "open the component's state directory from the tenant position, and — when the operator " +
    'declares the component pid — the same files through /proc/<pid>/root and its environment ' +
    'through /proc/<pid>/environ',
  requirement:
    "the component's sealed key material must not be readable from the tenant position by any " +
    'route: not through the tenant\'s own mount namespace, and not through a shared PID namespace',
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
      if (CHAIN_KEY.test(buf.toString('utf8'))) {
        keyMaterialSeen = true;
      }
    }

    const dirVisible = await ctx.vantage.pathReadable(dir);

    // -----------------------------------------------------------------------
    // THE SECOND ROUTE TO THE SAME FILE, AND A MOUNT BOUNDARY DOES NOT CLOSE IT
    // -----------------------------------------------------------------------
    //
    // A deployment can hide the state directory from the tenant's mount
    // namespace and still hand it over, because `/proc/<pid>/root` resolves in
    // the TARGET's mount namespace. Same for `/proc/<pid>/environ`, which is
    // where the API key the component authenticates with actually lives.
    //
    // Both need the tenant to share a PID namespace with the component and to
    // pass the kernel's ptrace check. That is a deployment fact, exactly like
    // the file mode, so this probe TRIES it rather than reasoning about it —
    // the same discipline the header states for 0600.
    //
    // The pid is declared by the operator (types.ts DeploymentUnderTest). With
    // none declared the probe records that it did not look, because a boundary
    // nobody tested is not a boundary anybody demonstrated.
    const pid = ctx.deployment.componentPid ?? null;
    const viaProc: string[] = [];
    let procKeyMaterial = false;
    let procCredentialEnv = false;
    let procVisible = false;
    if (pid !== null) {
      procVisible = await ctx.vantage.pathReadable(`/proc/${pid}`);
      for (const name of SEALED_FILES) {
        const buf = await ctx.vantage.readFile(`/proc/${pid}/root${path.join(dir, name)}`);
        if (!buf) continue;
        viaProc.push(`root${path.sep}${name}`);
        if (CHAIN_KEY.test(buf.toString('utf8'))) procKeyMaterial = true;
      }
      const env = await ctx.vantage.readFile(`/proc/${pid}/environ`);
      if (env) {
        // NUL-separated. Only whether a credential-shaped name is present is
        // recorded — an evidence record that quoted the value would be the
        // leak it is reporting.
        const names = env.toString('utf8').split('\0');
        if (names.some((n) => CREDENTIAL_ENV.test(`${n.split('=')[0]}=`))) {
          procCredentialEnv = true;
          viaProc.push('environ');
        }
      }
    }

    const procEvidence = {
      component_pid_declared: pid,
      proc_entry_visible: procVisible,
      proc_paths_read: viaProc.join(',') || 'none',
      proc_chain_key_recovered: procKeyMaterial,
      proc_credential_env_readable: procCredentialEnv,
    };

    if (viaProc.length > 0) {
      return {
        outcome: 'succeeded',
        detail:
          `The state directory is ${readable.length ? 'directly readable, AND ' : 'not in the tenant\'s own mount namespace, but '}` +
          `reachable through /proc/${pid} (${viaProc.join(', ')}). A shared PID namespace ` +
          'defeats the mount boundary outright: /proc/<pid>/root resolves in the component\'s ' +
          'mount namespace, so hiding the directory from the tenant hides nothing' +
          (procKeyMaterial
            ? ', and the chain key came back with it — every past and future leaf of this ' +
              'component is forgeable.'
            : procCredentialEnv
              ? ", and the component's process environment hands over a credential-shaped value."
              : '.'),
        evidence: {
          state_dir: dir,
          dir_visible: dirVisible,
          files_read: readable.length,
          files: readable.join(',') || 'none',
          chain_key_recovered: keyMaterialSeen,
          ...procEvidence,
        },
      };
    }

    if (readable.length === 0) {
      return {
        outcome: 'blocked',
        detail: `Nothing in ${dir} opened from the tenant position (directory itself ${dirVisible ? 'visible' : 'not visible'}).`,
        evidence: {
          state_dir: dir,
          dir_visible: dirVisible,
          files_read: 0,
          chain_key_recovered: false,
          ...procEvidence,
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
        ...procEvidence,
      },
    };
  },
};
