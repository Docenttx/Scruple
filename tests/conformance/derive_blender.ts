// WO-B6 — the Blender add-on, graded by @scruple/conformance.
//
// ---------------------------------------------------------------------------
// DERIVED FROM SOURCE, NOT FROM A TABLE OF BOOLEANS
// ---------------------------------------------------------------------------
//
// The rule `packages/scruple-conformance/src/studio.ts` opens with applies
// here unchanged: a harness fed hand-written booleans proves only that whoever
// wrote them had read the WO. So every load-bearing fact below is extracted
// from the addon's own source by an anchor that is named in the extraction,
// and a missing anchor THROWS rather than defaulting to the flattering value.
//
// Two source trees, and the split matters:
//
//   readAddon  /data/scruple-blender — the integration being graded. Pinned to
//              a commit, because grading a tree somebody is editing is grading
//              nothing.
//   readWeb    /data/scruple-web — read ONLY for `lib/capture/surface.ts`'s
//              registered `blender` profile. The profile is the server's
//              declaration ABOUT this host; taking it from the addon would let
//              the graded party write its own security target.
//
// WHY THE ANSWER IS EXPECTED TO BE NON-COMPLIANT. Blender is an
// `authoring-application` running on the user's own machine, with
// `declaredPlacement: 'attested-client'`, `enforcement: 'none'` and
// `attestation: 'none'` in the registered profile. A grade that came out
// compliant would mean the harness is broken, not that the addon is finished —
// the same reasoning `conformance.test.ts` applies to Studio's two published
// FAILs. `assertGradeIsHonest` below asserts that, and the mutation control in
// `grade_blender.ts` shows the grader responds when a fact is changed.

import crypto from 'node:crypto';

import type { HostCaptureProfile } from '../../../scruple-web/lib/capture/surface';
import type { DeclaredEvidence, GradeInput } from '../../../scruple-web/packages/scruple-conformance/src/grade';

export type ReadSource = (repoRelativePath: string) => string | null;

export class DerivationError extends Error {}

/** Source with `#` and `"""` docstrings removed, so prose cannot be evidence. */
export function pycode(src: string): string {
  return src
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/'''[\s\S]*?'''/g, ' ')
    .replace(/^\s*#[^\n]*/gm, '');
}

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

function anchored(src: string, path: string, anchor: RegExp, pattern: RegExp): boolean {
  if (!anchor.test(src)) {
    throw new DerivationError(
      `anchor ${anchor} not found in ${path}. The file has changed shape under the derivation; ` +
        're-derive rather than trusting a pattern that no longer knows where it is.',
    );
  }
  return pattern.test(src);
}

const CAPTURE_PATH = [
  'adapter/flow.py',
  'adapter/handlers.py',
  'adapter/scene.py',
  'adapter/assurance.py',
  'adapter/sdk.py',
];

/**
 * The registered `blender` profile, read out of the SERVER's registry.
 *
 * Parsed rather than imported because `lib/capture/surface.ts` is TypeScript in
 * another repo and this file has to run without a build step. The parse is
 * anchored on the `blender:` key and throws if any field it needs is absent —
 * a profile with a missing field is not a profile with a default.
 */
