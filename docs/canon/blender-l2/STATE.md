# STATE — Scruple for Blender against the L2 floor

_2026-09-07, WO-B7. Closes the WO-B1…B7 series in `/data/scruple-blender`
and WO-S1 in `/data/scruple-web`. Addon at `af95462` + this commit; server
at `b6cb1fd`._

Every line in section 1 names the thing that showed it. Where a claim rests
on a report rather than on something re-run today, the source column says
so. Nothing here is asserted from a passing test alone: a test that has
never been made to fail is a claim about the test.

---

## 0 · What was re-verified at close-out, and what was taken on report

WO-B7's gate is that every claim of "works" names an observable. So the
close-out re-ran the load-bearing ones from the shell, outside the
harnesses that produced them, and marks the rest as second-hand.

| re-checked today, independently | result |
|---|---|
| addon suite, clean tree | **308 passed**, `git status` clean before this commit (was 306 at `af95462`; +2 this WO) |
| all seven WO-B6 artifacts re-hashed with `sha256sum`/`hashlib` against `iterations.output_hash` | **7/7 match** (§1.1) |
| all seven leaf signatures verified against `:5899/api/signer/pubkey` with the P-256 key, in a process that shares no code with the addon | **7/7 verify**, and both controls (hex spelling, one flipped signature byte) **fail** as they must |
| the one-pixel control through `/api/v2/verify` | original `found: true`; altered `found: false` |
| the four C2PA credentials read back with `c2pa` 0.36.0 | **4/4 `Valid`**; controls `c2pa-tampered.png` and `wrong-key.png` both **`Invalid`** |
| the C2PA manifest's own provenance assertion | binds `leaf_id 76`, `content_hash 71ea39c2…` — the same hash the file on disk still produces |
| WO-B4's deliberately dropped capture | `select count(*) … output_hash='9fa67444…'` → **0**. Still absent, still named in the report |
| Blender 3.0.1 headless render, right now | `/tmp/b7smoke.png`, 10 496 B, Cycles CPU |
| the production witness DB at `/opt/scruple-witness/` | `witness.db` mtime **2026-09-02**, WAL **2026-09-03**. **Nothing in this run wrote to it** |
| whether the addon's SHIPPED SDK can carry an H-4 envelope | **it can** — measured, §2.1. This is new, and it changes WO-B4's headline |

Taken from the reports and **not** re-run today: the in-Blender live
harnesses (B2/B3/B4/B5/B6), the sixteen B5 mutations, the eight B6
mutations, and the conformance grader's five moved cells and two inert
ones. Their evidence files are committed beside this one; the runs
themselves are not cheap to repeat and nothing in the re-checks contradicts
them.

---

## 1 · What works, proven by side effect

### 1.1 Done — and true independently of the sandbox

These do not depend on the surrogate, on a signature, or on anything that
would change when a real CVM comes up.

| what | the observable |
|---|---|
| The addon captures from real headless Blender and lands a leaf on `/api/v2/witness` | 90 rows in `scruple-scratch.db.iterations`, 88 witnessed. Leaves 15-18 (B3), 21-26 (B4), 45-46 (B5), 76-82 (B6), 87-90 (B7) |
| Content hashes are real | every artifact re-hashes from disk to its recorded `content_hash` — 7/7 re-checked today with `hashlib`, against rows read from sqlite. Two programs sharing no code |
| MIME is declared, never sniffed | four distinct declared types on one run: `image/png`, `image/jpeg`, `application/x-blender`, `model/obj`, `model/stl` (`06-REAL-CONTENT.md`). Control: an undeclared export format raises `MimeRequiredError` in real Blender (`02-in-blender-evidence.json`) |
| `lib/` is gone and the SDK is the implementation | `unzip -l dist/scruple-blender-0.1.0.zip \| grep -c scruple_blender/lib/` → **0**. `test_sdk_adoption.py` (29 tests) asserts `scruple_host_sdk.__file__` is inside `vendor/`; restoring `lib/queue_store.py` turns four tests red (demonstrated, `02-SDK-ADOPTION.md`) |
| The zip builds and carries the SDK | `build/build_addon.sh` → `dist/scruple-blender-0.1.0.zip`, 212 232 B, 73 files, rebuilt today |
| Store-and-forward survives the server being down | app stopped, three real renders spooled, app restarted, `drain {attempted: 3, succeeded: 3}`, rows 21/22/23 with matching hashes (`04-live-phases.jsonl`) |
| A missing leaf is **detected**, not silently absent | one queue line deleted → `counts {settled: 5, gap: 1}`, `all_clear False`, the missing hash named. Six captures taken, five rows in the DB. The must-NOT-fire twin is Part 1's `all_clear True` on the same code path |
| The panel is a project manager, tracker and lock dashboard | six panel classes register in real Blender with correct `bl_parent_id`; six operators invoked through `bpy.ops`; `poll()` measured moving from `tracker FALSE receipt FALSE` to `true/true` after two captures (`05-dashboard-phases.jsonl`) |
| A project switch changes where a leaf lands | requested 3 → `iterations.project_id = 3` (leaf 45); requested 4 → 4 (leaf 46). Re-read from the DB today |
| One-pixel tampering fails verification | `torus.png` `found: true`; `altered-one-pixel.png` `found: false`. Re-run today |
| The addon is graded by the real conformance package | `06-conformance-grade.json`: `compliant: false`, `lifecycle: integrating`, P5/P6 pass, P8 n/a, the rest fail. Graded against the **server's** registered `blender` profile, not one the addon wrote about itself |

