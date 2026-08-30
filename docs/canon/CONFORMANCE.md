# Conformance — the seven probes, the self-grade, and the submission

_2026-08-30. WO-9, extended by WO-14. Implementation:
`packages/scruple-conformance/`, `services/scruple-capture/probes/`,
`scripts/probe-harness/`, `test/v2/conformance.test.ts`._

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
   **WO-14 moved where they run.** See §1.1.
2. ~~**§10 C-8's three directories are satisfiable today only by accident.**~~
   **Closed by WO-14.** `CaptureConfig.watchedVolumes` declares the three roots
   with their types, one watcher per root, and the type reaches the leaf. See
   §1.2.
3. **P2 cannot be satisfied by a declaration, and one hole remains that it
   can.** See "DEFECT-2, and the hole that is left" below.

WO-14 added a fourth, and it is the one worth reading twice:

4. **Every probe that had never run from the tenant position was wrong about
   something, and the first clean run was the least trustworthy artifact in the
   exercise.** Four defects came out of the first genuine run — probe 6 never
   reaching a ratchet, a probe run of one deployment satisfying another's P2, a
   derived P7 reason stating a fact it had not checked, and probe 6's downward
   counter case degenerating on a young component. None was visible from
   reading the code. Three were visible only because a **green** run got read
   line by line instead of being taken at its summary.

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
./scripts/probe-harness/run.sh                 # namespaces, when there is no Docker (§1.1)
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

## 1.1 Occupying the tenant position without Docker

There is no Docker on this host. `scripts/probe-harness/` builds the tenant
position out of `unshare(2)` instead:

```
unshare --user --map-root-user --net --mount --fork   # the deployment
  └── unshare --net --mount --pid --fork              # the tenant
      joined by two veth pairs; no default route, no resolver
```

`run.sh` runs the seven; `run.sh --audit` runs them nine times, once per
deliberately broken topology. Results land under
`$TMPDIR/scruple-probe-harness/<stamp>/<profile>/` — `probes.json` (results plus
the namespace inodes the run occupied), `probes.log` (the Sonobuoy-shaped human
half), `deployment.json`, `gaps.json`. Set `HARNESS_OUT` to put them somewhere a
submission bundle can pick them up; **not** under `artifacts/`, which is the
app's content-addressed store.

**What this genuinely answers, and it is most of the point of WO-14:**

| probe | answered? | by what |
|---|---|---|
| P-01 | **yes** | the upstream binds the deployment namespace's loopback; the tenant's loopback is a different loopback, and the deployment's routable address does not carry that port |
| P-02 | **yes** | the gate's listener and the provisioning endpoint are both reached over a real socket from the tenant's namespace |
| P-03 | **partly** — see below | the state directory is absent from the tenant's mount namespace, and absent from `/proc/<pid>/root` because the tenant has its own PID namespace |
| P-04, P-05, P-06 | **yes** (they always could be) | behavioural; the deployment is real either way |
| P-07 | **yes** | the tenant's routing table has no default route, and the negative control sits on a *second* veth subnet so a reachable control proves routing works somewhere other than the one link the tenant obviously has |

**What it does not answer, stated so that nobody reads a namespace as a
container.**

- **It is not a container.** No image, no cgroup, no seccomp or LSM profile.
  A conformance claim about a vendor's *container* runtime is not what this
  produces; it is a claim about network and mount topology, which is the part
  probes 1, 2, 3 and 7 actually ask about.
- **P-03 is answered for one of §4.4 step 4's two postures and not the other.**
  A user namespace maps the invoking uid to root, so a 0600 file owned by that
  uid is readable inside it by construction. This harness therefore answers
  *"the state directory is not in the tenant's mount namespace"* — and cannot
  answer *"the state directory is shared, 0600, owned by a principal the tenant
  is not"*. That second posture needs two real uids, which needs a real
  container runtime or a second unprivileged account. **The two are different
  configurations and certification is per configuration (§7)**, so the run
  records which one it occupied rather than generalising.
- **The tenant runs as the same uid that owns the component's files on disk.**
  Everything the mount namespace hides is hidden by the mount namespace alone.
- **A shared PID namespace defeats the mount boundary outright, and the audit
  proves it.** `/proc/<pid>/root` resolves in the *component's* mount namespace.
  Under the `p3-shared-pid` profile the tenant reads `identity.json` — chain key
  included — through `/proc`, with the tenant's own view of that path still
  empty. P-03 now attempts that route when the operator declares
  `componentPid`, because a boundary nobody tested is not a boundary anybody
  demonstrated.

