# Canvas — the baseline, and what canvas can honestly claim

**Status:** Implemented. `lib/canvas/baseline.ts`, `test/v2/canvas-retrofit.test.ts`.
**Version:** 1.0.0 · 2026-08-30 · WO-10 of `WO-SERIES-CANON-AS-FLOOR.md`
**Binds:** `STUDIO_P1-P8_GRADE.md` §"Path A — Canvas / ComfyUI" (every FAIL below is one of its), `H4-DUKPT-CAPTURE-COMPONENT.md` §2, §7 and §10 C-7/C-8/C-9/C-10, `PLACEMENT_AND_SURFACES.md` (every axis name)
**Consumes:** `services/scruple-capture/src/**` — canvas's route table, frame decoder, MIME declarations and correlator all come from there

---

## 1. What this closes, and what it does not

The grade found canvas passing P1, P3, P4, P5 and P6, and failing **P2 and
P7 for one reason between them**: no baseline covered any Studio capture
code anywhere in the estate. The only tamper surface that existed was
`services/witness-server/tamper-surface.mjs`, covering four files of the
witness server — the component that computes everyone else's baseline and,
until 2026-08-26, was not in git.

So P2 failed because the capture path was unmeasured, and P7 failed only
because `attestation.provider: none` — which is the correct value, and which
P7 explicitly permits — had nowhere to be declared.

`lib/canvas/baseline.ts` is both halves. It is the witness server's file,
applied to canvas's capture path, with the declaration attached.

**What a matching hash means:** the capture path is the code we think it is.
**What it does not mean:** that canvas is trustworthy. It does not cover
`node_modules` as installed, the Node runtime, the OS, the Next build
output, the Cloudflare tunnel, or the machine. Do not let it be read as the
stronger claim.

---

## 2. Why an explicit list, and why the list cuts both ways

The reference file states the design choice in its own comment and it is
inherited verbatim:

> Explicit list, not a directory walk. A walk would silently include whatever
> someone drops in the directory, which is the opposite of a tamper surface:
> **adding a file must change the hash for a reason we can name**, not because
> the glob happened to widen.

The second edge is the one that matters more here. A file that JOINS the
capture path and is not added to `TRACKED` is invisible to the baseline — and
a walk over `lib/canvas/**` would not have solved that either, because it
would have started measuring something new and told nobody. So the test
closes the other half directly: **every `lib/canvas/*.ts` module and both
entry points must be tracked**, asserted by reading the directory.

`lib/canvas/baseline.ts` itself is the one exclusion of that rule, because it
carries the recorded hash and hashing it would be a fixpoint rather than a
measurement. The exclusion is in `EXCLUDED` with its reason, alongside three
others, because an exclusion nobody can find is the same as an oversight.

### When this test fails

It is supposed to. A tracked file changed and the manifest did not. Re-record:

```
npx tsx -e "import('./lib/canvas/baseline').then(m=>console.log(m.tamperSurface().tamper_surface_hash))"
```

and say in the commit **why the capture path changed**. That sentence is the
product; the hash is just what makes writing it unavoidable.

---

## 3. The structural difference between canvas and the sidecar

H-4 §2 is built on **two surfaces**, and says why one is never enough:
ComfyUI produces retrievable output through disk and through the WebSocket,
and each covers what the other structurally cannot.

**Canvas has one.** The Modal container's `output/`, `temp/` and `input/` are
not mounted into scruple-web and cannot be — scruple-web is a Next
application on a different host from the GPU container. Canvas is a pure
network gate.

This is declared, not implied: `canvasCaptureProfile()` names
`surfaces: ['network-gate']` and the test asserts `filesystem-watch` is
absent. Three consequences follow and all three are stated rather than
discovered:

1. **H-4 §7 probe 4 is not satisfiable for canvas.** "A file written into the
   output volume produces no leaf within the drain window" is supposed to
   fail; for canvas it passes trivially, because there is no watcher. Canvas
   must not be certified against probe 4, and a self-grade harness that
   scores it as passing is scoring the absence of a surface as a success.
2. **C-8 lands differently.** `PreviewImage` writes to `temp/`, not
   `output/`, and a watcher on `output/` alone misses every one. Canvas gates
   the **route** rather than a directory, so `/view?type=output`, `?type=temp`
   and `?type=input` are all captured identically — which is the one advantage
   a network gate has over the watcher canvas cannot have. The directory is
   recorded on the capture row and never used as a filter.