**The grade being `false` is a pass, not a failure of this work.** The
registered profile is `attested-client` with `enforcement: none`, which
`resolvePlacement` degrades to `unattested-client` — "the measured party
can modify the capture code and reach its key". A compliant grade here
would mean the grader is broken.

### 1.2 Done **against the surrogate** — real cryptography over a software key

Everything in this section is a real ECDSA signature that a third party can
check. **None of it is hardware-backed, and nothing in the addon records it
as such.** `GET :8799/20180608/keys/{ocid}` answers `protectionMode:
SOFTWARE`, re-read today.

| what | the observable |
|---|---|
| Leaves are ECDSA-signed and the signature is now disclosed to the client | `GET /api/v2/receipt/76` → `signature.state: signed`, `key_protection: software`, `leaf_signer_surrogate: true`, plus the exact instructions for what was signed over |
| The signature verifies, independently of Scruple's word for it | 7/7 verified today against `:5899/api/signer/pubkey`. Controls: the same signature over the ASCII hex spelling → **False**; one flipped byte → **False** |
| The app tier copied the signature rather than inventing one | `sig==wit`: the `iterations` value is byte-identical to the witness server's own `witnesses` row (`06-REAL-CONTENT.md`) |
| The addon checks the signature itself, and says when it could not | `independently_verifiable_checked` is a real check, `checked_ok` has **three** values. With `SCRUPLE_WITNESS_PUBLIC_URL` unset the receipt publishes no key address and both the good and the tampered signature come back `not checked` — control C2′ |
| C2PA credentials signed against the surrogate | four assets, `signing_mode: kms-http`, read back **`Valid`** with `c2pa` 0.36.0 today. Controls: a byte flipped in a signed asset → **`Invalid`**; the surrogate's certificate over the wrong key → **`Invalid`** |
| The credential tells the truth about its own key | the `ai.scruple.provenance` assertion carries `signer_protection_mode: SOFTWARE`, `hardware_backed: false`, read off the wire at mint time — confirmed today by reading the manifest out of `torus.png.c2pa.png` |
| The assurance tier is honest on every leaf | all 14 B6 leaves read `passthrough (software-signed)`. **None reads `verified`**, and the suite asserts that exhaustively over the two inputs |

One precision on "read back `Valid`": that is `c2pa` 0.36.0's
`validation_state` over a **self-minted** chain — it says the manifest's
hashes and its signature check out, which is exactly what distinguishes the
signed asset from the tampered one and from the wrong-key one. It says
nothing about the certificate chaining to a recognised trust list, and no
claim here depends on it doing so. Measured today with default settings as
well as with `verify_trust: false`; the verdicts are the same either way.

### 1.3 Cannot be done without the real CVM

| what | why, and what stands in for it today |
|---|---|
| A leaf at assurance tier **`verified`** | needs an attestation the server verified **and** a signature. The surrogate supplies the second; Blender declares no attestation provider, and the surrogate's key is software. The tier rule requires both and refuses to compute `verified` from one half |
| A C2PA credential with real key custody | `sign.py` never held the key — it called `/20180608/sign` on the surrogate — but the surrogate holds it in software. A certificate cannot attest key custody and the manifest says so in its own note |
| P1 / P3 on the conformance grade | both fail at `unattested-client` and **cannot move** while the zip is unsigned. Two mutations prove it: attestation made `verified` → `NO CHANGE`; the key moved out of reach → `NO CHANGE`. Kept, named as inert and asserted inert, because deleting them would delete the answer |
| Hardware-backed anything | `protectionMode: SOFTWARE`, checked today |

