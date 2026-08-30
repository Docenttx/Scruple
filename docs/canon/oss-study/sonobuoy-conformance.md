# OSS study: Kubernetes conformance (Sonobuoy + k8s-conformance) — mapped to Scruple

## Bottom line

Kubernetes conformance is a **self-test + PR + bot-checked-labels + trademark-license** loop, not an audit: a vendor runs a tool (Sonobuoy) in their own cluster, gets a results tarball, submits four files as a single-commit PR to `cncf/k8s-conformance`, a bot mechanically verifies the *test evidence* (all required tests present, all passing) while a human verifies *paperwork* (CNCF membership, signed Participation Form), and in return the vendor earns a time-limited, revocable license to a trademark phrase. This works for Kubernetes because every one of its conformance claims is a **functional** claim a test can independently observe. Scruple's P1–P8 are a mix: P1/P3/P6 (boundary integrity, key custody, zero-content) are **security-posture claims about a vendor's own infrastructure that no self-run suite can catch a lying vendor on** — CNCF has no equivalent problem, and the artifact below shows the split item-by-item plus what SOC2/CMVP-style third-party attestation would need to close the gap for a small team.

---

## 1. The submission process

### 1.1 What exactly a vendor submits

Per `instructions.md` (`/data/oss-study/k8s-conformance/instructions.md`), a PR to `cncf/k8s-conformance` under `vX.Y/$dir/` contains exactly four files:

```
vX.Y/$dir/README.md       — human-readable reproduction steps (no links allowed, see FAQ)
vX.Y/$dir/e2e.log         — Sonobuoy's raw test log
vX.Y/$dir/junit_01.xml    — Sonobuoy's machine-readable JUnit results
vX.Y/$dir/PRODUCT.yaml    — vendor/product metadata
```

`PRODUCT.yaml` required fields: `vendor`, `name`, `version`, `website_url`, `documentation_url`, `contact_email_address`, `type` (`distribution` | `hosted platform` | `installer`), `description`. Optional: `repo_url`, `product_logo_url`.

A real example, `v1.30/aks/PRODUCT.yaml`:
```yaml
vendor: Microsoft
name: Azure Kubernetes Service AKS
version: v1.30.5
website_url: https://docs.microsoft.com/en-us/azure/aks/
documentation_url: https://docs.microsoft.com/en-us/azure/aks/
product_logo_url: https://raw.githubusercontent.com/cncf/landscape/master/hosted_logos/azure-kubernetes-service.svg
contact_email_address: zhechengli@microsoft.com
type: hosted platform
description: 'AKS allows you to quickly deploy a production ready Kubernetes cluster in Azure.'
```
Its `README.md` is literally the exact `az`/`sonobuoy` CLI commands used, because the FAQ (`faq.md`) explicitly bans linking out: *"No. We need the Readme of your conformance submission to contain more detailed directions on how to install and configure your Kubernetes implementation... we're requesting that you include sufficient detail... such that an informed user will be able to replicate your results."* Its `junit_01.xml` is 2.5MB (402 of 7199 specs run — the rest are `[Conformance]`-tagged-but-not-applicable filtered by `--mode=certified-conformance`), and `e2e.log` ends with the summary line `SUCCESS! -- 402 Passed | 0 Failed | 0 Pending | 6797 Skipped`.

A second real example, `v1.30/cdk/PRODUCT.yaml` (Canonical/Charmed Kubernetes, `type: distribution`), shows the same four-field shape for an installer-class product. 21 products are certified for v1.30 alone; the repo has one directory per `kubernetes-version × product` combination going back to v1.9 (2018).

### 1.2 Who reviews it, against what checklist

Two separate reviewers, doing two separate jobs:

