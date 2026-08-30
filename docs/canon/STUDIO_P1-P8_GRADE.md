# Scruple Web Studio — formal grade against Integration Requirements P1–P8

_Graded 2026-08-30 against `docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` v1.2 §2._

## Bottom line

Studio has **two capture paths, and they are not close to each other in quality.**
The canvas/ComfyUI path is a genuinely sound design that fails on paperwork — it
has no baseline, so nothing it does is *provable*. The Kohya path fails on
architecture, and the headline is worse than a property failure: **it never
creates a witness leaf at all.** Kohya checkpoints land in two local SQLite
tables and stop there.

Neither path can pass today, because **no baseline attestation covering any
Studio capture code exists anywhere in the estate.** The only tamper-surface
that exists covers four files of the witness server itself
(`services/witness-server/tamper-surface.mjs:39-46`). P2 is therefore FAIL for
both paths by construction, and P7 fails for both as a consequence — not because
attestation is absent, but because there is no manifest in which to declare
`attestation.provider: none`.

---

## Summary table

| | Canvas / ComfyUI | Kohya |
|---|---|---|
| **P1** runtime boundary integrity | **PASS** (conditional) | **FAIL** |
| **P2** baseline coverage | **FAIL** | **FAIL** |
| **P3** API key custody | **PASS** | **FAIL** |
| **P4** principal identity | **PASS** | **FAIL** (derived from P3) |
| **P5** immutable event chain | **PASS** | **FAIL** (no chain exists) |
| **P6** zero-content posture | **PASS** | **PASS** |
| **P7** attestation declaration | **FAIL** | **FAIL** |
| **P8** attestation import | n/a | n/a |

Compliance is binary (Standard §5). **Both paths are non-compliant.** The
distinction that matters is that canvas is four fixes from compliant and Kohya
needs a different architecture.

---

## Path A — Canvas / ComfyUI

Capture runs in `app/canvas-proxy/[sessionId]/[[...path]]/route.ts`, a
server-side HTTP proxy. `POST /prompt` is teed for the workflow JSON;
`GET /view` is teed for output bytes; both feed `lib/canvas/witness.ts`.

### P1 — PASS, conditional

The design is right, and the route's own header says why:

> `route.ts:4-7` — "The browser never learns the Modal URL; only the proxy
> knows it, and only the proxy is server-side trusted to call Modal with the
> shared-secret header."

The hash is taken on bytes in transit through code the user cannot reach. The
user cannot substitute bytes after hashing because they never hold them first.
Custom-node packs are baked into the Modal image and pinned by
`machines.manifest_hash` (`lib/canvas/manifest.ts:32,68`), so the toolchain is
measured rather than asserted.

**Three conditions on this PASS, all currently satisfied, none guaranteed:**

1. **The WebSocket sidecar must stay pass-through.**
   `scripts/canvas-ws-proxy.mjs:14-18` states WS frames carry only status
   events and the HTTP path carries "the authoritative provenance bytes." That
   is true of the ComfyUI version pinned today. It is a property of the
   upstream application, not of our code — a ComfyUI version that returns
   result bytes over WS silently opens an uncaptured egress path. **This needs
   an assertion in the baseline, not a comment in a file.**
2. **Personal machines (WO-7) would break it.** `lib/canvas/witness.ts:112-114`
   notes "Today everyone shares the default machine; WO-7 will let users have
   personal machines." If a user can define their own custom-node manifest,
   they choose the middleware inside the boundary, and P1's "custom nodes,
   plugins, or middleware the user can disable or replace at runtime" bites.
   **WO-7 as specified would move canvas from P1-PASS to P1-FAIL.** That is a
   design decision to take deliberately, not to discover later.
3. Only the default machine's manifest is pinned; the lookup falls back to
   `user_id IS NULL` (`lib/canvas/witness.ts:117-123`), so a null manifest hash
   degrades to a v2 leaf silently rather than refusing.

### P2 — FAIL

No baseline covers `canvas-proxy/route.ts`, `lib/canvas/witness.ts`,
`lib/iterations/ingest.ts`, or `scripts/canvas-ws-proxy.mjs`. The capture path
is unmeasured. Everything in the P1 analysis above is true by reading the source
and unprovable to a third party — which is precisely the gap P2 exists to close.

### P3 — PASS

`SCRUPLE_CANVAS_SHARED_SECRET` is held by the proxy and the sidecar, both
server-side. The browser receives a session id, not a credential, and not the
upstream URL.

### P4 — PASS

`userId` comes from `auth()` on the proxy request; the project is resolved
server-side by `resolveActiveProjectId(userId)` (`lib/canvas/witness.ts:163`).
The end user supplies neither.