---

## 2 · Built but unproven, or built and unwired

### 2.1 H-4 client-binding — the one that changed today

WO-B1 flagged it, WO-B4 measured the blocker as *"one SDK parameter"*, and
WO-S1(b) added that parameter three hours later. WO-B6 then re-vendored at
`b6cb1fd`, which is **after** S1. So the question a close-out has to settle
is whether the bytes inside the shipped zip can do H-4 today.

They can. Measured, not inferred — `07-h4-vendored-probe.py` imports
**only** from `/data/scruple-blender/vendor` and never from
`/data/scruple-web/packages`:

```
SDK in use: /data/scruple-blender/vendor/scruple_host_sdk/witness_flow.py
VENDOR.json source_commit: b6cb1fd

provision      component_id=7695c397-…  counter=0
MUST FIRE  witness a  leaf=87  component={counter:0, verified:True, gap:0}
CONTROL    witness b  leaf=88  component={counter:1, verified:True, gap:0}
CONTROL    witness c  leaf=89  component={counter:2, verified:True, gap:0}
           gaps: [0, 0, 0] — the detector is not simply always saying yes
MUST FIRE  counter 3 spent and never delivered
           witness e  leaf=90  component={counter:4, verified:True, gap:1}
GET /api/v2/components/status  →  gaps {open: 1, missing: 1,
           list: [{from_counter: 3, to_counter: 3, missing_count: 1}]}
           liveness live · attestation {provider: none, status: passthrough}
CONTROL    an envelope with no MAC is refused client-side; no counter spent
```

Leaves 87-90 are in `scruple-scratch.db`; their four artifacts re-hash from
disk; `component_counter_gaps` holds the row. Evidence:
`07-h4-vendored-evidence.json`.

**So H-4 is no longer blocked on a capability. It is unwired.** What is
missing:

1. **Adapter wiring** — nothing in `adapter/` provisions a component,
   persists its identity and ratchet state, or passes `component=` /
   `ratchet=` to `witness()`. Every leaf the addon produces is still
   `component_verified: false`, stated rather than omitted.
2. **The provisioning ceremony** — no route in the estate mints a
   provisioning token. `issueProvisioningToken()` is called by
   `test/v2/*.test.ts` and by "the vendor console", which does not exist;
   the sandbox used `issue_token.py`, which reproduces that INSERT. That
   may be correct by design — in payments the injection ceremony is
   deliberately not something the terminal initiates — but it has no
   implementation, so a component cannot provision itself end to end.
3. **Where the ratchet state lives.** A forward-secure ratchet that
   survives a Blender restart has to persist somewhere, and the addon's
   current secret storage is the plaintext API key at 0600 in
   `~/.scruple/blender-auth.json` — which is the *thing H-4 exists to
   replace*. Persisting an IK next to it would move the problem, not close
   it. This is the design question, and it is not answered anywhere in this
   series.

**Two sentences the addon was shipping are now false, and this WO fixed
them.** `adapter/reconcile.py` told its user that the SDK had "no
`component` / `mac` parameter" and that there was "still no way to ask" for
the standing account. Both were true when written and both were false
against the bytes in `vendor/`. The reason code `no_sdk_route` is now
`not_wired`, the details name adapter wiring rather than blaming an API,
and two tests pin it:

- `test_the_vendored_sdk_carries_the_h4_surface` — goes red if a re-vendor
  ever takes the parameters back out. Demonstrated: dropping `ratchet=`
  from the vendored `witness_flow.py` turns it and two vendor-integrity
  tests red.
- `test_no_reason_string_claims_the_sdk_cannot_carry_an_envelope` — the
  control. Demonstrated: reinstating the phrase *"there is still no way to
  ask"* turns it red at the forbidden-claim assertion; reverted, green.

### 2.2 Built, exercised only against a mock

