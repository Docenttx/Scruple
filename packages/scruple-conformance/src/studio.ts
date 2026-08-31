// Studio's evidence, DERIVED FROM SOURCE. The acceptance test for the harness.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE IS NOT A TABLE OF BOOLEANS
// ---------------------------------------------------------------------------
//
// The whole claim of the grade harness is that two people grading the same
// integration get the same answer. A harness fed hand-written booleans proves
// only that whoever wrote the booleans had read STUDIO_P1-P8_GRADE.md, and it
// would reproduce that document's two FAILs for the same reason a photocopier
// would.
//
// So every load-bearing fact below is extracted from the source it is a fact
// about, by an anchor that is named in the extraction. If an anchor is missing
// the function THROWS. It does not default, it does not fall back to `false`,
// and it never returns the benign value — a derivation that quietly degrades
// is exactly how a harness grades a broken integration clean, which is the one
// outcome the WO says means the harness is broken rather than the integration.
//
// ---------------------------------------------------------------------------
// READ THROUGH A `ReadSource`, AND PIN IT
// ---------------------------------------------------------------------------
//
// Grading a working tree that other people are editing is grading nothing. The
// reader is an injection so the acceptance test can pin it to a commit
// (`git show <sha>:<path>`), which is also what makes the grade citable — a
// grade with no source ref is an opinion with line numbers.

import crypto from 'node:crypto';

import type { HostCaptureProfile } from '../../../lib/capture/surface';
import type { Cited, DeclaredEvidence, GradeInput } from './grade';
import type { SealEvidence } from './seal';

export type ReadSource = (repoRelativePath: string) => string | null;

export class DerivationError extends Error {}

/* ────────────────────────────────────────────────────────────────────────
 * ANCHORS MATCH CODE, NOT PROSE — and this rule was written by a bug.
 *
 * The first cut anchored Kohya's P3 on `/SCRUPLE_APPS_WITNESS_SECRET/` and
 * matched on `/SCRUPLE_WITNESS_SECRET:\s*witnessSecret/`. A concurrent WO
 * replaced the global secret with a per-session token, so the code pattern
 * stopped matching — but the old identifier survived IN A COMMENT explaining
 * what had been removed. The anchor still matched, the pattern did not, and
 * the grader reported P3 as IMPROVED.
 *
 * It has not improved. A per-session token narrows the blast radius from
 * all-users to one-user, which is worth doing, and it does not move the
 * credential out of a shell the witnessed party controls. P3 is about custody,
 * not scope.
 *
 * Two rules fall out, and both are enforced below:
 *
 *   1. STRIP COMMENTS BEFORE MATCHING. A grader that reads documentation as
 *      evidence can be defeated by deleting a line and explaining why.
 *   2. ANCHOR ON THE PROPERTY, NOT ON THE IDENTIFIER. "a credential-shaped
 *      value is injected into the pod environment" survives a rename;
 *      "SCRUPLE_WITNESS_SECRET appears" does not. Every anchor below is
 *      labelled PROPERTY or STRING, and the STRING ones are only used where
 *      the identifier IS the fact (a specific env var's custody) or where the
 *      finding is documentary (a docstring that lies).
 * ──────────────────────────────────────────────────────────────────────── */

/** Source with `//` and block comments removed, so prose cannot be evidence. */
export function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/^\s*#[^\n]*/gm, '');
}

/** Env keys that name a credential, whatever the product calls them today. */
const CREDENTIAL_KEY = /\bSCRUPLE_[A-Z0-9_]*(SECRET|TOKEN|KEY|CREDENTIAL|PASSWORD)[A-Z0-9_]*\b/g;

function must(read: ReadSource, p: string): string {
  const s = read(p);
  if (s === null) {
    throw new DerivationError(
      `${p} could not be read from the pinned source. The grade refuses to proceed: a fact ` +
        'about a file nobody could open is not a fact.',
    );
  }
  return s;
}

