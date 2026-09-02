// Canvas's tamper surface — the baseline that closes P2, and P7 with it.
//
// WHY THIS EXISTS
//
// `STUDIO_P1-P8_GRADE.md` grades canvas P1 PASS, P3 PASS, P4 PASS, P5 PASS,
// P6 PASS — and P2 FAIL and P7 FAIL, for ONE reason between them:
//
//   P2 — "No baseline covers canvas-proxy/route.ts, lib/canvas/witness.ts,
//        lib/iterations/ingest.ts, or scripts/canvas-ws-proxy.mjs. The
//        capture path is unmeasured. Everything in the P1 analysis above is
//        true by reading the source and unprovable to a third party — which
//        is precisely the gap P2 exists to close."
//
//   P7 — "`executionAttestation: null`. Modal provides no hardware
//        attestation, so `provider: none` is the correct VALUE — and P7
//        explicitly permits it. It fails only because there is no baseline
//        manifest to declare it in. This item closes for free the moment
//        P2 does."
//
// Before this file, the only tamper surface anywhere in the estate was
// `services/witness-server/tamper-surface.mjs`, covering four files of the
// witness server itself. No baseline covered any Studio CAPTURE code. This
// is that file's shape, applied to canvas's capture path.
//
// ── THE DESIGN CHOICE, INHERITED DELIBERATELY ─────────────────────────
//
// An EXPLICIT LIST, not a directory walk, and the reference file says why in
// its own comment: "A walk would silently include whatever someone drops in
// the directory, which is the opposite of a tamper surface: adding a file
// must change the hash for a reason we can name, not because the glob
// happened to widen."
//
// That cuts both ways and the second edge is the useful one here. A file
// that JOINS the capture path and is not added to this list is invisible to
// the baseline, which is the failure mode a walk pretends to solve and does
// not: a walk over `lib/canvas/**` would have covered a new file
// automatically and told nobody it had started measuring something new.
// `test/v2/canvas-retrofit.test.ts` closes the other half by asserting that
// every module the proxy route and the sidecar actually import is tracked.
//
// ── WHAT A MATCHING HASH MEANS, AND WHAT IT DOES NOT ─────────────────
//
// COVERS: the tracked source files below, by content, plus the declared
// dependency pins.
// DOES NOT COVER: node_modules as installed, the Node runtime, the OS, the
// Next.js build output, the Modal image ComfyUI runs in (that is pinned
// separately by `machines.manifest_hash`, lib/canvas/manifest.ts), the
// Cloudflare tunnel, or the machine. A matching hash means "the capture path
// is the code we think it is", not "canvas is trustworthy". Do not let it be
// read as the stronger claim.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE CAPTURE PATH, enumerated.
 *
 * Order is irrelevant — the canonical form sorts — but the grouping is how a
 * reviewer checks the list is complete rather than merely long.
 */
export const TRACKED: readonly string[] = [
  // ── The HTTP leg. The gate itself. ──────────────────────────────
  'app/canvas-proxy/[sessionId]/[[...path]]/route.ts',
  'lib/canvas/gate.ts',
  'lib/canvas/egress.ts',
  'lib/canvas/correlate.ts',
  'lib/canvas/witness.ts',
  'lib/canvas/manifest.ts',
  'lib/canvas/session.ts',
  // WO-25. The deployment identity and the seal stamp. A change here
  // changes what every canvas leaf says about its own approval, which is
  // the same reason `witness.ts` is on this list.
  'lib/canvas/deployment.ts',

  // ── The WS leg. A separate process, and the half that was
  //    pass-through until WO-10. ──────────────────────────────────
  'scripts/canvas-ws-proxy.mjs',
  'lib/canvas/ws-capture.ts',

  // ── The shared ingest path. Where a canvas leaf is actually built,
  //    and the three modules that decide its preimage. A change to any
  //    of these changes what canvas attests to. ───────────────────
  'lib/iterations/ingest.ts',
  'lib/leaf/hashes.ts',
  'lib/scruple/witness.ts',
  'lib/scruple/hash.ts',
  'lib/scruple/artifacts.ts',
  // The SHAPE of the evidence. `canvas_capture_log`'s columns are what a
  // capture row can say, and its CHECK constraint is what a status can BE.
  // A migration that widened either without changing this hash would change
  // what canvas is able to record while the baseline said nothing moved.
  'lib/db/migrations/044_canvas_capture.sql',

  // ── The component canvas migrated onto. ONLY the four modules canvas
  //    imports or mirrors: the frame decoder, the MIME declarations,
  //    the correlator, and the HTTP route table canvas's egress.ts is
  //    checked against. See EXCLUDED for the rest of the component and
  //    why it is not on canvas's surface. ─────────────────────────
  'services/scruple-capture/src/surfaces/ws-gate.ts',
  'services/scruple-capture/src/surfaces/http-gate.ts',
  'services/scruple-capture/src/correlation.ts',
  'services/scruple-capture/src/mime.ts',

  // ── The assurance function. What canvas is permitted to claim is
  //    computed here, so it is part of what the baseline measures. ──
  'lib/capture/surface.ts',
  // ── And the class layer above it (WO-24), by this list's own rule.
  //    `lib/capture/classes.ts` decides canvas's capability class, which
  //    probes are in scope for it, and — through the custody locus — the
  //    exact sentence it is permitted to say. surface.ts imports it, so
  //    without this entry a change to the claim wording would leave the
  //    tamper-surface hash untouched, which is the gap this list exists
  //    to prevent. ────────────────────────────────────────────────────
  'lib/capture/classes.ts',

  // ── Dependency pins. Same precedent as the witness server's. ─────
  'package.json',
  'package-lock.json',
];