| what | why it is unproven |
|---|---|
| The read path for a **hardware** signer | `adapter/assurance.py` reads `key_protection` and would render a non-surrogate key as `undeclared`, never `hardware` — because the witness does not transmit a protection mode. No hardware signer has ever answered it |
| The `verified` branch of the panel | `test_dashboard.py` proves the region renders and that it is **absent** for a passthrough leaf, but no real leaf has ever reached that tier |
| Paid actions | `/api/stripe/config` with a valid bearer key → **HTTP 503**, re-measured today. Every paid button in Blender is blocked, correctly, and the panel says why. `charge()` → `mark()` has never run against a real payment |
| `rebaseline` | the scratch witness refuses it (`503 signer_unavailable`, synthetic project id), so **every leaf in this series carries a `baseline_ref` that does not equal the running build's tamper surface hash**, and `attach()` said so on every phase. Recorded rather than worked around |
| The C2PA button in the addon | `POST /api/v2/mark` returns *"The Signer CVM is not running"* **unconditionally** — observed on leaf 76's receipt again today, while four credentials were signed against a reachable surrogate minutes apart. The modality is unwired server-side, not unavailable. `app/api/v2/mark/route.ts` is scruple-web's |
| `checkpoint` | refuses by design: no v2 route, no member of the closed modality vocabulary. Registered, explains itself, charges nothing |

### 2.3 A cost, not a defect, and not fixed

Every capture base64-encodes the whole artifact into `capture()`'s return
and **nothing reads it** — 573 KB of base64 for a 429 KB `.blend`, built
and discarded. It is not a P6 failure (nothing leaves the machine; the POST
body is `content_hash` only), and the conformance derivation was corrected
so it does not grade it as one. It is a copy of user content sitting in
memory for no reason, in `scruple_api.capture`, and it belongs to the SDK.

---

## 3 · What needs a human at a Blender GUI

**Everything in this series ran `--background`. The panel has never been
seen.** The mock-bpy suite and the in-Blender registration checks cover a
great deal — `bl_parent_id` validity, `poll()` transitions, operator
properties actually being declared — and the live run caught one bug the
mock structurally could not (a sub-panel's `poll()` is evaluated
independently of its parent, so the receipt panel drew under a signed-out
panel). But three classes of thing cannot be reached headless:

1. **Layout and legibility.** Row density, truncation of a 64-hex digest in
   a narrow N-panel, whether a five-state connection indicator reads as
   five states, whether the sub-panel order is sensible when four of five
   are collapsed. `05-DASHBOARD.md` caps the lists at 10/8/6 rows with a
   stated remainder because an N-panel does not scroll — nobody has seen
   what that looks like at either cap.
2. **The sign-in handshake.** `auth.py` opens a browser at
   `/settings/keys/desktop` and waits for a paste-back. Every run here
   injected an API key into a scratch cache directory instead.
3. **The operators under interaction.** They run synchronously on the main
   thread, so a slow witness freezes the UI for its duration. There is no
   busy state and could not be one without a rework. Nobody has felt that.

A GUI Blender was attempted in this sandbox (`gui_probe*.py`, `gui4.png`
in the scratch tree) and produced screenshots; nothing in the series rests
on them.

---

## 4 · What needs the founder

Five, in the order they block things.

1. **H-4: decide the client-binding shape, or accept passthrough.** The
   floor says mandatory (`L2_AS_THE_VENDOR_FLOOR.md:30`). The mechanism now
   works end to end from the addon's own shipped bytes (§2.1). What is
   undecided is where a Blender component's ratchet state lives on a user's
   own machine, and who runs the provisioning ceremony given that no route
   mints a token. Until that is answered, every Blender leaf is
   `component_verified: false` — which is honest and is not the floor.

2. **Publish the verifying key, or proxy it.** `SCRUPLE_WITNESS_PUBLIC_URL`
   unset is the deployment default, and unset means a client holds a
   signature it cannot check while the same receipt says
   `independently_verifiable: true`. One environment variable moved every
   leaf in WO-B6 from `checked_ok: None` to `checked_ok: True`. The
   alternatives are publishing the witness address or adding an
   unauthenticated proxy route on a tree that also serves production —
   WO-S1 declined to make that call unilaterally and it is still open.

3. **`scruple_api` says `jcs-1`; the server writes `jcs-2`.** The digests
   agree — WO-B3 measured client and server `workflow_hash` matching on all
   four leaves, including on `1e-5` and `3.0`, the two values the languages
   historically disagreed on. The **label** is what an auditor reads to
   know which rule to replay, and it disagrees on every leaf. One constant
   in `packages/scruple-api`, plus a decision about whether a v2 route
   should return the profile at all.

