# Filing corrections — claims published outside the building that the code does not support

_Opened 2026-09-02 (WO-29). Every item below was verified against the code, the
signed bytes, or a measurement run on this branch. Nothing was re-signed and no
signed artifact, manifest or hash file was modified._

**How to read this file.** Each item says what was wrong, where it went, what
corrective action it needs, and whether it is **founder-gated**. Founder-gated
means it requires re-issuing something to an outside party or re-signing an
artifact, and no agent may do it unilaterally.

**The governing rule for all of it:** a fact inside a signed artifact is not
quietly corrected. Editing evidence to match a corrected story is
indistinguishable from the thing Scruple exists to detect. Where a signed value
is wrong, the artifact is left wrong, the error is disclosed in the prose beside
it, and the *source* that emits the value is fixed so a future emission is right.

---

## READ THIS FIRST — the brief for this work had the exposure backwards

The work order, and `docs/canon/demo-readiness/SYNTHESIS.md` before it, said the
two filing errors were "already in front of a standards body." **They are not.**
The C2PA MCC package's own status line reads *"Draft. Not yet submitted… Do not
submit either document externally until this review completes,"* and its only
commit calls the documents "WG proposal drafts." Nothing in that folder has left
the building.

**Something else has.** On **2026-07-16 a provider-qualification appendix was
sent to the EU AI Office**, over the founder's name as signatory of record
(`docs/session-reports/2026-07-16-overnight-landing.md:8` — *"EU AI Office
response — **sent**"*; `:198` — *"### EU AI Office — ALREADY SENT"*). That
document (**F-10**) asserts capabilities the code does not have, to the regulator
assessing Scruple's qualification as a provider of marking and detection
solutions. It, not the MCC package, is the urgent item in this file.

Priority order is therefore **F-10 → F-03/F-04 → F-11 → F-05 → F-12 → the
rest.** F-01 and F-02, which the brief named as most urgent, are real errors but
are **pre-transmission** and cost far less.

---

## Status summary

| # | Item | Where it went | Fixed here | Founder-gated |
|---|---|---|---|---|
| F-01 | Base model's SHA-256 given as the trained artifact's, inside the `sha256sum` step a verifier is told to run | Bundle README (internal) + 3 places in the C2PA MCC package (**draft, never transmitted**) | Bundle README only | **Yes** — the 3 MCC lines |
| F-02 | Signed manifest says the LoRA was trained by "kohya-ss"; it was `diffusers+peft` on Modal | Inside the **signed** sidecar + MCC draft | Source emitter only; error disclosed in the README | **Yes** — re-sign |
| F-03 | Article 50 page claimed video watermarking, resize survival, a chain hash in the payload, and two paths to one chain | `scruple.ai` reviewer landing page for the **EU AI Office** | Yes, fully | **Yes** — republish |
| F-04 | Three integration category pages carried the same claims | `scruple.ai` category pages | Yes, fully | **Yes** — republish |
| F-05 | *The Scruple Standard* §9.2.2 / §9.2.3 describe video and audio watermarking that does not exist | Public capability register, offered for download from the Article 50 page | No — not in this WO's scope | **Yes** |
| F-06 | Article 50 page cited "*The Scruple Standard, v1.5* §12" for the conformance disclosure; v1.7 deleted §12 and renumbered Hardware Attestation into it | Same reviewer landing page | Yes | No |
| F-07 | `lib/v2/capabilities.ts` tells clients a watermark is available for `video/*` and `audio/*` | Server capability answer to integrators | No — code, out of scope | No, but needs an owner |
| F-08 | The bundle's `MANIFEST.sha256` does not cover three of its own iteration subtrees or its own README | `bundle-29e9a40e1d43`, cross-referenced by the MCC package | No — cannot fix without re-hashing | **Yes** |
| F-09 | Chain lock described as "censorship-resistant" public-ledger anchoring; the shipping modality mints on **Ravencoin testnet** | `scruple.ai` category pages + Article 50 page | Yes | **Yes** — republish |
| **F-10** | **Provider-qualification appendix asserts a marking stack on every output, a witness API that returns C2PA manifests, PDF signing, a distributable watermark module, and signed detection results** | **SENT to the EU AI Office, 2026-07-16** | No — not this WO's files | **YES — the only item requiring a correction to an outside party** |
| F-11 | Integrator guide tells customers to install two packages that do not exist and describes anti-forgery validation the server does not perform | `docs/api/witness-integration.md`, named as the canonical integrator guide in a **submitted** C2PA onboarding runbook | No | **Yes** |
| F-12 | Staged EU evidence bundle cites a smoke test as proving "75% resize survival"; the test resizes down **and back**, which is not a resize | On file, designated answer to the AI Office's next follow-up | No | **Yes** |
| F-13 | In-product copy tells the user to "Sign with C2PA" directly above a button hard-disabled as unavailable | Live product UI | No — code | No, but needs an owner |

---

## F-01 — The verification instruction produced a mismatch

**What was wrong.** Three published documents printed
`31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`
as the trained artifact's SHA-256. That is the **base model**
(`sd_xl_base_1.0.safetensors`). The trained LoRA hashes to
`3141eb757d4dbc6b9ef5eb33cb7c7ab8334b8598fef18a007b515d2722bbe900`.

The worst instance was inside the `sha256sum` step a verifier is explicitly told
to run. A reviewer following our own instructions got a mismatch — which is the
exact signature of tampering, produced by our own prose.

**The cryptography was never wrong.** Verified against the signed bytes, not
against another document: the raw 32-byte digest in the `c2pa.hash.data` CBOR
bstr of `stay-puft-cyberpunk-lora-r4.safetensors.c2pa` is `3141eb75…` (byte
offset 1864 of the 16,498-byte sidecar). The base model digest appears in the
signed sidecar only as `training_run.base_model.sha256_hex` — never as a
binding. Corroborated by the database: `iterations` id 170 has
`output_hash = 3141eb75…`, and `training_runs` id 2 has
`base_model_path = 'sd_xl_base_1.0.safetensors'` beside
`base_model_hash = 31e35c80…`.

**Where it went, and what each needs:**

| Location | Status | Action |
|---|---|---|
| `docs/provenance-bundles/bundle-29e9a40e1d43/iterations/training-181/README.md:7` | Internal + cross-referenced by the MCC package | **FIXED 2026-09-02**, with the correction recorded in the file rather than silently applied |
| …`/README.md`, "How a verifier uses this" `sha256sum` step | Same | **FIXED 2026-09-02**; the base model hash now appears there labelled as the base model |
| `docs/wo/2026-07-12-c2pa-mcc-wg/00-membership-application.md:33` — "Whole-file SHA-256 `31e35c80…`" | **DRAFT. Never transmitted.** | **FOUNDER-GATED.** One-line correction before transmission |
| `docs/wo/2026-07-12-c2pa-mcc-wg/01-technical-proposal.md:138` — "confirm the result equals `31e35c80…`" | **DRAFT. Never transmitted.** | **FOUNDER-GATED.** This is the verification step handed to WG reviewers. Same one-line correction |
| `docs/wo/2026-07-12-c2pa-mcc-wg/README.md:20` — "LoRA content hash `31e35c80…`" | **DRAFT. Never transmitted.** | **FOUNDER-GATED.** Same |

**Nothing here requires re-issuing to an outside party.** See "The MCC package
was never submitted" below — this is the single largest de-escalation in this
file, and it means F-01 costs three line edits made before transmission rather
than a correction notice to a standards body.

The three MCC lines are left untouched deliberately: `docs/wo/` is not this WO's
to edit, and a pre-transmission filing should be corrected by the person who
signs it.

---

## F-02 — The signed manifest names a trainer that never ran. **RE-SIGN REQUIRED.**

**What is wrong.** The signed sidecar asserts
`training_run.trainer_family = "kohya-ss / diffusers+peft"`. The run was not
Kohya. It was a standalone `diffusers+peft` function on Modal
(`modal/scruple_trainer.py`, 2026-07-05). `training_runs.source` is
`diffusers+peft`; `training_runs.kohya_version` is NULL; no Kohya training run
has ever occurred in this project's history, on any path. The adjacent
`training_run.trainer` field says `diffusers+peft` and is correct, so the signed
assertion contradicts itself.

Confirmed inside the signed bytes: the ASCII string `kohya` occurs at byte
offset 1682 of `stay-puft-cyberpunk-lora-r4.safetensors.c2pa`. It is under the
COSE_Sign1 signature. It cannot be corrected without producing new bytes.

**What was done here:**

- `scripts/puffjuly12/12-emit-lora-sidecar.py` — the hardcoded literal at what
  was line 199 is **replaced by a derivation** from `training_runs.source` and
  `training_runs.kohya_version`. A row that claims Kohya but records no Kohya
  version no longer gets upgraded to the Kohya family. For project 181 the
  emitter now produces `diffusers+peft`. **A future emission is correct.**
- The training-181 `README.md` now states the error plainly, says the signed
  artifact is left wrong on purpose, and tells a reader to treat
  `trainer_family` as known-wrong and `trainer` as authoritative.
- `verification-report.json` still reports `kohya-ss / diffusers+peft` and
  **must**: it is a faithful decomposition of the signed bytes. Making the
  report disagree with what is signed would be worse than the original error.
- The signed sidecar, `manifest.json`, `MANIFEST.sha256` and every hash file are
  **untouched**.

### What re-signing would actually involve — FOUNDER DECISION

This is not a one-line change. The specifics, verified today:

1. **The original signing key no longer exists.** The emitter loads its ES256
   private key from `$SCRUPLE_C2PA_KEYS_DIR`, defaulting to
   `/tmp/puffjuly12/keys/c2pa-es256.pem`. **That directory is gone**, and no
   copy of the private key exists anywhere in the repository or on this host —
   only the public half survives, in the bundle's
   `l2/c2pa-es256-pubkey.pem`. A re-sign therefore cannot reuse the original
   signer. It needs either a newly minted keypair and cert chain, or the L2
   SoftHSM signer inside the SEV-SNP CVM — which is deliberately powered down
   pre-launch and would have to be brought up.

2. **The published signer fingerprint would stop matching.** `879614a0…` is
   printed in the bundle's root README, in the training-181 README's verification
   steps, inside the signed manifest as
   `com.scruple.leaf.signer_pubkey_sha256_hex`, and in
   `l2/c2pa-es256-pubkey-sha256.txt` — which **is** covered by `MANIFEST.sha256`.
   A new signer means either the new sidecar's `x5chain` disagrees with the
   bundle's own L2 key material, or the L2 key material changes and
   `MANIFEST.sha256` has to be reissued with it. Choosing which is a founder
   call, not a mechanical one.

3. **The blast radius is smaller than it looks, and this is worth knowing before
   deciding.** Re-signing the LoRA sidecar does **not** invalidate the bundle's
   Merkle root or its ledger anchor:
   - `witness/checkpoint.json` has exactly **5 leaves** — iterations 1–5, the
     FLUX images. It does not reference project 181 or the LoRA hash at all.
   - `MANIFEST.sha256` covers 43 files and **does not cover
     `iterations/training-181/` at all** (see F-08).
   - The LoRA's own anchor — `SCR_DB433994`, Merkle root `1404513c…`, RVN txid
     `32882d63…`, the IPFS CID and the Arweave tx — commits the **witness leaf**,
     which is derived from the training run's own hashes and not from the C2PA
     sidecar. Re-signing produces a new wrapper around the same leaf; the
     on-chain anchor stays valid and does not need reissuing.

4. **The sidecar is not byte-reproducible.** Per the bundle's own
   `NOTES.md` §7, ECDSA-P256 signing uses a random nonce and `c2pa-rs` mints a
   random `instanceID` per sign, so re-signing yields different bytes even with
   identical inputs. There is no "prove the only change was the trainer string"
   diff. The honest artifact of a re-sign is therefore **two sidecars kept side
   by side** — the original, wrong, and the reissue — with a note explaining the
   difference, not a replacement.

5. **What would change in the signed content.** Exactly one field:
   `c2pa.assertion.training-mining` → `training_run.trainer_family`, from
   `"kohya-ss / diffusers+peft"` to `"diffusers+peft"`. Every hash, every anchor,
   every other assertion is unchanged.

**Recommendation, for the founder to accept or reject:** the cheapest defensible
outcome is **do not re-sign**. Keep the original sidecar as-is, keep the
disclosure in the README beside it, and let the corrected emitter produce a
correct sidecar for the *next* training artifact — one that was actually
captured rather than hand-entered. A re-sign with a different key, over a
July artifact whose provenance record was typed in by hand and whose weights
are known-worthless (loss went NaN), buys a corrected string at the price of a
broken signer-fingerprint chain. That is a bad trade. But it is the founder's
trade to make.

---

## F-03 — The EU AI Act Article 50 page overclaimed the marking measure. **CORRECTED; NEEDS REPUBLISH.**

`docs/website/eu-ai-act-article-50-section-1.md` is the reviewer landing page
written so that every one of the **AI Office's** verification asks is answered on
one page. Unlike the MCC package, this one is genuinely external-facing and
carries a real, verifiable C2PA Conformance Program Intake ID.

Four claims were wrong, plus two more found while checking them. All are now
corrected against measurement.

| v1.0 claim | Measured 2026-09-02 |
|---|---|
| "imperceptible pixel-space watermark for image **and video** outputs" | **No video embedder exists in any form.** `services/watermark/` contains no video, audio, MP4 or ffmpeg code; `lib/watermark/apply.ts` skips every output whose kind is not `image` |
| "survives common transformations (re-encoding, **resizing**, colour transforms)" | Survives JPEG q95–q70, WebP q90, and greyscale / brightness / contrast / saturation. **Dies** on 512→480, 512→511, 512→256 and 512→1024 resizes, an 8-pixel crop, a 1-degree rotation, a horizontal flip, and JPEG q65 or below. The decoder derives block indices from the received image's width, so any geometry change re-indexes every bit |
| "encodes a hash back into the Scruple audit chain" | The 128-bit payload is magic + version + tier + a 64-bit wall-clock timestamp. **No content hash, no leaf hash, no chain pointer.** The two tiers that would carry a resolvable Scruple ID are implemented and invoked by nothing |
| "both paths point back to the same Scruple audit chain" | The C2PA path does. The marked copy is produced **after** the event is sealed, and the witness refuses further entries for a sealed project, so the derivative has never been given a leaf — it is in **no** chain |
| *(new)* "Signer — Scruple's attested signing key produces … the watermark's cryptographic binding" | **There is no cryptographic binding in the mark.** It is Reed–Solomon ECC plus triple repetition over DCT coefficient parity. No key, no MAC, no signature. Recovering it proves a Scruple-format payload is present; it does not authenticate origin, and anyone implementing the published scheme can produce one that decodes |
| *(new)* "When this modality is selected for a Scruple event, the resulting content carries an in-band C2PA manifest" | **No Scruple event can select it.** `/api/v2/mark` answers a `c2pa` request with `signer_unavailable`; `/api/scruple/c2pa/sign` has no product caller; the "Sign with C2PA" button is hard-disabled |

**The page now says plainly:** a provenance conversation is defensible for images
and MP4/MOV; a marking-measures conversation is not. Scruple's Section 1 position
rests on in-band signed metadata alone, and the watermark is explicitly **not**
offered as satisfaction of the second measure. The C2PA capability is described
as demonstrable-on-request and not-yet-customer-selectable, which is what is
true.

**Founder-gated:** whatever is live on `scruple.ai` still carries v1.0. The
corrected v1.1 has to be published, and if the AI Office has already been
pointed at the v1.0 page, the four corrections should be flagged rather than
swapped in silently.

---

## F-04 — The three integration category pages carried the same claims. **CORRECTED; NEEDS REPUBLISH.**

- `docs/website/integrations/motion.md` — claimed a video watermark "embedded at
  frame-generation time" surviving "re-encoding, container changes, resolution
  changes within limits", and that the motion integrations "implement both
  mandatory measures". None of that is true. Corrected.
- `docs/website/integrations/illustration.md` — claimed the mark "encod[es] a
  hash back into the Scruple audit chain", survives "resizing", and that C2PA +
  watermark give two paths that "both point back to the same Scruple audit
  chain". Corrected, with the measured robustness table summarised inline.
- `docs/website/integrations/3d-design.md` — milder; the watermark bullet is now
  scoped and measured, and the C2PA availability caveat added.

All three also cited a Standard version that does not exist (see F-06).

**Founder-gated:** these are live site copy. Republish.

---

## F-05 — *The Scruple Standard* describes video and audio watermarking that does not exist. **NOT FIXED.**

`docs/architecture/SCRUPLE_STANDARD_v1_7.md` is the public capability register,
offered for download directly from the Article 50 page — so the AI Office is
invited to read it.

- **§9.2.2 Video watermarking** — "Frequency-domain spread-spectrum embedded
  per-keyframe, with payload spread temporally across keyframes for robustness
  against frame drop and container remuxing. The detector recovers the payload
  from any small sample of keyframes." **None of this exists.** There is no video
  embedder, no keyframe logic, no temporal spread, and no video detector.
- **§9.2.3 Audio watermarking** — "Frequency-domain spread-spectrum on the audio
  spectrum, embedded in perceptually-masked bands per psychoacoustic models."
  **No audio embedder exists.** The named alternative (integrating an
  open-source neural audio watermarker) is a plan, not a capability.
- §9.2 as a whole is positioned as "the peer of §9.1 for satisfying EU AI Act
  Article 50 Section 1 mandatory marking measures." On measurement it is not a
  peer of anything.

The header's scope note — "describes capability classes, not specific
implementations" — does not rescue these. They are written in the present
indicative about a detector that does not exist. `docs/architecture/` is outside
this WO's file ownership, so nothing was changed there.

**Founder-gated.** This is the largest remaining overclaim in the estate and it
is one the Article 50 page actively points a regulator toward. It needs either a
Standard revision that moves §9.2.2 and §9.2.3 into a clearly-marked roadmap
section, or the removal of the Standard from the Article 50 page's download list
until it is corrected. The same text is in `docs/architecture/SCRUPLE_STANDARD_v1.md`
(which self-declares as v1.6).

---

## F-06 — The Article 50 page cited a Standard version and section that do not exist. **FIXED.**

The page (dated 2026-07-30) offered "*The Scruple Standard, v1.5*" for download
and cited "*v1.5* §12" for the C2PA Conformance Program status disclosure — the
disclosure the AI Office is told to use for independent verification.

- No v1.5 file exists. The repo holds `SCRUPLE_STANDARD_v1.md` (self-declaring
  **v1.6**) and `SCRUPLE_STANDARD_v1_7.md` (**v1.7**), both dated the same day as
  the page.
- **v1.7 deleted §12 entirely** — its own change log records "§12 (C2PA
  Conformance Program participation) removed in its entirety" — and renumbered
  Hardware Attestation into §12. An AI Office reviewer following the citation
  lands on hardware attestation, not on the conformance disclosure.