**A bot** (`prow.cncf.io`) checks the submission is *evidentially complete* — 15 numbered, mechanical requirements in `instructions.md#requirements`, e.g. #2 "submission contains all required files", #6 "the PRODUCT.yaml metadata contains all required fields", #11 "all required conformance tests in the junit_01.xml are present", #12 "all tests pass in e2e.log", #13 "there is only one commit" (squash required), #14 "only required files are in submission" (no stray files). Every failed check gets a `not-verifiable` label plus an explanatory bot comment; the vendor force-pushes fixes until every check clears, at which point the bot applies `conformance-product-submission`, `no-failed-tests-v1.xx`, `release-documents-checked`, `release-v1.xx`, `tests-verified-v1.xx`.

**A human reviewer** then does policy checks that no bot can verify, per `reviewing.md`: (1) vendor is a current CNCF member (or has paid an equivalent fee, or is a qualifying non-profit); (2) a signed Participation Form is on file and the vendor is "in good standing"; (3) the `name`/`website_url` in `PRODUCT.yaml` match what's listed on that Participation Form's "Qualifying Offerings" section; (4) if `name` contains "Kubernetes" non-descriptively, it's listed in the form's "Participant Kubernetes Combinations" section. If any of these fail, the reviewer replies with a specific reason ("Signed participation form needed", etc.) rather than a bot label. **This is the load-bearing split**: bot verifies the machine-checkable test artifact, human verifies the human-trust artifact (identity, standing, licensing scope) — nothing here asks a human to re-run or spot-check the tests themselves.

### 1.3 What the vendor gets, and what they may then say

Per `terms-conditions/Certified_Kubernetes_Terms.md`: the vendor becomes a "**Participant**" holding a license to the "**Certified Kubernetes Marks**" (trademarks owned by The Linux Foundation, not CNCF). Concretely they may:
- Use the word "Kubernetes" in their product name (e.g. "Acme Kubernetes Engine") as a "Participant Kubernetes Combination", *only* in plain text, with an ® symbol and a mandated attribution line ("Kubernetes® is a registered trademark of The Linux Foundation... used pursuant to a license") — explicitly **not** as a stylized logo or folded into their own logo.
- Display the "Certified Kubernetes" mark per the Branding Guide.
- Be listed on the CNCF landscape and `cncf.io/certification/software-conformance` and `kubernetes.io/partners`.

What they may **not** say is enumerated as prohibitions, and this is the most transferable clause: **"Do not be misleading about the nature or scope of certification... do not state or imply that there are different degrees of certification"** — i.e., no "gold/silver/platinum" gradient, no "certified before" bragging, and explicitly no implying Linux Foundation/CNCF *endorsement* ("do not say... 'certified by CNCF'"). Certification is binary and non-comparative by contract, not just by design.

### 1.4 Validity period and re-certification triggers

From the Terms and `faq.md`: a Qualifying Offering's certified status for Kubernetes `x.y` lasts until the **later of** 12 months after `x.y`'s release, or 9 months after `x.y+1`'s release. Additionally: "**Already certified implementations remain certified as long as a newer version is certified at least once a year**" — i.e., certifying against a newer K8s version resets the clock and implicitly re-validates the product is still conformant. Forced re-certification also happens if (a) the product is materially modified and LF determines it may no longer pass, or (b) end users report the public self-tests can't be reproduced or fail — LF gives 30 days' written notice to re-pass and resubmit, else the marks must come down within 30 days. Version eligibility is capped at "current + 2 prior minor releases" (`faq.md`).

---

## 2. The test suite as the executable definition of the standard

### 2.1 The `[Conformance]` tag

`docs/KubeConformance-1.30.md` in `k8s-conformance` explains the mechanism directly: a conformance test is any Ginkgo spec whose descriptive string contains the literal `[Conformance]` tag, generated from Go code like:
```go
/*
  Release: v1.13
  Testname: Kubelet, log output, default
  Description: By default the stdout and stderr from the process being executed
  in a pod MUST be sent to the pod's logs.
*/
framework.ConformanceIt("should print the output to logs [NodeConformance]", func(ctx context.Context) {
```
The doc-comment above the test, written in RFC 2119 language (MUST/MUST NOT/SHOULD), **is** the spec. The generated `KubeConformance-*.md` files (one per K8s minor version, 1.9 through 1.37 in this checkout) are literally extracted from that comment via `test/conformance` + `gen-conformance-release-docs.sh` — there is no separately authored prose spec; the test *is* the requirement, and the doc is its rendering.