### P5 — PASS, with a separate §7 failure

Nothing mutates or deletes prior leaves.

**But** `lib/canvas/witness.ts:155-157` swallows ingest failure:

```
} catch (e) {
  console.error('[canvas/witness] ingest failed', e);
}
```

The user receives their image; no leaf is written; nothing surfaces. That is a
**Standard §7 violation** (Phase-3 failures never silently dropped), and it
produces a chain with holes that carries no record of the holes. Not a P-item
failure, and worse than most of them — a hole you can see is evidence, a hole
you cannot see is a lie of omission.

### P6 — PASS

`WitnessIterationRecord` (`lib/scruple/witness.ts:10-28`) carries content hash,
input hash, workflow hash, model-fingerprints hash and machine manifest hash.
Hashes and small metadata only. No payload bytes leave.

**Note the direction of travel:** this legacy v2.2 leaf carries all five hashes.
The new `/v2/witness` route drops `input_hash`, `workflow_hash` and
`model_fingerprints_hash`. **The v2 API is an evidentiary regression against the
path it is meant to replace**, and Studio's older code is currently the better
citizen. Fix v2 before migrating canvas onto it.

### P7 — FAIL

`executionAttestation: null` (`lib/canvas/witness.ts:139`). Modal provides no
hardware attestation, so `provider: none` is the correct *value* — and P7
explicitly permits it. It fails only because there is no baseline manifest to
declare it in. This item closes for free the moment P2 does.

---

## Path B — Kohya

Capture is `sitecustomize.py` inside the user's RunPod pod, monkey-patching
`safetensors.torch.save_file`; it HMACs a JSON body to
`app/api/apps/kohya/witness/route.ts`.

### The headline: no leaf is ever created

The route's own comment is the finding
(`app/api/apps/kohya/witness/route.ts:116-121`):

> "We do NOT yet POST to the witness server for a leaf hash from this route —
> the leaf construction still runs through the canonical `/api/v1/log/*` ingest
> surface, keyed by the tenant's API principal, not by the pod-side HMAC (which
> authenticates the hook, not the human customer). Wiring the pod-side HMAC
> through to a witness leaf is a separate follow-up."

The route writes `app_kohya_progress` and `training_runs` and returns `ok: true`.
**Kohya training produces no witnessed evidence.** Meanwhile the pod hook's
docstring tells the operator the opposite — `kohya_safetensors_hook.py:11-12`
claims "scruple-web signs a leaf and inserts a training_runs / iterations row."
It inserts the row. It does not sign a leaf. **Anyone reading the hook believes
Kohya is witnessed.**

### P1 — FAIL

`sitecustomize.py` in a pod the user has a shell in. The user can delete it, set
`PYTHONNOUSERSITE`, re-patch `save_file`, or simply unset one env var — the
docstring documents the last one as intended behaviour
(`kohya_safetensors_hook.py:23-24`): *"If any env var is missing, the hook is a
no-op (Kohya still works, no witness)."*

P1 names this exact shape unacceptable twice over: "custom nodes, plugins, or
middleware the user can disable or replace at runtime" and "server-side code the
user has shell or admin access to."

### P2 — FAIL, and unfixable in place

No baseline. And it could not be fixed by writing one, because the measured
artifact sits inside the boundary it is supposed to measure — a hash of
`sitecustomize.py` computed by the pod proves nothing about the pod.

Compounding it: **two divergent copies of the hook exist.**
`public/pod-hooks/kohya_safetensors_hook.py` (167 lines, publicly served, so
presumably what pods fetch) is the **older** one and never computes
`header_hash`; `research/scruple-kohya-image/scruple_safetensors_hook.py` (176
lines) does. The route treats `header_hash` as optional "from older hook builds"
(`route.ts:39-40`), so in production the structural fingerprint is most likely
always null. You cannot baseline a file that ships in two versions.

### P3 — FAIL, most serious item in the grade

`lib/apps/backends/runpod-session.ts:155-163` injects the secret as a pod env var:

```
const witnessSecret = process.env.SCRUPLE_APPS_WITNESS_SECRET ?? '';
const env: Record<string, string> = {
  SCRUPLE_USER_ID: req.userId,
  ...
  SCRUPLE_WITNESS_SECRET: witnessSecret,
};
```

P3 names this verbatim as unacceptable: *"API key distributed to end users via
email, configuration file, or environment variable in a user-controlled shell."*

It is also **global** — one secret for every pod and every user. Any customer
who runs `env` in their own pod holds the credential that authenticates every
other customer's witness traffic. `docs/canon/studio-l2/04-PLAN.md:441` records
this as "any pod can witness as any user"; the grade upgrades it from a
configuration decision to a **tenancy boundary that does not exist.**