Fixed: the citations now read v1.7, and the page states that the status table on
the page **is** the disclosure. The same stale v1.5 citations in the three
integration pages were corrected, including `3d-design.md`'s reference to
"§15.3", which v1.7 renumbered to §12.3.

---

## F-07 — The server tells integrators a watermark is available for video and audio. **NOT FIXED — code.**

`lib/v2/capabilities.ts`, `isWatermarkable()`: returns `true` for any
`video/*` or `audio/*` MIME type, and `capabilitiesFor()` then reports
`{ modality: 'watermark', available: true, reason: 'An imperceptible mark …
recoverable from the pixels or audio alone.' }`.

No video or audio embedder exists. This is the same overclaim as F-03 and F-05,
but expressed as a **server capability answer that integrator clients render
directly** — and the file's own comment says clients should render from this
answer rather than encoding their own beliefs. So the false claim propagates into
every integration UI.

Not fixed: `lib/` is outside this WO's file ownership. Needs an owner. The fix is
narrow — gate `isWatermarkable()` on the formats the embedder actually decodes.

---

## F-08 — The bundle's hash manifest does not cover three of its own subtrees. **NOT FIXED.**

`docs/provenance-bundles/bundle-29e9a40e1d43/MANIFEST.sha256` lists 43 files:
`iterations/1`–`iterations/5`, `l2/**`, `sign-results.json`, and
`witness/checkpoint.json`. It does **not** cover:

- `iterations/training-181/**` — the LoRA sidecar, its manifest, its verification
  report, its NOTES and its README
- `iterations/audio-1/**`
- `iterations/video-1/**`
- the bundle's own root `README.md`

`witness/checkpoint.json` likewise has only 5 leaves and does not reference the
training, audio or video iterations.

The practical consequence is that the parts of the bundle a reader most needs to
trust — including the README that tells them how to verify — can be altered
without breaking the bundle's own integrity file. That is how the F-01 hash
error survived: nothing checked it.

It is also why the F-01 fix above was made as a **documented correction inside
the file** rather than a silent edit. Anyone comparing an older copy of that
README against the current one will find the change explained in the file itself.

**Founder-gated.** Extending `MANIFEST.sha256` to cover the whole tree means
reissuing a hash file that the MCC package cross-references. Not done here, by
the hard stop.

---

## F-09 — Chain lock was described as censorship-resistant; it mints on testnet. **CORRECTED.**

Nobody had flagged this one. All three integration category pages described the
chain-lock modality as inscribing the leaf hash "on a distributed public ledger
for **censorship-resistant** discoverability," with no mention of which network.

`lib/scruple/witness.ts:112` records that the witness server "now mints on RVN
testnet (post-pivot patch)", and `app/api/v2/mark/route.ts`'s own header says
the chain modality "currently mints on testnet, which the response states
explicitly so nothing downstream mistakes a testnet anchor for a real one." The
API is careful about this; the website was not.