/**
 * What is deliberately NOT on canvas's tamper surface, and why. Kept in code
 * rather than in prose because an exclusion nobody can find is the same as
 * an oversight.
 */
export const EXCLUDED: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'lib/canvas/baseline.ts',
    reason:
      'This file. It carries the recorded hash, so hashing it would be a fixpoint problem ' +
      'rather than a measurement. services/witness-server/tamper-surface.mjs excludes itself ' +
      'for the same reason. Its integrity comes from git and from review, not from itself.',
  },
  {
    path: 'services/scruple-capture/src/identity.ts, leaf.ts, queue.ts, submitter.ts, ' +
      'component.ts, config.ts, build-measurement.ts, surfaces/fs-watch.ts',
    reason:
      'The component\'s ratchet, queue, submitter and filesystem watcher. Canvas uses NONE of ' +
      'them: it has no ratchet key, its sink is ingestIteration rather than /api/v2/witness, ' +
      'and it cannot have a filesystem watcher because the Modal container\'s output/, temp/ ' +
      'and input/ are not mounted into scruple-web. Including code canvas does not execute ' +
      'would make the baseline break for reasons that say nothing about canvas.',
  },
  {
    path: 'modal/**',
    reason:
      'The ComfyUI image itself. Measured separately and better: machines.manifest_hash pins ' +
      'the ComfyUI version and every custom-node pack by commit, and that hash is IN THE LEAF ' +
      'preimage (lib/canvas/manifest.ts). A second hash of the same thing would be a second ' +
      'preimage for something that already has one.',
  },
  {
    path: 'components/canvas/**, app/canvas/**',
    reason:
      'Browser-side UI. Placement `unattested-client` by definition — the user can edit it — ' +
      'and it is deliberately not on the capture path: canvas v2 exists BECAUSE the COM-6/7 ' +
      'design had a browser intercept POSTing witness calls, which anyone with a session ' +
      'token could forge. Baselining code whose modification we already assume would imply a ' +
      'claim about it that P1 explicitly refuses to make.',
  },
];

export interface TamperSurfaceEntry {
  file: string;
  sha256: string | null;
  missing: boolean;
}

export interface TamperSurface {
  tamper_surface_hash: string;
  files: TamperSurfaceEntry[];
  canonical: string;
  complete: boolean;
}

export function tamperSurface(root: string = process.cwd()): TamperSurface {
  const entries: TamperSurfaceEntry[] = TRACKED.map((rel) => {
    const p = path.join(root, rel);
    if (!existsSync(p)) return { file: rel, sha256: null, missing: true };
    return {
      file: rel,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
      missing: false,
    };
  });

  // Canonical form: sorted "sha256  filename" lines, newline separated,
  // trailing newline. Stable across platforms and reproducible by hand with
  // sha256sum, which matters when a reviewer wants to check it without
  // running our code. Byte-identical in shape to the witness server's, so
  // one reviewer's habit works on both.
  const canonical =
    entries
      .map((e) => `${e.sha256 ?? 'MISSING'}  ${e.file}`)
      .sort()
      .join('\n') + '\n';

  return {
    tamper_surface_hash: createHash('sha256').update(canonical).digest('hex'),
    files: entries,
    canonical,
    complete: entries.every((e) => !e.missing),
  };
}