3. **A tenant with a shell in the container is out of model**, exactly as §6
   says. Canvas's Modal container does not expose one, which is why the grade
   allows P1 to PASS at all; that is a property of the deployment, so
   certification is per **configuration** and this baseline is declared
   against the shared-default machine only.

---

## 4. The §7 fix, and the argument behind it

`lib/canvas/witness.ts:155` used to end the capture path with
`catch (e) { console.error('[canvas/witness] ingest failed', e); }`. The user
received their image, no leaf was written, and nothing outside a log line
knew.

The canon's answer for the SDK is that **the queue is in the failure path by
construction**. The component's `submitter.ts` states the split:

- **BLOCKING** — the MAC. No byte is forwarded until the ratchet counter is
  spent and the entry is on disk.
- **NOT BLOCKING** — the witness. Capture must not depend on witness-server
  health; a failed submission is a queued submission.

That works because the blocking half is **local and cheap**. Canvas has no
ratchet, so copying either half naively copies the wrong one: fail-closed on
`ingestIteration` would destroy the customer's own artwork because a storage
provider rate-limited us, and never-block is the line that produced this bug.

**Canvas splits at the seam it actually has:**

| | Canvas | Component |
|---|---|---|
| Blocking, must succeed | the `canvas_capture_log` row (one local SQLite insert) | the MAC + queue fsync |
| Not blocking, queued on failure | `ingestIteration` — storage upload, witness call, iteration row | the `/api/v2/witness` submission |
| On the blocking half failing | 502, bytes refused | gate fails closed |
| On the non-blocking half failing | row settles `failed`, bytes retained in the content-addressed store, `X-Scruple-Capture: failed` on the response, error-level log, `retryFailedCaptures()` drains | entry stays queued with its counter, backoff |

Note that `ingestIteration` **already** made the second choice for the witness
server alone: an unreachable witness lands the row with `witnessed=0,
leaf_scheme='v1'`. What the old catch swallowed was everything outside that —
the storage throw, the DB error, the missing active project. Those are now the
queue's, and the queue is in the failure path by construction.

**Four outcomes, and each is a different sentence:**

| `status` | Means |
|---|---|
| `witnessed` | ingest ran, a leaf exists |
| `failed` | ingest threw. Bytes delivered, no leaf, retryable, visible |
| `unwitnessed` | bytes left a byte-egress route with no workflow to attribute them to and no prior iteration with that content hash. **A named hole** |
| `refetch` | the same content hash is already on an iterations row. A thumbnail reload |

The old code's `return` on "no pending row" conflated the last two, which is
what made it look harmless.

**One thing WO-10 did not wire, named rather than left to be discovered:**
`retryFailedCaptures()` exists, is tested, and has no scheduled caller.
Nothing drains the queue on a timer. The component drains every 30 seconds
from `services/scruple-capture/src/index.ts`; canvas's equivalent home is
`scripts/reconcile-sweep.ts`, which is not this work order's file. Until it is
wired, a failed capture is durable, visible through `openCaptureFailures()`
and recoverable **on demand** rather than automatically. That is strictly
better than the swallowed catch and strictly worse than the component, and
saying which is the point.

---

## 5. P7 — `provider: none` is a claim, and no-declaration is not

Modal offers no attestable compute. H-5's vocabulary therefore makes every
canvas leaf `passthrough`, and Standard §12.4 requires the receipt to read as
such — "Stored" MUST NOT read as "verified". `CANVAS_BASELINE.attestation`
declares `{ provider: 'none', quote_ref: null }`.

Declaring `none` is not a weaker claim than declaring nothing. It is the only
one of the two that is a claim at all.

This is also H-4 §9's third open question in its concrete form: **the
reference integration cannot demonstrate the design's strongest tier.** That
is a founder call about where the reference should live, not a defect in
canvas, and it is recorded here so the question is asked deliberately rather
than discovered when someone asks for a `verified` receipt.

---

## 6. What the baseline asserts that is not a file hash

The grade's condition 1 on canvas's P1 PASS asked for exactly this — the
WebSocket pass-through property "needs an assertion in the baseline, not a
comment in a file." `CANVAS_BASELINE.assertions` carries five:

1. **The WebSocket leg is a gate, not a pass-through.** It decodes every
   binary frame with the component's decoder and witnesses those the graph
   declares as WebSocket artifacts. A ComfyUI release that starts returning
   result bytes over WS now changes this hash rather than opening a silent
   egress path.
2. **The HTTP leg gates five byte-egress routes, not one** (H-4 §10 C-7), and
   any other 2xx binary response is recorded by the tripwire as unenumerated
   egress.
