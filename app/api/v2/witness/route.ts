// POST /api/v2/witness — witness one event.
//
// Supersedes /api/witness/cad, /api/scruple/witness/{adobe,photoshop} and
// /api/apps/kohya/witness. Those four were the same operation expressed
// four ways, on three different auth models, with three different ideas
// of what a successful response means.
//
// TWO THINGS THIS ROUTE DOES THAT NONE OF THEM DID:
//
// 1. It requires a baseline (D-3). §3 says every workflow leaf references
//    the baseline; §5 calls a leaf from unbaselined code NOT
//    Scruple-witnessed. A leaf with no baseline_ref is therefore not a
//    weaker leaf, it is a different thing, and accepting it would make
//    "Scruple-witnessed" mean nothing in particular.
//
// 2. It always reports `witnessed` (D-8). Capture stays non-blocking —
//    that is a deliberate design choice and it survives — but the caller
//    is told the truth either way. The old ingest path returned ok:true
//    over a failed witness with no field to express it, while the Adobe
//    routes wrote witnessed=1 unconditionally.
//
// 3. It carries the whole evidence package (WO-1). It did not always.
//    The first cut accepted `graph` and discarded it — literally
//    `workflowHash: body.graph ? undefined : undefined` — and never
//    computed input_hash or model_fingerprints_hash at all. That made
//    this route WORSE evidence than the legacy canvas path it was
//    written to replace, which has carried all five hashes since v2.2.
//    The formulas now live in lib/leaf/hashes.ts and both paths import
//    them, because two implementations of a preimage are two preimages.
//    Every field is defined in lib/leaf/registry.yaml and
//    test/v2/leaf-registry.test.ts fails if this file emits one that
//    is not, or drops one that must be.
//
// 4. It VERIFIES THE COMPONENT ENVELOPE (WO-6). WO-3 built the
//    server-side ratchet and WO-4 built reconciliation on top of it, and
//    this route called neither: components were sending the §4.3
//    envelope and its MAC, and nothing checked them. A ratchet nothing
//    verifies is decoration — the gap accounting that makes suppression
//    visible only exists if `verifySubmission()` runs. It runs here now,
//    AFTER `requireScope`, which is §10 C-6's structural fix: the
//    counter is attacker-supplied and ratcheting to it is work
//    proportional to it, so no unauthenticated request may cause any.
//
//    A submission with NO component envelope is still accepted — canvas
//    and the plugins have none — but it is recorded as unverified
//    (`component_verified = 0`, migration 043) rather than silently
//    treated as fine. A leaf whose producer could not be identified is
//    weaker evidence than one whose producer MACed it, and the row now
//    says which it is.
//
// 5. It accepts a submission with NO MIME. H-4 §7 probe 4 requires that a
//    file written directly into a tenant's output volume produce a leaf,
//    and nothing declares a type for such a write — there is no
//    producing node and no host API to ask. CANON_SKELETON §5 property 1
//    forbids guessing one, so the component sends none; `mime:
//    z.string().min(1)` then rejected it and made probe 4 unsatisfiable
//    by construction. The type is now optional and its absence is
//    recorded as `mime_declared = 0`, which is a different fact from
//    `application/octet-stream` — that placeholder silently gates the
//    image-only watermarker shut while looking exactly like a
//    declaration.
//
// 6. IT STAMPS THE SEAL STATE THE LEAF WAS WRITTEN UNDER (WO-22).
//    docs/canon/INTEGRATION_LIFECYCLE.md step 2 produces REAL LEAVES from
//    a pipeline that is not yet approved — that is the point of it, and
//    the failures are supposed to happen there. But "if they are not
//    marked, then the moment a vendor seals, they hold a pile of
//    integration-era leaves INDISTINGUISHABLE FROM APPROVED ONES, and the
//    first audit cannot tell which configuration produced what."
//
//    So every leaf carries `seal_state` and, when and only when that
//    state is `sealed`, the `seal_ref` it was written under. The
//    vocabulary is the estate's existing one: `undeclared` for a leaf
//    that named no deployment (canvas, the plugins — 045's word for
//    045's case), `unregistered` for one that named a deployment we have
//    no record of under this tenant (045's `unpublished`, one level up),
//    `unchecked` for our own failure. NULL is every row written before
//    migration 046, where the question was never asked.
//
//    A leaf is STAMPED, NEVER REFUSED, on any of these. Refusing would
//    not un-produce the artifact; it would produce an artifact with no
//    leaf, converting a flagged fact into a silence — §4.2's trade, made
//    again. And `sealed` is the only state that may claim the standard:
//    compliance stays binary, the state says which side of the line the
//    deployment was on. It is not a tier.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { verifySubmission } from '@/lib/ratchet/verify';
import { componentPreimage } from '@/lib/leaf/componentPreimage';
import { validateCaptureClaims } from '@/lib/leaf/captureClaims';
import { validateResolutionHandles } from '@/lib/leaf/resolutionHandles';
import { bindSettlement, evaluateSettlement } from '@/lib/leaf/settlement';
import { basisForTrust } from '@/lib/leaf/attestationBasis';
import { witness } from '@/lib/scruple/witness';
import { hashHostEvidence } from '@/lib/capture/hostRegistry';
import {
  IMPORTED_DATABLOCKS_INPUT_KIND,
  validateImportedDatablocks,
} from '@/lib/capture/importedDatablocks';
import {
  hashGraphOrTraining,
  hashModelFingerprints,
  hashRunInputs,
} from '@/lib/leaf/hashes';
import { CANONICALIZATION_PROFILE, canonicalize } from '@/lib/leaf/canonicalJson';
import { sha256Hex } from '@/lib/scruple/hash';
import { releaseRunSequence, reserveRunSequence } from '@/lib/iterations/ingest';
import { discloseLeafSignature } from '@/lib/leaf/signatureDisclosure';
import { checkDeploymentSeal, componentDeployment } from '@/lib/seal/registry';

export const dynamic = 'force-dynamic';