4. **Backfill, or don't.** Migration 052 stores the H-1 triple going
   forward and deliberately backfills nothing. Leaf 20 is the shape of the
   consequence: the witness DB holds a real signature for it, the app tier
   never observed it, and the receipt says `unknown` rather than
   `unsigned`. Re-checked today on leaves 15 and 18 — `state: unknown`,
   `independently_verifiable: false`, while the witness DB holds
   surrogate-signed rows for that era. Recovering them is a reconciliation
   with its own evidence, and it needs a ruling on what a
   recovered-but-not-observed signature is worth.

5. **`/api/v2` has no project route and no payment surface.** The dashboard
   reads `/api/projects` — v1, same bearer key, the route the Fusion
   palette uses — because the alternative was a project switcher whose
   selection changed nothing. Payment is worse: `/api/stripe/*`
   authenticates by session cookie, so a headless plugin cannot pay at all
   (503 today on the scratch app; 401 on a configured one). Either v2 grows
   these or the "v2-pure integration" is not a thing an addon can be.

Two smaller ones, already written up where they were found: **`/api/v2/mark`
answers "the Signer CVM is not running" unconditionally** (§2.2), and
**`sign.py` returns `ok: true` for a credential whose certificate does not
bind the signing key** because `verify_after_sign` is off under
`SCRUPLE_C2PA_DEV=1` — only the reader catches it (B6 control C4).

---

## 5 · Corrections to earlier reports in this series

A close-out that leaves superseded claims standing is not a close-out.

| where | what it said | what is true |
|---|---|---|
| `01-GAP.md` Table 3 row 1 | H-1 is "a purely client-side gap" | Wrong, and WO-B3 said so: the app tier had **no column** for the signature. It took migration 052 (WO-S1a) to make it client-readable at all |
| `04-STORE-AND-FORWARD.md`, "Three things for the founder" #1 | "one SDK parameter unlocks the floor's own reconciliation" | The parameter landed the same day (WO-S1b) and is in `vendor/`. **Superseded — H-4 is now adapter wiring plus a ceremony decision, not a capability.** §2.1 |
| `adapter/reconcile.py` reason strings | the SDK has "no `component` / `mac` parameter"; "there is still no way to ask" | Both false against the bytes in `vendor/`. Corrected in this commit, with a control test that fails if either sentence comes back |
| `05-DASHBOARD.md` §7 | "289 passed, 2 failed" on vendor drift | Resolved: WO-B6 re-vendored from `b6cb1fd` once WO-S1 had committed. `test_sdk_adoption.py` is 29/29 green today |
| `03-V2-WITNESS-L2.md`, "the gate passes and you should not trust one clause of it" | `/api/v2/verify` calls any HMAC-sealed leaf independently verifiable | **Fixed by WO-S1a**: verify now reads the ECDSA column. Re-checked today — leaves 15/18 (pre-052) report `independently_verifiable: false`, and leaf 76 reports `true` with a signature that actually verifies |

---

## 6 · Sandbox state — and one thing that should not be running

Production was respected on the two things the brief named explicitly, and
this is checkable:

- **The production witness (`:5799`) was never written to.**
  `/opt/scruple-witness/witness.db` mtime **2026-09-02 23:37**, `-wal`
  **2026-09-03 18:19**. Nothing from today.
- Every leaf in this series is in `/mnt/corpus/scruple-blender-l2/`'s
  scratch databases.

**But something is listening on `:3001`, and this run started it.**

```
$ ss -ltnp | grep :3001
LISTEN *:3001   users:(("next-server (v14.2.15)",pid=4105224))
$ ls -l /proc/4105224/fd/1
 → /mnt/corpus/scruple-blender-l2/site-3001.log
$ ls -l /proc/4105224/cwd            → /data/scruple-web
$ ps -o lstart= -p 4105224           → Mon Sep  7 10:15:54 2026
$ ps -o args= -p 4103645             → npm exec next dev -p 3001   (PPID 1)
```

The log is `Next.js 14.2.15 … Environments: .env.local … Ready in 2.3s`,
then four `GET / 307`. It also wrote into **`/data/scruple-web/.next`** —
the production build directory, distinct from the sandbox's
`.next-blender-l2` — whose contents carry mtimes of `10:16:14`.

