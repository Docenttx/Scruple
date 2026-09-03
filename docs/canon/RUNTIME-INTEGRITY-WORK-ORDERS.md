# Runtime integrity work orders — tiered

_2026-09-03, re-cut. Source: eleven council reviews of the generation runtime
(`review-eval/`), plus the host survey behind `SERVER_ARCHITECTURE.md`._

## The framing that decides the ranking

Studio is **not a product with users**. It is the worked example vendors copy.
`STUDIO_IS_AN_EXEMPLAR.md`, founder direction:

> **It must be perfect *as an example*.** … Not *most capable*. **Most faithful.**

That does not soften this list — it inverts it. Anything whose trigger is load,
concurrency or scale stops mattering, because there is no load. Anything a
vendor would **copy**, or an auditor would **recompute**, matters more, because
a product's defect is contained and a blueprint's defect propagates. We are the
party auditing vendors against a floor; our reference implementation has to meet
it.

Two things survive regardless of users: infrastructure that is reachable from
the internet, and secrets. Attackers are not users.

## Evidence status

**VERIFIED** = I confirmed it against the live code or a live endpoint.
**LEAD** = file, line, plausible argument, confirmed by nothing that ran.
No WO here closes by reading it and agreeing.

---

# TIER 1 — do first. Live infrastructure, not user-facing risk.

### WO-60 · The Modal GPU endpoint has no authentication — **VERIFIED LIVE**

`modal/scruple_runner.py:733`. All six `admin-*` siblings take `x_admin_token`
and call `_check_admin`. `web_run` takes neither. Probed with no credentials:

```
POST https://aquanomous--run.modal.run  {}
-> HTTP 200  {"ok":false,"error":"workflow_api_json (object) required"}
```

That is the application's own validation error, reached unauthenticated. A
well-formed body executes an arbitrary ComfyUI graph on our GPU, at our cost,
in a container that mounts the models volume — and custom nodes are a
code-execution surface. The URL is a predictable Modal pattern derived from the
workspace name; obscurity is not a control.

**Green means:** the endpoint refuses an unauthenticated POST, and a run driven
through `/api/runs` still succeeds. Both halves, because a token check that also
breaks the product is not a fix.

### WO-61 · `localPath` reads any file on the host — **VERIFIED**

`lib/runs/inputs.ts:65`. The comment says *"Guard against path traversal
surprises"*; the guard is `path.resolve()`, which normalises and does not
confine. No root, no allowlist. Confirmed by calling `resolveInput` directly:
it read `/etc/hostname`.

It composes into an exfiltration primitive rather than a mere read: the bytes
are hashed, stored content-addressed, and become retrievable through
`/api/artifact/<hash>`. `.env.local` holds `AUTH_SECRET`, the Modal tokens,
Stripe keys and the BDK.

**Green means:** a confinement root, `localPath` outside it refused, and the
false comment deleted rather than reworded. **Watch for:** this is a dev-run
affordance — confine it, do not remove it, or the CC pipeline loses its input
path.

---

# TIER 2 — blueprint fidelity. What a vendor copies and an auditor recomputes.

## 2A — Measurement honesty. Generalise WO-27's rule.

WO-27 settled this once for `input_hash`: **bind it, or decline; never assert an
empty set.** It was applied in exactly one place. Against the L2 floor this is
**H-5** — two-tier assurance, the one item marked *implemented*: a record
declares what actually backed it.

### WO-62 · `machine_manifest_hash` conflates THREE documents — **VERIFIED, upgraded**

Sharper than my first cut, which said two. The column holds, indistinguishably:
the container's own measurement; a caller-supplied hash; and **"whichever
machine row this user created most recently"**. Nothing on the row records which.

My fix this morning (`97af9e4`) is **incomplete** — the `except` still degrades
silently to the descriptor.

**Green means:** an evidence-source recorded beside the hash, and three honest
states — measured / genuinely absent / could-not-determine. Collapsing the last
two is the original defect.

### WO-63 · Model fingerprinting reports failure as "no models" — **LEAD**

`scruple_runner.py:328` drops unreadable files silently; `:451` collapses
everything to `{}`; ingest turns that into `model_fingerprints_hash = null`,
which is the representation for *we enumerated and there were none*.

### WO-64 · `witnessed = 1` on any non-null witness response — **LEAD, new**

Set even when the response carries no signature and no leaf hash. A leaf can
therefore claim it was witnessed on the strength of an HTTP 200 with `{}`. This
is H-5 violated in the field it is named after.

### WO-65 · Degraded runs are invisible to callers — **LEAD**

`witnessed`, `leafScheme`, `seal`, `storagePointer` are computed, documented as
things callers must surface, and dropped by both doors. Keep `ok: true` — the
run happened; make its qualifications visible.

## 2B — Reproducibility. An outsider must recompute and agree.

### WO-66 · `input_hash` is raw `JSON.stringify` over the graph — **LEAD, highest value**

`lib/leaf/hashes.ts:76`. V8 orders integer-like keys ascending, Python preserves
insertion order; Python escapes non-ASCII by default, V8 emits UTF-8. A verifier
in the other language gets a mismatch, **which reads as tampering**.

**This is load-bearing on Priority 1.** The demo artifact is Studio output.
`bundle-iter176`'s instructions ask a reviewer to recompute `machine_manifest_hash`
and `workflow_hash` — **not `input_hash`** — so the bundle survives by omission,
and a serious auditor will not confine themselves to the steps we hand them.