A testnet inscription is not censorship-resistant in any meaningful sense —
testnet coins are worthless, so the security budget defending the inscription is
approximately zero, and testnets are periodically reset. The July provenance
bundle's own anchor (`8f8f9586…`) and the LoRA's anchor (`32882d63…`) are both
raven-**testnet**.

Corrected on all three category pages and on the Article 50 page, which now
states that the reference bundle's anchor is a demonstration anchor and not a
production one. `lib/scruple/ravend.ts` does support mainnet, so this is a
configuration and operations gap rather than a missing capability.

**Founder-gated** only in the sense that the corrected pages need publishing —
and that someone should decide whether chain lock ships on mainnet before it is
sold as censorship-resistant.

---

## F-10 — The appendix sent to the EU AI Office asserts capabilities the code does not have. **SENT. FOUNDER-GATED.**

`docs/eu-ai-office/2026-07-16/attachment.md` — *"Appendix: Provider Qualification
under Section 1 of the Code of Practice on Transparency of AI-Generated
Content"*, dated 2026-07-16, signatory of record **Shaun Hargadine**. Sent.

**First, what the document gets right**, because it matters to the remedy: §4
marks video watermarking and audio watermarking as **"Roadmap Q4 2026,"** not
shipped. That is honest, and it is the opposite of what *The Scruple Standard*
(F-05) and the website (F-03) said. Whoever wrote this appendix was more careful
than everything downstream of it. The corrections below are narrower than they
would otherwise be.

