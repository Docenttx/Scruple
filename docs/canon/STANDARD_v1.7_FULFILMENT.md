# Standard v1.7 — Clause Fulfilment Matrix

**What this is:** every clause of `SCRUPLE_STANDARD_v1_7.md` mapped to the
canon surface element that delivers it, or to an explicit statement that
nothing does.

**Two columns, and the difference matters.** *Today* is what the estate
does as of 2026-08-26, after the morning's repairs. *Canon* is what the
skeleton in `CANON_SKELETON.md` and `openapi-v2.yaml` would deliver.
Neither column is a promise about a date.

Legend — **MEETS** · **PARTIAL** · **ABSENT** · **N/A** (with a reason)

---

## §2 What Scruple witnesses

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Witnesses AI-workflow events | PARTIAL | MEETS | `POST /v2/witness`, `kind` ∈ document_save, artifact, graph_execute, model_write |
| Witnesses the integration itself | **ABSENT** | MEETS | `POST /v2/baseline` at the `attach` hook |

Today only one integration captures more than a finished file: the live
ComfyUI proxy captures the workflow graph. Kohya captures the checkpoint
but not the dataset root, hyperparameters or base model, despite a
`training_runs` schema fully provisioned to hold them. No integration
witnesses itself at all.

## §3 Baseline attestation

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Baseline measured and signed at install | **ABSENT** | MEETS | `POST /v2/baseline` |
| Baseline is the tenant's genesis leaf | **ABSENT** | MEETS | `Baseline.baseline_ref` |
| Every workflow leaf references the baseline | **ABSENT** | MEETS | `baseline_ref` REQUIRED on `POST /v2/witness`; 409 if unknown |

The server has had a baseline API since the witnessing-L2 sprint. Nothing
has ever called it. **D-3 is the largest behavioural change in the
skeleton**: witnessing without a baseline stops being possible. §5 leaves
no room for the alternative — a leaf produced by unbaselined code is
exactly what the Standard calls *not Scruple-witnessed*.

## §4 Changing an integration is itself a witnessed event

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Tamper-surface change surfaces or forces re-baseline | **ABSENT** | MEETS | `attach` hook compares `tamper_surface_hash` |
| Re-baseline is itself a signed leaf | **ABSENT** | MEETS | `POST /v2/baseline/rebaseline` — `witness_leaf_id` is non-nullable |
| Re-baseline linked to prior baselines by hash | **ABSENT** | MEETS | `previous_baseline_hash` |
| Optional public anchoring of the baseline | **ABSENT** | MEETS | `anchor_publicly` |

The existing rebaseline implementation leaves `witness_leaf_id`
permanently null, so the one property that makes §4 meaningful — that the
change is *on the record* — is the exact property missing.

## §5 Compliance is binary

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Witnessed-or-not is cryptographic, not self-declared | PARTIAL | MEETS | `baseline_ref` + `Leaf.witnessed` |
| No tier structure | MEETS | MEETS | no compliance grade anywhere in the surface |
| No silent partial credit | **MEETS as of today** | MEETS | `witnessed` on every leaf response |

This was the worst-broken clause in the sweep and is now the most
recently repaired. The server returned `ok:true` over a failed witness
with no `witnessed` field in the schema, while the Adobe routes wrote
`witnessed=1` unconditionally — the truth signal was broken at both ends
at once. Fixed in `bff1fd8` and `45b8b89`. Four integrations also exposed
a "C2PA" control that performed something else; all four now say what
they do (`aa889a2`, `7b54dfa`, `2ec6a7c`, `24d0054`).

## §6 Security ends at the signing moment

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| No post-signing custody claim | MEETS | MEETS | surface makes no such claim |
| Phase 3 changes publication, not integrity | MEETS | MEETS | `MarkResult.outstanding` is operational, never a security state |

Nothing in the estate claims otherwise. This clause is met by not doing
something, and the skeleton keeps not doing it.

## §7 Lock tiers add discoverability, not integrity

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Tier language is discoverability, not strength | PARTIAL | MEETS | `chain_tier` documented as reach |
| Failed Phase-3 op is never silently dropped | **ABSENT** | MEETS | SDK queue in the failure path; `MarkResult.outstanding` |

Six integrations independently built an offline retry queue, tested it,
and never wired it into the failure path. That is not six oversights —
it is a Standard requirement that discipline alone failed to deliver six
times, which is why the SDK contract puts the queue in the failure path
*by construction* rather than by remembering.

## §8 The two Scruple Layers

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Soft / Hard Scruple distinction | N/A | N/A | a deployment posture, not an API surface |

No integration claims Hard Scruple. Nothing in the skeleton needs to
express the distinction; if that changes it belongs in `capabilities`.

## §9 Output modality options

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| §9.1 C2PA content credentials | **ABSENT** | MEETS | `modalities: [c2pa]` |
| §9.2 EU-compliant watermarking | **ABSENT** | MEETS | `modalities: [watermark]`, `payload_kind: timestamp` |
| §9.3 Chain lock | PARTIAL | MEETS | `modalities: [chain]` + `chain.network` |
| §9.3 SCR_ID watermark auto-attached with chain lock | **ABSENT** | MEETS | `payload_kind: scr_id`, attached without a separate request |
| §9.4 Local lock on every event | PARTIAL | MEETS | `MarkResult.local_lock`, always present |
| §9.5 Any combination permissible | **ABSENT** | MEETS | `modalities` is a set |
| §9.5 **Selection recorded in the leaf** | **ABSENT** | MEETS | `modalities_requested` / `modalities_applied` |
| §9.6 Continuity events marked on recovery | **ABSENT** | MEETS | `witness.continuity` |

