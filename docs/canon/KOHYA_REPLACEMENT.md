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

---

# Part II — Studio's Kohya, to L2

_2026-08-30. WO-19 of `WO-SERIES-2-PROVING-IT.md`._
**Implements §4's recommendation (b2).**
**Code:** `lib/apps/kohya/`, `services/scruple-capture/kohya/job-runner.ts`,
`services/scruple-capture/kohya/job-api-server.ts`,
`app/api/apps/kohya/jobs/route.ts`,
`research/scruple-kohya-image/Dockerfile.jobapi`,
`test/v2/kohya-jobapi.test.ts`.

## 7. The job API, and what it buys

§4 (b2) said: keep one container, replace the GUI as the tenant-facing surface
with a job-submission API, and the tenant's code execution goes away because
nothing exposed grants it. That is now built, and the tier moved with it.

| | Before (GUI) | After (job API) |
|---|---|---|
| Tenant surface | Gradio on 7860 — a command launcher | `POST /jobs` — data and hyperparameters |
| Declared placement | `sidecar-gate` | `server-library` |
| Enforcement | `none` | `no-tenant-code` |
| **Effective placement** | **`unattested-client`** | **`server-library`** |
| P1 | fails | **holds** — structurally, not conditionally |
| P3 | fails | **holds** |
| Leaf | **none may be issued** | `passthrough` |

Read the last row before celebrating the ones above it. `server-library` with
no attestation still produces a **`passthrough`** leaf —
`PLACEMENT_AND_SURFACES.md` §5.2's top-right cell. P1 being free does not buy
a `verified` attestation and nothing does except chaining to a vendor root,
which is implemented nowhere in the estate. This WO raises the placement two
tiers and does not raise the leaf at all. Saying so is the difference between
a grade and a brochure.

### 7.1 The thing that made it possible was already true

The finding is `§3`'s and it is worth restating because it is the whole
argument: **RunPod is not what hands the tenant root. We are.** Pods run under
our API key, so RunPod gives the customer no console, no SSH and no exec. Every
bit of code execution inside that container was granted by the application we
chose to put there.

And the grant is not subtle. `kohya_gui/lora_gui.py` builds an
`accelerate launch …` argv and runs it through `subprocess.Popen`; along the
way `common_gui.py::run_cmd_advanced_training` takes the GUI's
**`additional_parameters`** free-text box, splits it on whitespace and appends
every token to that argv. So the shipped image contains a UI field that
injects arbitrary training flags — including `--network_module`,
`--dataset_class` and `--optimizer_type`, all three of which are import paths
(§8). The "paste your own args" trap this WO warns about is not a thing a
future contributor might add. **It is in the product today**, and it is
recorded in code as `GUI_ARBITRARY_ARGUMENT_FIELD` so that removing the GUI
reads as closing a hole rather than as removing a feature.

### 7.2 Component as PID 1, trainer as child

`research/scruple-kohya-image/Dockerfile.jobapi` runs the component as the
container's init and the trainer as its child. The `exec` in `start-jobapi.sh`
is load-bearing.

If the trainer were PID 1 and the component a child, killing the component
would leave the container running with an unobserved trainer in it — a
checkpoint written to a volume nobody is watching, which is **no leaf for an
event that happened**, the failure `PLACEMENT_AND_SURFACES.md` §2.2 says must
never be modelled as a weaker leaf because a missing leaf is invisible and a
weak one is not.

With the component as PID 1 the same act ends the container. The tenant can
still stop being witnessed; they cannot stop being witnessed *and keep
training*. That is the same trade H-4 §4.2 makes with the counter in the clear,
and it is the guarantee payments actually ships.

### 7.3 `header_hash` survived the second move

The in-pod hook computed it, WO-11b carried it out of the pod, and this WO
moves the capture again. It is preserved by **reusing `CheckpointWatchSurface`
unchanged** rather than writing a second observer, and asserted on the new path
by `test/v2/kohya-jobapi.test.ts`. Losing it here would have made this WO a net
evidence regression — worse than doing nothing — which is the mistake
`STUDIO_P1-P8_GRADE.md` records `/v2/witness` making against the legacy canvas
leaf.