/** Assert an anchor exists, and return whether the pattern that follows matches. */
function anchored(src: string, path: string, anchor: RegExp, pattern: RegExp): boolean {
  if (!anchor.test(src)) {
    throw new DerivationError(
      `anchor ${anchor} not found in ${path}. The file has changed shape under the ` +
        'derivation; re-derive rather than trusting a pattern that no longer knows where it is.',
    );
  }
  return pattern.test(src);
}

/* ────────────────────────────────────────────────────────────────────────
 * P2's one genuinely mechanical check: what does the estate's only
 * tamper surface actually cover?
 * ──────────────────────────────────────────────────────────────────────── */

export function deriveBaselineCoverage(read: ReadSource): { ref: string; covers: string[] } | null {
  // TWO manifests, not one, and both have to be read or the grader reports a
  // FAIL that a landed retrofit already closed. `tamper-surface.mjs` covers
  // four files of the witness server; `lib/canvas/baseline.ts` was added by
  // the canvas retrofit and covers the canvas capture path. A grader that
  // knows about only the first is as wrong as one that knows about neither —
  // it is just wrong in the flattering direction next time.
  const sources: Array<{ path: string; prefix: string }> = [
    { path: 'services/witness-server/tamper-surface.mjs', prefix: 'services/witness-server/' },
    { path: 'lib/canvas/baseline.ts', prefix: '' },
  ];

  const covers: string[] = [];
  const refs: string[] = [];
  let sawAny = false;

  for (const src of sources) {
    const raw = read(src.path);
    if (raw === null) continue; // not present at this ref; not an error
    sawAny = true;
    // The terminator is `\n];`, NOT the first `]`.
    //
    // Found by grading a real baseline: the canvas manifest's first entry is
    // `'app/canvas-proxy/[sessionId]/[[...path]]/route.ts'`, and a lazy
    // `[\s\S]*?\]` stops inside `[sessionId]`. The parse then returned ONE
    // covered file out of twenty-three and the grader reported P2 FAIL on a
    // baseline that covers the whole path — a false NEGATIVE, which is the
    // less dangerous direction and still wrong. Next.js route segments are
    // going to keep putting brackets in paths.
    const m = /export const TRACKED[^=]*=\s*\[([\s\S]*?)\n\];/.exec(raw);
    if (!m) {
      throw new DerivationError(
        `${src.path} exists but has no \`export const TRACKED = [...]\`. That array is what a ` +
          'baseline covers; if it moved, P2 is being graded against nothing.',
      );
    }
    for (const q of m[1].matchAll(/'([^']+)'/g)) covers.push(src.prefix + q[1]);
    refs.push(`${src.path}#TRACKED`);
  }

  if (!sawAny) {
    throw new DerivationError(
      'No baseline manifest could be read at all. Expected at least ' +
        'services/witness-server/tamper-surface.mjs.',
    );
  }
  return covers.length ? { ref: refs.join(' + '), covers } : null;
}


/* ────────────────────────────────────────────────────────────────────────
 * THE SEAL STATE IS NOT IN THE SOURCE, AND SAYING SO IS THE DERIVATION
 *
 * A deployment's lifecycle state is a fold over signed events in
 * `deployment_lifecycle_events` (migration 046), not a fact any file states.
 * A source-pinned derivation therefore CANNOT read it, and the honest return
 * for canvas and Kohya is that nothing describes a seal state for them at all
 * — which is the registry's `undeclared`, and which migration 046 says in as
 * many words: "canvas and the plugins carry no component and no deployment".
 *
 * That is an ordinary place to be. It is step 1.
 *
 * THE TRIPWIRE. The moment a capture path names a deployment id, this
 * derivation is looking at an integration whose seal state lives somewhere it
 * cannot see, and returning `null` would report a pre-seal state for a
 * deployment that may be sealed — the flattering direction, which is the one
 * direction this file refuses to fail in. So it throws and asks to be wired to
 * `sealStatus()` instead.
 * ──────────────────────────────────────────────────────────────────────── */
