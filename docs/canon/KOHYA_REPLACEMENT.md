# Kohya, re-placed — and whether RunPod can hold it

_2026-08-30. WO-11b and WO-12 of `WO-SERIES-CANON-AS-FLOOR.md`._
**Binds:** `H4-DUKPT-CAPTURE-COMPONENT.md` (the component and its obligations),
`PLACEMENT_AND_SURFACES.md` §7.2 (the target row), `STUDIO_P1-P8_GRADE.md`
Path B (the diagnosis).
**Code:** `services/scruple-capture/kohya/`, `test/v2/kohya-replacement.test.ts`.

---

## 0. The short version

A `sidecar-gate` Kohya is buildable and is built. **It cannot be deployed on a
RunPod Pod**, and the reason is not RunPod's fault and not fixable by us: the
obligation that fails is H-4 §2 obligation 2 — a component in a namespace the
tenant cannot reach — and a RunPod Pod is one container.

The deeper finding is that obligation 2 is not really failing because of RunPod.
It is failing because **the thing we are hosting hands the tenant a shell.**
Kohya's GUI is a training-command launcher; its entire function is to take a
form and run a process. Pods run under *our* RunPod API key, so RunPod gives the
customer no console, no SSH, no exec — every bit of code execution the tenant
has inside that container was granted by the application we chose to put there.

That reframes the founder question. It is not *"can capture live outside a
user-controlled pod?"* It is *"does the pod have to be user-controlled at all?"*
— and the answer is no, at a cost, which §4 prices.

**Recommendation: (b), reached by removing the tenant's code execution rather
than by adding a sidecar** — which lands on `server-library`, not
`sidecar-gate`, and is a stronger tier than the WO asked for. Ship (a)'s
sentence in the standard meanwhile, and do not ship (c).

---

## 1. What re-placement means when the artifact is a file

`PLACEMENT_AND_SURFACES.md` §7.2 gives the target as hooks `model.write` +
`artifact.produced`, surfaces `filesystem-watch` + `network-gate`, placement
`sidecar-gate`. Read quickly that is the ComfyUI component with a different
`host` string. It is not, and the difference decides what the design can
promise.

**ComfyUI's artifacts are retrieved through a surface the gate owns.** That is
what lets `services/scruple-capture/src/submitter.ts` block: the gate awaits
`emit()` before forwarding a byte, so no artifact reaches the tenant that no
leaf covers. Fail-closed is available there.

**A Kohya checkpoint is a file.** It is written to a volume the tenant's own
process owns, and every ordinary way of collecting it — the pod's file browser,
JupyterLab, `scp`, remounting a network volume — reads bytes off disk without
crossing anything we could place in front of. *There is no point at which bytes
can be withheld pending a leaf.*

So of the component's three duties:

| Duty | Kohya | What it covers | What a ComfyUI-shaped reading wrongly assumes |
|---|---|---|---|
| **gate** | **applies in part** | the training request on the way **in** — dataset config, base model, hyperparameters — committed as the run inputs the leaf carries | the checkpoint on the way **out**. It does not come out that way, and fail-closed — the whole value of the ComfyUI gate — is not available |
| **watch** | **applies, and is load-bearing** | every safetensors write that completes in the checkpoint volume, hashed on close, with the header hashed separately as a structural fingerprint | that it is the *complement* to the gate. For ComfyUI the watcher covers what the gate cannot; for Kohya the watcher **is** the capture |
| **submit** | **applies unchanged** | ratchet, counter in the clear, durable queue, drain, gap and silence accounting | that it is plumbing. On a host with no fail-closed point it carries the most weight: a tenant who removes the capture stops the counter, and **a stopped counter is visible** |

That last row is the one worth dwelling on. Losing fail-closed sounds like
losing everything, and it is not. What replaces "you cannot get the bytes
without a leaf" is "you cannot get the bytes *and* leave the record looking
undisturbed" — H-4 §4.2's gap and silence accounting, obtained free from the key
schedule. It is a weaker guarantee, stated honestly, and it is the guarantee
payments actually ships: a terminal protects what flows through it, and a
merchant who stops using the terminal shows up as a merchant who stopped
transacting.

### What was built

`services/scruple-capture/kohya/`, reusing the component's `Identity`,
`QueueStore`, `Submitter`, and the OS-level `CloseWriteSource` unchanged:

- **`profile.ts`** — the duties above as data, the four §2 obligations as a
  `KohyaTopology` a vendor declares, and `resolveKohyaPlacement()`, which runs
  `resolvePlacement()` over them. Assurance is taken from obligations **1 and 2
  only**: obligations 3 (all artifact volumes watched) and 4 (egress denied) are
  *coverage*, and `PLACEMENT_AND_SURFACES.md` §2.2 is explicit that coverage
  gaps produce **no leaf for events that happened** rather than a weaker leaf,
  so they must not move the tier. They are reported separately as caveats on
  what the deployment may claim.