One thing is *added*: a **run commitment**. The checkpoint's `model.write` now
carries the canonical job — the hyperparameters that produced the weights —
rather than a filename. A training run's provenance is not an image's
provenance with different filenames, and this is the field that makes the
difference. The same canonical bytes go into `training_runs.config_json` and
are covered by `params_hash`, so the row and the leaf agree by construction
rather than by convention.

### 7.4 There are two job APIs and that is not duplication

`app/api/apps/kohya/jobs/route.ts` is Studio's product surface. The component's
own `POST /jobs` (`job-api-server.ts`) is what the proxy forwards to and what
the tenant can actually reach. The placement argument depends on the second
one: a whitelist enforced only in Next.js is a whitelist enforced only against
clients that chose to use it.

Both **import the same module**. A second parser, however carefully written,
would be a second parser to keep in step, and the two would come apart exactly
once, silently, at the worst moment.

---

## 8. The whitelist, which is the deliverable

`--network_module` is an import path. One free-form argument field silently
reverts Studio to `unattested-client`. So the accepted parameter set is not a
detail of the job API; it is the thing the tier is computed from.

### 8.1 How the argument surface was enumerated

From **kohya's own argument parser, walked as an AST** — not from memory and
not from what the GUI renders, because the GUI is a client of the parser and
shows a subset of it.

- Source: `kohya-ss/sd-scripts` @ `37a1cbbc5725ed2a3575506e7bd2001c9908ac92`.
- Cross-checked against `bmaltais/kohya_ss` @ `45088f04`, whose sd-scripts
  submodule pins `6721028c`. The two revisions differ by **exactly one flag**
  on this surface (`--show_timesteps_offset`, DiT-only), so the pin and
  upstream are interchangeable for classification.
- **`library/train_util.py` is now a 218-line re-export shim.** Every training
  `add_argument` moved to `library/args.py`. A table built from the old
  location would silently have been a table of nothing — worth recording,
  because "we read the parser" is only true if you read the one that runs.

The surface is `train_network.py::setup_parser()` and exactly the builders it
composes, plus `add_sdxl_training_arguments` for the SDXL entry point: **198
distinct flags.** Arguments belonging to other entry points (FLUX, SD3,
Lumina, Hunyuan, Anima, `train_db`, textual inversion) are off-surface and
unlisted; running one of those scripts is a different configuration and needs
its own pass.

### 8.2 The classification rule, applied mechanically

```
store_true / store_false          → safe-scalar
has choices=                      → safe-scalar
type is int / float / int_or_float → safe-scalar
ANYTHING ELSE (a free-form str)   → UNCLASSIFIED, therefore DENIED
```

**181 of 198 classified. The 17 that were not are denied by absence** — that
is the rule working, not a gap in it. They are enumerated in
`UNCLASSIFIED_SURFACE_FLAGS` precisely so they stay denied: adding one to the
classification table would be a decision, and the constant records that none
was made. The test suite asserts each is refused and that none has quietly
acquired an entry.

The seventeen: `--caption_extention` (a preserved upstream typo alias, and
which of the two wins was not traced), `--caption_prefix`, `--caption_suffix`,
`--caption_separator`, `--secondary_separator`, `--keep_tokens_separator`,
`--face_crop_aug_range`, and the eleven `--metadata_*` fields. None is needed
by Studio, so none was worth the review that classifying it would take.

The overrides are where the mechanical rule is wrong in either direction, and
each names the file and line that decides it. Four free-form strings are
promoted to safe after reading their sinks — `--resolution`,
`--caption_extension`, `--lr_scheduler`, `--training_comment`; the rest move a
flag the rule called safe into a denied class.

### 8.3 What was denied, and why

**Code — the value is imported and called.**

| Flag | Sink |
|---|---|
| `--network_module` | `train_network.py:1049-1051` — `importlib.import_module(args.network_module)`, then `create_network(...)`. And `sys.path` is appended with the script directory first, so a bare name resolves against a directory the dataset path can reach. |
| `--dataset_class` | `library/dataset.py:1544-1549` — imported *and instantiated*, with the dataset in hand. |
| `--optimizer_type` | `library/optimizer.py:333-344` — **a value containing a dot is an import path.** A second `--network_module` wearing a different name. |
| `--lr_scheduler_type` | `library/optimizer.py:513-519` — same pattern, and one keystroke from the inert `--lr_scheduler`. |
| `--torch_compile`, `--dynamo_backend` | the backend name is resolved by torch; `choices=`-constrained, but what accelerate does with `ipex`/`tvm`/`onnxrt` was not traced. **Denied as unresolved rather than assumed benign.** |