**§9.1 and §9.2 are the headline.** Zero integrations have ever produced a
content credential. Watermarking has no HTTP endpoint at all —
`services/watermark` runs no server, and the only path is a subprocess
buried inside `lock/local`, scoped to already-stored image iterations.
v1.7 promoted watermarking to a mandatory peer of C2PA under EU AI Act
Article 50 Code of Practice Section 1, so half of what the Standard
promises is currently unreachable by any plugin.

**§9.5's recording requirement is the subtlest thing in the Standard and
nothing implements it.** It cannot be retrofitted: absence of a
credential proves nothing unless the user's selection was committed at
signing time. It is also why the surface has one `mark` call instead of
per-modality endpoints.

**§9.6 is a capability nobody has asked for.** It is specified here
because the clause exists; it is the most reasonable thing in this
document to defer.

## §10 Evidentiary discipline · §11 Four axes

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| — | N/A | N/A | descriptive framing, no API obligation |

## §12 Hardware attestation

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| §12.1 Two attestation chains | PARTIAL | PARTIAL | `AttestationInput` on baseline and witness |
| §12.3 Third-party hardware observer | N/A | N/A | TME/Blackhole, out of scope for the plugin surface |
| §12.4 **Verified ≠ passthrough** | **VIOLATION** | MEETS | `Attestation.status`, non-optional |
| §12.5 Freshness windows | **ABSENT** | PARTIAL | per-tenant config, named but not specified here |

§12.4 is the only clause in the Standard the estate actively **violates**
rather than merely fails to implement. All six verifier plugins are
structural-only — they never chain to a vendor root — and they present as
verified. The clause says in terms: *"'Stored' MUST NOT read as
'verified.'"* This also bears on the GPSA, which describes the
attestation posture to a conformance reviewer.

## §13 Change discipline

| Clause | Today | Canon | Delivered by |
|---|---|---|---|
| Standard is versioned; minor bump for material change | **AT RISK** | — | — |
| Canonical version is the doc at rest in the repository | **AMBIGUOUS** | — | — |

Two files disagree about which is canonical.
`SCRUPLE_STANDARD_v1.md` holds **v1.6**; `SCRUPLE_STANDARD_v1_7.md` holds
**v1.7**. They differ by 284 lines and both are committed. §13 says the
canonical version is "the document at rest in Scruple's repository" —
there are two documents at rest and the clause does not disambiguate
them. Everything in this matrix grades against the v1_7 file.

---

## The L2 floor (cross-cutting)

Added 2026-08-26 on the founder's principle: *"we can't have an evidence
standard below a simple compliance standard."* Full analysis in
`L2_FLOOR.md`.

Clause conformance is necessary and not sufficient. A clause can be met
by a mechanism whose assurance is below the C2PA Level 2 bar the GPSA is
filed at — and several are.

| Path | Clause status | L2 floor |
|---|---|---|
| C2PA manifest (§9.1) | ABSENT (never produced) | **MEETS** — ECDSA, PKCS#11 HSM, SEV-SNP CVM |
| Witness leaf (§2) | PARTIAL | **BELOW** — HMAC secret in a systemd env var on the app host |
| Baseline (§3) + rebaseline (§4) | ABSENT | **BELOW** — same witness path |
| Local lock (§9.4) | PARTIAL | **BELOW** — HMAC `server_signature` |
| Chain lock (§9.3) | PARTIAL | **PARTIAL** — the on-chain mint is an asymmetric public verifier; the seal beneath it is not |
| Watermark (§9.2) | ABSENT | **INHERITS** — payload integrity derives from the leaf |
| Attestation (§12.4) | VIOLATION | **BELOW** — structural-only, never chains to a vendor root |
| Client key custody | N/A | **BELOW** — plaintext keys in `%APPDATA%`; one global Kohya HMAC |

**The inversion this exposes.** The relationship chart says C2PA is one
modality *inside* Scruple's evidentiary framework. The assurance runs the
other way: the modality is at L2 and the framework containing it is not.
Every row marked BELOW is an evidence claim weaker than the compliance
artifact sitting beside it.

**Consequence for §2.** The Standard says Scruple witnesses workflow
events and the integration itself "through the same signing key." They
are different keys, of different kinds, in different places, at different
assurance levels. Whether that sentence is intent or a claim already made
to a counterparty is a founder question, recorded in `L2_FLOOR.md` §6.

---

## Summary

| | Today | Canon |
|---|---|---|
| MEETS | 4 | 24 |
| PARTIAL | 7 | 3 |
| ABSENT | 17 | 0 |
| VIOLATION | 1 | 0 |
| N/A | 5 | 5 |

**The single most important row** is §9.5's "selection recorded in the
leaf." Everything else in the ABSENT column can be added later to events
witnessed today. That one cannot — it has to be captured at the moment of
signing or the distinction it exists to preserve is gone for good.

**The one to argue about** is D-3, baseline-or-refuse. It is the clause
reading I am most confident of and the change most likely to be
unwelcome, because it makes every integration do work before it can do
anything useful. If it is softened, §3, §4 and §5 all soften with it, and
the honest thing would be to say so in the Standard rather than in the
implementation.