export function deriveSealEvidence(
  read: ReadSource,
  capturePathFiles: readonly string[],
  injected: Cited<SealEvidence> | null = null,
): Cited<SealEvidence> | null {
  if (injected) return injected;
  const src = capturePathFiles.map((f) => code(read(f) ?? '')).join('\n');
  if (/\bdeployment_?[Ii]d\b/.test(src)) {
    throw new DerivationError(
      'The capture path names a deployment id, so this integration is bound to a deployment in ' +
        'lib/seal/registry.ts and its seal state is a fold over signed lifecycle events — not ' +
        'something source can answer. Pass sealStatus(deploymentId) in as evidence rather than ' +
        'letting the grade report a pre-seal state for a deployment that may be sealed.',
    );
  }
  return null;
}

/**
 * A cited absence of any ratchet on this path — LIVENESS evidence, never P2.
 *
 * Without it the grader cannot tell "this deployment has a counter chain and
 * nobody accounted for its gaps" from "there is no counter chain here", and
 * reporting both as a missing completeness proof is what made canvas look
 * unfixable. Property anchor over comment-stripped source: `lib/canvas/
 * witness.ts` says "Canvas has no ratchet" in a COMMENT, and a comment is not
 * evidence in this file (see the ANCHORS MATCH CODE note above). The absence
 * of ratchet machinery in the code is.
 */