**Kwargs into code the same request chose.** `--network_args` splits on
`=` and forwards **raw strings** as `**kwargs` into whatever `--network_module`
imported — no `literal_eval`, arbitrary keyword names. `--optimizer_args` and
`--lr_scheduler_args` do use `ast.literal_eval` on the values, which is the
safe literal parser; the arbitrary **keys** are the problem, not the values.

**Config expansion — one field that reopens the whole surface.**
`--config_file` is `toml.load`ed, **flattened into one namespace**, and passed
as `parser.parse_args(namespace=...)`. It can set any attribute name
*including ones that are not declared arguments at all*, which then reach
`getattr(args, …)` call sites. Accepting it would make the whitelist
decorative. `--dataset_config` is the same shape over a larger path surface;
`--log_tracker_config` replaces the tracker's whole `init_kwargs`.

**`--sample_prompts` — and here the brief was wrong, which is worth the
paragraph.** The WO says it shells out. **At sd-scripts `37a1cbb`, it does
not.** `library/sampling.py` generates samples in-process with the training
script's own pipeline; the only `subprocess` calls anywhere in sd-scripts are
two `git rev-parse HEAD` invocations and one `uname -a`, none taking user
input. It is denied on two other grounds, both read out of the code:

1. It is a **directive file**. `line_to_prompt_dict` (`sampling.py:128-216`)
   re-parses each line on `" --"` with a hand-rolled matcher, so the file's
   contents become arguments *after the argument parser has finished*.
2. Three of those fragments — `cn`, `mk`, `i` — are **filesystem paths read at
   sample time**, so one accepted path yields an unbounded set of further
   reads. (The `ss` fragment also sets the sampler, and unlike `--sample_sampler`
   it is not `choices=`-constrained.)

The conclusion is the same and the reason is different, and the difference
matters: a whitelist justified by a sink that does not exist is a whitelist
that will be argued with by the first person who reads the code.

**Unpickle — bytes that reach `torch.load`.** This class was not in the brief
and is the sharpest thing the extraction turned up. `--network_weights`,
`--base_weights` and `--resume` all load tenant-named bytes through
`torch.load`; `library/model_util.py:980` passes `weights_only=False`
**explicitly**, and most `networks/*.py` call sites leave it unset, so the
behaviour depends on the installed torch version. A pickle is code.
`--pretrained_model_name_or_path` carries three hazards at once: an arbitrary
local path, a Hugging Face repo id (a download initiated from inside the
boundary), and that same guard-disabled `torch.load`.

**Paths.** The obvious ones (`--train_data_dir`, `--output_dir`,
`--logging_dir`, `--reg_data_dir`, `--in_json`, `--vae`) and three
non-obvious ones worth naming: **`--log_prefix`** is concatenated raw into a
path at `accelerator_setup.py:90`, so a `../` in it walks out of the log root;
**`--console_log_file`** opens its target for *truncation*; and
**`--metadata_thumbnail`** reads a named file and base64s it **into the
safetensors header** — an arbitrary read whose result is exfiltrated inside
the artifact we hash.

**Egress and credentials.** The whole `--huggingface_*` upload path
(uploading a checkpoint from inside the trainer is exactly the artifact path
the component exists to observe, routed around it), `--wandb_api_key`,
`--log_with`. Note `get_sanitized_config_or_none` scrubs `wandb_api_key` and
`huggingface_token` before the config is uploaded to a tracker — and nothing
else, so every local path in the run goes with it.

**Launcher.** DeepSpeed's nine flags, plus `--debug_dataset`, which turns the
run into an interactive `cv2.imshow` session that never trains. Not a
code-execution sink; refused because a job that does not train is not a job.

**Arguments I could not classify are listed in §8.2 and denied.** Two more,
off this surface, are recorded here so they are not rediscovered as new:
`--compile_backend` (Anima only, free-form `str`, **no `choices=`**, handed to
`torch.compile(backend=…)`; whether torch resolves an arbitrary dotted string
to an import depends on the installed version's `lookup_backend`, which was
not read) and `--show_timesteps` (DiT only; renders a plot and exits, and its
write path was not traced).