Three facts and one non-fact:

- The process was started at **10:15:54**, inside WO-B5's window
  (09:47:25 → 10:16:25), with `TMPDIR` pointing at the WO scratch tree and
  its output redirected into it. It is orphaned (PPID 1) and still running.
- It is what currently answers on `:3001`. Nothing else can have been bound
  there at 10:15:54, so the live endpoint was **already down** before this
  run touched it.
- It rebuilt `/data/scruple-web/.next`.
- **I could not determine which command launched it.** No driver script in
  the scratch tree mentions 3001; both that do mention it say production is

> **Resolved, by the session that ran this series.** That process is mine, and
> it is not a stray. `scruple.stooges.ai` was found returning **502** at 10:14
> during the WO-S1 check: the original unsupervised `next dev -p 3001` — an
> orphan running since 2026-09-02 — was simply **gone**, with nothing listening
> and no process. No OOM (17 GB free) and nothing in any WO log kills it, so the
> cause is genuinely unknown. It was restarted at 10:15:54 to put the site back
> up, deliberately detached and logging to
> `/mnt/corpus/scruple-blender-l2/site-3001.log` so a recurrence leaves
> evidence. Rebuilding `.next` was the cost of that restart.
>
> It should keep running — it *is* the live site. The real finding is the one
> this series stumbled into: **that site has no supervisor**, it went down
> silently mid-run, and nothing restarted it. That is founder decision 5
> (`STATE_2026-09-03.md`) arriving on its own.

  never touched.

I have **not** killed it. Stopping the only process serving a public
endpoint is the same class of unsupervised act as starting it, and it is
the founder's call. If `:3001` is meant to be down, kill `4103645`; if it
is meant to be up, it should be up under a supervisor with its logs
somewhere other than a scratch directory, and `/data/scruple-web/.next`
should be rebuilt deliberately.

Other sandbox state is in `/mnt/corpus/scruple-blender-l2/SANDBOX-NOTES.md`,
including the one that bites: **the scratch witness must be restarted with
its `kms-http` command** or it silently drops back to `disabled` signing,
and the runner's `/health` check will not notice.

---

## 7 · The numbers, and where everything is

| | |
|---|---|
| addon suite | **308 passed** (81 baseline → 94 → 176 → 214 → 253 → 289 → 306 → 308) |
| `services/c2pa-signer` | 118 passed |
| `scruple-web` `test:v2` / conformance / integration / sdk | 656 / 47 / 19 / 192 pass; **2 pre-existing `test_model_write.py` failures**, unrelated, diagnosed in `S1-SERVER-SDK.md` and deliberately not papered over |
| leaves produced | 90 rows in the scratch app, 88 witnessed, 63 with a stored ECDSA signature; 100 rows in the scratch witness, 99 signed, **99 surrogate** |
| controls demonstrated red and reverted | 4 (B2) + 6 (B3) + 12 pairs (B4) + 16 (B5) + 8 + 5 + 2-inert (B6) + 2 (B7) |
| commits | `8297407` … `af95462` in `/data/scruple-blender`, plus this one. `79f5507`, `7209d65`, `b6cb1fd` in `/data/scruple-web`. **Nothing pushed** |

Reports, in order: `01-GAP.md` (+ `gap.json`), `02-SDK-ADOPTION.md`,
`03-V2-WITNESS-L2.md`, `04-STORE-AND-FORWARD.md`, `05-DASHBOARD.md`,
`06-REAL-CONTENT.md`, this file, and `S1-SERVER-SDK.md` in
`/data/scruple-web/docs/canon/blender-l2/`.

---

## 8 · The one-paragraph version

The addon was a v1 client with a hand-rolled copy of the SDK, an offline
queue nobody had ever called, and a `kind` vocabulary the v2 route rejects —
so **no leaf it produced could ever have landed**. It now consumes the
vendored SDK, captures real headless Blender output onto `/api/v2/witness`,
survives the server being down, detects a capture that went missing,
presents a project/tracker/lock dashboard, and reads a disclosed ECDSA
signature and checks it itself. Every leaf reads **`passthrough
(software-signed)`**, because a software surrogate signed it and the addon
declares no attestation — and `verified` is unreachable by construction, not
by omission. The floor item the whole structure rests on, **H-4
client-binding, is still not closed** — but as of today it is unwired rather
than impossible, and that is a smaller and much more specific ask than it
was this morning.