export function deriveRatchetAbsence(
  read: ReadSource,
  capturePathFiles: readonly string[],
): Cited<string> | null {
  const src = capturePathFiles.map((f) => code(read(f) ?? '')).join('\n');
  if (/\bratchet|nextCounter|advanceRatchet|\bcounter\s*[:=]/i.test(src)) return null;
  return {
    value:
      'no ratchet machinery appears anywhere on the declared capture path — no counter is ' +
      'advanced, no chain key is used, and the sink is an ingest call rather than a ratcheted ' +
      'component submission',
    cite: `${capturePathFiles.join(' / ')} (comment-stripped: no counter chain)`,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Path A — canvas / ComfyUI
 * ──────────────────────────────────────────────────────────────────────── */

const CANVAS_PROXY = 'app/canvas-proxy/[sessionId]/[[...path]]/route.ts';
const CANVAS_CAPTURE_PATH = [
  CANVAS_PROXY,
  'lib/canvas/witness.ts',
  'lib/iterations/ingest.ts',
  'scripts/canvas-ws-proxy.mjs',
];

/**
 * `capturePathFiles` IS A DECLARED P2 INPUT, not a constant, and it has to be
 * a parameter because the capture path MOVES. The canvas retrofit replaced
 * `scripts/canvas-ws-proxy.mjs` with `lib/canvas/ws-capture.ts` and pulled the
 * shared secret into `lib/canvas/gate.ts`; a derivation pinned to the old list
 * either throws (which it does, loudly, by design) or — far worse — reports an
 * improvement because the thing it was looking for is no longer there.
 *
 * Re-declaring the list when the code moves is exactly what P2 asks an
 * integrator to do. The default is the list the published grade names.
 */
export function deriveCanvas(
  read: ReadSource,
  probesRun: GradeInput['probes'] = null,
  capturePathFiles: readonly string[] = CANVAS_CAPTURE_PATH,
): GradeInput {
  const proxy = must(read, capturePathFiles[0]);
  const witness = must(read, 'lib/canvas/witness.ts');
  const leafShape = must(read, 'lib/scruple/witness.ts');
  // Everything on the declared capture path that is not the route or the
  // witness module — the WS half, the gate, whatever the retrofit called it
  // this week. Read as one blob: the question is where the credential lives on
  // the path, not which file holds it.
  const rest = capturePathFiles
    .slice(1)
    .filter((f) => f !== 'lib/canvas/witness.ts')
    .map((f) => read(f) ?? '')
    .join('\n');
  const sidecar = rest;

  const baseline = deriveBaselineCoverage(read);

  // P3 — the shared secret is read from the server environment inside the
  // proxy and the browser is handed a session id. Anchored on the env var so a
  // rename is a loud failure rather than a silent PASS.
  // P3 — PROPERTY anchor. Not "SCRUPLE_CANVAS_SHARED_SECRET appears" but
  // "every credential-shaped value this path uses is read from the SERVER
  // process environment". A rename cannot defeat it and a comment cannot
  // satisfy it, because the scan runs over comment-stripped source.
  const capture = code(proxy) + '\n' + code(sidecar);
  const credentialKeys = [...new Set([...capture.matchAll(CREDENTIAL_KEY)].map((m) => m[0]))];
  if (credentialKeys.length === 0) {
    throw new DerivationError(
      'No credential-shaped identifier found in the canvas proxy or its WS sidecar. Either the ' +
        'shared secret moved somewhere this derivation cannot see, or the path stopped ' +
        'authenticating to Modal. Both are findings; neither is a P3 pass by default.',
    );
  }
  const secretServerSide = credentialKeys.every((k) =>
    new RegExp(`process\\.env\\.${k}\\b`).test(capture),
  );

  // P4 — PROPERTY anchor: identity comes from a server-side session AND is
  // not read out of the request body. Either half alone is satisfiable by an
  // integration that does both.
  const sessionDerived = /\bauth\(\)|getServerSession\(|await userId\(\)/.test(code(proxy));
  const bodySupplied = /\bbody\.(user_?[Ii]d|userId)\b/.test(code(proxy) + code(witness));
  const identityFromSession = sessionDerived && !bodySupplied;

  // P5 — a leaf is actually created, and no prior leaf is updated. The UPDATE
  // in this file targets canvas_pending_iterations (a work queue), not a leaf.
  // PROPERTY anchor: a leaf is produced by SOME route, and no prior leaf row
  // is updated in place. Names the shapes rather than one function.
  const leavesCreated = /\b(ingestIteration|witnessLeaf|leafHash)\b|\/api\/v2\/witness/.test(
    code(witness),
  );
  const mutatesLeaves = /UPDATE\s+(iterations|leaves)\b/i.test(code(witness));

  // P5's separate §7 finding: ingest failure is swallowed.
  const swallowsIngestFailure = /catch \(e\) \{\s*console\.error\('\[canvas\/witness\] ingest failed', e\);\s*\}/.test(
    witness,
  );

  // P6 — the legacy v2.2 record's field list.
  const recordFields = [...leafShape.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
  const carriesPayload = /imageBytes|payload|contentBase64/.test(
    /export interface WitnessIterationRecord \{[\s\S]*?\n\}/.exec(leafShape)?.[0] ?? '',
  );

  // P1 condition 1 — the WS sidecar is pass-through, asserted in a comment.
  const wsIsPassThroughByComment = anchored(
    sidecar,
    'scripts/canvas-ws-proxy.mjs',
    /provenance|status/i,
    /authoritative provenance bytes|status events/i,
  );
  // P1 condition 3 — the manifest lookup falls back to a null user.
  const manifestFallsBackToNull = anchored(
    witness,
    'lib/canvas/witness.ts',
    /manifest_hash/,
    /user_id IS NULL/,
  );

  const profile: HostCaptureProfile = {
    host: 'canvas / ComfyUI (server-side proxy, as shipped)',
    hooks: ['graph.execute', 'artifact.produced'],
    surfaces: ['network-gate'],
    fidelity: 'as-delivered',
    // SIDECAR-GATE, not server-library, and the difference is not pedantry.
    //
    // The tempting reading is that the proxy runs in scruple-web's own server
    // process, the measured party is a browser, therefore `server-library`.
    // That reading makes P1 hold UNCONDITIONALLY — and the published grade's
    // P1 is explicitly conditional, because what it actually turns on is
    // whether a tenant can reach the Modal URL without going through the
    // proxy. That is a topology question (H-4 §7 probe 1), not a property of
    // where the code lives, and `server-library` would answer it by
    // declaration. It would also make P3 hold unconditionally and drop the
    // shared secret's custody out of the grade entirely.
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
    // INFERENCE-HOST, and declaring it is what stops probe 4 reading as a
    // canvas failure. The class declares P-04 not applicable to a member with
    // no `filesystem-watch` surface, and canvas declares none — so the
    // not-applicable is CHECKED against the profile rather than accepted from
    // `surfaceAbsences` on a cite nobody could verify.
    capabilityClasses: ['inference-host'],
    // Files rest on the Modal volume. The browser user reaches them only
    // through the proxy, so every mutation crosses a path the pipeline sees —
    // conditionally, on the same fact P1's declared conditions turn on (a
    // pinned default machine manifest, no user-defined custom nodes).
    custodyLocus: 'vendor-custody',
  };

  const evidence: DeclaredEvidence = {
    capturePathFiles: {
      value: [...capturePathFiles],
      cite: capturePathFiles.join(', '),
    },
    baseline: baseline && capturePathFiles.every((f) => baseline.covers.includes(f))
      ? { value: baseline, cite: baseline.ref }
      : null,
    seal: deriveSealEvidence(read, capturePathFiles),
    // LIVENESS, NOT P2. Canvas has no ratchet; that is a fact about liveness
    // being unavailable here, and it stopped being a coverage failure when P2
    // stopped being a completeness proof.
    ratchetGapAccounting: null,
    ratchetAbsence: deriveRatchetAbsence(read, capturePathFiles),
    keyCustody: {
      value: {
        reachableByMeasuredParty: !secretServerSide,
        where: secretServerSide
          ? `${credentialKeys.join(', ')} are read from the SERVER process environment by the proxy and the sidecar; the browser receives a session id, not a credential, and not the upstream URL`
          : `not held server-side: ${credentialKeys.join(', ')}`,
        // The sidecar-gate condition assuranceFor attaches to P3 is about a
        // SEALED KEY FILE on a host the measured party can reach. There is no
        // such file here: the credential is an environment variable in a
        // process a browser has no code execution in. The condition is not
        // waived, it is inapplicable, and the citation is the process boundary.
        dischargesSealCondition: secretServerSide,
      },
      cite: `${capturePathFiles.join(' / ')} (process.env.*) — credential lives in scruple-web's server process, which the measured party (a browser) has no code execution in`,
    },
    principalIdentity: {
      value: {
        suppliedByMeasuredParty: !identityFromSession,
        source: identityFromSession
          ? 'auth() on the proxy request; project resolved server-side by resolveActiveProjectId(userId)'
          : 'unknown',
      },
      cite: `${CANVAS_PROXY} (auth()), lib/canvas/witness.ts (resolveActiveProjectId)`,
    },
    eventChain: {
      value: { leavesCreated, mutatesPriorRows: mutatesLeaves },
      cite: 'lib/canvas/witness.ts (ingestIteration)',
    },
    zeroContent: {
      value: { carriesPayloadBytes: carriesPayload, fields: recordFields.slice(0, 12) },
      cite: 'lib/scruple/witness.ts (WitnessIterationRecord)',
    },
    attestationDeclaration: null,
    attestationImport: null,
    // Canvas has NO filesystem surface: the Modal volume is not mountable into
    // scruple-web, so probe 4 has nothing to write into. Declared here so the
    // grader records that P2's coverage for that path rests on a declaration
    // it cannot check — WO-5 DEFECT-2, named rather than papered over.
    surfaceAbsences: {
      'P-04': {
        value:
          'no filesystem surface — the Modal volume is not mountable into scruple-web, so there ' +
          'is no output/temp/input directory for a watcher to watch or a tenant to write into',
        cite: 'lib/canvas/witness.ts + the canvas proxy: capture is network-gate only',
      },
    },
    declaredP1Conditions: [
      wsIsPassThroughByComment
        ? 'the WebSocket sidecar stays pass-through. scripts/canvas-ws-proxy.mjs asserts it in a COMMENT, and it is a property of the upstream application, not of our code — a ComfyUI version that returns result bytes over WS silently opens an uncaptured egress path. This needs an assertion in the baseline.'
        : 'the WebSocket sidecar is not asserted to be pass-through anywhere',
      'personal machines (WO-7) would break it: if a user can define their own custom-node manifest they choose the middleware inside the boundary, which is the shape P1 names unacceptable.',
      manifestFallsBackToNull
        ? 'only the default machine\'s manifest is pinned; the lookup falls back to `user_id IS NULL`, so a null manifest hash degrades to a v2 leaf silently rather than refusing.'
        : 'the machine manifest lookup no longer falls back to a null user',
    ],
    separateFindings: swallowsIngestFailure
      ? [
          {
            title: 'Standard §7 — ingest failure is silently swallowed',
            detail:
              'The user receives their image; no leaf is written; nothing surfaces. That produces a chain with holes carrying no record of the holes. A hole you can see is evidence; a hole you cannot see is a lie of omission.',
            cite: 'lib/canvas/witness.ts (catch → console.error, no rethrow, no record)',
          },
        ]
      : [],
  };

  return { path: 'Canvas / ComfyUI', profile, evidence, probes: probesRun };
}

/* ────────────────────────────────────────────────────────────────────────
 * Path B — Kohya
 * ──────────────────────────────────────────────────────────────────────── */

const KOHYA_ROUTE = 'app/api/apps/kohya/witness/route.ts';
const KOHYA_HOOK_PUBLIC = 'public/pod-hooks/kohya_safetensors_hook.py';
const KOHYA_HOOK_RESEARCH = 'research/scruple-kohya-image/scruple_safetensors_hook.py';
const KOHYA_CAPTURE_PATH = [KOHYA_HOOK_PUBLIC, KOHYA_ROUTE, 'lib/apps/backends/runpod-session.ts'];

export function deriveKohya(read: ReadSource, probesRun: GradeInput['probes'] = null): GradeInput {
  const route = must(read, KOHYA_ROUTE);
  const spawn = must(read, 'lib/apps/backends/runpod-session.ts');
  const hookPublic = must(read, KOHYA_HOOK_PUBLIC);
  const hookResearch = read(KOHYA_HOOK_RESEARCH);

  const baseline = deriveBaselineCoverage(read);

  // P1 — PROPERTY anchor, two independent halves, either of which is fatal:
  //   * the hook is a file the tenant's own pod fetches and imports, so the
  //     tenant can delete it, set PYTHONNOUSERSITE, or re-patch save_file; and
  //   * it reads its configuration from the pod environment, which the tenant
  //     controls, and does nothing when that configuration is absent.
  // Neither half is a string match on a docstring. The docstring is used only
  // as a SEPARATE FINDING below, where its being documentary is the point.
  const hookCode = code(hookPublic);
  const hookReadsPodEnv = /os\.environ(\.get)?\s*[.(\[]/.test(hookCode);
  const hookNoOpsWithoutEnv = /\breturn\b/.test(hookCode) && hookReadsPodEnv;
  const hookIsServedToPod = KOHYA_HOOK_PUBLIC.startsWith('public/');
  const hookIsOptional = hookIsServedToPod && hookNoOpsWithoutEnv;
  if (!hookReadsPodEnv) {
    throw new DerivationError(
      `${KOHYA_HOOK_PUBLIC} no longer reads its configuration from the pod environment. The ` +
        'derivation cannot find the mechanism P1 is about; re-derive rather than reporting a pass.',
    );
  }

  // P2 — two divergent copies, so there is no single file to measure.
  const hashPublic = crypto.createHash('sha256').update(hookPublic).digest('hex');
  const hashResearch = hookResearch ? crypto.createHash('sha256').update(hookResearch).digest('hex') : null;
  const divergentCopies = hashResearch !== null && hashResearch !== hashPublic;

  // P3 — PROPERTY anchor, and this one has already been defeated once by a
  // string anchor (see the ANCHORS MATCH CODE note at the head of this file).
  //
  // The property is "a credential-shaped value is put into the environment of
  // a pod the tenant has a shell in". Not "SCRUPLE_WITNESS_SECRET appears" —
  // that identifier was replaced by a per-session token in a later WO, and a
  // per-session token is the same custody failure with a smaller blast radius.
  // P3 is about custody, not scope.
  const spawnCode = code(spawn);
  const podEnvCredentials = [...new Set([...spawnCode.matchAll(CREDENTIAL_KEY)].map((m) => m[0]))];
  // The anchor is the pod env block itself, identified by a key that is not a
  // credential and so has no reason to be renamed by a custody change.
  if (!/SCRUPLE_USER_ID/.test(spawnCode)) {
    throw new DerivationError(
      'lib/apps/backends/runpod-session.ts no longer builds a pod environment containing ' +
        'SCRUPLE_USER_ID. The derivation cannot find the block P3 is about; re-derive rather ' +
        'than reporting an improvement.',
    );
  }
  const secretInPodEnv = podEnvCredentials.length > 0;

  // P4 — PROPERTY anchor: the principal arrives on the wire from the pod
  // rather than from a server-side session.
  const routeCode = code(route);
  const identityInBody =
    /\buser_?[Ii]d\s*:\s*z\./.test(routeCode) || /\bbody\.user_?[Ii]d\b/.test(routeCode);

  // P5 — PROPERTY anchors, over comment-stripped source. The route's own
  // comment explains at length that it does NOT sign a leaf, and a grader that
  // read comments would find every one of these words in it.
  const createsLeaf = /\b(witnessLeaf|ingestIteration|leafHash)\b|\/api\/v2\/witness/.test(routeCode);
  const mutatesPrior = /UPDATE\s+training_runs\s+SET/i.test(routeCode);

  // P6 — PROPERTY anchor: does the accepted body carry payload bytes?
  const carriesPayload = /\b(weights|tensor_bytes|payload|file_base64)\b/i.test(routeCode);

  const profile: HostCaptureProfile = {
    host: 'kohya (in-pod hook, as shipped)',
    hooks: ['model.write'],
    surfaces: ['in-process-callback'],
    fidelity: 'as-written',
    // Declared as a gate by the WO series; nothing enforces it. The pod is
    // the tenant's, with a shell in it.
    declaredPlacement: 'sidecar-gate',
    enforcement: hookIsOptional ? 'none' : 'isolated-namespace',
    attestation: 'none',
    // TRAINING-HOST, and the class immediately says something the P-item table
    // never did: a checkpoint is a FILE, so the class requires a
    // `filesystem-watch` position and this profile has only an in-process
    // patch on `safetensors.save_file`. That is a COVERAGE finding independent
    // of placement — the patch covers the saves that go through the function
    // it patched and no others — and it is exactly the re-placement WO-11
    // describes. It also drops probe 5 from Kohya's required set: there is no
    // interactive retrieval channel for a checkpoint.
    capabilityClasses: ['training-host'],
    // The pod is the tenant's and they have a shell in it.
    custodyLocus: 'shared-custody',
  };

  const evidence: DeclaredEvidence = {
    capturePathFiles: { value: KOHYA_CAPTURE_PATH, cite: KOHYA_CAPTURE_PATH.join(', ') },
    baseline:
      baseline && KOHYA_CAPTURE_PATH.every((f) => baseline.covers.includes(f))
        ? { value: baseline, cite: baseline.ref }
        : null,
    seal: deriveSealEvidence(read, KOHYA_CAPTURE_PATH),
    ratchetGapAccounting: null,
    ratchetAbsence: deriveRatchetAbsence(read, KOHYA_CAPTURE_PATH),
    keyCustody: {
      value: {
        reachableByMeasuredParty: secretInPodEnv,
        where: secretInPodEnv
          ? 'SCRUPLE_WITNESS_SECRET is injected as a pod environment variable, in a shell the witnessed party controls — and it is GLOBAL, one secret for every pod and every user'
          : 'not in the pod environment',
      },
      cite: 'lib/apps/backends/runpod-session.ts (env.SCRUPLE_WITNESS_SECRET)',
    },
    principalIdentity: {
      value: {
        suppliedByMeasuredParty: identityInBody,
        source: 'user_id and session_id in the request body, cross-checked against app_sessions',
      },
      cite: `${KOHYA_ROUTE} (request body schema)`,
    },
    eventChain: {
      value: { leavesCreated: createsLeaf, mutatesPriorRows: mutatesPrior },
      cite: `${KOHYA_ROUTE} (writes app_kohya_progress and training_runs, returns ok:true)`,
    },
    zeroContent: {
      value: {
        carriesPayloadBytes: carriesPayload,
        fields: ['output_hash', 'header_hash', 'size_bytes', 'structural_summary'],
      },
      cite: `${KOHYA_ROUTE} (body schema)`,
    },
    attestationDeclaration: null,
    attestationImport: null,
    // NONE, AND THE PREVIOUS VALUE HERE WAS CANVAS'S, COPIED. It declared "no
    // filesystem surface — the Modal volume is not mountable into scruple-web"
    // on KOHYA's evidence, citing `lib/canvas/witness.ts` from a grade of a
    // RunPod pod. Kohya has a filesystem; what it lacks is a watcher on it,
    // which is a finding and not an absence. The frozen profile never reached
    // this field for Kohya (P2 fails earlier, on the missing baseline), so the
    // published cells are unaffected — it was a false statement waiting for
    // the first rule that read it.
    //
    // The honest version of the same fact is now the class's: `training-host`
    // REQUIRES a `filesystem-watch` position and this profile declares none.
    surfaceAbsences: {},
    declaredP1Conditions: [],
    separateFindings: [
      ...(divergentCopies
        ? [
            {
              title: 'Two divergent copies of the hook exist',
              detail:
                `${KOHYA_HOOK_PUBLIC} (sha256 ${hashPublic.slice(0, 12)}) and ${KOHYA_HOOK_RESEARCH} ` +
                `(sha256 ${hashResearch!.slice(0, 12)}) differ. You cannot baseline a file that ` +
                'ships in two versions, so this blocks P2 before any manifest is written.',
              cite: `${KOHYA_HOOK_PUBLIC} vs ${KOHYA_HOOK_RESEARCH}`,
            },
          ]
        : []),
      ...(!createsLeaf
        ? [
            {
              title: 'The hook\'s docstring claims a leaf is signed and the route never signs one',
              detail:
                'The route writes app_kohya_progress and training_runs and returns ok:true. Anyone ' +
                'reading the pod hook believes Kohya is witnessed. Reporting an unwitnessed ' +
                'checkpoint as witnessed is the one failure mode with no honest defence.',
              cite: `${KOHYA_HOOK_PUBLIC} docstring vs ${KOHYA_ROUTE}`,
            },
          ]
        : []),
    ],
  };

  return { path: 'Kohya', profile, evidence, probes: probesRun };
}

export function deriveStudio(
  read: ReadSource,
  probesRun: GradeInput['probes'] = null,
  canvasCapturePath?: readonly string[],
): GradeInput[] {
  return [deriveCanvas(read, probesRun, canvasCapturePath), deriveKohya(read, probesRun)];
}
