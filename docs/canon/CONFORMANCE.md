# Conformance — the seven probes, the self-grade, and the submission

_2026-08-30. WO-9. Implementation: `packages/scruple-conformance/`,
`services/scruple-capture/probes/`, `test/v2/conformance.test.ts`._

## Bottom line

A conformance suite that cannot reproduce a known failure is not evidence of
anything. This one reproduces `STUDIO_P1-P8_GRADE.md` cell for cell against a
named commit, **including both FAILs**, from source rather than from a table of
booleans.

Three things came out of building it that are worth more than the code:

1. **Four of the seven probes cannot be strengthened by writing more code.**
   Probes 1, 2, 3 and 7 ask "can the tenant reach X?", which is a fact about
   network and mount topology. A process inside the same namespace as the
   tenant cannot answer it by observation, and a process outside it is
   answering about the wrong position. They can only be strengthened by moving
   where they run. This is `oss-study/sonobuoy-conformance.md` §5.2 — "P1 and
   P3 are the irreducible cases" — arrived at from the other end.
2. **§10 C-8's three directories are satisfiable today only by accident.**
   `CaptureConfig.outputVolume` is singular. The only way to watch `output/`,
   `temp/` and `input/` with the shipped component is to mount them as
   subdirectories of one root and rely on `fs.watch`'s recursive flag.
3. **P2 cannot be satisfied by a declaration, and one hole remains that it
   can.** See "DEFECT-2, and the hole that is left" below.

---

## 1. A probe is an attack

H-4 §7 says it in one line: *"Run from inside the tenant container, where the
adversary sits; each must fail."* Two consequences the code takes literally.

**Two results, running in opposite directions.** `outcome` is what happened to
the attack (`blocked` | `succeeded` | `not-attempted`); `verdict` is what that
means for the deployment (`pass` | `fail` | `inconclusive`). Blocked → pass.
Succeeded → fail. They are never one field, because conflating them is how a
suite reports a successful exfiltration as a green tick.

**Inconclusive is not a pass, anywhere.** Sonobuoy requires
`--mode=certified-conformance` precisely because "a valid certification run may
not skip any conformance tests". A probe that could not be attempted, or one
attempted from a vantage that only *models* the tenant's position, is recorded
as inconclusive and counts as not-passed everywhere it aggregates. There is no
configuration in which a skip becomes a pass.

### The seven

| id | H-4 ref | attack | kind |
|---|---|---|---|
| P-01 | §7.1, §2 obl. 1 | reach ComfyUI directly, bypassing the component | topological |
| P-02 | §7.2, §4.4, C-5 | reach the provisioning or admin surface | topological |
| P-03 | §7.3, §4.4 step 4 | read the sealed IK | topological |
| P-04 | §7.4, C-8 | write into `output/`, `temp/`, `input/` and get no leaf | behavioural |
| P-05 | §7.5, §2 path 2 | retrieve over WS and get no leaf | behavioural |
| P-06 | §7.6, C-2/C-3/C-6 | submit a leaf at or below the last counter | behavioural |
| P-07 | C-9 → §7.7, new obl. 4 | open an outbound connection to an external host | topological |

### Where they run, and why `--simulate` is not evidence

`OsVantage` **occupies** the tenant's position — real sockets, real filesystem.
Run it inside the workload container and its answers are facts about that
deployment:

```
docker exec -it  <workload-container>  npx scruple-conformance run --config …
kubectl exec -it <workload-pod>     -- npx scruple-conformance run --config …
```

`SimulatedVantage` **models** the position from a policy, for tests and dry
runs. Every topological result from it is stamped inadmissible by the runner,
not by the probe — one place to enforce it rather than seven places to forget.

The upstream address, the state directory and the egress target are **given by
the operator, never discovered**. A probe that had to find the upstream would
be testing our port scanner, and a deployment that survived a failed scan would
pass on our incompetence rather than on its topology. A conformant deployment
is one where *knowing* the address does not help.

---

## 2. What each probe cannot prove