### 2.2 Eligibility rules for promotion to `[Conformance]` (from `kubernetes/community/.../sig-architecture/conformance-tests.md`, referenced by `docs/README.md`)

A normal e2e test must satisfy **all** of, to be promoted:
1. Tests only GA, non-optional features/APIs (no alpha/beta/feature-flagged/deprecated).
2. Doesn't require direct kubelet API access to pass.
3. Provider-agnostic — no `SkipIfProviderIs`/`SkipUnlessProviderIs`.
4. Uses only capabilities exposed via the API; no write access to system namespaces.
5. Works without public internet access (beyond pre-pulled images).
6. Works without non-standard filesystem permissions on pods.
7. Doesn't rely on binaries beyond what the kernel/kubelet already need.
8. Doesn't depend on OS-dependent output, where avoidable.
9. Container images support every architecture K8s releases for.
10. Passes against the correct version range per the version-skew policy.
11. **Stable for at least two weeks with no flakes.**
12. Only promotable before the release's code-freeze date.
13. Has a literal string name (not dynamically generated).

Process: a SIG first develops the e2e test normally (owning SIG approves). Promotion is a *separate* PR titled "Promote xxx e2e test to Conformance", tagged `/area conformance`, reviewed by `@kubernetes/sig-architecture-pr-reviews` + the owning SIG's reviewers + `@kubernetes/cncf-conformance-wg`, carrying flakiness evidence, converting `framework.It()` → `framework.ConformanceIt()`, and tracked on "SIG Architecture's Conformance Test Review board." This decouples *writing* a test (SIG-owned, fast) from *certifying it as part of the portable contract* (architecture-owned, deliberately slow) — a two-gate structure worth reusing.

**Why this matters**: because promotion is adversarial-review-gated and requires two weeks of flake-free evidence, the test suite functions as a single, auditable, versioned, machine-executable definition of "conformant" — vendors and CNCF are never arguing about what the spec *means*, only about whether the JUnit output says pass or fail.

---

## 3. Sonobuoy the tool

`/data/oss-study/sonobuoy` (Apache 2.0, VMware/Heptio → CNCF-adjacent, `vmware-tanzu/sonobuoy`).

**Running it** (`instructions.md`, `README.md`): `sonobuoy run --mode=certified-conformance` deploys an aggregator pod plus one pod per plugin into the vendor's own cluster; `--mode=certified-conformance` is *mandatory* for certification runs specifically because without it, disruptive tests may be silently skipped — "A valid certification run may not skip any conformance tests." `sonobuoy status`/`sonobuoy logs` poll progress; `sonobuoy retrieve` copies a single `.tar.gz` off the aggregator pod. The two files required for submission live at a fixed path inside it: `plugins/e2e/results/global/{e2e.log,junit_01.xml}`.

**Plugin architecture** (`site/content/docs/main/plugins.md`, `pkg/plugin/manifest/manifest.go`): a plugin is a YAML manifest (`sonobuoy-config` + a pod `spec`) of `driver: Job` (runs once) or `driver: Daemonset` (runs per-node), declaring a `result-format` of `raw`, `junit`, `gojson`, or `manual`. The contract is minimal and generic: the plugin's container does its work and writes the name of its output file into a "done file" (default `/tmp/results/done`); a Sonobuoy-injected sidecar watches for that file and ships the named file back to the aggregator. This is genuinely a third-party-extensible plugin model — nothing in the driver/result-format contract is Kubernetes-specific, and the ecosystem proves it: `heptio/sonobuoy-plugin-systemd-logs` ships as a second built-in, and blog posts in this checkout document independent plugins (`site/content/posts/2019-11-18-cis-benchmark-plugin.md` — a CIS Benchmark plugin by a third party; `2021-11-09-E2E-Skeleton-Plugin.md` — a scaffold for writing your *own* conformance-shaped plugin). A minimal real manifest, `test/integration/testdata/hello-world.yaml`:
```yaml
sonobuoy-config:
  driver: Job
  plugin-name: hello-world
  result-format: raw
spec:
  command: [./run.sh]
  image: hello:v9
  name: plugin
  resources: {}
  volumeMounts:
  - mountPath: /tmp/results
    name: results
```
`result-format: manual` is the most relevant mode for Scruple: a plugin can emit its own `sonobuoy_results.yaml` in Sonobuoy's canonical schema rather than JUnit, letting a non-test-suite check (e.g., "does the manifest declare a baseline hash") report pass/fail through the same aggregation and CLI (`sonobuoy results $tarball`) as the e2e suite.