**Watch for:** scheme bump. Migration 049 already gives a row somewhere to say
which rule made it. Pair with WO-67 and WO-69 in one bump.

### WO-67 · `mtime` is inside `model_fingerprints_hash` — **VERIFIED**

`scruple_runner.py:312`. Filesystem metadata, not a property of the bytes. One
of the five headline hashes is not recomputable by anyone who holds the model.
`hashes.ts:49` notes mtime but frames it as float *formatting*; re-record it
under reproducibility, which is the larger claim.

### WO-68 · The manifest digest folds a transient error string — **VERIFIED**

`container_manifest.py:84`, under a comment claiming it *"keeps the hash
deterministic."* It does the opposite. Collect unreadable paths into an
`unreadable` list; mark the manifest incomplete; keep them out of the preimage.

### WO-69 · The stored manifest is not the bytes that were hashed — **LEAD, new**

What is persisted is Node's `JSON.stringify` of a `JSON.parse` round-trip of the
runner's object; the hash was computed over Python's `json.dumps`. They agree
only for documents with no floats and no non-ASCII — which is why my
verification of iteration 174 round-tripped cleanly and proved less than I
thought. Same family: the Python side is not RFC 8785.

### WO-70 · Output selection depends on node completion order — **LEAD**

`scruple_runner.py:624` iterates `outputs.values()`. A graph with a `SaveImage`
and a `PreviewImage` can bind a different artifact on two identical runs. Sort
by node id with a stated tie-break.

### WO-71 · Input binding compares bare filenames — **LEAD**

`ingest.ts:251` matches on `basenameOf`, so `train/init.png` satisfies a
reference to `clipspace/init.png` and the leaf makes an affirmative claim over
bytes the graph never read. Compounded by `scruple_runner.py:530`: the input
directory is never cleared between runs on a warm container.

### WO-72 · `projectName` is mutable, unpersisted, and witnessed — **LEAD, new**

Sent to the witness on every leaf. Rename a project and historical leaves no
longer verify.

### WO-73 · The v1 fallback leaf has no domain separation — **LEAD, new**

When the witness is unreachable, the fallback sets `leaf_hash = output_hash`.
Two iterations with identical output bytes then carry identical leaf hashes and
the chain is ambiguous.

## 2C — Patterns a vendor would copy

### WO-74 · `run_sequence` allocated outside the transaction — **VERIFIED**

`ingest.ts:400`. `MAX+1` with no lock; the comment leans on
`UNIQUE(project_id, run_sequence)`, but the witness call is line 444 and the
transaction is 485, so the constraint fires **after the leaf is signed**. The
race needs concurrency and Studio has none — **it stays Tier 2 because
witness-before-insert with an unlocked counter is the pattern that gets copied**,
and because the failure it produces is an unretractable orphan on an
append-only log.

### WO-75 · Fingerprint cache keyed on filesystem metadata — **LEAD, new**

`(path, mtime_ns, size)`. A model modified and `os.utime`'d back evades
re-fingerprinting on a warm container. A vendor copying this inherits a
swap-detection hole.

### WO-76 · A corrupt job row mints a weakened leaf — **LEAD**

`execute.ts:285` swallows a parse failure on `run_workflow` and falls back to
`null`, which empties `referencedInputs`, bypasses the decline branch, and signs
an affirmative *"no inputs"* claim. Fail the job.

---

# TIER 3 — parked while Studio has no users. Revisit if it takes traffic.

Correct, and triggered only by load, concurrency or scale:

- **`pollRunJob` is not idempotent** (`execute.ts:241`) — needs overlapping pollers.
- **Transient 502 becomes terminal failure** (`modal.ts:182`) — costs a finished GPU run.
- **The timeout ladder is inconsistent** — sync request dies while the GPU keeps working; the 120s status route is shorter than a large checkpoint ingest.
- **Storage paths truncate the content hash to 48 bits** — needs ~16M artifacts.
- **`CanonicalizationError` after storage** traps async jobs in a re-upload loop.
- **`outputKind` precedence inverted** on the async path.
- **Staged inputs** (`WO-51`) — right for provenance, but a **custody** change; route through `CUSTODY_LOCUS.md`, not straight to code.
- **Optimizations** — four, all one waste: multi-gigabyte artifacts base64'd and held whole in memory, transferred once per *poll*. Mostly disappears with idempotency.

**Two proposed optimizations were correctly REFUSED and stay refused:** a
checkpoint-hash sidecar (volume integrity), and computing the container manifest
at **build time** — which trades a runtime measurement for a build-time
declaration, the `content` versus `declared` distinction the seal manifest rests
on. That refusal was reached without sight of the canon.

---

# TIER 4 — host hygiene (`SERVER_ARCHITECTURE.md`)

1. **`/opt/scruple-witness/arweave-key.json` is world-readable (0644)** while every other secret on the box is 0600. One `chmod`.
2. **`/data` is at 93%** (11G free).
3. **`ravend-mainnet.service` enabled and crash-looping past 61,000 restarts.** Testnet — the live anchor — is healthy. Repair or disable; it must not sit enabled and broken.
4. **nginx carries a dead `canvas.scruple.ai` vhost** — no DNS, two routes proxying to a port with nothing on it.

Recorded elsewhere and larger than all four: **`scruple.stooges.ai` is an
unsupervised `next dev` process**, absent from systemd and pm2.