**P-01.** A `blocked` says this vantage has no route. It does not say no route
exists — a second interface, a DNS name resolving elsewhere, a host-network
sibling. H-4 §6 is explicit that topology probes plus reconciliation make P1
*checkable* and that neither makes it *provable*. The evidence record carries
that sentence so a reader is not left to supply it.

**P-02.** The provisioning endpoint is on the public internet by design, so
reachability is not the question; what must fail is the *request*. §10 C-5: the
one-time token cannot say which tenant is calling, so an API key carrying
`component:provision` is required in addition, and a tenant credential must not
carry it.

**P-03.** The mode is recorded as context, never as the answer. A 0600 file in
a namespace the tenant shares as the same uid is 0600 *and* readable. The read
decides.

**P-04.** Covers all three of C-8's directories with distinct bytes per
directory — one blob would let a single leaf answer for three writes. Three
outcomes, not two: **witnessed** (a `filesystem-watch` leaf covers those exact
bytes), **unwitnessed** (attack succeeded), and **surface absent** (there is no
filesystem surface here at all — canvas, because the Modal volume is not
mountable into scruple-web). The third is `not-attempted`: nothing was gated
and nothing could leak. Scoring the absence of a surface as a pass would be
scoring a gap as a success.

**P-05.** Requires a leaf from a **non-filesystem** surface. A leaf is keyed by
content hash, so two artifacts with identical bytes share one — and a leaf the
watcher produced for a *file* does not witness a WebSocket delivery of the same
bytes, which never became a file. Accepting it would report a gated WS path
where there is none. (Found the hard way: the stub emits the same 1×1 PNG down
both paths, and the first version of this probe passed on a collision.)

**P-06.** §7 probe 6 was written when §4.2 required strict increase. **C-3
replaced that with a bounded acceptance window**, so "submit at or below the
last counter" would now fail a conformant server for doing the right thing — an
unseen counter below the high-water mark is the queue draining, and refusing it
destroys the evidence the queue exists to preserve. What survives is replay
defence: three forged submissions (inside the window, far below, far above),
all of which must be refused. A tenant without the chain key cannot produce a
valid MAC at all, so this probe measures **the server**, not the tenant.

**P-07.** Two channels, because a policy that blocks TCP and leaves the
resolver open still leaks a hash per query. And it **requires a negative
control**: an endpoint outside the workload's policy that this position is
expected to reach. Without one, "nothing got out" cannot be told apart from an
air-gapped runner, and the probe returns inconclusive rather than a pass it did
not earn. NXDOMAIN counts as an open channel — the query left and something
answered.

---

## 3. The self-grade

Two sources of truth, and the split is the design.

**Derived** — P1 and P3 come from `assuranceForHost()` in
`lib/capture/surface.ts`, which is already a total function of (placement,
enforcement, attestation). The harness does not re-decide it.

**Declared and checked** — everything the placement axes cannot see: whether a
baseline covers the capture path, where the credential physically lives,
whether a leaf is created at all, whether prior rows are mutated. Every one
carries a `cite`, because a grade whose inputs are unsourced booleans is a
survey.

### DEFECT-2, and the hole that is left

WO-5's DEFECT-2 is open: nothing in the hook/surface/placement model can say
that a set of surfaces *covers* every egress path of a host. A profile naming
only `filesystem-watch` is a well-formed sentence about coverage that carries
no coverage claim.

So **P2 is never satisfied by a declaration.** It requires all three of:

1. a baseline covering **every** file the integrator names on the capture path
   — nothing declared, everything compared;
2. an admissible run in which the coverage probes (4, 5, 7) were attempted from
   an occupied tenant position and blocked;
3. ratchet gap accounting — without it, a run that captured nothing and a run
   that captured everything produce the same report.

**The residual hole, named rather than papered over.** A coverage probe can
come back `not-attempted` because the surface it probes does not exist in this
integration. The grader accepts that **only** when the integrator declares the
absence in `surfaceAbsences` with a citation, and it says so in the P2 reason.
A vendor who falsely declares "no filesystem surface" gets a P2 pass they did
not earn. Closing that needs a coverage axis — which is DEFECT-2 itself.

### Anchors match code, not prose

