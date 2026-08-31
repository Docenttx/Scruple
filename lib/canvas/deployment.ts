// Canvas as a REGISTERED DEPLOYMENT (WO-25).
//
// docs/canon/INTEGRATION_LIFECYCLE.md §10 item 6, and the correction that
// closes it:
//
//   "Canvas does not ingest through POST /api/v2/witness; it goes through
//    lib/iterations/ingest.ts... Canvas leaves therefore carry
//    seal_state = NULL today, which is honest (the question was not asked)
//    but is not the re-grade the direction promises."
//
// and docs/canon/STUDIO_IS_AN_EXEMPLAR.md's live violation:
//
//   "canvas is on a parallel path instead of consuming the shared one."
//
// ONE FIX, TWO FINDINGS. This module is the fix: it gives canvas a
// deployment identity, and it makes the canvas ingest path a CONSUMER of
// `lib/seal/registry.ts` rather than a second place where a leaf's seal
// state is decided. There is exactly one `checkDeploymentSeal()` in the
// estate and after this file both paths call it.
//
// ═══════════════════════════════════════════════════════════════════════
// WHAT THIS DOES **NOT** MAKE TRUE, SAID HERE RATHER THAN DISCOVERED
// ═══════════════════════════════════════════════════════════════════════
//
// Canvas still does not traverse `app/api/v2/witness/route.ts`. It has no
// component, no ratchet and no MAC, so there is no envelope for that route
// to verify; sending an unMACed submission over HTTP to our own process
// would add a network hop and a second authentication story without adding
// a single fact. What was a parallel implementation of THE SEAL STAMP is
// now a shared one. What remains parallel is the LEAF WRITE itself, and
// that is a narrower, nameable gap rather than a closed one — see
// docs/canon/STUDIO_SEAL.md §4.
//
// ═══════════════════════════════════════════════════════════════════════
// WHY THE TENANT IS A CONSTANT AND NOT THE END USER
// ═══════════════════════════════════════════════════════════════════════
//
// `checkDeploymentSeal(tenantId, deploymentId)` checks the deployment
// against the CALLING tenant, because on `/v2/witness` the deployment id
// is a bare string on the wire and without that check a tenant could stamp
// their leaves with somebody else's `sealed`.
//
// Canvas's shape is the other one. The deployment is not declared by the
// caller at all — it is a constant in server code, and the party that owns
// the pipeline is SCRUPLE, not the artist whose image is being witnessed.
// A hosting vendor's deployment produces leaves for its tenants; the
// tenants do not each own a deployment. So the owning tenant is a platform
// identity, the pair is resolved here and never from a request, and the
// check remains non-vacuous in the only way that matters: it is still
// `sealStatus()` that answers whether this pipeline was approved as of
// this instant, and that answer is not ours to assert.
//
// ═══════════════════════════════════════════════════════════════════════
// AND WHY THIS FILE CANNOT REGISTER ITSELF
// ═══════════════════════════════════════════════════════════════════════
//
// The `deployments` row is created by `lib/db/migrations/047_canvas_
// deployment.sql`, because migration 046 is explicit that the row is a
// NAME and not evidence: "nothing here is signed, because nothing here is
// a claim." Every actual claim — `integrating`, `verifying`, `sealed` — is
// a signed lifecycle event, and signing needs the registry key. Putting a
// key-bearing write on the capture hot path would be both a self-serve
// lifecycle move (INTEGRATION_LIFECYCLE.md §10 item 5) and a key in a
// request handler. The operator steps are in docs/canon/STUDIO_SEAL.md §6.

import { conn } from '@/lib/db/sqlite';
import {
  declaredDigest,
  declareManifest,
  type BoundaryClass,
  type PipelineManifest,
} from '@/lib/seal/measure';
import { checkDeploymentSeal, type SealStamp } from '@/lib/seal/registry';

/**
 * The deployment id canvas leaves carry.
 *
 * It names the CONFIGURATION and not the product, because certification is
 * per configuration (H-4 §7) and `docs/canon/CANVAS_BASELINE.md` §6
 * assertion 5 already declares canvas against the shared-default machine
 * only. Personal machines (WO-7) let a user choose middleware inside the
 * boundary; that is a different pipeline and it must not be able to
 * inherit this one's approval by sharing its name.
 */