---

## 4. What conformance deliberately does NOT test

From the `conformance-tests.md` scope section (fetched from `kubernetes/community`):
- **Platform/node-reliant features** — multiple disk mounts, GPUs, high density: not portable across implementations, so not testable as a universal contract.
- **Optional features** — e.g. policy enforcement: not present in every conformant cluster by definition.
- **Cloud-provider-specific features** — GCE monitoring, S3 bucketing: certification is about the *portable* Kubernetes API, not any one vendor's environment.
- **Non-default admission plugins** — anything needing a plugin most clusters won't have enabled.
- **Deprecated/pending-deprecation features** — e.g. `componentstatus`.
- **Operational endpoints** rather than application-facing ones — e.g. apiserver logs.
- **Exact Event content / optional Condition fields (Reason, Message)** — excluded because there's no delivery guarantee on Events and these strings are explicitly allowed to change over time; testing them would make the suite brittle against implementation details the API contract never promised.

The unifying rationale, stated directly: *"Conformance tests are intended to be stable and backwards compatible according to the standard API deprecation policies."* Scope is bounded to what is (a) universal across all implementations, (b) part of the actual API contract, and (c) stable enough to promise for a year. Everything else — performance, scale, non-portable capability, provider extension — is out of scope by design, not by oversight.

---

## 5. Mapping to Scruple

### 5.1 The conformance loop, concretely

| K8s conformance | Scruple conformance (proposed) |
|---|---|
| `sonobuoy run --mode=certified-conformance` in vendor's cluster | A `scruple-conformance` CLI/container the vendor runs inside their own integration (points at their real capture path, their real key store) |
| Emits `e2e.log` + `junit_01.xml` | Emits a `scruple-conformance-report.json` + a raw event/session log |
| Vendor extracts required files into `vX/$vendor/` | Vendor opens a PR to `scruple/conformance` with `PRODUCT.yaml`-equivalent (vendor, product, integration version, standard version, contact) + the report + a README describing exactly how they wired the witness calls into their stack |
| Bot checks: all required files present, all required checks in the JSON ran and passed, one squashed commit, no stray files | Same bot shape — but see 5.2, the bot can only check the *mechanically testable* subset |
| Human reviewer checks CNCF membership + Participation Form match | Human reviewer checks a signed **Scruple Integration Agreement** (Participation-Form equivalent: names the exact integration point, binds the vendor to re-attest on material changes, states what they're allowed to claim) |
| Vendor earns "Certified Kubernetes" mark, binary, time-boxed, non-comparative, revocable | Vendor earns "Scruple Verified" mark under the same shape: binary (no tiers), time-boxed (re-attest on a fixed interval or on integration change), revocable on reproduction failure, non-endorsement ("Scruple Verified" ≠ "Scruple guarantees this vendor is secure") |
| Re-cert forced by: new K8s minor release, reported reproduction failure, material product change | Re-cert forced by: witness-server protocol version bump, reported failure to reproduce a claimed baseline, vendor's capture-path code changing (P1's whole surface) |

### 5.2 The critical difference — item-by-item split of P1–P8