**Five claims that measurement does not support:**

1. **`:48` — "Every output generated by Scruple Studio carries the full marking
   stack described in §4."** An unconditional universal. No Scruple Studio output
   carries a C2PA manifest: `/api/scruple/c2pa/sign` has no product caller, the
   "Sign with C2PA" button is hard-disabled, and `/api/v2/mark` answers
   `signer_unavailable`. Watermarking is reached only from `/api/lock/local`, so
   an output the user never locally locks carries no mark either. The correct
   statement is that the stack is *available to* Studio outputs by design and is
   currently exercised on one path.

2. **`:63` — the Witness API "returns a C2PA-conformant signed manifest
   (Sub-measure 1.1.1)."** It does not. The witness ingests hashes and returns a
   signed audit-chain **leaf**. The C2PA signer is a separate service and is not
   wired into the witness ingest path. This is the load-bearing sentence of the
   whole qualification — it is what makes Scruple a *third-party provider of
   marking solutions* rather than a logging vendor — so it is the single
   highest-consequence line in the document.

3. **`:79` — Sub-measure 1.1.1 listed as "Shipped" for "Image, video, audio,
   PDF, ML models."** **PDF cannot be signed.** Docent's own C2PA Conformance
   Program submission ships a `NOT_SUPPORTED.txt` for `application/pdf` saying
   *"the wrapper does not currently expose the signer for this MIME"* — filed
   two days after this appendix went to the AI Office. PDF is asserted as
   shipped to one external body and as unsupported to another, in the same
   fortnight. ML models are sidecar-only, which the appendix does not say.