Note for WO-05: a per-session secret does **not** fix P3. It narrows blast
radius from all-users to one-user, which is worth doing, but the secret is still
in a shell the witnessed party controls, and P3 is about custody, not scope.

### P4 — FAIL, derived

`user_id` and `session_id` arrive in the request body
(`route.ts:44-48`) and are cross-checked against `app_sessions`
(`route.ts:76-89`) — sound in itself. But the only thing preventing forgery is
the HMAC, and every user holds the key. `output_hash` is attacker-chosen
throughout. P4 requires identity "not a value the end user can supply or modify";
here they can supply the value *and* the signature over it.

### P5 — FAIL

There is no event chain to be immutable. Separately, the route performs
`UPDATE training_runs SET model_hash = ...` in place on an existing row
(`route.ts:143-166`), which is the mutation pattern P5 forbids for leaves. And
`route.ts:171-177` swallows the write failure as "non-fatal" — another §7 silent
drop.

### P6 — PASS

Body carries `output_hash`, `header_hash`, `size_bytes`, `structural_summary`
(layer names, shapes, dtypes) and identifiers. No weights, no payload bytes.
This is the one property Kohya gets right, and it gets it right by design.

### P7 — FAIL

No baseline manifest, so nothing declares a provider. RunPod pods have no
hardware attestation available, so `none` would be the correct value —
but see below, because that has a business consequence.

---

## What this grade says about the vendor strategy

Three things fall out that matter beyond Studio.

**1. The failures cluster in exactly one place: the user-controlled pod.**
Every Kohya failure (P1, P2, P3, P4) is the same failure wearing four hats —
the capture code, the credential, and the identity all live inside the boundary
of the party being witnessed. This is not a Kohya bug. It is the defining
property of the shape "training on a pod the customer controls," and it will
recur identically for **every vendor who offers customer-controlled compute** —
which is most of the market we are aiming at. Canvas v2 already made this
decision once for ComfyUI: capture moved out of the pod and into a proxy. Kohya
needs the same move, and the general answer for vendors is the same move.

**This is the founder decision I flagged before compaction, and the grade
sharpens it:** is training-on-a-user-controlled-pod a shape Scruple supports at
all? Three honest answers exist — (a) it is not supportable and the standard
says so; (b) it is supportable only through a capture proxy outside the pod;
(c) it is supportable at a declared lower tier that is visibly not the full
claim. Today we are accidentally doing a fourth thing: shipping it and calling
it witnessed.

**2. Studio's own grade is the best sales asset we have — and only if we
publish it.** We are asking vendors to submit to P1–P8 in a boundary we cannot
see. A reference implementation that grades itself honestly, publishes two
FAILs, and shows what it did about them is far more persuasive than one that
claims a clean sheet. It also sets the norm we need: **the grade is a document
the vendor produces, and producing an unflattering one is normal.**

**3. P7 has a commercial edge we have not been using.** RunPod and Hugging Face
*do* have attestable hardware in their fleets. A vendor on plain compute
declares `none` and is still compliant; a vendor on attested compute declares a
provider and gets a materially stronger receipt. That is a real differentiator we
can hand them — and the reason `verified` vs `passthrough` (P7/P8) is worth the
machinery it costs.

---

## Fix order

**Canvas — four items, all small, and it passes:**
1. Write a tamper-surface manifest covering the proxy, `lib/canvas/witness.ts`,
   `lib/iterations/ingest.ts` and the WS sidecar; produce a baseline. **Closes
   P2 and P7 together.**
2. Make ingest failure loud (`lib/canvas/witness.ts:155`). §7.
3. Assert the WS-is-status-only property in the baseline rather than in a
   comment, so a ComfyUI bump that breaks it fails visibly.
4. Decide WO-7 (personal machines) against P1 **before** building it.

**Kohya — architectural, do not patch:**
1. Move capture out of the pod. The pod is not a place a credential or a
   measurement can live. Canvas v2's proxy is the precedent and probably the
   design.
2. Until then, stop the hook's docstring claiming a leaf is signed, and stop the
   route returning `ok: true` for an unwitnessed save. Reporting an unwitnessed
   checkpoint as witnessed is the one failure mode with no honest defence.
3. Resolve the two hook copies before anything else — you cannot measure a file
   that ships in two versions.

**Estate-wide:**
- Restore `input_hash`, `workflow_hash`, `model_fingerprints_hash` to
  `/v2/witness` before migrating canvas onto it. The new API is currently worse
  evidence than the old path.