Kubernetes conformance tests *functional* behavior against a live API a test process can directly observe and where lying is self-defeating (a faked pass is caught the moment any user reruns the suite, because the suite talks to the real object the claim is about). Several of Scruple's P1–P8 are instead **claims about facts of the vendor's own infrastructure that a suite run *by that same vendor, inside their own boundary*, structurally cannot verify** — the suite can only ask the vendor's own systems whether the vendor's own systems are honest, which is the exact case K8s conformance never has to handle.

| Req | What it claims | Mechanically testable by vendor-run suite? | Why / how |
|---|---|---|---|
| **P1** runtime boundary integrity (capture code not modifiable by witnessed party) | A negative claim about who *can* reach the capture code | **Not directly testable.** A suite can confirm the capture code *currently* produces correct hashes, but cannot prove the witnessed party lacks write access to that code path — that's an infrastructure/IAM fact external to any test run. A suite CAN do a partial, indirect check: attempt an authenticated tamper (inject a modified capture binary/config through whatever surface the witnessed party would have) and confirm it's rejected — this converts part of P1 into a probe, not a full proof. |
| **P2** baseline coverage of the capture path | Existence of an attestation covering the exact code that runs | **Testable.** The suite can hash the running capture code/container and check a baseline attestation exists and matches — this is exactly Sonobuoy-shaped (a functional artifact either exists and matches, or doesn't). |
| **P3** API key custody (signing key unreachable by witnessed party) | A negative claim about a secret's location | **Not testable by a vendor-run suite.** Whether the witnessed party (e.g. an end customer of the vendor, or a compromised container) can reach the key is a fact about the vendor's secret-management architecture, which the vendor controls and could misreport. The suite can only confirm the key *isn't* passed to it as a runtime input it can see — proves nothing about other paths. |
| **P4** principal identity | The witness event carries an authenticated, correct principal | **Testable.** The suite can submit known identities and check they land correctly and can't be spoofed by an unauthenticated caller from the position it's run in. |
| **P5** immutable event chain | The chain can't be edited/reordered undetected after the fact | **Testable.** Structural — attempt to tamper a submitted chain and confirm detection; this is functional, like a K8s API test. |
| **P6** zero-content posture | No raw content ever leaves the vendor boundary | **Testable, with a caveat.** The suite can inspect what's actually sent over the wire it controls (network capture / mock endpoint) — strong evidence, though it only covers the paths exercised by the suite, not every code path in the vendor's stack. |
| **P7** attestation declaration (verified vs. passthrough) | Manifest correctly declares which mode is in effect | **Testable.** Structural check that the declared value matches what P1–P6 actually measured in this run. |
| **P8** attestation import discipline | Imported attestations are handled per policy | **Testable.** Feed known-good/known-bad attestations, confirm accept/reject behavior. |

**The split**: P4, P5, P6 (with caveat), P7, P8, and half of P2 are functionally testable — a vendor lying about them either can't produce a passing run, or the lie is falsifiable the moment any third party (including Scruple, spot-checking) reruns the probe. **P1 and P3 are the irreducible cases** — "is this code unreachable by X" and "is this key unreachable by X" are facts about access control topology that a process running *inside* the same trust boundary cannot prove from the inside, no matter how cleverly the test is written. This mirrors exactly why K8s conformance never had to solve this problem: every K8s conformance claim is "does this API behave correctly," never "is our etcd truly inaccessible to the tenant" — Kubernetes doesn't certify a hosting *security* posture, it certifies *API surface behavior*.

### 5.3 What the industry does for the non-testable ones

CNCF's own answer for claims it can't verify is exactly the human-review half of §1.2 above: it doesn't try to verify them at all — it converts them into a **signed representation with legal consequence** (the Participation Form + Terms's indemnification clause) backed by a **revocation mechanism triggered by third-party report** (the "end users find you don't reproduce" clause, 30-day cure window, mark removal). CNCF explicitly declines to be a security auditor; it is a *registrar of self-attested claims with a trademark leash*.