- **`checkpoint-watch.ts`** — `filesystem-watch` / `model.write` /
  `model_write`, hashing on close, and preserving `header_hash`: the safetensors
  header — every layer name, shape and dtype — hashed separately from the
  content, so a metadata-only edit and a structural change are distinguishable.
  The in-pod hook already computed this, and losing it in the move would have
  made the re-placement a *net evidence regression*, which is the mistake
  `STUDIO_P1-P8_GRADE.md` records `/v2/witness` making against the legacy canvas
  leaf. Settle window is 15 s, not the ComfyUI 250 ms: §10 C-10's partial-hash
  failure mode is far more likely on a multi-gigabyte file written by a process
  that is also saturating a GPU, and on a checkpoint the resulting two-hashes
  record is **indistinguishable from the tamper case it is not**. That is a
  mitigation, not a fix; the fix is real `IN_CLOSE_WRITE`, which
  `CloseWriteSource` exists to accept.
- **`index.ts`** — the runner, whose most important behaviour is that **it
  refuses to start** when the placement does not survive its enforcement, and
  refuses *before* `Identity.open()`, so a refused deployment never burns a
  provisioning token and never seals an IK somewhere the tenant can read it
  (§7 probe 3).

No leaf can be produced by any of it at `unattested-client`, and nothing added
here can report a checkpoint as witnessed: `/api/apps/kohya/witness` still
answers `witnessed: false` unconditionally and `test/v2/kohya-honesty.test.ts`
still passes.

---

## 2. What re-placement does *not* fix, and it is Kohya-specific

H-4 §2 obligation 1 says the workload binds loopback and the component is the
only route to it. On ComfyUI that buys a lot. **On Kohya it buys ingress
attribution and no containment**, because the thing behind the gate is a program
whose purpose is to run commands the user typed into a form.

§10 C-9 found this for ComfyUI as an *extension* problem — `comfy_api_nodes/`
opening `aiohttp` sessions from inside the process, custom nodes POSTing
anywhere. For Kohya it is not an extension. It is the product. A gate in front
of Kohya's GUI is a gate in front of a remote shell, and obligation 4 (egress
denied) stops being hardening and becomes the thing obligation 1 leans on.

This is why `profile.ts` makes the vendor declare all four and why the code
prints the coverage caveats even when the tier is fine.

---

## 3. Can RunPod hold it? Obligation by obligation

Facts about the deployment as it exists (`lib/apps/backends/runpod-session.ts`,
`lib/apps/runpod-machines.ts`): pods are created through RunPod's REST API with
**our** `RUNPOD_API_KEY`, from a template naming **one** container image, with
`ports: ['7860/http']`, reached by the customer at
`https://<podId>-7860.proxy.runpod.net`.

| Obligation | On a RunPod Pod | Verdict |
|---|---|---|
| **1** — workload reachable only through the component | We choose the `ports` array, so we can expose the component's port and not the trainer's. At the network layer this is satisfiable. But the exposed app is a command launcher (§2), so it is satisfiable and worth much less than it looks. | **satisfiable, hollow** |
| **2** — component in a namespace with no tenant exec, debug or filesystem access | **A Pod is one container from one image.** RunPod templates have no sidecar, no second container, no separate namespace. A component in that container shares a PID namespace and a filesystem with a process the tenant can make run arbitrary commands: they can kill it, `ptrace` it, or read its sealed `IK` off disk (§7 probe 3). | **FAILS, structurally** |
| **3** — every artifact volume mounted and watched | Satisfiable in-container; not satisfiable *across* containers, because there is no second container. RunPod network volumes attach to a pod, and we have no demonstrated configuration mounting one read-write into two pods with asymmetric access. **Confirm before relying on it.** | **fails as a consequence of 2** |
| **4** — workload egress denied except through the component | RunPod Pods have unrestricted outbound internet and no per-pod network policy we can set through the API this backend uses. A training process can `curl` a checkpoint anywhere. | **FAILS** |

**Verdict: a fully-conformant `sidecar-gate` Kohya is not achievable on RunPod
Pods as RunPod offers them.** `resolveKohyaPlacement(RUNPOD_POD_TOPOLOGY)`
returns `unattested-client`, `mayIssueLeaf: false`, and `KohyaCapture.start()`
refuses. That is asserted in `test/v2/kohya-replacement.test.ts`, so the finding
is a property of the code rather than a claim in a document.