export function readRegisteredProfile(readWeb: ReadSource): HostCaptureProfile {
  const src = must(readWeb, 'lib/capture/surface.ts');
  const m = /\n {2}blender:\s*\{([\s\S]*?)\n {2}\},/.exec(src);
  if (!m) {
    throw new DerivationError(
      'lib/capture/surface.ts has no `blender:` entry in CAPTURE_PROFILES. The host this grade ' +
        'is about is not registered; there is nothing to grade it against.',
    );
  }
  const block = m[1];
  const scalar = (k: string): string => {
    const v = new RegExp(`${k}:\\s*'([^']+)'`).exec(block);
    if (!v) throw new DerivationError(`blender profile has no ${k}. Refusing to substitute one.`);
    return v[1];
  };
  const list = (k: string): string[] => {
    const v = new RegExp(`${k}:\\s*\\[([^\\]]*)\\]`).exec(block);
    if (!v) throw new DerivationError(`blender profile has no ${k}. Refusing to substitute one.`);
    return [...v[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  return {
    host: scalar('host'),
    hooks: list('hooks'),
    surfaces: list('surfaces'),
    fidelity: scalar('fidelity'),
    declaredPlacement: scalar('declaredPlacement'),
    enforcement: scalar('enforcement'),
    attestation: scalar('attestation'),
    capabilityClasses: list('capabilityClasses'),
    custodyLocus: scalar('custodyLocus'),
  } as HostCaptureProfile;
}

export function deriveBlender(
  readAddon: ReadSource,
  readWeb: ReadSource,
  probesRun: GradeInput['probes'] = null,
): GradeInput {
  const flow = must(readAddon, 'adapter/flow.py');
  const assurance = must(readAddon, 'adapter/assurance.py');
  const sdk = must(readAddon, 'adapter/sdk.py');
  const handlers = must(readAddon, 'adapter/handlers.py');
  const http = must(readAddon, 'vendor/scruple_host_sdk/http.py');
  const witnessFlow = must(readAddon, 'vendor/scruple_host_sdk/witness_flow.py');
  const capture = must(readAddon, 'vendor/scruple_api/capture.py');

  const flowCode = pycode(flow);
  const httpCode = pycode(http);
  const witnessCode = pycode(witnessFlow);
  const captureCode = pycode(capture);
  const assuranceCode = pycode(assurance);

  // ── P1 · runtime boundary integrity ───────────────────────────────────
  // Derived by `assuranceFor` from placement x attestation, and this
  // derivation has no business second-guessing it. What IS derived here is
  // the condition the integrator attaches to their own claim: the addon is
  // a zip the user installs into an interpreter the user owns, and nothing
  // signs it. PROPERTY anchor, on the packager.
  const build = must(readAddon, 'build/build_addon.sh');
  const zipIsSigned = /\b(codesign|gpg|openssl\s+dgst|--sign)\b/.test(pycode(build));

  // ── P2 · the measured surface ────────────────────────────────────────
  // The addon establishes a baseline over its OWN installed bytes, and the
  // manifest of what that covers is computed at runtime rather than written
  // down — so the coverage claim is derived from the code that builds it.
  // PROPERTY anchor: does the tamper surface hash the addon's own files?
  const surfaceHashesOwnBytes = anchored(
    pycode(sdk),
    'adapter/sdk.py',
    /tamper_surface|baseline/i,
    /sha256|hashlib|tamper_surface/i,
  );

  // ── P3 · key custody ─────────────────────────────────────────────────
  // The API key lives in a file on the user's own machine, written by the
  // addon, readable by the user. The measured party IS the key holder.
  // PROPERTY anchor on the SDK's auth store rather than on a name.
  const auth = must(readAddon, 'vendor/scruple_host_sdk/auth.py');
  const authCode = pycode(auth);
  const keyOnUserDisk = /open\s*\(|Path\(|write_text|json\.dump/.test(authCode);
  if (!/api_key|token/i.test(authCode)) {
    throw new DerivationError(
      'vendor/scruple_host_sdk/auth.py no longer stores an API key. The derivation cannot find ' +
        'the mechanism P3 is about; re-derive rather than reporting an improvement.',
    );
  }

  // ── P4 · principal identity ──────────────────────────────────────────
  // The bearer key IS the principal and it is presented by the measured
  // party. There is no server-side session behind it.
  const principalFromMeasuredParty = anchored(
    httpCode,
    'vendor/scruple_host_sdk/http.py',
    /Authorization/,
    /Bearer\s*\{|f"Bearer/,
  );

  // ── P5 · event chain ─────────────────────────────────────────────────
  const createsLeaf = /\/api\/v2\/witness|client\.witness|witness_file/.test(
    flowCode + witnessCode,
  );
  const mutatesPrior = /\bUPDATE\s+|\bDELETE\s+FROM\b/i.test(flowCode);

  // ── P6 · zero content ────────────────────────────────────────────────
  //
  // ANCHORED ON THE REQUEST BODY, AND THE FIRST CUT WAS ANCHORED WRONG.
  // It read `capture()`, found `inline_base64`, and would have reported
  // Blender as carrying payload bytes. It does not: `capture()` computes an
  // inline encoding, `witness()` builds a body from `content_hash` and never
  // reads it, and nothing in the addon passes it on. P6 asks what leaves the
  // machine, so the anchor is the dict that becomes the POST body.
  //
  // The wasted encoding is real and is reported below as a separate finding,
  // where it belongs — it is a cost and a memory-residency question, not a
  // zero-content failure.
  const bodyBlock = /body:\s*Dict\[str,\s*Any\]\s*=\s*\{([\s\S]*?)\n {4}\}/.exec(witnessCode);
  if (!bodyBlock) {
    throw new DerivationError(
      'vendor/scruple_host_sdk/witness_flow.py no longer builds a literal `body` dict. The ' +
        'derivation cannot find what P6 is about; re-derive rather than reporting a pass.',
    );
  }
  const carriesPayload = /base64|payload|bytes|content\b(?!_hash)/.test(bodyBlock[1]);
  const captureEncodesUnused =
    /inline_base64\(path\)/.test(captureCode) && !/inline_base64/.test(witnessCode + flowCode);

  // ── P7 · attestation declaration ─────────────────────────────────────
  // Does the addon declare an attestation provider anywhere? It records the
  // status the SERVER sends and declares none of its own — which is the
  // honest thing for a client on a machine it does not own, and is still a
  // P7 FAIL, because P7 asks whether one is declared, not whether declining
  // to declare one was reasonable.
  const declaresProvider = /attestation_provider\s*=\s*["'](?!none)/.test(assuranceCode + flowCode);

  // ── P8 · imported attestations ───────────────────────────────────────
  // The addon imports none. It reads `platform_attestation_status` off a
  // receipt and renders it; it never treats an attestation from elsewhere
  // as its own.
  const importsAttestations = /verify_quote|import_attestation|attestation_evidence/.test(
    assuranceCode + flowCode,
  );

  // ── the seal ─────────────────────────────────────────────────────────
  // NULL, AND NOT AS AN OVERSIGHT. The addon states its own seal state as
  // `undeclared` and `claims_standard` as false, in source. There is no
  // deployment registered for it, so there is no seal row to read and
  // nothing for `sealCurrency` to be current ABOUT.
  const declaresUnsealed = anchored(
    assuranceCode,
    'adapter/assurance.py',
    /seal_state/,
    /seal_state:\s*str\s*=\s*"undeclared"/,
  );
  if (!declaresUnsealed) {
    throw new DerivationError(
      'adapter/assurance.py no longer hardcodes seal_state="undeclared". If the addon now ' +
        'declares a deployment, this grade must read its seal row rather than assuming none.',
    );
  }

  const profile = readRegisteredProfile(readWeb);

  const evidence: DeclaredEvidence = {
    capturePathFiles: { value: [...CAPTURE_PATH], cite: CAPTURE_PATH.join(', ') },
    // The addon's baseline covers the installed zip's own bytes. Cited by
    // the function that computes it, not by a hash typed here — the hash
    // differs per build, which is the point of it.
    baseline: surfaceHashesOwnBytes
      ? {
          value: {
            ref: 'computed at runtime over the installed addon files',
            covers: [...CAPTURE_PATH],
          },
          cite: 'adapter/sdk.py (tamper surface) + vendor/scruple_host_sdk/state.py',
        }
      : null,
    seal: null,
    // H-4 is not closed in this addon: it sends no §4.3 component envelope,
    // so there is no counter chain. That is an ABSENCE, and declaring it is
    // what keeps it from being read as unaccounted silence.
    ratchetGapAccounting: null,
    ratchetAbsence: {
      value:
        'The addon sends no §4.3 component envelope. `adapter/assurance.py` records ' +
        '`component_verified = False` on every leaf and says so in terms. There is no counter ' +
        'chain on this path, so there are no gaps to account for.',
      cite: 'adapter/assurance.py (component_verified: bool = False)',
    },
    // No egress surface is claimed absent. Blender has a filesystem, a
    // network stack and a Python console; the addon is simply not positioned
    // to control any of them, which is a placement finding and not an
    // absence.
    surfaceAbsences: {},
    keyCustody: {
      value: {
        reachableByMeasuredParty: keyOnUserDisk,
        where:
          'a file on the user\'s own machine, written by the addon under its cache dir. The ' +
          'measured party owns the interpreter, the process and the disk.',
      },
      cite: 'vendor/scruple_host_sdk/auth.py (the API key store)',
    },
    principalIdentity: {
      value: {
        suppliedByMeasuredParty: principalFromMeasuredParty,
        source: 'a bearer API key presented by the addon on every request',
      },
      cite: 'vendor/scruple_host_sdk/http.py (Authorization: Bearer)',
    },
    eventChain: {
      value: { leavesCreated: createsLeaf, mutatesPriorRows: mutatesPrior },
      cite: 'adapter/flow.py -> vendor/scruple_host_sdk/witness_flow.py (POST /api/v2/witness)',
    },
    zeroContent: {
      value: {
        carriesPayloadBytes: carriesPayload,
        fields: ['content_hash', 'mime', 'kind', 'workflow', 'baseline_ref'],
      },
      cite: 'vendor/scruple_host_sdk/capture.py (hashes the file, sends no bytes)',
    },
    attestationDeclaration: declaresProvider
      ? {
          value: { declaredIn: 'adapter/', provider: 'declared in the addon' },
          cite: 'adapter/assurance.py',
        }
      : null,
    attestationImport: {
      value: { imports: importsAttestations, rejectsUnverifiable: false },
      cite: 'adapter/assurance.py (attestation_status is rendered, never imported as evidence)',
    },
    declaredP1Conditions: [
      'The addon runs inside a Python interpreter the measured party owns. Blender exposes a ' +
        'scripting console and an addons directory the user can write; nothing in this ' +
        'integration constrains either.',
      ...(zipIsSigned
        ? []
        : [
            'The distributed zip is unsigned — build/build_addon.sh has no signing step — so an ' +
              'installed copy cannot be distinguished from a modified one before it runs.',
          ]),
    ],
    separateFindings: [
      {
        title: 'The C2PA control does not attach a C2PA credential',
        detail:
          'POST /api/v2/mark reports `c2pa` outstanding with "The Signer CVM is not running." ' +
          'unconditionally — it never attempts a signature, so a running signer makes no ' +
          'difference to the answer. Measured on 2026-09-07 with a CVM surrogate reachable at ' +
          '127.0.0.1:8799 and answering /20180608/sign: the same outstanding reason came back, ' +
          'while the identical render bytes were C2PA-signed against that surrogate through ' +
          'services/c2pa-signer and read back Valid.',
        cite: 'app/api/v2/mark/route.ts (the `c2pa` branch) vs docs/canon/blender-l2/06-evidence-key-address-published.json',
      },
      ...(captureEncodesUnused
        ? [
            {
              title: 'Every capture base64-encodes the whole artifact and nothing reads it',
              detail:
                '`capture()` returns `inline_base64: inline_base64(path)`, which reads the entire ' +
                'file and base64-encodes it. `witness()` builds its request body from ' +
                '`content_hash` alone and never looks at the field; no caller in this addon does ' +
                'either. So every witnessed save materialises a full copy of the artifact in the ' +
                'process, 1.33x its size, and discards it — 573KB of base64 for the 429KB .blend ' +
                'in the WO-B6 run. Not a zero-content failure, because nothing is sent; a cost, ' +
                'and a copy of user content sitting in memory for no reason.',
              cite: 'vendor/scruple_api/capture.py (capture) vs vendor/scruple_host_sdk/witness_flow.py (body)',
            },
          ]
        : []),
      {
        title: 'A receipt publishes no verifying-key address unless the deployment sets one',
        detail:
          'WO-S1 disclosed the leaf signature and instructions for checking it, but ' +
          '`verification.public_key_url` is null unless SCRUPLE_WITNESS_PUBLIC_URL is set on the ' +
          'app. Unset, a client holds a signature it cannot check and `independently_verifiable: ' +
          'true` is a claim with nothing behind it for that reader. Measured both ways in WO-B6.',
        cite: 'lib/leaf/signatureDisclosure.ts (publicWitnessBase) — both phases in docs/canon/blender-l2/',
      },
    ],
  };

  return { path: 'Blender add-on', profile, evidence, probes: probesRun };
}