Adjacent programs that *do* solve exactly this — "how do you certify an infrastructural/topological fact a self-test can't reach" — via **independent third-party audit**:
- **SOC 2 Type II**: an accredited external auditor examines actual access controls, key management, and change-management evidence (logs, screenshares, interviews) over a period, not a single point-in-time self-test. This is the closest structural match to P1/P3 — "who can reach this" is exactly a SOC 2 access-control control objective.
- **FIPS 140 / CMVP**: an accredited independent lab validates that cryptographic module boundaries and key handling meet the standard; vendor cannot self-certify at all — the lab is *mandatory*, not optional the way K8s's model is self-test-first.
- **PCI-DSS**: for higher tiers, a Qualified Security Assessor (a third party certified by the PCI Council, not the vendor and not the Council itself) does an on-site assessment; lower tiers allow a Self-Assessment Questionnaire — i.e., PCI runs a **two-tier model**, self-attestation for low-stakes claims, mandatory third-party assessor for high-stakes ones.
- **Common Criteria**: fully third-party (accredited testing labs + national certification bodies), the heaviest and slowest of the four — not a fit for a small team's velocity.

**Which model fits a small team**: PCI's two-tier split is the right shape to copy, not SOC 2 or Common Criteria wholesale (both require accredited auditors Scruple can't stand up or afford). Concretely: run the K8s-style self-test/bot loop for P2, P4–P8 (all mechanically testable) exactly as designed above; for P1 and P3 specifically, require a **signed attestation document** (the Scruple equivalent of the Participation Form) where a named accountable individual at the vendor states the specific architectural fact under legal/contractual weight, *plus* publish the exact test/probe a customer or Scruple can run **against the live integration** to catch a lie after the fact (the K8s "end user reproducibility" clause — anyone can rerun and if it doesn't reproduce, the mark comes off within 30 days). This doesn't make P1/P3 provable in advance, but it makes false claims **costly and discoverable in production**, which is what SOC 2 letters and CMVP certs also ultimately rest on (an auditor's letter is still trust-plus-consequence, not mathematical proof).

### 5.4 The smallest version we could actually run

1. **A single conformance-check container/script** the vendor runs against their live integration, producing one JSON report — testable checks (P2, P4–P8) run for real; P1/P3 fields in the report are the vendor's own attested yes/no plus a pointer to how a third party could probe it.
2. **A four-file PR template** to a `scruple-conformance` repo: `INTEGRATION.yaml` (vendor/product/contact/integration-point description — the PRODUCT.yaml analog), the JSON report, a README with exact reproduction steps (no links, per the K8s FAQ lesson — link rot defeats reproducibility), and a one-page signed attestation covering P1/P3.
3. **One human reviewer** (a founder, not a review board) checks the signed attestation and that the vendor is a real counter-party worth a trademark license — this is the only step requiring judgment, and it's the same weight as CNCF's membership/Participation-Form check, not a security audit.
4. **A trademark-shaped grant, not a security guarantee**: "Scruple Verified" is licensed, binary, dated, and revocable — with contract language copied near-verbatim from the K8s Terms' "do not imply Scruple endorses this vendor's overall security" and "do not imply degrees of verification" clauses, because that's precisely the liability boundary CNCF already solved.
5. **Reproducibility as the enforcement mechanism** for everything not directly testable: publish the probe scripts, make "Scruple Verified" contingent on any third party being able to rerun the mechanical checks against the live integration at any time, and treat a failed reproduction (reported by anyone) the same way CNCF does — 30-day cure window, then the mark comes off.

---

## Notes on licenses / not found

- `sonobuoy` and `k8s-conformance`: both Apache License 2.0.
- Trademark ownership sits with **The Linux Foundation**, not CNCF — worth copying the split (a neutral IP-holding entity distinct from the technical review body) if Scruple ever separates "who owns the mark" from "who reviews submissions."
- Not found in this repo: the actual Prow bot source implementing the 15 requirement checks (referenced but the bot itself lives in a separate `test-infra`/prow config repo, not fetched here). Not found: a documented SLA for reviewer turnaround beyond "3 business days" contact escalation.