const Body = z.object({
  baseline_ref: z.string().regex(/^[0-9a-f]{64}$/, 'must be the 64-hex tamper_surface_hash'),
  kind: z.enum(['document_save', 'artifact', 'graph_execute', 'model_write']),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  // OPTIONAL, AND NEVER DEFAULTED. See note 5 in the header: an
  // unattributed write (H-4 §7 probe 4) has nobody entitled to declare a
  // type, and the honest record of that is an absent field, not
  // `application/octet-stream`. A caller that CAN declare one still must
  // — nothing here infers it, and `mime_declared` tells the two apart.
  mime: z.string().min(1).optional(),
  project_id: z.number().int().positive().optional(),
  // WO-22. Which sealed deployment produced this. Optional and never
  // inferred beyond the component binding below: a leaf that declared no
  // deployment is `undeclared`, which is a different fact from one that
  // declared a deployment we do not have.
  deployment_id: z.string().min(1).optional(),
  graph: z.record(z.unknown()).optional(),
  training: z.record(z.unknown()).optional(),
  machine_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // ---- the input side of the package (WO-1) ------------------------
  // Two ways in, because this surface is zero-content (P6) and the only
  // party holding input bytes is the caller.
  //
  //  `inputs`     — a declared manifest of {kind, hash}. We hash it with
  //                 the same function ingest.ts uses, so the preimage is
  //                 identical rather than merely similar.
  //  `input_hash` — already computed host-side. Passed through verbatim.
  //
  // Same shape for the weights. A caller may send the fingerprint
  // manifest and let us hash it, or send the hash alone.
  inputs: z
    .array(
      z.object({
        kind: z.string().min(1),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .optional(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  model_fingerprints: z.record(z.record(z.unknown())).optional(),
  model_fingerprints_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // WO-D6. The HOST's own evidence document — what the gate could not see.
  // Top level rather than inside `capture` for the reason `model_fingerprints`
  // is: `capture` is what the COMPONENT observed, this is what the HOST said,
  // and only the document's hash rides in the MAC. `capture.host_semantics`
  // and its three siblings are validated by validateCaptureClaims() rather
  // than here, because `capture` is a free record on this route and every
  // rule that matters about those fields is cross-field.
  host_evidence: z.record(z.unknown()).optional(),
  // WO-E2. THE ABSENCE SET AND ITS SCOPE — the artifacts the upstream said it
  // produced that the component did not capture. Top level for the reason
  // `host_evidence` and `model_fingerprints` are: `capture` is what the
  // component OBSERVED, this is the diff against what the upstream REPORTED,
  // and only the document's hash rides in the MAC. The five scalars in
  // `capture` are validated by validateCaptureClaims() rather than here,
  // because `capture` is a free record on this route and every rule that
  // matters about them is cross-field.
  declared_uncaptured: z.record(z.unknown()).optional(),
  // WO-F3. WHAT ENTERED THIS DOCUMENT FROM OUTSIDE IT, and that nobody here
  // watched it arrive. The DOCUMENT is top level for `host_evidence`'s and
  // `declared_uncaptured`'s reason and, like them, only its digest is signed.
  //
  // ⚑ THE FIVE SCALARS ARE TOP LEVEL TOO, WHICH IS NOT WHERE 058's AND 059's
  // SCALARS LIVE, and the difference is the point. Those belong to `capture`
  // because a capture component is the thing that observed them. This field
  // exists for a product with no capture block at all — the standalone Blender
  // add-on, `docs/BLENDER.md` row 1 — and `validateCaptureClaims` rightly
  // obliges any capture-bearing leaf to declare a basis, a profile, a
  // confinement, an upstream epoch and a host level. Forcing a plugin to
  // invent all five in order to say one true thing about an imported image
  // would be the trade WO-F3 was written to refuse. `componentPreimage()`
  // reads them from the root, so they are inside the MAC either way.
  //
  // Every cross-field rule about them is in lib/capture/importedDatablocks.ts,
  // which reads the RAW json — a zod schema can say a key is a number and
  // cannot say that a key sent one level down is outside the MAC.
  imported_datablocks: z.record(z.unknown()).optional(),
  imported_datablocks_source: z.enum(['host_datablocks', 'none']).optional(),
  imported_origin_observed: z.boolean().optional(),
  imported_datablocks_count: z.number().int().nonnegative().optional(),
  imported_datablocks_unreadable_count: z.number().int().nonnegative().optional(),
  imported_datablocks_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  attestation: z.object({ type: z.string().min(1), report: z.string().min(1) }).optional(),
  continuity: z
    .object({
      produced_at: z.string().min(1),
      external_manifest_hash: z.string().min(1),
    })
    .optional(),

  // ---- the H-4 §4.3 component envelope, and its MAC ----------------
  // Optional, because canvas and the plugins have no component. Present
  // together or not at all: an envelope with no MAC is an unauthenticated
  // claim of a counter, which is the one thing the ratchet exists to make
  // impossible.
  component: z
    .object({
      component_id: z.string().min(1),
      build_measurement: z.string().nullable().optional(),
      counter: z.number().int().nonnegative(),
      attestation: z
        .object({
          provider: z.string().min(1).nullable().optional(),
          quote_ref: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  mac: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // What the COMPONENT saw, as distinct from what the leaf commits to.
  // Passed through to the preimage and not otherwise interpreted here —
  // lib/leaf/componentPreimage.ts is the only thing that reads it, so a
  // new capture field is one edit and not two.
  capture: z.record(z.unknown()).optional(),
  // WO-C2. THE RESOLUTION HANDLES. Declared here so the parsed body carries
  // them into `componentPreimage()`, and validated out of the RAW json by
  // `lib/leaf/resolutionHandles.ts` — which is where the field-by-field rules
  // live, because a zod schema can say a key is a string and cannot say that
  // a key sent one level up is an unsigned redirect.
  resolution: z.record(z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'witness:write');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  // THE RAW JSON IS KEPT, and that is not a stylistic choice. Zod STRIPS
  // unknown top-level keys, so a rule written against the parsed body cannot
  // see a field the schema does not declare — and `close_detection` is
  // precisely a field the schema does not declare. Validating the parsed body
  // would have refused it inside `capture` and waved it through one level up,
  // which is the shape of the bypass, not a corner case. Found by the control
  // in test/v2/attestation-basis.test.ts, which was written to look for it.
  let raw: Record<string, unknown> = {};
  let body: z.infer<typeof Body>;
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
    body = Body.parse(parsed);
  } catch (e) {
    return v2Error(
      'invalid_body',
      'Witness request did not validate. `mime` is optional but never inferred: declare it when anything was entitled to declare it, and omit it when nothing was (H-4 §7 probe 4). A placeholder type is not the same as an absent one.',
      String(e),
    );
  }

  // ---- D-3: baseline or refuse -------------------------------------
  const base = conn()
    .prepare(
      `SELECT baseline_hash, retired_at FROM baselines
        WHERE tenant_id = ? AND baseline_hash = ?`,
    )
    .get(principal.userId, body.baseline_ref) as
    | { baseline_hash: string; retired_at: string | null }
    | undefined;

  if (!base) {
    return v2Error(
      'baseline_required',
      'This baseline is not known for this tenant. Establish one with POST /api/v2/baseline before witnessing — an event from unbaselined code is not Scruple-witnessed (§3, §5).',
    );
  }
  if (base.retired_at !== null) {
    return v2Error(
      'baseline_stale',
      'This baseline has been retired by a later transition. Re-read GET /api/v2/baseline/current and retry — leaves must reference the active baseline (§4).',
    );
  }

  // ---- WO-C1: what the capture block is ENTITLED TO CLAIM ----------
  //
  // Before the ratchet, and deliberately: this is a refusal about the
  // CONTENT of a claim, and it does not need the component to be
  // authenticated to be true. It is also above every write, so a refused
  // claim leaves no row — which is the difference between a validator and
  // a comment.
  //
  // Three rules, all from the settled design and none of them in prose:
  //   1. `close_detection` is rejected as a provenance or completion field;
  //   2. a capture-bearing leaf must declare one of the three bases, and
  //      `attestation_status: null` is not one of them;
  //   3. `verified` is unreachable on the desktop profile by construction,
  //      and while the Merkle blocker stands `stale` is the only basis;
  //   ...and, since WO-D6, 7. a capture-bearing leaf must say which LEVEL its
  //      host hook ran at, and a Level-2 claim needs an adapter behind it.
  //
  // lib/leaf/captureClaims.ts carries the argument for each.
  const claims = validateCaptureClaims(raw);
  if (!claims.ok) return v2Error(claims.code, claims.message, claims.detail);

  // ---- WO-F3: what entered this document from OUTSIDE it ------------------
  //
  // Beside rule 1's call and above every write, for the same reason: this
  // refuses the CONTENT of a claim, so a refused declaration must leave no row.
  //
  // Finding E7-1 — the finding the E series ends on — is that two leaves built
  // around two DIFFERENT AI images were identical in every field capable of
  // describing how the artifact came to exist. Not a false claim; an ABSENT
  // one, and absence and "there was nothing" read the same. This is the field
  // that lets the honest statement be made: THESE DATABLOCKS ENTERED THIS
  // DOCUMENT FROM OUTSIDE IT, HERE ARE THE DIGESTS OF THEIR BYTES, AND THE
  // PARTY THAT PRODUCED THIS LEAF DID NOT OBSERVE HOW THEY CAME TO EXIST.
  //
  // It says nothing about what made them, and it is not entitled to.
  const imported = validateImportedDatablocks(raw);
  if (!imported.ok) return v2Error(imported.code, imported.message, imported.detail);


  // ---- the component envelope (H-4 §4.3), verified — or its absence
  // ---- recorded (WO-6, §10 C-6) -------------------------------------
  //
  // ORDER IS THE POINT. `requireScope` ran at the top of this function,
  // so by the time control reaches here the caller is an authenticated
  // tenant and `verifySubmission()` will not ratchet a single step for
  // anyone else. C-6: `MAX_RATCHET_ADVANCE = 100_000` is ~584 ms of CPU
  // before the MAC is checked, on a counter that travels in the clear —
  // the fix is not a smaller cap (that trades a DoS window for a
  // legitimate-backlog ceiling and destroys the evidence the queue
  // exists to preserve), it is that the unauthenticated cost is zero.
  if (body.component && !body.mac) {
    return v2Error(
      'invalid_body',
      'A component envelope was sent with no `mac`. The counter travels in the clear; ' +
        'without the MAC it is an unauthenticated claim about a component, which is the one ' +
        'thing the ratchet exists to make impossible. Send both or neither.',
    );
  }
  if (body.mac && !body.component) {
    return v2Error(
      'invalid_body',
      'A `mac` was sent with no component envelope. There is nothing to verify it against.',
    );
  }

  // ---- WO-C2: the handles are only handles when they are SIGNED ----
  //
  // AFTER the envelope/MAC pairing check above and BEFORE `verifySubmission`,
  // and both halves of that position are deliberate. After, because "an
  // envelope with no MAC" is a more specific diagnosis of the same fault and
  // a caller told `resolution_handles_unsigned` would go looking at the wrong
  // field. Before, because this refuses content and must leave no row —
  // nothing below has written anything yet, and nothing above has ratcheted.
  //
  // Read from the RAW json, not the parsed body, for the reason WO-C1 found
  // the hard way one file over: zod strips undeclared top-level keys, so a
  // rule about a handle sent where the preimage does not read it cannot see
  // the very key it is about.
  //
  // Architect's first settle condition. Moving the Merkle path and the raw
  // quote OUT of the leaf is only tenable if the pointer to them cannot be
  // moved — "an attacker who can rewrite an unsigned endpoint redirects
  // resolution to a service that will happily confirm anything." The five
  // handles are in the preimage of all three implementations; this refuses
  // every shape that would put one somewhere else.
  const handles = validateResolutionHandles(raw);
  if (!handles.ok) return v2Error(handles.code, handles.message, handles.detail);

  // ---- WO-C3: the deadline is a CLAIM, and it is checked against a clock ----
  //
  // `validateResolutionHandles` has settled the SHAPE of the two new handles.
  // This settles what they MEAN, and it needs the database and the wall clock,
  // which is why it is a second call and not a seventh rule in that file.
  //
  // Two things happen here and both are the council's:
  //
  //  1. The retention digest must RESOLVE to durations. Architect: a digest
  //     that binds only a policy identity leaves "a resolution attempt after
  //     the evidence is legitimately gone ... indistinguishable from a forged
  //     handle." An unresolvable digest is refused rather than stored, because
  //     a leaf stored with one is unresolvable-by-construction and looks
  //     exactly like a leaf that is fine.
  //
  //  2. The deadline must sit where a NAMED CLOCK puts the end of that
  //     policy's settlement window. The component derives its deadline from
  //     its own clock — it is the only party that knows its window — and a
  //     value derived from a locally-set timestamp is the config-inherited
  //     field class this design refuses. So it is CHECKED here, once, against
  //     a clock with a name and an authority, and the terminal `expired` is
  //     computed only from that clock. A component two hours fast is refused,
  //     not believed.
  //
  // Placed with the handle validation for the same reason it is: this refuses
  // content, and nothing below has written a row yet.
  const settlement = bindSettlement(handles.handles);
  if (!settlement.ok) return v2Error(settlement.code, settlement.message, settlement.detail);

  let componentVerified = false;
  let componentGap = 0;
  let componentAttestation: 'verified' | 'passthrough' | null = null;
  let componentBuildChanged = false;

  if (body.component && body.mac) {
    // ONE function builds the preimage and both sides call it
    // (lib/leaf/componentPreimage.ts). A server that reconstructed the
    // field set by hand would have a MAC that verifies whatever the
    // server happened to assemble.
    const result = verifySubmission(
      { userId: principal.userId, keyId: principal.keyId },
      {
        componentId: body.component.component_id,
        counter: body.component.counter,
        mac: body.mac,
        preimage: componentPreimage({
          baseline_ref: body.baseline_ref,
          kind: body.kind,
          content_hash: body.content_hash,
          mime: body.mime,
          input_hash: body.input_hash,
          model_fingerprints_hash: body.model_fingerprints_hash,
          machine_manifest_hash: body.machine_manifest_hash,
          // WO-F3. In the MAC, from the submission root. The values are the
          // ones the caller sent — the validator above refused every shape
          // that is not exactly what it looks like — so the server MACs the
          // same bytes the client MACed.
          imported_datablocks_source: body.imported_datablocks_source,
          imported_origin_observed: body.imported_origin_observed,
          imported_datablocks_count: body.imported_datablocks_count,
          imported_datablocks_unreadable_count: body.imported_datablocks_unreadable_count,
          imported_datablocks_hash: body.imported_datablocks_hash,
          capture: body.capture as Record<string, never> | undefined,
          // WO-C2. The handles enter the MAC here, on the server's side of
          // the same one function the component called. A byte changed in
          // flight lands as `component_unverified`.
          resolution: body.resolution as Record<string, never> | undefined,
          component: body.component,
        }),
        buildMeasurement: body.component.build_measurement ?? null,
      },
    );

    if (!result.ok) {
      // A genuine queue retry (§5) re-sends the same bytes and must be
      // dropped IDEMPOTENTLY rather than treated as an attack. It is the
      // designed behaviour of queue.py's drain, so it answers 200 and
      // writes nothing — a second leaf for one event would be worse than
      // no answer.
      if (result.reason === 'duplicate') {
        return v2Ok(
          {
            deduplicated: true,
            witnessed: false,
            component: {
              component_id: body.component.component_id,
              counter: body.component.counter,
              verified: true,
            },
            note: result.message,
          },
          200,
        );
      }
      return v2Error(
        'component_unverified',
        result.message,
        { reason: result.reason, ...(result.detail ?? {}) },
      );
    }

    componentVerified = true;
    componentGap = result.gap;
    componentAttestation = result.attestation_status;
    componentBuildChanged = result.build_changed;
  }

  // ---- §12.4: verified or passthrough, never bare -------------------
  // Chain-to-vendor-root verification is not implemented; all six
  // verifier plugins are structural-only. Anything supplied is therefore
  // recorded honestly as passthrough. "Stored" must not read as
  // "verified".
  //
  // A verified component's posture WINS over a bare `attestation` block,
  // because the component's was established at provisioning against the
  // BDK and this one is whatever the caller sent. They agree today
  // (nothing can produce 'verified'), and when something can, the one
  // backed by a key must be the one that counts.
  const attestationStatus: 'verified' | 'passthrough' | null =
    componentAttestation ?? (body.attestation ? 'passthrough' : null);

  // ---- resolve the project BEFORE witnessing ------------------------
  //
  // Order matters here and it did not used to. The witness call ran
  // first, with `projectId: `tenant:${userId}`` and `runSequence: 0`
  // hardcoded, and the INSERT afterwards used a DIFFERENT project id and
  // a properly computed sequence. Three consequences, none visible from
  // this file:
  //
  //  - Every leaf this route ever produced claimed run_sequence 0. The
  //    witness chains prev_record_hash by `ORDER BY run_sequence DESC`,
  //    so a second event could not be ordered against the first.
  //  - `tenant:` is on the production witness's refused-prefix list
  //    (server.js:~554), added after a test wrote nine rows into the
  //    real audit log. So in production this route's witness call
  //    returned 400 and the catch below swallowed it: `witnessed` was
  //    false for every event that did not carry an explicit project_id,
  //    and nothing said why.
  //  - The leaf and the row it was stored on disagreed about which
  //    project they belonged to.
  //
  // Resolving the project first fixes all three, and drops the synthetic
  // id entirely: the witness now sees the same numeric project id the
  // canvas path sends, so a tenant's plugin events and their canvas
  // events land on one chain instead of two.
  const now = new Date().toISOString();

  // ---- WO-22: which lifecycle state was this written under? ---------
  //
  // Resolution order, and each step is a different fact rather than a
  // fallback for the same one:
  //
  //   1. what the caller declared. A host may run several deployments
  //      through one component-less surface, and only it knows which.
  //   2. the component's binding, when a component MACed this leaf. This
  //      is the trustworthy half: the component authenticated, and the
  //      binding is ours, not the caller's.
  //   3. nothing → `undeclared`.
  //
  // The declared id is checked against THIS TENANT inside
  // checkDeploymentSeal(): a deployment id is a bare string on the wire,
  // and without that check a tenant could stamp their leaves with
  // somebody else's `sealed`.
  //
  // The stamp is evaluated as of `now` and written down there and then,
  // for 045's reason: a seal issued later does not retro-bless an earlier
  // leaf, and a reseal later does not retro-condemn one.
  const declaredDeployment =
    body.deployment_id ??
    (body.component ? componentDeployment(body.component.component_id) : null);
  const seal = checkDeploymentSeal(principal.userId, declaredDeployment, now);

  // `iterations` is project-scoped — the table predates the canon surface,
  // which is tenant-scoped. Rather than push project management into every
  // adapter (the §4 hook contract goes attach -> baseline -> save ->
  // witness, with no project step), resolve or create one per tenant and
  // host. Found live: without this the route 500s on a NOT NULL
  // constraint, which no unit test could have caught.
  let projectId = body.project_id ?? null;
  if (projectId === null) {
    const holderName = `scruple:${body.kind === 'model_write' ? 'training' : 'workflow'}`;
    const existing = conn()
      .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ? LIMIT 1`)
      .get(principal.userId, holderName) as { id: number } | undefined;
    if (existing) {
      projectId = existing.id;
    } else {
      const created = conn()
        .prepare(
          `INSERT INTO projects
             (user_id, name, type, status, created_at,
              iteration_count, is_active, witnessed_count, is_archived)
           VALUES (?, ?, 'image', 'unlocked', ?, 0, 0, 0, 0)`,
        )
        .run(principal.userId, holderName, now);
      projectId = Number(created.lastInsertRowid);
    }
  }

  // run_sequence was hardcoded to 0, which collided with the UNIQUE
  // (project_id, run_sequence) index on the SECOND witness for any tenant.
  // The first call always worked, so nothing short of witnessing twice
  // would have found it — which is precisely what a unit test with a
  // mocked database does not do.
  //
  // AND `MAX(run_sequence) + 1` WAS STILL WRONG, WHICH WO-D6 FOUND LIVE.
  // Migration 051 wrote the argument in full: allocate unlocked, make a
  // REMOTE witness call, then insert — two concurrent ingests in one project
  // both read N, both obtain a SIGNED LEAF for N, and the loser's INSERT
  // aborts, leaving an orphan leaf on an append-only log. The migration fixed
  // `lib/iterations/ingest.ts` and this route, the estate's OTHER door, kept
  // the unlocked read.
  //
  // It was not theoretical and it is not "Studio has no concurrency today".
  // A single ComfyUI generation produces TWO observations of the same bytes —
  // the HTTP gate's `as-delivered` copy and the output-volume watcher's
  // `as-written` one, which is H-4 §2's whole two-surface claim — and the
  // component submits them concurrently. WO-D6's host-adapter scenario hit
  // the collision on its second run: counter 1 spent, leaf witnessed, INSERT
  // aborted, 500 with an empty body and the event held in the queue.
  //
  // `reserveRunSequence` TAKES the number inside a write transaction, so a
  // second caller serialises there rather than at the INSERT — by which point
  // a leaf already exists and the loss is unretractable.
  const runSequence = reserveRunSequence(projectId);

  // ---- the evidence package (WO-1) ----------------------------------
  // Every hash below is defined in lib/leaf/registry.yaml, including the
  // exact preimage, and computed by lib/leaf/hashes.ts — the same module
  // lib/iterations/ingest.ts calls. Reimplementing any of them here
  // would produce a second preimage that looks like the first until an
  // auditor tries to reproduce one.

  // workflow_hash. On kind=model_write there is no graph and the
  // training recipe plays the graph's role; `kind` tells a verifier
  // which document to re-canonicalize. Before WO-1 both were accepted
  // and silently dropped.
  const workflowHash = hashGraphOrTraining(body.graph, body.training);

  // input_hash. This surface never sees input bytes (P6), so either the
  // caller declares the manifest and we hash it with ingest's formula,
  // or the caller sends the hash it computed itself.
  //
  // ---- WO-F3: ⚑ AND THE DECLARATION'S DIGEST IS FOLDED IN HERE ------------
  //
  // This is what makes a changed datablock MOVE THE LEAF HASH, and it is the
  // half of the binding that does not depend on there being a component.
  //
  // The five scalars are in the ratchet MAC, which covers them for any
  // submission that carries an envelope — and the product this field was built
  // for carries none: the standalone add-on is a plugin, `component_verified`
  // is 0 on its every leaf, and a MAC nobody computed binds nothing. What binds
  // it there is the LEAF: the witness's canonical record hashes `input_hash`
  // under both v2 and v2.2, and the leaf hash is what the witness signs and
  // what a Merkle proof resolves to. So the declaration enters the run's input
  // manifest as one ref, under a reserved kind, and a single flipped hex digit
  // in a single datablock's digest changes `input_hash`, changes `leaf_hash`,
  // and invalidates the signature over it.
  //
  // 🔴 THE ALTERNATIVE WAS A NEW FIELD IN THE WITNESS'S RECORD, and it is
  // refused twice over: the witness process is out of bounds for this series,
  // and a new record field would be a new leaf scheme that every leaf written
  // before it could not express. `input_hash` already means "what went into
  // this run", and an imported datablock is exactly that — E7-1 measured it
  // NULL on both add-on leaves, which is the same silence one column over.
  const declaredInputs = body.inputs ?? null;
  const reserved = declaredInputs?.filter((i) => i.kind === IMPORTED_DATABLOCKS_INPUT_KIND) ?? [];
  if (reserved.length > 0) {
    return v2Error(
      'imported_datablocks_refused',
      `An input ref of kind "${IMPORTED_DATABLOCKS_INPUT_KIND}" was declared by the caller. ` +
        'That kind is reserved: the route folds the declaration digest into the input ' +
        'manifest itself, and a hand-supplied ref under the same kind would be ' +
        'indistinguishable from it in the preimage — a caller could claim a datablock ' +
        'declaration in the leaf hash without sending a declaration at all.',
      { reserved: reserved.map((r) => r.hash) },
    );
  }
  if (imported.declaration?.hash && body.input_hash) {
    // Refused rather than silently not folded. A precomputed `input_hash` is
    // opaque — there is no manifest to append to — so honouring it would store
    // a declaration that the leaf hash does not cover, which is the class of
    // defect this work order exists to close: a record that looks bound and is
    // not. Send `inputs` instead and let the route hash them.
    return v2Error(
      'imported_datablocks_refused',
      'A precomputed `input_hash` was sent beside an `imported_datablocks` declaration. The ' +
        "declaration's digest is folded into the input manifest so that a changed datablock " +
        'moves the leaf hash; a precomputed hash has no manifest to fold it into, so the ' +
        'declaration would sit on the leaf with nothing binding it. Send `inputs` (which may ' +
        'be empty) and let this route compute the hash.',
      { imported_datablocks_hash: imported.declaration.hash },
    );
  }
  const foldedInputs =
    imported.declaration?.hash !== undefined && imported.declaration?.hash !== null
      ? [
          ...(declaredInputs ?? []),
          { kind: IMPORTED_DATABLOCKS_INPUT_KIND, hash: imported.declaration.hash },
        ]
      : declaredInputs;
  const inputHash =
    body.input_hash ??
    (foldedInputs
      ? hashRunInputs({ provider: null, prompt: null, spec: null, inputs: foldedInputs })
      : null);

  // model_fingerprints_hash. Same two ways in.
  const fingerprints = hashModelFingerprints(body.model_fingerprints);
  if (
    fingerprints &&
    body.model_fingerprints_hash &&
    fingerprints.hash !== body.model_fingerprints_hash
  ) {
    // Refuse rather than pick one. A caller that sent both is asserting
    // they agree, and if they do not, one of the two is wrong — choosing
    // silently would put a hash in the leaf that does not describe the
    // manifest stored beside it.
    return v2Error(
      'invalid_body',
      'model_fingerprints and model_fingerprints_hash disagree. Send one or the other, or send a hash that matches the manifest.',
      { computed: fingerprints.hash, supplied: body.model_fingerprints_hash },
    );
  }
  const modelFingerprintsHash = body.model_fingerprints_hash ?? fingerprints?.hash ?? null;
  const modelFingerprintsJson = fingerprints?.json ?? null;

  // host_evidence_hash. WO-D6, and the same arrangement as the manifest above
  // for the same reason: the caller sends BOTH halves, and the route
  // recomputes one from the other and REFUSES rather than picking a winner.
  //
  // It matters more here than there. `capture.host_evidence_hash` is inside
  // the MAC and `host_evidence` is not, so a host adapter whose document and
  // digest disagreed would ship a SIGNED claim about a document nobody can
  // reproduce — the leaf would say "camera CAM_hero" is committed to and the
  // stored manifest would say something else, with the signature vouching for
  // neither. Recomputing here is what keeps the unsigned half honest.
  //
  // The declared half is read off `claims.host`, which validateCaptureClaims()
  // already checked for internal consistency — so by the time control reaches
  // here, 'blind' cannot be carrying a hash and 'declined' cannot be carrying
  // a document. What is left to check is arithmetic.
  const hostEvidence = hashHostEvidence(body.host_evidence as Record<string, unknown> | undefined);
  const declaredHostEvidenceHash = claims.host?.evidenceHash ?? null;
  if (hostEvidence && declaredHostEvidenceHash && hostEvidence.hash !== declaredHostEvidenceHash) {
    return v2Error(
      'invalid_body',
      'host_evidence and capture.host_evidence_hash disagree. The hash is inside the MAC and ' +
        'the document is not, so accepting a pair that does not match would sign a claim about ' +
        'a document nobody can reproduce.',
      { computed: hostEvidence.hash, supplied: declaredHostEvidenceHash },
    );
  }

  // declared_uncaptured_hash. WO-E2, and the third instance of the same
  // arrangement in this route for the third time's reason: the caller sends
  // BOTH halves, we recompute one from the other, and we REFUSE rather than
  // pick a winner.
  //
  // It matters here for a reason the other two do not have. The signed half is
  // a COMPLETENESS CLAIM — `uncaptured_scope`, and a digest of the set that
  // claim ranges over. A document that disagreed with its digest would let a
  // party in the middle add or remove members of an absence set while the
  // signature vouched for a scope that no longer described it: the leaf would
  // say "complete, 3 uncaptured" and the stored set would name two, and a
  // verifier could not tell which half moved. Recomputing here is what keeps
  // the unsigned half honest.
  //
  // `claims.uncaptured` has already been checked for internal consistency by
  // rule 8, so by the time control reaches here a `not_enumerated` cannot be
  // carrying a hash and an enumerated scope cannot be missing one. What is
  // left is arithmetic.
  const uncapturedDoc = body.declared_uncaptured as
    | Record<string, unknown>
    | undefined;
  const uncapturedHashed =
    uncapturedDoc && Object.keys(uncapturedDoc).length > 0
      ? (() => {
          const json = canonicalize(uncapturedDoc);
          return { json, hash: sha256Hex(json) };
        })()
      : null;
  const declaredUncapturedHash = claims.uncaptured?.hash ?? null;
  if (uncapturedHashed && declaredUncapturedHash && uncapturedHashed.hash !== declaredUncapturedHash) {
    return v2Error(
      'invalid_body',
      'declared_uncaptured and capture.declared_uncaptured_hash disagree. The hash is inside ' +
        'the MAC and the document is not, so accepting a pair that does not match would sign ' +
        'a completeness claim about a set nobody can reproduce.',
      { computed: uncapturedHashed.hash, supplied: declaredUncapturedHash },
    );
  }
  // ⚑ AND THE TWO DIRECTIONS OF ABSENCE ARE BOTH REFUSED, because each is a
  // way the signed half and the unsigned half could be separated in flight:
  // a digest with no document to reproduce it from, and a document nothing
  // signed. Rule 8 refuses a hash without an enumerated scope; this refuses a
  // hash without the bytes it covers.
  if (declaredUncapturedHash && !uncapturedHashed) {
    return v2Error(
      'declared_uncaptured_refused',
      '`capture.declared_uncaptured_hash` is set and `declared_uncaptured` is absent. The ' +
        'digest is signed and the document is not, so a leaf carrying the digest alone ' +
        'commits to a set no verifier can ever read — an absence set nobody can inspect is ' +
        'the bare hole this field exists to close, wearing a signature.',
      { supplied: declaredUncapturedHash },
    );
  }
  if (uncapturedHashed && !declaredUncapturedHash) {
    return v2Error(
      'declared_uncaptured_refused',
      '`declared_uncaptured` was sent with no `capture.declared_uncaptured_hash`. The ' +
        'document is outside the MAC; without the digest beside it inside the MAC it is an ' +
        'unsigned attachment that a party in the middle could have written, and storing it ' +
        'would make it look exactly like a signed one.',
      { computed: uncapturedHashed.hash },
    );
  }


  // ---- witness (non-blocking by design) -----------------------------
  let leafHash = body.content_hash;
  let leafScheme: 'v1' | 'v2' | 'v2.2' = 'v1';
  let witnessed = false;
  let witnessId: string | null = null;
  let witnessSig: string | null = null;

  // WO-S1(a) — H-1's evidence signature, kept rather than dropped.
  //
  // `witnessSig` above is the HMAC (H-2, a transport seal between this tier
  // and the witness). It is NOT the thing a third party checks, and until
  // migration 052 it was the only signature this tier stored — which is why
  // /api/v2/verify reported `independently_verifiable` off it and was wrong
  // for every leaf. These four are the ECDSA half.
  //
  // `leafSigState` stays null unless the witness ANSWERED the question. A
  // pre-H-1 witness omits the field entirely; that is not the same as
  // answering "no signature", so `'leaf_signature' in res` is the test and
  // not `res.leaf_signature == null`.
  let leafSignature: string | null = null;
  let leafSignerKeyId: string | null = null;
  let leafSignatureAlg: string | null = null;
  let leafSignerSurrogate: number | null = null;
  let leafSigState: 'signed' | 'unsigned' | null = null;

  // §9.6 — an event produced outside the witness path during an outage,
  // using the customer's own credentials, being recorded on reconnect.
  // It is explicitly NOT Scruple-witnessed, so we do not even attempt to
  // witness it now: doing so would date the leaf to the recovery rather
  // than to the event, and would imply a witness that did not happen.
  if (!body.continuity) {
    try {
      const res = await witness.witnessIteration({
        projectId: String(projectId),
        runSequence,
        contentHash: body.content_hash,
        inputHash: inputHash ?? undefined,
        workflowHash: workflowHash ?? undefined,
        modelFingerprintsHash: modelFingerprintsHash ?? undefined,
        machineManifestHash: body.machine_manifest_hash,
      });
      if (res?.leaf_hash) {
        leafHash = res.leaf_hash;
        leafScheme = res.leaf_scheme ?? 'v2';
        witnessed = true;
        witnessId = String(res.witness_id ?? '');
        witnessSig = String(res.signature ?? '');
      }
      if (res && 'leaf_signature' in res) {
        leafSignature = res.leaf_signature ?? null;
        leafSignerKeyId = res.leaf_signer_key_id ?? null;
        leafSignatureAlg = res.leaf_signature_alg ?? null;
        // NAMING DRIFT, READ THROUGH THE REGISTRY RATHER THAN GUESSED. The
        // witness's COLUMN is `leaf_signer_surrogate`; its WIRE field is
        // `signer_surrogate` (server.js:828, and the note above it). Reading
        // the column name off the response yields undefined forever, and the
        // index signature on WitnessIterationResult means the compiler will
        // not say so. Both spellings are accepted here, live name first.
        const surrogate =
          res.signer_surrogate ??
          (res as { leaf_signer_surrogate?: unknown }).leaf_signer_surrogate;
        leafSignerSurrogate = leafSignature ? (surrogate ? 1 : 0) : null;
        leafSigState = leafSignature ? 'signed' : 'unsigned';
      }
    } catch {
      // Deliberately swallowed: capture must not block on witness-server
      // health. The caller learns the truth from `witnessed` below.
    }
  }

  const info = conn()
    .prepare(
      // The five hashes are stored here as well as sent to the witness.
      // The witness's copy is the evidence; this copy is what makes a
      // receipt renderable and a leaf re-derivable when the witness is
      // unreachable — which, on this route, it has been for every event
      // that did not carry an explicit project_id. Storing only what we
      // managed to transmit would make the outage unreconstructable.
      `INSERT INTO iterations
         (project_id, run_sequence, timestamp, leaf_hash, output_hash,
          output_kind, output_content_type, output_bytes, prompt,
          witnessed, witness_id, witness_signature, witness_timestamp,
          leaf_scheme, leaf_kind, baseline_hash,
          platform_attestation_json, platform_attestation_status,
          continuity_json,
          input_hash, workflow_hash,
          model_fingerprints, model_fingerprints_hash,
          machine_manifest_hash,
          component_id, component_counter, component_verified, mime_declared,
          deployment_id, seal_state, seal_ref,
          canonicalization_profile,
          leaf_signature, leaf_signer_key_id, leaf_signature_alg,
          leaf_signer_surrogate, leaf_signature_state,
          attestation_basis, attestation_profile,
          storage_confinement, storage_confinement_source,
          upstream_identity, upstream_epoch, upstream_continuity,
          upstream_low_watermark_open, upstream_low_watermark_close,
          upstream_uncaptured_reason, upstream_source,
          host, host_adapter, host_evidence_type, host_semantics,
          host_evidence, host_evidence_hash,
          uncaptured_enumeration_method, uncaptured_scope, uncaptured_scope_source,
          declared_uncaptured_count, declared_uncaptured_hash, declared_uncaptured,
          imported_datablocks_source, imported_origin_observed,
          imported_datablocks_count, imported_datablocks_unreadable_count,
          imported_datablocks_hash, imported_datablocks,
          resolution_witness_endpoint, resolution_witness_authority,
          resolution_checkpoint_id, resolution_prev_checkpoint_id,
          resolution_prev_checkpoint_quote_time,
          resolution_settlement_deadline, resolution_retention_policy_digest,
          settlement_clock, settlement_clock_authority, settlement_observed_at,
          evidence_retained_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      runSequence,
      now,
      leafHash,
      body.content_hash,
      body.kind === 'model_write' ? 'checkpoint' : 'image',
      // NULL, not a placeholder. `output_content_type` has been nullable
      // since migration 014 and this is the first caller that legitimately
      // has nothing to put in it.
      body.mime ?? null,
      body.mime ? `${body.kind} · ${body.mime}` : `${body.kind} · (no declared type)`,
      witnessed ? 1 : 0,
      witnessId,
      witnessSig,
      witnessed ? now : null,
      leafScheme,
      body.kind === 'model_write' ? 'training' : 'workflow',
      body.baseline_ref,
      body.attestation ? JSON.stringify(body.attestation) : null,
      attestationStatus,
      body.continuity ? JSON.stringify(body.continuity) : null,
      inputHash,
      workflowHash,
      modelFingerprintsJson,
      modelFingerprintsHash,
      body.machine_manifest_hash ?? null,
      body.component?.component_id ?? null,
      body.component?.counter ?? null,
      componentVerified ? 1 : 0,
      body.mime ? 1 : 0,
      seal.deployment_id,
      seal.state,
      // NULL unless `sealed`. Migration 046 carries the argument: a leaf
      // written during `resealing` was not written under an approval, and
      // stamping the last approved seal on it would read as though it
      // were.
      seal.seal_ref,
      // Migration 049 — same value, same source, same condition as
      // lib/iterations/ingest.ts. Two doors write leaves; a profile recorded
      // by only one of them is a field an auditor cannot rely on, which is the
      // shape of the leaf_kind defect WO-34 found one column over.
      workflowHash ? CANONICALIZATION_PROFILE : null,
      // Migration 052. Stored so a receipt can DISCLOSE the signature rather
      // than assert its existence, and so `leaf_signature_state` can tell
      // "unsigned" apart from "we never got an answer".
      leafSignature,
      leafSignerKeyId,
      leafSignatureAlg,
      leafSignerSurrogate,
      leafSigState,
      // Migration 053, WO-C1. NULL for a leaf with no capture block — a
      // legacy leaf, read back as 'unknown' rather than defaulted to
      // anything. `validateCaptureClaims()` above has already refused every
      // combination this column must never hold, so what lands here is what
      // the component said, not what the server decided it meant.
      claims.basis,
      claims.profile,
      // Migration 056, WO-C4. WHAT THE COMPONENT MEASURED AT EMISSION, and
      // NULL for a leaf with no capture block — never defaulted to 'confined'
      // and never to 'unknown' either: NULL is "the question was not asked of
      // this leaf", 'unknown' is "it was asked and could not be answered".
      // Rule 5 above has already refused every pair this column must not
      // hold, and the CHECK constraint refuses them again for any writer that
      // arrives without going through it.
      claims.confinement,
      claims.confinementSource,
      // Migration 057, WO-C5. WHICH UPSTREAM RUN THIS LEAF CAME FROM, and
      // NULL for a leaf with no capture block, for 056's reason: NULL is "the
      // question was never asked of this leaf", 'not_queried' is "asked, and
      // there was nothing to ask". Two identity columns and not one, because
      // /system_stats identifies the INSTALL and is byte-identical across a
      // restart, while the epoch identifies the RUN — reading either as the
      // other is the blind spot this migration closes. Rule 6 above has
      // already refused every combination these columns must never hold, and
      // 057's cross-column CHECK refuses them again for a writer that arrives
      // without going through it.
      claims.upstream?.identity ?? null,
      claims.upstream?.epoch ?? null,
      claims.upstream?.continuity ?? null,
      claims.upstream?.lowWatermarkOpen ?? null,
      claims.upstream?.lowWatermarkClose ?? null,
      claims.upstream?.uncapturedReason ?? null,
      claims.upstream?.source ?? null,
      // Migration 058, WO-D6. WHO SUPPLIED THE MEANING, AND WHETHER ANYBODY
      // DID. NULL for a leaf with no capture block, for 056's and 057's
      // reason: NULL is "the question was never asked of this leaf" — canvas
      // and the plugins have no host hook to ask — while 'blind' is "there
      // was a hook and nobody was registered on it". A leaf that came through
      // a component ALWAYS has a value here, because the component's leaf
      // builder defaults to 'blind' rather than leaving the field out, which
      // is what stops a Level-1 record from being merely thinner than a
      // Level-2 one. Rule 7 above has already refused every combination these
      // columns must never hold, and 058's cross-column CHECK refuses them
      // again for a writer that arrives without going through it.
      //
      // The manifest is stored as the CANONICAL BYTES THAT WERE HASHED, not
      // as a re-serialization of the parsed body — so a verifier holding this
      // column can reproduce `host_evidence_hash` directly. Same correction
      // `hashModelFingerprints` carries in its own header.
      claims.host?.host ?? null,
      claims.host?.adapter ?? null,
      claims.host?.evidenceType ?? null,
      claims.host?.semantics ?? null,
      hostEvidence?.json ?? null,
      claims.host?.evidenceHash ?? hostEvidence?.hash ?? null,
      // Migration 059, WO-E2. THE ABSENCE SET AND THE SCOPE IT ENUMERATED
      // OVER, and NULL for a leaf with no capture block — for 056's, 057's and
      // 058's reason: NULL is "the question was never asked of this leaf",
      // 'not_enumerated' is "asked, and there was nothing to enumerate".
      //
      // ⚑ `declared_uncaptured_count` IS 0 AND NOT NULL when the component
      // enumerated and found nothing uncaptured. That is the distinction the
      // whole field turns on and 059's CHECK 2 refuses the other writing of
      // it. Rule 8 above has already refused every combination these columns
      // must never hold.
      //
      // The document is stored as the CANONICAL BYTES THAT WERE HASHED, not as
      // a re-serialization of the parsed body — so a verifier holding this
      // column can reproduce `declared_uncaptured_hash` directly. Same
      // correction `hashModelFingerprints` and `host_evidence` carry.
      claims.uncaptured?.method ?? null,
      claims.uncaptured?.scope ?? null,
      claims.uncaptured?.scopeSource ?? null,
      claims.uncaptured?.count ?? null,
      claims.uncaptured?.hash ?? uncapturedHashed?.hash ?? null,
      uncapturedHashed?.json ?? null,
      // Migration 060, WO-F3. WHAT ENTERED THIS DOCUMENT FROM OUTSIDE IT, AND
      // THAT NOBODY HERE WATCHED IT ARRIVE. NULL across all six for a
      // submission that declared nothing — for 053's, 056's, 057's, 058's and
      // 059's reason: NULL is "the question was never asked of this leaf",
      // `source: 'none'` is "asked, and nothing enumerated anything".
      //
      // ⚑ `imported_datablocks_count` IS 0 AND NOT NULL when the host
      // enumerated its datablocks and none had come from outside. That is the
      // distinction the whole field turns on — the same one 059 holds for the
      // absence set — and 060's CHECK 2 refuses the other writing of it.
      //
      // ⚑ `imported_origin_observed` IS 0 AND NOT NULL on every leaf that
      // declares anything, because "nobody here watched these bytes arrive" is
      // the assertion, not the absence of one. It is the field E7-1 found
      // missing, and a NULL in it would be the silence again.
      //
      // The document is stored as the CANONICAL BYTES THAT WERE HASHED so a
      // verifier holding this column can reproduce the digest — and can run
      // the join this field exists for: given a witnessed artifact's content
      // hash, which documents imported it.
      imported.declaration?.source ?? null,
      imported.declaration?.originObserved === null ||
      imported.declaration?.originObserved === undefined
        ? null
        : imported.declaration.originObserved
          ? 1
          : 0,
      imported.declaration?.count ?? null,
      imported.declaration?.unreadableCount ?? null,
      imported.declaration?.hash ?? null,
      imported.declaration?.json ?? null,
      // Migration 054, WO-C2. WHAT THE COMPONENT SIGNED, not what this server
      // knows about itself. The endpoint is self-asserted by the emitter and
      // is deliberately NOT overwritten with our own address: a compromised
      // component naming somewhere else is a fact, and rewriting the column
      // would destroy the only record of it. `validateResolutionHandles()`
      // above has already refused every shape this column must never hold.
      handles.handles?.witness_endpoint ?? null,
      handles.handles?.witness_authority ?? null,
      handles.handles?.checkpoint_id ?? null,
      handles.handles?.prev_checkpoint_id ?? null,
      handles.handles?.prev_checkpoint_quote_time ?? null,
      // Migration 055, WO-C3. THE SIGNED PAIR, VERBATIM. When this leaf's
      // silence becomes a finding, and which retention policy bounds the
      // evidence that would settle it. Both are inside the MAC.
      handles.handles?.settlement_deadline ?? null,
      handles.handles?.retention_policy_digest ?? null,
      // AND THE MEASURED HALF, which the component never sees. The named
      // clock, who answers for it, what it said when this leaf arrived, and
      // the derived instant at which the evidence stops existing. `expired` is
      // computed from these and never from the row's own timestamp column:
      // Architect required a NAMED clock precisely so that the answer is not
      // the emitter's own machine talking.
      settlement.binding?.clock ?? null,
      settlement.binding?.clock_authority ?? null,
      settlement.binding?.observed_at ?? null,
      settlement.binding?.evidence_retained_until ?? null,
    );

  // The reservation has done its job: the real row now holds the number.
  // A failure to release burns one number and is harmless; reusing one a
  // witness may already have signed is not — migration 051 says so in full,
  // and this route is now the second caller to obey it.
  releaseRunSequence(projectId, runSequence);

  return v2Ok(
    {
      leaf_id: String(info.lastInsertRowid),
      leaf_hash: leafHash,
      // 201 means CAPTURED. It has never meant witnessed, and a client
      // that renders one as the other is making a claim the server did
      // not make (§5).
      witnessed,
      leaf_scheme: leafScheme,
      run_sequence: runSequence,
      baseline_ref: body.baseline_ref,
      // WO-S1(a), additive. The same disclosure the receipt carries, from
      // the same function, returned at capture time so a client learns
      // what its leaf is sealed with without a second round trip — and so
      // a client whose own canonicalization disagrees with the row's
      // (`jcs-1` against `jcs-2`, observed) finds out on the response that
      // recorded it rather than never.
      signature: discloseLeafSignature(
        {
          leaf_signature: leafSignature,
          leaf_signer_key_id: leafSignerKeyId,
          leaf_signature_alg: leafSignatureAlg,
          leaf_signer_surrogate: leafSignerSurrogate,
          leaf_signature_state: leafSigState,
        },
        leafHash,
      ),
      canonicalization_profile: workflowHash ? CANONICALIZATION_PROFILE : null,
      attestation: attestationStatus ? { status: attestationStatus } : null,
      // WO-C1. The per-leaf basis every field-level `source: measured` on
      // this leaf is conditional on, returned through the SAME reader a
      // trust decision must use. A leaf with no capture block reads
      // 'unknown' here rather than null, because 'unknown' is a state a
      // consumer can act on and an absent key is one nobody reads.
      //
      // Every leaf emitted today reads `stale`: the witness and the
      // verifier do not pass shared Merkle vectors, so no checkpoint can
      // be claimed settled. WO-C6.
      attestation_basis: {
        basis: basisForTrust(claims.basis),
        profile: claims.profile,
      },
      // WO-C2. Echoed back so a caller can see that the handles it signed are
      // the handles that were stored — and, when it sent none, that the leaf
      // records none rather than one this server filled in for it.
      //
      // `signed: true` is the whole claim of this block: these values are
      // inside the ratchet MAC, so a party between the component and this
      // route cannot rewrite an endpoint, add an authority or forge a
      // checkpoint id without producing `component_unverified`. It is null on
      // a leaf with no handles, which is every leaf written before WO-C2.
      resolution: handles.handles
        ? { ...handles.handles, signed: componentVerified }
        : null,
      // WO-C3. The MEASURED half, returned beside the signed half so a caller
      // can see what its deadline was actually bound to — the clock's name and
      // authority, the instant it read, and when the evidence it points at
      // stops existing. A caller that reads this and finds a
      // `evidence_retained_until` sooner than it expected has a policy problem
      // it can see at capture time rather than at audit time.
      //
      // `settlement.state` is 'pending' on every leaf that carries a deadline
      // and 'unknown' on every leaf that does not — never 'expired' at
      // capture, since a deadline that had already passed at ingest is refused
      // by the band check above.
      settlement: settlement.binding
        ? {
            deadline: settlement.binding.deadline,
            retention_policy_digest: settlement.binding.retention_policy_digest,
            retention_duration_s: settlement.binding.policy.retention_duration_s,
            settlement_window_s: settlement.binding.policy.settlement_window_s,
            evidence_retained_until: settlement.binding.evidence_retained_until,
            clock: {
              name: settlement.binding.clock,
              authority: settlement.binding.clock_authority,
              read_at: settlement.binding.observed_at,
            },
            state: evaluateSettlement({
              resolution_settlement_deadline: settlement.binding.deadline,
              resolution_retention_policy_digest: settlement.binding.retention_policy_digest,
              settlement_clock: settlement.binding.clock,
              settlement_clock_authority: settlement.binding.clock_authority,
              settlement_observed_at: settlement.binding.observed_at,
              evidence_retained_until: settlement.binding.evidence_retained_until,
              resolution_checkpoint_id: handles.handles?.checkpoint_id ?? null,
            }).state,
            source: 'measured',
          }
        : null,
      // What this leaf actually commits to. A caller that sent a graph
      // is entitled to see that it was folded in rather than dropped —
      // which is exactly what could not be seen before WO-1.
      input_hash: inputHash,
      // WO-F3. Echoed on every response, INCLUDING WHEN IT IS NULL, because
      // "this leaf declares nothing about what was imported into it" is a fact
      // a consumer needs and an absent key is a fact nobody reads — the same
      // rule `component` and `seal` follow above.
      //
      // `input_hash_folds_declaration` is spelled out rather than left for a
      // client to derive: it is the answer to "is this declaration bound to
      // this leaf", and a caller that sent a declaration is entitled to see
      // that its digest went into the leaf hash rather than merely into a
      // column. That is exactly what could not be seen before WO-F3.
      imported_datablocks: imported.declaration
        ? {
            source: imported.declaration.source,
            origin_observed: imported.declaration.originObserved,
            count: imported.declaration.count,
            unreadable_count: imported.declaration.unreadableCount,
            hash: imported.declaration.hash,
            input_hash_folds_declaration: Boolean(imported.declaration.hash),
            signed: componentVerified,
          }
        : null,
      workflow_hash: workflowHash,
      model_fingerprints_hash: modelFingerprintsHash,
      machine_manifest_hash: body.machine_manifest_hash ?? null,
      continuity_marked: Boolean(body.continuity),
      // Echoed so a caller can see the type it declared, and see NULL
      // when it declared none. `mime_declared: false` is what a receipt
      // renders as "observed without a declared type" — never as
      // application/octet-stream.
      mime: body.mime ?? null,
      mime_declared: Boolean(body.mime),
      // Present on every response, including when it is null, because
      // "this leaf carries no component" is a fact a consumer needs and
      // an absent key is a fact nobody reads.
      component: body.component
        ? {
            component_id: body.component.component_id,
            counter: body.component.counter,
            verified: componentVerified,
            // Counters this component produced and never delivered. 0 is
            // the ordinary case; anything else says events happened that
            // are not in the record, and it does NOT invalidate this leaf
            // (§4.2) — a suppressed event must not be able to attack the
            // vendor's whole chain.
            gap: componentGap,
            build_changed: componentBuildChanged,
          }
        : null,
      // False for canvas and plugin traffic, which has no component. It
      // is stated rather than omitted so that "we did not check" and "we
      // checked and it passed" are never the same response.
      component_verified: componentVerified,
      // WO-22. Present on every response, including when the state is
      // `undeclared`, because "this leaf carries no deployment" is a fact
      // a consumer needs and an absent key is a fact nobody reads.
      //
      // `claims_standard` is spelled out rather than left for a client to
      // derive from `state === 'sealed'` and get subtly wrong somewhere.
      // It is the whole question the lifecycle answers, and it is binary.
      seal: {
        deployment_id: seal.deployment_id,
        state: seal.state,
        seal_ref: seal.seal_ref,
        claims_standard: seal.state === 'sealed',
      },
    },
    201,
  );
}