export const CANVAS_DEPLOYMENT_ID = 'studio-canvas-shared-default';

/**
 * The owning tenant. Scruple-as-vendor, not the artist.
 *
 * Deliberately not a real user id: no `users` row may ever hold it, so a
 * request can never arrive carrying it, and the platform deployment cannot
 * be claimed by a tenant who guesses the string.
 */
export const CANVAS_DEPLOYMENT_TENANT = 'platform:scruple-studio';

/** The instant migration 047 registers the row at. Kept here so the
 *  migration and the tests agree on one spelling of one instant. */
export const CANVAS_DEPLOYMENT_CREATED_AT = '2026-08-31T00:00:00.000Z';

export interface DeploymentRef {
  deploymentId: string;
  tenantId: string;
}

export const canvasDeploymentRef = (): DeploymentRef => ({
  deploymentId: CANVAS_DEPLOYMENT_ID,
  tenantId: CANVAS_DEPLOYMENT_TENANT,
});

/**
 * The stamp a canvas leaf carries, as of an instant.
 *
 * Thin on purpose: the whole point of WO-25 is that this is a CALL into
 * the shared registry and not a second implementation of it.
 */
export function canvasSealStamp(asOf?: string): SealStamp {
  return checkDeploymentSeal(CANVAS_DEPLOYMENT_TENANT, CANVAS_DEPLOYMENT_ID, asOf);
}

/* ═══════════════════════════════════════════════════════════════════════
 * THE PIPELINE BOUNDARY
 *
 * `lib/canvas/baseline.ts` already enumerates a 23-file TAMPER SURFACE.
 * This is not that list, and the difference is the substance of the
 * boundary argument (docs/canon/STUDIO_SEAL.md §3):
 *
 *   1. IT IS A SUPERSET, not a copy. The tamper surface deliberately
 *      excludes `modal/**` on the grounds that the image "is measured
 *      separately and better" by `machines.manifest_hash`. Separately is
 *      exactly the problem a pipeline measurement exists to end — "a new
 *      upstream release is a new measurement and a new approval" — so the
 *      image enters here as the `host` class, as a DECLARED digest, which
 *      is the class measure.ts created for it.
 *
 *   2. IT IS PARTITIONED, not flat. One flat hash makes a lockfile bump
 *      break exactly as loudly as a rewrite of the gate, which is the
 *      "vendor stops bothering" failure lib/seal/materiality.ts is built
 *      to avoid. Here `package-lock.json` is `dependency`: a bump is
 *      `consequential`, counted against a budget of 8, and does not force
 *      a reseal. A change to `lib/canvas/gate.ts` is `material` and does.
 *
 *   3. IT INCLUDES THE FILE THE TAMPER SURFACE CANNOT. `lib/canvas/
 *      baseline.ts` excludes ITSELF, correctly, because it carries its own
 *      recorded hash and hashing it would be a fixpoint. That reason does
 *      not transfer: a pipeline manifest is stored in the seal row, not in
 *      the file, so there is no fixpoint — and baseline.ts is where
 *      canvas's placement, enforcement, surfaces and `attestation: none`
 *      are DECLARED. A configuration that can be edited without moving the
 *      approved measurement is not an approved configuration.
 *
 *   4. IT CARRIES THE TWO THINGS NO FILE HOLDS. measure.ts's `config`
 *      class names "the endpoint, the credential", and Kohya is the
 *      estate's standing proof that a configuration change turns capture
 *      off while looking exactly like a quiet afternoon. Neither is a file
 *      here, so both are `declared` entries below.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * `capture` — the observing code. Everything the bytes pass through, plus
 * the three modules that decide the leaf's preimage, plus the four
 * component modules canvas consumes rather than reimplements.
 */