Written by a bug. The first cut anchored Kohya's P3 on
`/SCRUPLE_APPS_WITNESS_SECRET/` and matched on
`/SCRUPLE_WITNESS_SECRET:\s*witnessSecret/`. A concurrent WO replaced the
global secret with a per-session token — and the old identifier survived **in a
comment explaining what had been removed**. The anchor still matched, the
pattern did not, and the grader reported P3 as *improved*.

It had not improved. A per-session token narrows blast radius from all-users to
one-user and does not move the credential out of a shell the witnessed party
controls. P3 is about custody, not scope.

Two rules, both enforced in `studio.ts`:

1. **Strip comments before matching.** A grader that reads documentation as
   evidence can be defeated by deleting a line and explaining why.
2. **Anchor on the property, not the identifier.** "a credential-shaped value
   is injected into the pod environment" survives a rename;
   "`SCRUPLE_WITNESS_SECRET` appears" does not.

And every anchor **throws** when its anchor is missing. A derivation that
silently returns the benign value is how a harness grades a broken integration
clean.

### The capture-path file list is an input, not a constant

It moves. The canvas retrofit replaced `scripts/canvas-ws-proxy.mjs` with
`lib/canvas/ws-capture.ts` and pulled the shared secret into
`lib/canvas/gate.ts`. Re-declaring the list when the code moves is exactly what
P2 asks an integrator to do; a derivation pinned to a stale list throws.

---

## 4. The submission

`cncf/k8s-conformance`'s four files, adapted. What changed, and why each change
earns itself:

| K8s | here | why |
|---|---|---|
| `PRODUCT.yaml` | `INTEGRATION.yaml` | same eight fields by name, plus placement / enforcement / attestation / standard version — the inputs to `assuranceForHost`, so the metadata and the grade cannot disagree |
| `junit_01.xml` | `probes.json` | JUnit has no room for "the attack succeeded" as distinct from "the test errored", and that is the whole semantics here |
| `e2e.log` | `probes.log` | same job, same closing summary line |
| — | `GRADE.md` | the file K8s needs no analogue for, because every K8s claim is functional and P1/P3 are not |
| — | `MANIFEST.json`, signed | K8s's trust anchor is a PR from an identified member and evidence anyone can re-run; ours is a report about a boundary nobody outside the vendor can see, so the least it can do is be attributable |

The signature is Ed25519 over the canonical manifest — C-1's rules (UTF-8 JSON,
keys by Unicode code point, compact, **floats refused**) applied recursively,
held byte-identical to `lib/ratchet/ratchet.ts#canonicalPreimage` on flat
objects by a test. It is **not a security claim about the deployment**: it is
attribution plus integrity, which is what §5.3 says the industry does for the
parts it cannot verify.

`verifyBundle()` is the bot's half — required files present, no strays, hashes
match, signature verifies, run admissible. The human half (is this a real
counterparty, is the Integration Agreement signed) is deliberately absent, for
the reason `reviewing.md` keeps it out of Prow.

**READMEs carry no links.** The K8s FAQ bans them because link rot defeats
reproducibility, and reproducibility is the enforcement mechanism for
everything P1 and P3 cannot prove in advance.

---

## 5. What is unimplementable as §7 is written

- **§7 probe 6 is stale.** It predates C-3's acceptance window and would now
  fail a conformant server. Implemented as replay defence instead; §7 should be
  amended to say so.
- **§7 says "each must fail" and stops.** It does not say what a probe that
  *could not run* means. Silence there is how a skip becomes a pass; the
  three-valued outcome and the inadmissibility rule are this suite's answer and
  belong in the spec.
- **§7 assumes the probe can occupy the tenant's position.** For probes 1, 2, 3
  and 7 that assumption is the entire content of the result, and nothing in the
  spec requires a run to record which position it had. `INTEGRATION.yaml`
  carries `probe_vantage` for that reason.
- **§7 probe 7 needs a negative control** and does not mention one. Without it
  the probe reports every air-gapped CI runner as a conformant egress policy.
- **§2 obligation 3 (as amended by C-8) has no configuration to express it.**
  `CaptureConfig.outputVolume` is one directory.