/**
 * THE DECLARATION. The manifest shape `scruple-baseline.yaml` uses, for the
 * canvas integration specifically.
 *
 * `attestation.provider: 'none'` IS the P7 answer. Modal offers no hardware
 * attestation; H-5's vocabulary makes the leaf `passthrough` and the receipt
 * must read as such (Standard §12.4 — "Stored" MUST NOT read as "verified").
 * Declaring `none` is not a weaker claim than declaring nothing — it is the
 * only one of the two that is a claim at all, and it is what P7 asks for.
 */
export const CANVAS_BASELINE = {
  integration_id: 'scruple-canvas',
  version: '1.0.0-wo10',
  declared_at: '2026-08-30T00:00:00Z',
  placement: 'sidecar-gate',
  enforcement: 'isolated-namespace',
  surfaces: ['network-gate'] as const,
  fidelity: 'as-delivered',
  attestation: {
    // P7. Modal has no attestable compute. See docs/canon/CANVAS_BASELINE.md
    // §5 and H-4 §9's third open question.
    provider: 'none',
    quote_ref: null,
  },
  /**
   * ASSERTIONS THE BASELINE CARRIES THAT ARE NOT FILE HASHES.
   *
   * The grade's condition 1 on canvas's P1 PASS asked for exactly this:
   * the WS-pass-through property "needs an assertion in the baseline, not a
   * comment in a file."
   */
  assertions: [
    'The WebSocket leg is a GATE, not a pass-through. scripts/canvas-ws-proxy.mjs ' +
      'decodes every binary frame with the component\'s decoder and witnesses those the ' +
      'graph declares as WebSocket artifacts. A ComfyUI release that returns result bytes ' +
      'over WS therefore changes this hash rather than opening a silent egress path.',
    'The HTTP leg gates FIVE byte-egress routes, not one. The route table is the ' +
      'component\'s BYTE_EGRESS (H-4 §10 C-7) and any other 2xx binary response is ' +
      'recorded by the tripwire as unenumerated egress.',
    'attestation.provider is none, and it is correct: Modal offers no hardware ' +
      'attestation, so every canvas leaf is passthrough and no receipt may read as verified.',
    'Canvas has NO filesystem-watch surface. The Modal container\'s output/, temp/ and ' +
      'input/ are not mounted into scruple-web. H-4 §7 probes 4 (a file written into the ' +
      'output volume produces a leaf) is NOT SATISFIABLE for canvas and must not be ' +
      'claimed. See docs/canon/CANVAS_BASELINE.md §3.',
    'Only the default machine manifest is pinned; lib/canvas/witness.ts falls back to ' +
      'user_id IS NULL. Personal machines (WO-7) would let a user choose the middleware ' +
      'inside the boundary and would move canvas from P1-PASS to P1-FAIL. This baseline ' +
      'is declared against the shared-default configuration only — certification is per ' +
      'CONFIGURATION (H-4 §7).',
  ],
  excluded: EXCLUDED,
  tracked: TRACKED,
  /**
   * THE RECORDED HASH.
   *
   * `test/v2/canvas-retrofit.test.ts` recomputes `tamperSurface()` from the
   * working tree and asserts equality with this value. Changing any tracked
   * file without updating this constant fails that test — which is the whole
   * mechanism, and the reason it is a constant in code rather than a number
   * in a document.
   *
   * To re-record after an intended change:
   *   npx tsx -e "import('./lib/canvas/baseline').then(m=>console.log(m.tamperSurface().tamper_surface_hash))"
   */
  // Re-recorded by WO-25. WHY THE CAPTURE PATH CHANGED: canvas acquired a
  // deployment identity (`lib/canvas/deployment.ts`) and its leaves are
  // now stamped with a seal state resolved by `lib/seal/registry.ts`
  // instead of NULL, so `lib/canvas/witness.ts` and
  // `lib/iterations/ingest.ts` both moved. That sentence is the product;
  // the hash is what makes writing it unavoidable.
  tamper_surface_hash: '7f2b46763ed04b62d2021c2ec9816031cdff14856454bb4d5daebe2d77ab12e2',
} as const;