### The part that is easy to get wrong

It would be natural to write this up as "RunPod cannot host witnessed training."
That is not what the evidence says, and the difference is the whole of §4.

RunPod is not what gives the tenant root. **We are.** RunPod hands the customer
nothing — no console, no SSH — because the pod is ours. Every bit of code
execution inside that container was granted by Kohya's GUI, which we chose to
put there and expose. A single RunPod container running an image where the
tenant has *no* code execution is not `sidecar-gate` at all; it is
`server-library`, where P1 is free (`PLACEMENT_AND_SURFACES.md` §5.2).

---

## 4. The founder question, priced

> Is training on a user-controlled pod a shape Scruple supports at all?

Three answers are live. Today we do a fourth thing — ship it and call it
witnessed — and WO-11a has already stopped that, so the fourth is off the table
whatever else is decided.

### (a) Not supportable, and the standard says so

*Cost:* one paragraph in the Standard and a row in the vendor matrix. Zero
engineering. It costs us the Kohya feature as a witnessed product and keeps it
as a recorded one.

*What it buys:* the standard refuses in the one place refusing is most
persuasive — against our own product. `PLACEMENT_AND_SURFACES.md` §4.1 exists to
make refusal expressible, and a standard that has never refused anything is a
brochure.

*What it costs strategically:* customer-controlled compute is most of the market
in `STUDIO_P1-P8_GRADE.md`'s own words. A blanket "no" also refuses the vendors
we most want, and it over-refuses: §3 shows the constraint is tenant code
execution, not customer-controlled hardware.

### (b) Supportable only via capture outside the pod

Two sub-shapes, and they are not the same price.

**(b1) A true sidecar — two containers, shared volume, egress policy.** Not
available on RunPod Pods. Requires a different substrate: RunPod Serverless with
our own image, a Kubernetes-shaped host, or our own metal. *Cost:* a substrate
migration, a network policy story, and a shared-volume story — weeks, and it
leaves RunPod Pods behind entirely.

**(b2) Remove the tenant's code execution instead.** Keep one container. Replace
the Kohya GUI as the tenant-facing surface with a **job-submission API**: the
tenant supplies a dataset and hyperparameters, never a command. The component
runs as PID 1, the trainer is its child, and the tenant has no shell — because
nothing exposed grants one. Placement becomes `server-library` with enforcement
`no-tenant-code`: **P1 holds, P3 holds, leaf `passthrough`.**

*Cost, and it is real:* the job API must be a whitelist, not a passthrough.
kohya_ss's config surface includes `--network_module` (an import path — code
execution), arbitrary dataset paths, and `--sample_prompts` shelling out. Every
one of those has to be enumerated and constrained, and a single "advanced: paste
your own args" box silently converts the configuration back to
`unattested-client` — exactly the trap `PLACEMENT_AND_SURFACES.md` §7.3 records
for a vendor's custom-handler path. It also costs the feature its selling point
for the users who wanted Kohya *because* it is Kohya.

*What it buys:* the strongest tier available anywhere in the estate, on the
substrate we already run, with no sidecar and no migration. And it generalises:
it is the same sentence we will need to say to every vendor with a managed path
and a BYO-container path.

### (c) A declared lower tier, visibly not the full claim

*Cost:* new vocabulary in the receipt, a tier below `passthrough`, and a
publication surface that explains it.

*Why I recommend against it:* the model already has a place for this and it is
not a tier. §4.1: events at `unattested-client` may be **recorded as declared**
and may never be reported as witnessed. That is what `/api/apps/kohya/witness`
now does — `witnessed: false`, `placement: 'unattested-client'`, with a reason.
Turning "recorded" into a *tier* is the move that makes tiers stop meaning
anything, because the tier below the floor is indistinguishable from a claim to
a reader skimming a receipt. §2.2 makes the same argument about coverage: a
missing leaf must not be modelled as a weaker one, precisely because a weak leaf
is visible and a missing one is not.

### Recommendation

**(b2), with (a)'s sentence written into the Standard in the meantime.**

Concretely: the Standard says that a configuration in which the measured party
can execute code alongside the workload is `unattested-client` and may not be
reported as witnessed — which refuses today's Kohya without over-refusing
customer-controlled hardware. Then close it by removing the tenant's code
execution rather than by chasing a sidecar RunPod cannot host. Keep the
`sidecar-gate` implementation as built: it is what a *vendor* with real
container isolation will deploy, it is what the probes test, and it costs
nothing to keep because it refuses on its own where it does not fit.

Do not ship (c).

---

## 5. WO-12 — the global secret, site by site