3. **`attestation.provider` is `none`, and it is correct.**
4. **Canvas has no filesystem-watch surface**, so §7 probe 4 is not
   satisfiable and must not be claimed.
5. **Only the default machine manifest is pinned.** Personal machines (WO-7)
   would let a user choose the middleware inside the boundary and would move
   canvas from P1-PASS to P1-FAIL. This baseline is declared against the
   shared-default configuration only.

---

## 7. Named holes

A baseline that lists only what it covers is half a document.

- **Egress from the workload container** (C-9). Canvas's proxy is an INGRESS
  gate. `comfy_api_nodes/` ships ~25 in-tree node packs that open sessions to
  external services from inside the ComfyUI process, and any custom node can
  POST an image anywhere. Those bytes leave through neither leg. The honest
  claim is *"every artifact retrieved through the sanctioned path is
  witnessed"*, which is narrower than "cannot produce a retrievable artifact
  with no leaf".
- **WS artifacts from undeclared writers.** The WS leg witnesses frames whose
  prompt graph declares a WebSocket writer (`SaveImageWebsocket`) and
  **counts** the rest as previews, logging the tally on socket close. A custom
  node returning artifact bytes over WS without being on that list is counted,
  not witnessed. Same shape as C-7's finding, on the other surface.
- **Correlation is a heuristic on one path and a link on the other.**
  `filename-prefix` is a real link — the writing node declared the prefix.
  `ws-executing` is a timing link, correct under ComfyUI's one-prompt-at-a-time
  execution and wrong under a second worker. The method is on every row, so a
  verifier is never told a guess was a fact. The old code used the timing
  guess exclusively and did not label it.
- **`user_id IS NULL` manifest fallback.** Still present, now logged. A null
  manifest hash degrades the leaf below v2.2; it no longer does so silently.
- **The tripwire does not capture.** It logs and counts. ComfyUI serves its
  own frontend through this proxy and every icon would otherwise become an
  iteration.

---

## 8. What the re-platform found in the component

WO-8's premise was that canvas "proves the component against a path we know
works." It did, in the only way that counts: **trying to use the component
found two bugs in it that reading it had not**, both fixed in `68c3327`.

1. **`http.request({protocol: 'https:'})` throws `ERR_INVALID_PROTOCOL`.** It
   does not fall back to TLS. Both of `http-gate.ts`'s proxy paths passed the
   target's protocol straight through, so the component **could not proxy to
   any https upstream** — which is every hosted ComfyUI that is not a bare
   container on the same host, Modal included. Found by pointing canvas's
   upstream at it and getting a throw instead of a connection.
2. **`WsGate` had no keepalive.** Cloudflare and Modal close an idle tunnel at
   ~100-125s and a generation is routinely quieter than that between progress
   frames. Adopting the component's WS half verbatim would have **regressed**
   canvas, which has carried a 30s bidirectional ping since canvas v2 — and
   the regression would have presented as a missing leaf rather than as the
   timeout it is.

Both are the same class of finding: a defect that only appears when a second
integration exists. Neither is visible from inside the reference deployment,
where the upstream is loopback http and nothing sits between the gate and the
tenant. That is the argument for migrating canvas onto the component **before**
a vendor does, stated as an outcome rather than as a plan.

## 9. One operational change

The WS sidecar's run command changed:

```
-  node scripts/canvas-ws-proxy.mjs
+  node --import tsx scripts/canvas-ws-proxy.mjs
```

`--import tsx` is required, not incidental. The sidecar imports
`lib/canvas/gate.ts` and `lib/canvas/ws-capture.ts` so that the WS leg and the
HTTP leg share ONE session lookup, ONE correlator and ONE capture path. Two
implementations of a gate are two gates, and the second one is the one nobody
maintains. `tsx` is already a devDependency and `scripts/gen-predicate-vectors`
already runs `.mjs` under it, so this is an existing pattern rather than a new
dependency. Whatever supervises the process (pm2 / systemd) needs the flag.

## 10. Running it

```
# the tamper surface, printed
npx tsx -e "import('./lib/canvas/baseline').then(m=>{const t=m.tamperSurface();for(const f of t.files)console.log(f.sha256??'MISSING',f.file);console.log('hash:',t.tamper_surface_hash)})"

# the acceptance
WITNESS_SERVER_URL=http://127.0.0.1:1 npm run test:v2
```

The canonical form is sorted `sha256  filename` lines with a trailing
newline — byte-identical in shape to the witness server's, and reproducible by
hand with `sha256sum`, which matters when a reviewer wants to check it without
running our code.