4. **`:66` and `:80` — the "Scruple Watermark Reference," an "open-source
   imperceptible watermarking module," with 1.1.2 scoped to cover "downstream
   products consuming" it.** **No such distributable exists.** There is no
   `@scruple/watermark` npm package and no `scruple-watermark` PyPI package
   anywhere in the repository; `services/watermark/` runs no server and exposes
   no HTTP surface. The three packages that do exist —
   `@scruple/verify`, `@scruple/conformance`, `@scruple/attestation-verifiers` —
   are all marked `"private": true` in their own `package.json`. The count of
   downstream products consuming the reference is zero, and there is nothing for
   them to consume. Note this also qualifies the appendix's description of
   Scruple-Verify as "distributed as a library and CLI, open-source."

5. **`:106` — "Detection results are downloadable in a digitally signed form
   including a hash of the submitted content, an identifier of the detection
   solution, and a timestamp, per Sub-measure 2.1.2."** `packages/scruple-verify`
   has no path that signs its own verdict. The only signature verbs in its CLI
   verify **inbound** Ed25519 checkpoints. A named Code sub-measure is asserted
   as satisfied by a mechanism that does not exist. Related: `:103` says the
   solution "includes a detection mechanism for **each** marking technique in §4"
   — there is no video or audio detector, though §4 does at least label those
   rows as roadmap.

**What re-issuing would involve.** This is the one item in this file that
genuinely requires writing to an outside party. It is a **correction to a
regulator on a live qualification**, so it is legal-review territory, not an
engineering task. The realistic shape:

- A short corrigendum to the AI Office referencing the 2026-07-16 appendix,
  correcting items 1–5, and restating §4's status column where "Shipped" should
  read "implemented; not yet exposed as a customer-selectable modality."
- It should go out **with**, not before, the corrected `scruple.ai` Article 50
  page (F-03), because that page is the public artifact the AI Office is pointed
  at and the two must agree.
- It should also settle F-05, since the appendix and the Standard currently
  disagree with each other about video and audio watermarking — the appendix
  says roadmap, the Standard says implemented. A regulator comparing them finds
  a contradiction in Docent's own filings.

**Nothing about this is fixed here.** `docs/eu-ai-office/` is outside this WO's
file ownership, and a document sent under the founder's name as signatory is not
an agent's to edit — for the same reason a signed artifact is not.

---

## F-11 — The integrator guide ships instructions that cannot work and advertises validation that does not exist. **FOUNDER-GATED.**

`docs/api/witness-integration.md` is named as *"the canonical integrator-facing
guide"* in `docs/c2pa-conformance-evidence/.../runbooks/customer-onboarding.md`
— a runbook that **was** submitted to the C2PA Conformance Program. Its stated
audience is "vendors and enterprises running an AI inference or training stack."

- **`:228-233`** instructs integrators to `npm install @scruple/watermark` or
  `pip install scruple-watermark` and shows the import. Neither package exists
  (see F-10 item 4). An integrator following the guide fails at the install step.
- **`:269-273`** tells integrators the server validates that the payload's tier
  matches the caller's claim, that a chain-lock payload's SCR_ID "matches the
  caller's actual chain-lock record on file — **prevents a caller from claiming
  a chain-lock watermark without holding the real lock**," and that timestamps
  are checked against a clock-skew window. **None of those three checks exists.**
  `lib/witness/ingest.ts:219-244` validates presence-of-all-three, 64-hex shape,
  a 32-hex payload, magic byte `5c`, and version nibble 1 — and nothing else.
  The advertised anti-forgery control is absent, and it is advertised *as* an
  anti-forgery control.
- **`:330`** lists "audio clips shorter than 7 seconds" under conditions where a
  watermark is *not* applied, which tells a reader that longer audio **is**
  marked. No audio embedder exists.

This is worse than a documentation error in one respect: an integrator who reads
`:270` may reasonably rely on the server to reject forged lineage, and build
their own trust decisions on top of that. It does not.