**Recording the position, mechanically.** §10 C-11 asks a run to record which
position it occupied. `probes.json` carries the namespace *inodes* of both
sides (`/proc/self/ns/*`), read on the tenant side and on the deployment side,
plus `network_namespace_differs` / `mount_namespace_differs`. Two inode numbers
a reader can compare is a fact; "we ran it in a container, honest" is not.

**What the remaining inconclusives would need.** Nothing in the WO-14 run is
inconclusive. The two configurations this harness cannot reach need:

- the **shared-mount 0600** posture — a second uid, i.e. a container runtime
  (Docker/Podman/containerd) or a dedicated unprivileged account;
- **canvas's** tenant position — a browser against scruple-web plus a Modal-
  hosted ComfyUI. No namespace on this host can construct it, because the
  workload is not on this host. See "Canvas's P2, on evidence" below.

## 1.2 §10 C-8, in configuration rather than by accident

`CaptureConfig.watchedVolumes` is a list of `{ type, path }`; `output`, `temp`
and `input` are declared separately, each gets its own watcher, and nested roots
are **refused** (`resolveWatchedVolumes`) because a write under two roots has
two volume types and the question C-8 exists to answer stops having one answer.
`loadConfig` fails closed on a partial declaration: set one of
`SCRUPLE_CAPTURE_VOLUME_{OUTPUT,TEMP,INPUT}` and all three are required.

**The type reaches the leaf through `capture.egress`**, as
`file:<type>:<path within that root>` — the same `<scheme>:<qualifier>:<value>`
shape `ws-gate.ts` already uses (`ws:binary:4`). It goes there and not into a
new field because every member of `capture` is inside the MAC preimage
(`leaf.ts#preimageOf`), computed identically by the component and the ingest;
adding a member is a preimage change that invalidates every provisioned
component in the field. So the volume type is **authenticated, not annotated**,
and it cost no migration.

The pre-C-8 singular `outputVolume` is still accepted, because two callers this
change does not own construct a config with it, and it produces one root of type
`unspecified`. `topologyAdvisory` says so at startup and P-04 reports it as an
**unrecorded** type rather than a wrong one — an absent declaration and a false
one are different findings, which is the distinction `mime.ts` already refuses
to blur.

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

### A fourth conjunct, added by watching the third one be borrowed (WO-14)

The harness produced a real, admissible, seven-of-seven run from an occupied
tenant position — against the **`scruple-capture` ComfyUI deployment**. Attached
to **canvas's** grade it carried canvas straight past P2's coverage conjunct.

Every fact in that run was true. The conclusion was false. `GradeInput.probes`
was "a `ProbeRun`", with nothing tying a run to the deployment it ran against,
so **a run with no subject is a run anybody can borrow** — the same shape the
leaf oracle's `surfaces` already closes one level down ("some leaf covers these
bytes" is not "the path the tenant used produced a leaf").

So `DeploymentUnderTest.integration` names the subject, `runProbes` copies it
onto `ProbeRun.subject`, and `gradePath` fails P2 when the attached run is of
another deployment. Certification is per configuration (§7); a run is evidence
about the configuration it occupied and about no other.

This is also why the harness's own clean run was the least trustworthy artifact
in WO-14. It was read anyway, and that is where two of the three defects came
from.

### Canvas's P2, on evidence rather than on paperwork

**FAIL, and now for the right reasons.** The published grade's P2 FAIL was
originally "no baseline covers the capture path". The canvas retrofit landed
`lib/canvas/baseline.ts`, which covers it — so the paperwork half is now
*satisfied*, and P2 still fails on three independent counts:

1. **No probe run has ever occupied canvas's tenant position, and this harness
   cannot construct one.** Canvas's tenant is a browser against scruple-web,
   with ComfyUI on a Modal-hosted machine. The workload is not on this host, so
   no namespace on this host is that position. What it needs is a probe run
   from inside the Modal container plus a browser-side run against the proxy —
   real infrastructure, not more code.
2. **P-04 is satisfied only by a declared absence.** Canvas has no filesystem
   surface, which is true, and the grader accepts it because the integrator
   said so with a citation. That is the DEFECT-2 hole above, load-bearing here.