### 8.4 The accepted set

**44 parameters**, every one a closed domain: an enum, a bounded integer, a
bounded float, a boolean, or a pattern-matched slug. `ParameterKind` has no
`'string'` member — a free string is how this file fails, so the type does not
offer one. They emit 45 distinct flags out of the 181 classified — the
whitelist is a strict subset of what the table would allow, because
classification is not permission.

Seven dangerous flags are still emitted, and six of them take their value
**from us**:

| Flag | How the value is chosen |
|---|---|
| `--network_module` | `training_type` indexes `TRAINING_TYPE_NETWORK_MODULE`, a frozen map with **one** entry: `networks.lora`, which ships inside the pinned sd-scripts tree and was read. LyCORIS is a separate pip install with its own `--network_args` vocabulary and has not been read, so adding it is a code review with a pin of its own — a module you have not read is "an argument you cannot classify" one level up |
| `--optimizer_type` | `optimizer` indexes `OPTIMIZER_TYPE`; every value is asserted **dot-free** at module load, because a dot is what makes it an import |
| `--pretrained_model_name_or_path` | `base_model_id` indexes a closed catalog, which also selects the trainer **script** — there is no `--sdxl` argument, and a table built from what the GUI renders would have invented one |
| `--train_data_dir` | `dataset_id` is joined under a component-owned root and containment is re-checked after resolution |
| `--output_dir`, `--logging_dir` | the component's, per job id. These two are added by `buildTrainerArgv` directly rather than by a whitelist entry, so obligation 4 does not cover them — the pre-spawn assertion in `job-runner.ts` does, and it is the reason that assertion exists rather than being redundant with the static derivation. |

And exactly one tenant-valued dangerous flag: **`--output_name`**, a filename
stem with no upstream sanitization. A tenant who cannot name their own model is
being handed a worse product to buy a property they already have, so the
pattern is what pays for it — no separator, no leading dash (argv would read
that as a flag), no leading dot (that is how `..` starts) — and the **pattern
is asserted against a hostile corpus at module load**, so the exception is
granted to the regex rather than to the intention.

### 8.5 The tier is derived, not declared

This is the part worth arguing about, so here is the mechanism.

`deriveEnforcement()` returns `no-tenant-code` only when five obligations hold,
and **three of them are computed** from the whitelist and the classification
table:

1. no exposed surface grants code execution — *declared*
2. every accepted parameter has a closed domain — **derived**
3. every non-safe flag is component-valued, or tenant text under a vetted
   pattern — **derived**
4. every emitted flag appears in the classification table — **derived**
5. the component is PID 1 and the trainer is its child — *declared*

Add an "advanced: paste your own args" parameter and obligation 3 fails,
`resolvePlacement` degrades Studio to `unattested-client`, and the test suite
goes red. That is not a lint rule; it is the tier. `test/v2/kohya-jobapi.test.ts`
poisons the whitelist and asserts exactly that, and it is the load-bearing test
in the file — if it ever passes with `server-library`, the derivation has
become decoration.

The two *declared* obligations are properties of the image and the pod spec
that no code in this process can see. They are marked `basis: 'declaration'`,
reported in `needsProbe`, and returned in the API response, so an integrator
reading a receipt can tell which half of the tier is evidence and which half is
still a claim. H-4 §7 probes are what convert them. **Until those run, Studio's
`server-library` is three-fifths derived and two-fifths asserted, and the code
says which.**

### 8.6 The pin is part of the security argument

An argument added upstream after this table was written is unclassified and
therefore denied — which is only true while the ref is pinned.
`Dockerfile.jobapi` pins `SD_SCRIPTS_REF`, and **bumping it is a review of the
classification table, not a version bump.** If that stops being true, the
whitelist is a snapshot of a surface that moved and Studio's tier is a claim
about last quarter.

---

## 9. RunPod Serverless vs Pods, on evidence

Evaluated from RunPod's documentation and OpenAPI reference only. **No RunPod
resource was created, started or modified**, and no billable action was taken;
creating one is the founder's decision, not an engineer's.

### 9.1 It corrects §4 (b1)