---

## F-12 — The staged EU evidence bundle proves resize survival with a test that undoes the resize. **FOUNDER-GATED.**

`docs/eu-ai-office/evidence-bundle-2026-07-14/` is described in the session
report as *"on file if asked"* — the designated answer to the AI Office's next
follow-up. It is one email from being outside the building.

`04-coverage-per-modality/coverage-matrix.md:16` cites
`scripts/smoke-watermark.mjs` as proving "8 assertions including JPEG q=75 +
**75% resize survival**," restated at
`2026-07-14-provider-qualification-response.md:94` as "Robustness against JPEG
re-encoding at `q=75` and **75% linear resize** is validated by
`scripts/smoke-watermark.mjs`."

What that script actually does, at `:110-123`:

```js
im.resize((int(w*0.75), int(h*0.75)), Image.LANCZOS).resize((w, h), Image.LANCZOS)
```

It scales the image down **and back up to the original dimensions**, which
restores the 8×8 DCT block grid the decoder indexes off. The script's own console
message says *"survives 75% resize **roundtrip**"* — accurately. The
regulator-facing restatement dropped the word "roundtrip" and turned a
round-trip test into a resize-robustness claim.

Independently confirmed today: a 2× upsample followed by a downsample back to
512×512 **recovers** the payload, while a resize to 480×480, 511×511, 256×256 or
1024×1024 left in place **all fail**. The cited evidence therefore demonstrates
the opposite of what it is cited for. This is the single clearest instance in
the estate of a green test that could not have failed — see F-03 for the
measured matrix.

Two more claims in the same staged bundle, both of the F-10 class:

- `03-marking-implementation/marking-technical-spec.md:60` — the `/v1/log`
  derivative fields let integrators "chain the watermarked derivative back to its
  clean-master leaf **cryptographically**." The fields are validated and then
  dropped: they enter no leaf preimage and no stored row, so nothing is chained.
- `01-cover-letter.md:27` — "**every** raster image output published through
  Scruple Studio carries a 128-bit imperceptible watermark," encoding "a
  public-ledger Ravencoin asset identifier (chain-lock tiers)." Only
  `/api/lock/local` watermarks, and it emits tier 3; the Ravencoin-identifier
  variant has never been emitted by any code path.

**Recommendation:** this bundle should not be sent in its current form. If the
AI Office asks, it needs the same corrections as F-10 first.

---

## F-13 — The product tells the user to press a button it has disabled. **NOT FIXED — code.**

`components/WorkspaceView.tsx:209` renders: *"…**Sign with C2PA to emit an
industry-standard signed asset.**"* Directly beneath it,
`components/LockButtons.tsx:87` hard-disables that button with *"C2PA signing is
not available yet — this build cannot attach a content credential."*

Two contradictory sentences on one screen, the affirmative one written as a
product capability. Smallest fix in this file; outside this WO's ownership.

---

## The MCC package was never submitted — and the brief for this work said it was

`docs/wo/2026-07-12-c2pa-mcc-wg/README.md` states, in its own status line:

> **Status:** Draft. Not yet submitted. Documents in this folder are under
> internal review pending counsel sign-off and executive approval before
> transmission to the C2PA / CAWG.

and, under next steps: *"Do not submit either document externally until this
review completes."* The only commit touching the folder describes them as "WG
proposal drafts." There is no LFX enrollment record, no transmission record, and
the package's own contact block still reads "TBD at formal filing time."

`docs/canon/demo-readiness/SYNTHESIS.md` opens by saying both filing errors are
"already in front of a standards body," and the WO brief repeats it. **That is
not correct**, and it changes the shape of the response materially:

- F-01 and the MCC half of F-02 are **pre-transmission edits**, not retractions
  to a standards body. Nobody outside Docent has been handed the failing
  `sha256sum` step.
- Counsel review is still outstanding on that package regardless, which is the
  actual blocker.

### What *is* outside the building — the accurate inventory

1. **The EU AI Office appendix, sent 2026-07-16** (F-10). A live regulatory
   qualification, over the founder's name. **This is the only item that requires
   a correction to an outside party**, and it is the reason this file exists in
   the shape it does.
2. **`docs/website/**`** — the Article 50 reviewer landing page and the three
   category pages are site copy for `scruple.ai`. If they are live, the wrong
   claims are live, and they are aimed at the same regulator (F-03, F-04, F-09).
   Corrected here; publishing is the founder's.
3. **The C2PA Generator Product Conformance Program submissions** — Intake ID
   `019f5856-bff8-7f57-a879-80594a6fb3fe`, initial 2026-07-14, remediation
   2026-07-18, amendment 2026-07-30, under `docs/c2pa-conformance-evidence/`.
   Really sent, and **substantially honest**: they scope themselves narrowly to
   the C2PA Signer service, which genuinely works, and they affirmatively
   disclose their gaps (`NOT_SUPPORTED.txt` for PDF and pytorch). Their exposure
   is *indirect* — the submitted onboarding runbook points customers at
   `docs/api/witness-integration.md`, which is F-11.