3. **Ratchet gap accounting is structurally unavailable.** `lib/canvas/
   witness.ts` says it outright: *"Canvas has no ratchet."* There is no
   component, therefore no counter chain, therefore no gaps to account for —
   so P2's third conjunct cannot be satisfied by canvas **at any level of
   effort**, as the grader is written. Canvas either grows a ratcheted capture
   component, or P2 grows an alternative completeness test for componentless
   paths and says which one it applied. **That choice is not made here, and it
   should not be made by leaving it implicit.**

**P7 followed canvas's P2 into a false sentence, and that is fixed too.** P7's
"fails for free" branch printed *"no baseline manifest exists"* whenever P2
failed and no provider was declared — true while the only way to fail P2 was to
have no baseline, and false the moment P2 could fail for other reasons. It now
splits on whether a baseline is actually present, and says so. A derived reason
has to be derived from the same inputs as the thing it derives from.

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
- ~~**§2 obligation 3 (as amended by C-8) has no configuration to express it.**~~
  **Closed by WO-14** — `CaptureConfig.watchedVolumes`, §1.2 above.

### Added by WO-14, from running the seven where they mean something

- **Probe 6 had never reached a ratchet.** Its forged submission was a
  plausible sketch, not a `Submission`: no `component.attestation`, no `kind`,
  a three-field `capture`. An ingest that canonicalises before it verifies
  refuses that at the JSON layer, and all three attempts came back
  `400 malformed_submission` — recorded as a clean PASS. **Three 400s from a
  field validator are indistinguishable from a deployment with no replay
  defence at all.** The forgery is now the full submission written out longhand
  (restated, not imported, for the reason probe 5 restates `server.py`'s frame
  header), the only wrong thing in it is the MAC, and a refusal that smells of
  the validator is recorded as **inconclusive** rather than banked.
- **Probe 6's downward case degenerates on a young component.** With a
  high-water mark below the window width, "far below the window" is a negative
  counter and is refused as `invalid_counter` — the integer check, not C-3's
  floor. The evidence record now carries `far_below_degenerate`. Exercising the
  floor properly needs a component whose high-water mark exceeds
  `ACCEPTANCE_WINDOW + MAX_RATCHET_ADVANCE`, which a probe must not manufacture
  by spending 250,000 of the vendor's counters.
- **§7 probe 3 asks about a file and the answer is not only about files.**
  `/proc/<pid>/root` resolves in the target's mount namespace, so a shared PID
  namespace hands over a state directory that the tenant's own mount namespace
  does not contain. The probe now attempts it when the operator declares
  `componentPid`. **§7 should say that P1's isolation requirement includes the
  PID namespace, because mount isolation without it is not isolation** — the
  `p3-shared-pid` audit profile recovers the chain key through `/proc` with the
  direct path still empty.
- **A conformance run needs to say what it is a run OF.** §7 assumes one
  deployment and therefore never says this. Without it a run satisfies any
  integration's P2, which it did. `ProbeRun.subject`, above.

---

## 6. The audit pass, and why the clean run did not close the WO

`scripts/probe-harness/run.sh --audit` runs nine topologies: the conformant one
and eight deliberate breaks, one per probe (P-03 gets two, because it has two
boundaries). It takes about twenty seconds.

| profile | what is broken | expected |
|---|---|---|
| `none` | nothing | 7 pass |
| `p1-second-route` | the upstream is also reachable on the shared link | P-01 fail |
| `p2-open-provisioning` | provisioning grants an identity to anyone | P-02 fail |
| `p3-state-mounted` | the state directory is in the tenant's mount namespace | P-03 fail |
| `p3-shared-pid` | the tenant shares the component's PID namespace | P-03 fail |
| `p4-singular-volume` | the pre-C-8 single untyped root | P-04 fail |
| `p5-passthrough-ws` | HTTP gated, WebSocket relayed by a sidecar | P-05 fail |
| `p6-permissive-ingest` | the ingest records what it cannot verify | P-06 fail |
| `p7-open-egress` | a route to the egress target | P-07 fail |

The observed result is a clean diagonal: **each break is caught by exactly the
probe it targets and by no other.** That is the property worth having — a probe
that fires on every break is not sensitive, it is noisy, and a suite of noisy
probes cannot localise a fault.

**The diagonal is what makes the green run mean something, and the green run on
its own meant almost nothing.** The `none` profile passed 7/7 on the first
attempt, and reading its evidence rather than its summary is what found probe 6
measuring our own malformed request. The rule the first WO series arrived at
holds here too: *every artifact that got used by something else was found to be
wrong.* The probes had never been used by anything.