§4 (b1) offered "a true sidecar — two containers, shared volume, egress
policy" and said it would need a different substrate, naming **RunPod
Serverless** as one. **That is wrong and the correction matters.**

A Serverless worker is also **one container**. `TemplateCreateInput` takes a
single required `imageName` with a single `dockerEntrypoint` and
`dockerStartCmd`; no page in the Serverless documentation mentions a sidecar,
a pod spec, a second image, or compose, and there is no multi-container field
in either `TemplateCreateInput` or `EndpointCreateInput`.

So the sidecar was never available anywhere on RunPod, on either product. **The
"remove the tenant's code execution" answer was not the cheaper of two options;
it was the only one**, and §8 is what makes it hold.

### 9.2 The two objections that would have ruled Serverless out both fail

**"The component cannot be PID 1."** It can. RunPod's canonical worker
Dockerfile ends in a plain `CMD ["python", "-u", "/handler.py"]` with no
`ENTRYPOINT` and no injected agent, and `runpod.serverless.start({"handler":…})`
is documented as **required of you** — an ordinary blocking library call inside
your own process. RunPod's own dual-mode-worker example goes further and makes
a `start.sh` supervisor the container entrypoint, starting nginx and sshd
*before* the handler. That is exactly our shape.

One trap worth carrying: that example contains `RUN rm ../start.sh` to delete a
default script inherited from a `runpod/*` base image — so an inherited
`ENTRYPOINT` is a thing that has bitten people, not a hypothetical.
`Dockerfile.jobapi` builds from `runpod/pytorch`, so it now clears
`ENTRYPOINT []` **and fails the build** if `/start.sh`,
`/docker-entrypoint.sh`, `/entrypoint.sh` or `/post_start.sh` survives from
the base. A build that fails is a deployment that never claims
`server-library`; a build that quietly runs somebody else's init is one that
claims it wrongly.

**"A training run cannot survive the timeout."** The 10-minute figure is a
**default, not a ceiling**. `executionTimeout` ranges 5 s → **7 days**, `ttl`
likewise, and RunPod's own worked example configures **48 hours** of active
runtime. Two semantics to respect: `ttl` starts at *submission*, not at
execution, and its expiry is a hard kill that makes status checks return 404
even for a job that would have completed.

**But only on queue-based endpoints.** Load-balancing endpoints have a **5.5
minute per-request processing timeout**. That is a hard wall, and a training
job cannot be built on them. `/runsync` is likewise not the mechanism — its
client wait caps at 300 s. Multi-hour training is `/run` plus `/status`
polling or a webhook.

### 9.3 The axis where Serverless is genuinely better, and it is the one this WO is about

| | RunPod Pods | RunPod Serverless (queue) |
|---|---|---|
| Interactive surface, by default | **Web terminal, setup "None"** — a browser root shell started from the console with zero image cooperation; SSH proxied by RunPod; template `ports` defaults to `8888/http,22/tcp` | SSH into a worker exists, but requires a key pasted into **user account settings** and **Active workers ≥ 1** |
| Inbound HTTP by default | `https://<podId>-<port>.proxy.runpod.net` | **none** unless you turn on Expose HTTP/TCP ports; no per-worker proxy analogue |
| Who can reach the shell | the RunPod **account** holder | the RunPod **account** holder |
| Reachable by an endpoint-scoped Restricted API key | n/a | **not documented as reachable** — and `EndpointCreateInput` carries no `env`, `ports`, `dockerStartCmd` or `dockerEntrypoint`, so argv and environment are a template-scoped write |
| Containers per worker | 1 | 1 |
| Egress policy | none configurable | none configurable |
| Execution ceiling | none (rented by the second) | 7 days (queue); 5.5 min (load balancing) |
| Checkpoint egress | volume at `/workspace` | volume at `/runpod-volume`; handler JSON caps at **10 MB** (`/run`) / 20 MB (`/runsync`), so a checkpoint is a pointer, never a payload |

The row that decides it: **on Pods the interactive surface is on by default and
takes no cooperation from the image; on Serverless it is off by default and
takes an account-settings change.** Both surfaces are operator-side — neither
is reachable by a tenant holding a scoped credential — so this is not the
difference between safe and unsafe. It is the difference between an obligation
that is true because we configured it and one that is true because nothing
turned it on. `PLACEMENT_AND_SURFACES.md` §4.2's whole subject is that those
are not the same claim.

