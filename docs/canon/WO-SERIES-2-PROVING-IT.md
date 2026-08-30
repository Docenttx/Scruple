# WO series 2 — proving what we built

_2026-08-30, after the thirteen-WO canon-as-floor run. The first series made the
floor exist. **This one makes it demonstrated rather than designed**, and closes
the gap between what the repo does and what production runs._

**The state these five address:** everything from the first series is tested and
almost none of it is demonstrated **from the tenant's position**. Production
runs a six-week-old witness without H-1. The BDK is an env var. No `verified`
leaf has ever existed outside a mock. And a vendor can read our code but cannot
yet be told what to submit or what they get back.

---

## WO-14 · Occupy the tenant position

**Why first:** probes 1, 2, 3 and 7 are topological — no process in the same
namespace can answer them, so **they have never run where they would mean
anything.** That single gap is why canvas grades P2 FAIL despite having a real
baseline, and it is the whole difference between "we wrote a conformance suite"
and "we have evidence."

- Stand up a real two-container deployment: ComfyUI in one, `scruple-capture` in
  the other, shared volume, tenant-position shell in the ComfyUI container.
- Run all seven probes from that shell. Record `probe_vantage` on every result.
- **Every `inconclusive` must resolve to a real pass or a real fail.** An
  inconclusive that survives is the WO not being finished.
- Implement C-8 properly: `CaptureConfig.outputVolume` is singular, so watching
  `output/`, `temp/` and `input/` currently works only by mounting all three
  under one root and relying on a recursive watch. Make the config express it.
- Split the conformance suite from the fast unit suite. It runs ~18 minutes and
  blows the default budget, which trains everyone to skip it.

**Acceptance:** a complete run from the tenant position with no inconclusive
results, and canvas's P2 resolved on evidence rather than on paperwork.

**If everything passes on the first attempt, do not celebrate — audit.** A clean
first probe run against a deployment nobody has attacked is more likely to mean
the probes are weak than the topology is strong. The first series established
the pattern: every artifact that got used by something else was found to be
wrong.

---

## WO-15 · The published-builds registry (C-4)

**Why:** small work, outsized effect on what we are permitted to say. Until it
exists, `build_measurement` is **drift detection, not provenance**, and §4.3's
"the first time P1 is checkable at ingest" cannot go in a vendor conversation.
Right now this is the gap between what we built and what we may claim.

- A registry of component builds we publish: measurement, version, signature,
  supersession.
- Ingest checks the claimed measurement against it; an unknown build is recorded
  distinctly (**not** rejected — decide and document which, and why).
- The honest limit stays stated: a modified build can claim any string; what it
  cannot do is produce a valid MAC without the IK. Registry plus key, not
  registry alone.

**Acceptance:** a leaf from an unpublished build is distinguishable at ingest,
and §4.3's sentence becomes true rather than aspirational.

---

## WO-16 · Production H-1

**Why:** the repo has H-1; **production runs the 16 July build without it**, and
the two have diverged. Every leaf-signing claim from the first series assumes
H-1. Also: the BDK is an env var with the HSM as intended custody, which is
H-1's story left half-told.

- Redeploy `services/witness-server/` to `/opt/scruple-witness/`. Diff first —
  six weeks of production may hold changes the repo does not.
- Bring the CVM back up (~$135/month, already priced in `L2_FLOOR.md` §5).
- Move the BDK from `SCRUPLE_BDK_HEX` into the HSM. `bdk.ts` was written so this
  changes one file and no caller — verify that claim rather than trusting it.
- **Test the unverified thing first:** `L2_FLOOR.md` §5 records that the
  cloud-init binding the signer's public key to the SEV-SNP measurement is
  first-boot-only, and whether attestation survives a stop/start is **UNKNOWN**.
  If it does not, the restart plan does not work and neither does
  bring-it-up-per-batch. That is a correctness question wearing a cost
  question's clothes; answer it before anything depends on it.
- Rotate the exposed secrets while you are in there; move to a root-owned 0600
  EnvironmentFile.

**Acceptance:** production and repo agree, leaves are ECDSA-signed by the
HSM-resident key, and the stop/start attestation question has a recorded answer.

---

## WO-17 · The first `verified` leaf

**Why:** H-5 is implemented, the surrogate works, and **no real attestation has
ever flowed end to end.** Every leaf the estate has produced is `passthrough`.
A tier that has never once been demonstrated is a claim, not a capability.

- Produce one leaf at `verified`: real hardware attestation, nonce bound to the
  leaf preimage, verified server-side at ingest, IK sealed to the measurement.
- This forces the founder question about Modal. If Modal has no attestable
  compute, **build this on a `server-library` vendor that does** — that is the
  easier placement anyway, and a reference implementation that cannot
  demonstrate its own strongest tier is a bad reference.
- Then re-run the P7/P8 path against it: freshness window, nonce binding,
  rejection of a stale or replayed attestation.

**Acceptance:** one receipt that says `verified` and means it, with the
attestation independently checkable.

---

## WO-18 · What a vendor actually receives

**Why:** a vendor can read our code and still not know what to do. The
conformance *loop* — run this, submit that, receive this, keep it this long — is
studied (`oss-study/sonobuoy-conformance.md`) and unbuilt. This is the
commercial artifact, and it is what makes P1–P8 an obligation rather than an
opinion.

- The submission package: `INTEGRATION.yaml`, probe bundle, self-grade, declared
  placement and topology. Model it on real vendor submissions in
  `/data/oss-study/k8s-conformance`.
- What we check, and what we hand back. Per **configuration**, EMV-L3 shaped,
  re-run on material change — not per vendor and not perpetual.
- The mark and its terms, including the clause forbidding implied gradations,
  which is what makes Standard §5's binary compliance a legal property rather
  than an aspiration.
- The `server-library` quickstart, since that is where a real vendor starts and
  it is 38 lines.

**Acceptance:** we can hand a vendor one directory and a page, and they can
reach a submission without asking us a question.

---

## Not in the five, deliberately

**The Kohya job-submission API.** It is arguably higher value than WO-18 — it
converts a GUI product into an API product and lands Kohya on `server-library`,
a stronger tier than the sidecar, on the substrate we already run. It is not
here because **it is a product decision, not an engineering one**, and it is the
founder's to make. If it is decided, it displaces WO-18.

The whitelist constraint is not cosmetic and belongs in that decision:
`--network_module` is an import path and `--sample_prompts` shells out, so one
"paste your own args" box silently reverts the whole thing to
`unattested-client`.

## Sequencing

WO-14 and WO-15 are independent and can run together. WO-16 gates WO-17 (no real
attestation without real attested infrastructure). WO-18 wants WO-14 finished,
because the submission package should contain a probe run we have actually
performed ourselves.