const CAPTURE_FILES: readonly string[] = [
  // The HTTP leg.
  'app/canvas-proxy/[sessionId]/[[...path]]/route.ts',
  'lib/canvas/gate.ts',
  'lib/canvas/egress.ts',
  'lib/canvas/correlate.ts',
  'lib/canvas/witness.ts',
  'lib/canvas/manifest.ts',
  'lib/canvas/session.ts',
  // This file: it resolves the deployment identity and the seal stamp, so
  // editing it changes what every canvas leaf says about its own approval.
  'lib/canvas/deployment.ts',

  // The WS leg — a separate process, one shared capture path.
  'scripts/canvas-ws-proxy.mjs',
  'lib/canvas/ws-capture.ts',

  // Where a canvas leaf is actually built, and what fixes its preimage.
  'lib/iterations/ingest.ts',
  'lib/leaf/hashes.ts',
  'lib/scruple/witness.ts',
  'lib/scruple/hash.ts',
  'lib/scruple/artifacts.ts',

  // The component modules canvas CONSUMES (STUDIO_IS_AN_EXEMPLAR.md's
  // direction of dependency): frame decoder, MIME declarations, the
  // correlator, and the byte-egress route table.
  'services/scruple-capture/src/surfaces/ws-gate.ts',
  'services/scruple-capture/src/surfaces/http-gate.ts',
  'services/scruple-capture/src/correlation.ts',
  'services/scruple-capture/src/mime.ts',

  // THE ARGUABLE ONE, and it is argued rather than assumed. `registry.ts`
  // is not observing code — it is the code that decides the `seal_state`
  // written onto every canvas leaf. The class rule is "changes what a leaf
  // says", and this changes one of the leaf's fields directly. A change
  // here that made an unapproved pipeline stamp `sealed` is precisely the
  // change a seal has to cover, so it is inside and its edits are
  // material.
  'lib/seal/registry.ts',
];

/**
 * `config` — what binds hooks, surfaces and placement, and what decides
 * whether a leaf is produced or what it is allowed to claim.
 */
const CONFIG_FILES: readonly string[] = [
  // The declaration itself: placement, enforcement, surfaces, attestation,
  // and the five assertions the baseline carries that are not file hashes.
  'lib/canvas/baseline.ts',
  // What canvas is PERMITTED to say, computed rather than written down.
  'lib/capture/surface.ts',
  'lib/capture/classes.ts',
  // The shape of the evidence. `canvas_capture_log`'s CHECK constraint is
  // the fail-closed point: the capture row is written BEFORE bytes are
  // delivered, so a migration that narrowed what a status can BE would
  // decide whether a leaf is produced at all.
  'lib/db/migrations/044_canvas_capture.sql',
  // The columns the stamp is written to.
  'lib/db/migrations/046_integration_lifecycle.sql',
  // The deployment identity.
  'lib/db/migrations/047_canvas_deployment.sql',
];

/** `dependency` — lockfiles BY CONTENT, never the installed tree. */
const DEPENDENCY_FILES: readonly string[] = ['package.json', 'package-lock.json'];

/**
 * DELIBERATELY OUTSIDE, kept in code because an exclusion nobody can find
 * is the same as an oversight.
 */
export const PIPELINE_EXCLUDED: ReadonlyArray<{ id: string; reason: string }> = [
  {
    id: 'components/canvas/**, app/canvas/**',
    reason:
      'Browser-side UI. Placement is `unattested-client` by definition — the user can edit it — ' +
      'and canvas v2 exists BECAUSE the COM-6/7 design had a browser intercept posting witness ' +
      'calls that anyone with a session token could forge. Measuring code whose modification we ' +
      'already assume would imply a claim P1 explicitly refuses to make.',
  },
  {
    id: 'modal/**',
    reason:
      'The ComfyUI image SOURCE. Not excluded from the boundary — it is inside it as the `host` ' +
      'declared entry below, digested by machines.manifest_hash, which pins the ComfyUI version ' +
      'and every custom-node pack by commit and is already in the v2.2 leaf preimage. Hashing ' +
      'the build inputs as well would be a second preimage for one thing.',
  },
  {
    id: 'lib/seal/measure.ts, lib/seal/materiality.ts, lib/seal/cli.ts',
    reason:
      'THE MEASURING INSTRUMENT, NOT THE SPECIMEN. measure.ts computes the digest that IS this ' +
      'manifest; including it is the fixpoint tamper-surface.mjs and baseline.ts both refuse. ' +
      'materiality.ts and cli.ts are the scheme rather than this pipeline: a change to either ' +
      'moves every deployment in the estate at once and is a change to the STANDARD, which no ' +
      'single vendor\'s seal is the right place to record.',
  },
  {
    id: 'app/api/v2/witness/route.ts',
    reason:
      'Canvas does not traverse it. Measuring a route no canvas byte reaches would make the ' +
      'boundary break for reasons that say nothing about canvas — the same argument baseline.ts ' +
      'gives for excluding the component\'s ratchet and queue. THIS EXCLUSION IS ITSELF A ' +
      'FINDING and not merely a scoping choice: see docs/canon/STUDIO_SEAL.md §4.',
  },
  {
    id: 'the OS, the kernel, the Node runtime, node_modules as installed, the machine, model weights, tenant content',
    reason:
      'measure.ts\'s explicit outside list, inherited verbatim. A matching pipeline measurement ' +
      'means "this is the approved configuration", never "the running system is trustworthy" — ' +
      'that is the attestation row\'s job, and canvas\'s answer there is `passthrough`.',
  },
];