### 9.4 Recommendation

**Serverless, on queue-based endpoints, as the destination — and stay on Pods
until two experiments pass.** Not a hedge; the two are separable because
**nothing in this WO depends on the substrate.** `lib/apps/kohya/`,
`job-runner.ts` and the whitelist would ship unchanged on either. The tier is
bought by what the schema cannot express and by who owns PID 1, and both
products give us PID 1. So the choice is a deployment decision with a small
migration behind it, not an architecture decision, and it does not gate WO-19.

The economics agree without deciding anything: both bill per second, so a
multi-hour run costs the same shape either way. Serverless adds start-time and
a 5-second idle timeout (seconds against hours) and removes the risk of a
forgotten idle Pod and the $0.20/GB/month stopped-volume tax. Pods win only
with a 3–6 month prepaid savings plan, i.e. only at continuous utilisation.
Training is bursty. **Cost is a dimension here, not a reason.**

### 9.5 What would falsify this recommendation

Each is a checkable fact, not a judgement:

1. **PID 1 is not ours.** Deploy a trivial worker whose handler returns
   `open('/proc/1/cmdline').read()`. If PID 1 is not our `CMD`, the design
   premise collapses on Serverless and Pods win by default. *This is the one
   fact worth an experiment before committing anything.*
2. **The platform SSH path is reachable by a holder of a Restricted,
   endpoint-scoped API key**, or can be enabled without console access to user
   account settings. Then "no interactive surface" is false on Serverless too,
   and the §8.5 obligation stays a claim on both substrates.
3. **A configured `executionTimeout` is silently clamped.** Run a job with
   `executionTimeout: 172800000` that heartbeats past one hour. The documented
   48-hour example has to actually hold.
4. **A long job can be evicted without a resume contract.** The **Outdated**
   ("marked for replacement after update") and **Throttled** worker states have
   no documented interaction with an in-flight six-hour job. If a run can be
   killed mid-training with no documented resume, multi-hour training is not
   safe there — and note the interaction with our own design: an evicted
   trainer produces a checkpoint the watcher never saw, which is the invisible
   failure, not the visible one.
5. **Image pull is billed and dominates.** RunPod's own pages contradict each
   other — `workers/overview` says the **Initializing** state is not billed;
   `pricing` lists "start time: initializing the container and loading models"
   as one of three billed phases. Both cannot be true. Materially relevant with
   a CUDA + PyTorch + sd-scripts image.

And what would falsify staying on Pods, which is the symmetric question:

1. **A Pod cannot be deployed without a console-reachable interactive
   surface.** The web terminal's documented setup is "None". If there is no
   verifiable way to disable it and platform SSH for a Pod, then Pods expose
   more than Serverless whatever our PID 1 does, and §8.5's first obligation
   cannot be honestly declared on Pods at all.
2. **Pod templates default `ports` to `8888/http,22/tcp`.** If that cannot be
   set empty — or the console re-adds it — every Pod ships with an SSH port and
   a Jupyter port exposed.
3. **The Cloudflare ~100 s timeout on the Pod HTTP proxy** breaks the job API's
   control channel for any request that is not instantaneous. Queue jobs have
   no such limit.

**If Serverless cannot host this, the concrete reason would be (1) or (4)** —
not the container model, not the timeout, and not storage, all three of which
check out.

---

## 10. Does Studio's Kohya path grade P1–P8 now?

Against `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` §2, restating
`STUDIO_P1-P8_GRADE.md`'s Path B with the job-API configuration in place.