`SCRUPLE_APPS_WITNESS_SECRET` was one HMAC key, injected into every RunPod pod
as an environment variable. Any customer running `env` in their own pod held the
credential authenticating every other customer's witness traffic
(`docs/canon/studio-l2/04-PLAN.md:441`: "any pod can witness as any user").

**Retired, not rotated.** Every site and its disposition:

| Site | Disposition |
|---|---|
| `lib/apps/backends/runpod-session.ts:155` — read it and wrote it into the pod env | **DELETED.** Replaced by `podEnvFor()`, which injects `SCRUPLE_SESSION_TOKEN` (this session's own token, which the tenant's browser already holds), plus `SCRUPLE_PLACEMENT=unattested-client` and `SCRUPLE_CAN_WITNESS=0` as labels. `test/v2/kohya-replacement.test.ts` fails if the read returns. |
| `app/api/apps/kohya/witness/route.ts:34` — HMAC verification key | **DEMOTED TO THE ENUMERATED REMAINDER.** The primary key is now the session's `signed_token`. The global key is still tried second, and a declaration accepted on it is logged at error level and carries `credential: "global-deprecated"` in the response. **Removal condition:** delete the branch when `test/v2/kohya-honesty.test.ts` — WO-11a's drift guard, which signs its fixtures with the global key and is outside WO-12's scope to edit — is re-pointed at the session credential. |
| `public/pod-hooks/kohya_safetensors_hook.py` and `research/scruple-kohya-image/scruple_safetensors_hook.py` — signed with it | **REPLACED** by `SCRUPLE_SESSION_TOKEN`. The hook now refuses to POST unsigned rather than sending a signature-less body, and prints its placement at install. Both copies stay byte-identical. |
| `lib/apps/session.ts` — minted `signed_token` as `HMAC(AUTH_SECRET, id\|user\|app\|expiry)` truncated to 128 bits | **REPLACED** by 256 bits of CSPRNG. Nothing ever recomputed the derivation, so it bought nothing and cost something: every session token was a deterministic function of one global secret over values an attacker mostly knows. |
| `research/scruple-kohya-image/README.md`, `Dockerfile`, `start.sh` | **UPDATED** — the variable is documented as retired, with instructions to unset it. |
| `.env.local:65` | **STILL SET, and it is now inert in code terms** — nothing distributes it. Unsetting it is an operator action and it is the last step of the retirement. Left untouched deliberately; this is a shared dev host. |
| `docs/**` (12 files) | Prose references to the finding. Left as history. |

### What the session token is, and what it is not

It is **not** a fix for P3, and is not offered as one. P3 is about custody, not
scope; a key in a shell the measured party controls is not custody however
narrow it is. What changes is that a path whose ceiling is `witnessed: false`
can no longer be used to forge *another tenant's* records. The tenancy boundary
`04-PLAN.md` said did not exist now exists, and
`test/v2/kohya-replacement.test.ts` asserts a request signed with another
session's token is refused.

One incidental fix came with it: authentication now needs to know *which*
session is claiming before it can pick a key, so parsing and lookup happen
first, and every failure below the parse answers **401** — no longer
distinguishing "no such session" (was 404) from "bad signature", which had been
handing an unauthenticated caller a session-enumeration oracle.

---

## 6. Does H-4 close?

**No — and only one of the reasons is ours.**

H-4 §8 step 6 is "retire `SCRUPLE_APPS_WITNESS_SECRET`. Not rotate — retire."
The distribution site is gone, the pod no longer holds it, the hook no longer
signs with it, and the remaining read is enumerated above with a one-file
removal condition. **The custody hole H-4 §4.5 named is closed on this path.**

What keeps H-4 open:

1. **§8 step 1 is unstarted.** "Restore `input_hash`, `workflow_hash`,
   `model_fingerprints_hash` to `/v2/witness`. Nothing below matters until the
   leaf carries them." Kohya's leaf would carry a training-config commitment
   through the same fields. Not WO-11b's to do, and it gates the value of
   everything WO-11b built.
2. **§8 step 5 — "Kohya second" — is complete as far as it can be.** The
   component exists and refuses where it cannot hold. It is not *deployed*,
   because §3 says there is nowhere on RunPod to deploy it, and that is the
   founder decision in §4 rather than an engineering remainder.
3. **§10 C-4's published-builds registry still does not exist**, so
   `build_measurement` is drift detection and not provenance — unchanged by this
   WO and unchanged for ComfyUI.
4. **The last read of the global secret** (§5, row 2) is one branch and one
   fixture away from deletion.

H-4 closes when (1) lands, (4) is deleted, and §4's founder question is
answered — because until it is, "Kohya second" has no destination.