4. **The staged EU evidence bundle** (F-12) — not sent, but designated as the
   answer to the next follow-up. It should be corrected before it ships, not
   after it is asked for.

### What is *not* outside the building, contrary to the brief

The C2PA MCC package. F-01 and the MCC half of F-02 are pre-transmission edits.
That is a genuine de-escalation and it should be said clearly, because the
opposite belief is what set the priority order for this work.

---

## What needs the founder, in priority order

**Requires an outside party to be written to:**

1. **F-10 — the corrigendum to the EU AI Office.** Five claims in a sent
   qualification appendix. Legal review, not an engineering task. It should go
   out *with* the corrected Article 50 page (F-03) so the filing and the public
   page agree, and it should settle F-05 at the same time, because the appendix
   and the Standard currently contradict each other on video and audio
   watermarking.

**Requires publishing, and a decision about disclosure:**

2. **F-03 / F-04 / F-09 — publish the corrected `scruple.ai` pages**, and decide
   whether the AI Office is told the page changed rather than letting it change
   silently under them.
3. **F-05 — revise *The Scruple Standard* §9.2.2 and §9.2.3, or pull the
   Standard from the Article 50 page's download list.** Both live copies
   (`SCRUPLE_STANDARD_v1.md`, self-declaring v1.6, and `_v1_7.md`) describe a
   video watermark detector that does not exist, and the EU submissions cite the
   first by filename. `SCRUPLE_C2PA_RELATIONSHIP_CHART_v1.md`, also marked
   public-facing, carries the same video/audio watermark claim in a
   sales-shaped comparison table.

**Requires a decision before anything else is sent:**

4. **F-12 — correct the staged EU evidence bundle before it is sent.** In
   particular the "75% resize survival" evidence pointer, which cites a test
   that undoes the resize.
5. **F-11 — fix or withdraw `docs/api/witness-integration.md`.** It is named as
   canonical in a submitted runbook, tells integrators to install packages that
   do not exist, and advertises an anti-forgery check the server does not
   perform.

**Slower, lower consequence:**

6. **F-02 — decide whether to re-sign the July LoRA sidecar.** Recommendation
   above is *do not*. Either way write the decision down, because the error is
   now disclosed in the bundle and a reader will ask.
7. **F-01 — correct the three MCC draft lines before transmission**, and note
   that counsel review of that package is still open.
8. **F-08 — decide whether `MANIFEST.sha256` gets extended** to cover the whole
   bundle tree.
9. **F-07 and F-13 — assign an owner.** Two small code fixes:
   `isWatermarkable()` advertising video and audio through an API, and the
   product telling a user to press a button it has disabled.
10. **F-09 — decide whether chain lock ships on mainnet** before it is sold as
    censorship-resistant. Until then the corrected pages say testnet.

---

## Provenance of the measurements in this file

All measured on branch `feat/canon-skeleton`, 2026-09-02, with no witness server
contacted and no database written.

- **Hashes** — read directly out of the signed sidecar's bytes
  (`c2pa.hash.data` CBOR bstr at offset 1864) and corroborated against
  `iterations` id 170 and `training_runs` id 2 in `data/scruple.db` (read from a
  copy, including the WAL — the WAL matters: without it the table reads empty).
- **Watermark robustness** — `services/watermark/image_dct.py` driven directly on
  a 512×512 test image: embed, then decode after each transformation. The full
  matrix is in F-03.
- **Payload contents** — `services/watermark/payload.py`, plus a round trip
  through `build_payload_tier_1_3` / `build_payload_tier_4_5` and
  `decode_payload`.
- **Reachability** — `grep` over the repository for callers of
  `/api/scruple/c2pa/sign` and `watermarkProjectIterations`, plus the
  hard-disabled button in `components/LockButtons.tsx` and the
  `signer_unavailable` branch in `app/api/v2/mark/route.ts`.
- **The EU AI Office send** — `docs/session-reports/2026-07-16-overnight-landing.md`
  lines 8 and 198, plus the commit message for `5308116`. The appendix's own
  front matter names the signatory of record and the 2026-07-16 date.
- **Package existence** — every `packages/*/package.json` in the tree, plus a
  repository-wide grep for `@scruple/watermark` and `scruple-watermark`, which
  hits only documentation and one code comment, never a package.
- **The resize evidence** — `scripts/smoke-watermark.mjs:110-123` read directly,
  and reproduced: a down-then-back-up resample recovers the payload while every
  resize left in place fails.
- **Key material** — the ES256 private key path
  (`$SCRUPLE_C2PA_KEYS_DIR`, default `/tmp/puffjuly12/keys/c2pa-es256.pem`)
  does not exist on this host, and no copy exists in the repository.