| | Kohya, as graded | Kohya, job API | What still stands between it and PASS |
|---|---|---|---|
| **P1** runtime boundary integrity | FAIL | **PASS**, pending probe | The schema cannot express a command, which is derived. That the container exposes nothing else is **declared** — H-4 §7 probe 1. |
| **P2** baseline coverage | FAIL, "unfixable in place" | **FAIL** | Now fixable — the measured artifact no longer sits inside the boundary it measures — but no manifest covering the Kohya capture path exists. Not this WO's; see below. |
| **P3** API key custody | FAIL | **PASS**, pending probe | The credential is the component's sealed IK in a container with no tenant shell. That the tenant has no shell is the same declaration as P1's. |
| **P4** principal identity | FAIL (derived from P3) | **PASS**, pending probe | The principal is the component's identity, not a value the tenant supplies. Follows P3. |
| **P5** immutable event chain | FAIL, "no chain exists" | **PASS** for the capture path | The chain is the component's ratchet and queue. The `training_runs` row is an INSERT and a mirror, not the chain — no `UPDATE … SET model_hash` in place on this path. |
| **P6** zero-content posture | PASS | **PASS** | Unchanged and unchanged by design: header, shapes, dtypes, hashes. No weights. |
| **P7** attestation declaration | FAIL | **FAIL** | No baseline manifest in which to declare `attestation.provider: none`. Closes for free the moment P2 does. |
| **P8** attestation import | n/a | n/a | |

**So: not PASS, and the two that fail are the same missing thing.** P2 and P7
both want a baseline manifest covering the Kohya capture path, exactly as
canvas's P2 and P7 want one covering its own — `STUDIO_P1-P8_GRADE.md` already
says P7 "closes for free the moment P2 does." That work is WO-14's and it lives
under `lib/builds/`, which this WO does not own. Compliance is binary
(Standard §5): **Studio's Kohya path is still non-compliant, and it is now two
fixes from compliant rather than needing a different architecture.**

### 10.1 What needs a probe rather than a declaration

Three of the five enforcement obligations are computed from source and cannot
drift silently. Two are declarations, and P1, P3 and P4 all rest on them:

1. **No exposed tenant surface grants code execution.** True of
   `Dockerfile.jobapi` as written — the GUI is not installed, only 8899 is
   exposed — but the image **has not been built** and nothing has verified
   what a running container actually exposes. H-4 §7 probe 1.
2. **The component is PID 1 and the trainer is its child.** True of the
   `CMD` + `exec` as written; unverified in a running container. On RunPod's
   own base images this is the item §9.2's `RUN rm ../start.sh` trap bears on
   directly.

Both are reported as `needs_probe` in every job-API response and printed by the
component at startup, so an integrator reading a receipt can tell which half of
the tier is evidence.

Two more items are outstanding and neither is WO-19's:

3. **`SCRUPLE_KOHYA_SURFACE` defaults to `gui`.** The job-API mode requires a
   built image and `RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID`; the spawn **fails rather
   than falling back** if it is missing, because a silent downgrade from
   `server-library` to `unattested-client` is the failure the placement axis
   exists to make impossible. Until that template exists, Studio ships the GUI
   and ships it honestly: `witnessed: false`, `placement: unattested-client`.
4. ~~**H-4 §8 step 1 is still unstarted** — `input_hash`, `workflow_hash` and
   `model_fingerprints_hash` restored to `/v2/witness`.~~ **CORRECTED
   2026-09-02 (WO-30).** This was true when it was written and is not true now.
   WO-1 restored all three, and `app/api/v2/witness/route.ts` today accepts
   `kind: 'model_write'`, `training`, `inputs`/`input_hash` and
   `model_fingerprints`/`model_fingerprints_hash`, computing every hash through
   `lib/leaf/hashes.ts` — the same module `lib/iterations/ingest.ts` calls.
   `docs/canon/demo-readiness/training.md` §4 found the same thing
   independently. What remains true is the second half: the training-config
   commitment rides in the `graph` field rather than `training`, because
   `hashGraphOrTraining` treats the two identically and `kind` is what tells a
   verifier which document to re-canonicalize. Renaming a live wire field for
   tidiness is still not worth a scheme conversation.

   The one field genuinely still missing is `header_hash` for the checkpoint
   the run WROTE — §4.2 of `MODEL_WRITE_HOOK.md`, a leaf-scheme bump, and it
   does not gate anything. It rides uncovered on `capture.header_hash` from
   both components meanwhile.

5. **A training receipt is now producible with no GPU, and one is.**
   `test/v2/training-receipt.test.ts` drives the real component, the real
   `/api/v2/witness` handler, the real server-side ratchet and a stub witness
   over a synthetic safetensors file and a four-file dataset, and asserts a
   stored leaf with `witnessed = 1`, `leaf_kind = 'training'`, and all four
   commitments. What has still never happened is a run on a GPU (§10.1 items 1
   and 2 remain `needs_probe`).