/** The shared-default machine's manifest hash: canvas's `host` digest. */
export function sharedDefaultManifestHash(): string | null {
  try {
    const row = conn()
      .prepare(
        `SELECT manifest_hash FROM machines
          WHERE user_id IS NULL AND archived_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { manifest_hash?: string } | undefined;
    return row?.manifest_hash ?? null;
  } catch {
    return null;
  }
}

export interface CanvasManifestInput {
  /**
   * `machines.manifest_hash` for the shared-default machine. REQUIRED, and
   * not defaulted to a placeholder: `declareManifest` refuses a declared
   * file that is absent because "approving a configuration whose declared
   * files are absent approves something nobody looked at", and a host
   * digest nobody resolved is the same act with a nicer error.
   */
  hostManifestHash: string;
  /** `WITNESS_SERVER_URL` as the deployment is configured to use it. */
  witnessEndpoint: string;
  /**
   * WHERE the upstream credential comes from — NOT the credential.
   *
   * The digest is over the SOURCE IDENTITY (`env:SCRUPLE_CANVAS_SHARED_
   * SECRET`), never over the secret. Two reasons, and the second is the
   * one that is easy to get backwards: a manifest is stored in full on a
   * signed row and read by auditors, so a digest of a secret is an offline
   * oracle against it; and rotating a credential is not a change to the
   * approved configuration, while changing where the credential comes from
   * is exactly the Kohya failure — an env var that stopped being read.
   */
  credentialSource?: string;
  root?: string;
}

export function canvasPipelineManifest(input: CanvasManifestInput): PipelineManifest {
  const content: { class: BoundaryClass; path: string }[] = [
    ...CAPTURE_FILES.map((p) => ({ class: 'capture' as const, path: p })),
    ...CONFIG_FILES.map((p) => ({ class: 'config' as const, path: p })),
    ...DEPENDENCY_FILES.map((p) => ({ class: 'dependency' as const, path: p })),
  ];
  return declareManifest({
    root: input.root,
    content,
    declared: [
      {
        class: 'host',
        // ComfyUI plus every pinned custom-node pack, by commit. The `host`
        // class exists because "a host upgrade is the ordinary way a hook
        // stops firing", and on canvas a ComfyUI release that starts
        // returning result bytes over the WebSocket is that upgrade.
        id: 'host:comfyui@modal-shared-default',
        sha256: input.hostManifestHash,
      },
      {
        class: 'config',
        id: 'config:witness-endpoint',
        sha256: declaredDigest(input.witnessEndpoint),
      },
      {
        class: 'config',
        id: 'config:upstream-credential-source',
        sha256: declaredDigest(input.credentialSource ?? 'env:SCRUPLE_CANVAS_SHARED_SECRET'),
      },
    ],
  });
}

/** Convenience for the operator path: resolve what the environment says. */
export function canvasPipelineManifestFromEnv(root?: string): PipelineManifest {
  const hostManifestHash = sharedDefaultManifestHash();
  if (!hostManifestHash) {
    throw new Error(
      'No shared-default machine manifest is recorded, so canvas\'s `host` boundary entry has ' +
        'no digest. A pipeline manifest with a guessed host entry approves an image nobody ' +
        'looked at; resolve machines.manifest_hash first.',
    );
  }
  return canvasPipelineManifest({
    hostManifestHash,
    witnessEndpoint: process.env.WITNESS_SERVER_URL ?? 'http://127.0.0.1:5799',
    root,
  });
}

/* ═══════════════════════════════════════════════════════════════════════
 * WHAT BLOCKS `sealed`, IN CODE RATHER THAN IN PROSE
 *
 * INTEGRATION_LIFECYCLE.md correction 4: "probes are a PRECONDITION OF
 * APPROVAL... a seal is not granted without an admissible run, probe 7
 * with its negative control included."
 *
 * There is no HTTP write route and `lib/seal/registry.ts` is not ours to
 * change, so this cannot be a hard gate on `applySeal()`. It is the next
 * best thing and deliberately not a document: a list an operator and a
 * test can both read, so "canvas is not sealed" has a machine-checkable
 * reason attached to it. `test/v2/studio-sealed.test.ts` asserts it is
 * non-empty, which means the day someone believes the gap is closed they
 * have to delete an entry here and say why.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface SealBlocker {
  id: string;
  finding: string;
  /** What would clear it. Not a plan — a statement of what is missing. */
  clears_when: string;
}

export const CANVAS_SEAL_BLOCKERS: readonly SealBlocker[] = [
  {
    id: 'CSB-01',
    finding:
      'NO ADMISSIBLE PROBE RUN EXISTS FROM CANVAS\'S TENANT POSITION. Canvas\'s tenant is a ' +
      'browser on the public internet holding a session cookie; the workload is a ComfyUI ' +
      'process in a Modal container we do not have a shell in. Neither position is occupiable ' +
      'from this host, so `OsVantage` here answers topology questions about the WRONG position ' +
      'and `SimulatedVantage` stamps every result inadmissible by construction. WO-14\'s ' +
      'namespace harness builds a tenant position out of network and mount namespaces on this ' +
      'machine; it cannot build one on Modal\'s.',
    clears_when:
      'an admissible run of the `inference-host` required set (P-01, P-02, P-03, P-05, P-06, ' +
      'P-07 — P-04 is class-exempt for a profile declaring no filesystem-watch) is produced ' +
      'from inside the Modal container and from a real browser-equivalent client, with probe ' +
      '7\'s negative control included.',
  },
  {
    id: 'CSB-02',
    finding:
      'P-06 HAS NOTHING TO MEASURE ON THIS PATH. Probe 6 is counter/replay against the ratchet, ' +
      'and canvas has no ratchet, no component and no MAC — its sink is `ingestIteration`. That ' +
      'is NOT the liveness not-a-finding of INTEGRATION_LIFECYCLE.md correction 5 (a counter ' +
      'that cannot go silent because there is no counter); it is a REQUIRED PROBE OF THE ' +
      'DECLARED CLASS with no subject, which aggregates as `unmeasured` and therefore as not ' +
      'passed.',
    clears_when:
      'canvas submits through a ratcheted component envelope, or `inference-host` is shown to ' +
      'be the wrong class for a deployment whose capture path is the vendor\'s own server code ' +
      '— and the second is a change to the class, argued at class scope, not a canvas exemption.',
  },
  {
    id: 'CSB-03',
    finding:
      'THE `vendor-custody` HISTORY CONDITION IS UNMET. `custodyAssuranceFor` permits ' +
      '"this is the complete history of the project" for vendor-custody + sidecar-gate ONLY ' +
      'while no path the measured party can reach writes into the custody store without ' +
      'crossing the pipeline — "evidenced by probe 4 from an occupied tenant position, or by ' +
      'the class-checked absence of a filesystem egress path". Canvas has NEITHER: probe 4 is ' +
      'not satisfiable (no filesystem-watch surface, CANVAS_BASELINE.md §3.1) and the ' +
      'filesystem egress path is not absent, it is UNOBSERVED (§7, C-9: comfy_api_nodes ships ' +
      '~25 in-tree packs that open sessions to external services from inside the ComfyUI ' +
      'process). The locus is correct; the sentence it unlocks is not yet earned.',
    clears_when:
      'the C-9 egress path is either closed at the container boundary or observed, and the ' +
      'result is evidenced from an occupied position rather than read out of the source.',
  },
];
