# Scruple Desktop Studio — state of the thing

_2026-09-09, end of the WO-D series. Written to be read by someone deciding
what to do next, so it separates what was measured from what was merely built,
and it separates "done" from "done against the surrogate"._

The rule this document is written under: **every claim names the observable that
established it.** Where there is no observable there is no claim, and the item
is under "built but unproven" instead.

---

## 0. The one sentence that matters most

⚑ **Blender is not installed in this app.** There is no Blender launcher, no
Blender adapter and no Blender scene in any leaf. `/usr/bin/blender` exists on
this box and this app has never spoken to it. What WO-D6 built is the
**host-agnostic hook** Blender will plug into, and what proves it is a host we
invented — `phantom-cam`, a fixture in `scripts/desktop-run.mjs` that writes the
two files a Level-2 host writes and nothing else. That was deliberate:
docs/DESIGN.md says "Blender is the first consumer of this hook, not a special
case", and a hook that could only be satisfied by the host we happen to have
would be testing the special case.

The app says so itself, where a user would look: `app/ipc-profile.js` reports
Blender as `available: false`, `detail: "not installed in this app yet"`, beside
Kohya's `"the legacy training IPC has not been rewritten onto the SDK yet"`. A
dashboard that quietly omitted them would be the failure mode.

Blender is the next series. This one is the floor it stands on.

---

## 1. What works, and the observable that showed it

Every row was established by a command in `scripts/`, against the sandbox
(witness `:5899`, app `:3902`, surrogate `:8799`), with a control that had to
fire. Re-run all of them with `npm run gate`, which chains D1 … D7; or
`bash scripts/d7-gate.sh` for the whole flow on its own.

| what | the observable | the control that must not fire |
|---|---|---|
| **It runs headlessly.** Electron 38.8.6 · Chromium 140.0.7339.249 · Node 22.22.0, under `xvfb-run -a -s "-screen 0 1280x900x24"` | a scripted `ping` round trip carrying the main process's pid and a nonce minted in main and never injected into a page | pointed at a dead port the run FAILS; a preload that answers in the renderer is caught by `fake-bridge` |
| **A headless driver.** `scripts/desktop-run.mjs` drives a named scenario through the real IPC handlers — the desktop mirror of `scruple-run.ts` | side effects only: bytes on disk re-hashed by the driver, rows in the witness's own sqlite file, an exit code | `--audit` breaks each run once per mutation and requires EXACTLY the declared assertions to redden; `assert-expectation` proves an assertion can fail at all |
| **The vault**, rebuilt on the SDK's `ObservationSink` — a directory enumerated, typed by DECLARED MIME, hashed as a unit | leaves in the scratch witness whose content hashes re-hash from the bytes on disk | an undeclared file is REFUSED with `refused_mime_undeclared` and has **no leaf**; over-ceiling is refused as a recorded outcome, not skipped; an ordinary file is still accepted |
| **The gate in the path**, with ComfyUI launched by this app under a base directory it owns | a generation's leaf carries `model_fingerprints` computed from the model FILES | `model-swap` changes the bytes and keeps the filename, and the fingerprint changes — the entire product claim |
| **The canon design on the shared implementation.** 21 tokens ported into `/data/scruple-web`'s theme; the dashboard renders from `GET /api/v2/capabilities` | `getComputedStyle` in the real window — the layout engine's own answer, after the cascade | a region that does not apply is ABSENT: `count === 0` **and** the string occurs zero times in the serialised document |
| **The ComfyUI hook, host-agnostic.** Level 1 free, Level 2 by registered adapter | three real leaves reading `supplied`, `blind` and `declined`, compared from the shell | a Level-1 leaf DECLARES its blindness rather than being a thinner leaf; a host that forges a grade on its declaration is refused and the refusal is recorded |
| **The whole flow** — launch · gate · generate · vault · witness · receipt · C2PA — in one app, one launch | `bash scripts/d7-gate.sh`; the table below | four controls, §3 |

### The flow, printed

One line per **leaf** — a generation makes two, because the gate observes the
graph and the output. Every column is measured by the driver: the digest from
the bytes on disk, the leaf from the witness's own file, the basis from the
app's database, the last two columns over the public HTTP routes.

```
STATION     ARTIFACT                  CONTENT       REHASH  LEAF  LEAFHASH      BASIS  PROFILE           SEM       RCPT  RESOLVE
generate    artifact                  0d4b5fe3db3a  ok      588   1632f0cc2d83  stale  isolated-sidecar  supplied  200   resolvable
generate    artifact                  0d4b5fe3db3a  ok      589   c09f322e0ca9  stale  isolated-sidecar  supplied  200   resolvable
credential  staged copy               0d4b5fe3db3a  ok      588   1632f0cc2d83  stale  isolated-sidecar  supplied  200   resolvable
credential  staged copy               0d4b5fe3db3a  ok      589   c09f322e0ca9  stale  isolated-sidecar  supplied  200   resolvable
vault       accepted.png              ed5370081ece  ok      590   b3932d31122b  stale  desktop           blind     200   resolvable
vault       config.toml               780e3586e6f1  ok      592   35289963ed51  stale  desktop           blind     200   resolvable
vault       captions.txt              c7d60a6c2b64  ok      591   d234e1a1991a  stale  desktop           blind     200   resolvable
vault       manifest                  d73d77c76b42  ok      593   a2501dc50f59  stale  desktop           blind     200   resolvable
vault       undeclared.png (refused)  265fbb1b9e92  ok      NONE                                         -
```

**6 leaves** (the work order asks for at least 5), every artifact re-hashes,
every receipt resolves, and every basis reads `stale` — never `verified`. The
last row is the one that is supposed to have no leaf.

The two `credential` rows are the same bytes as the two `generate` rows, and
that is the point: **the bytes that were signed are the bytes that were
witnessed.** They appear twice because the run store is content-addressed and
the signer types an asset from its path, so the artifact is staged under the
filename ComfyUI gave it and the copy is re-hashed before anything is signed.

---

## 2. Done, versus done against the surrogate

🔴 **The surrogate is SOFTWARE-backed.** Nothing below is hardware-protected,
and no leaf in this repo has ever read `verified`.

| station | done | done against the surrogate | what production would change |
|---|---|---|---|
| capture, MAC, ratchet, queue | ✅ real | — | nothing; this is the same code the server ships |
| witness leaf (HMAC seal) | ✅ real | — | nothing |
| **witness leaf ECDSA signature (H-1)** | ❌ **not exercised at all** | — | see §4.1 — the scratch witness runs with leaf signing `disabled`, so every leaf here reads `signature.state: unsigned` and `independently_verifiable: false` |
| **C2PA credential** | ✅ produced, and it validates | ⚠️ **signed by the surrogate** — `signing_mode: kms-http`, `signer_identity: … surrogate=true` | a real OCI Vault key with instance-principal credentials, and a certificate chain someone has reason to trust |
| C2PA trust | — | ⚠️ `signingCredential.untrusted` on every credential, correctly | a real cert chain. This status is the honest one for a dev root and it must not be papered over |
| attestation basis | ✅ recorded per leaf | `stale` on every leaf | see §4.2 — this is an estate-wide condition (WO-C6), not a desktop one |
| `verified` | 🔴 unrepresentable | 🔴 unrepresentable | unchanged, by design, on the desktop profile |

**What "signed by the surrogate" was proved to mean.** `scripts/d7-gate.sh`
stage 2 stops the surrogate and signs again: the signature FAILS. There is no
fall back to a local key. If it had succeeded, the surrogate was never the
signer and the phrase would be a label.

---

## 3. The four controls behind the WO-D7 gate

A green assertion with no control proves only that it cannot fail.

1. **`tamper-the-artifact`** — one byte of the stored artifact is flipped AFTER
   the run. `EVERY-ARTIFACT-REHASHES` goes red and **nothing else does**: the
   leaf, the receipt, the resolution and the basis all stay green, because the
   leaf recorded what the bytes WERE and the file on disk is now something
   else. That is the correct outcome, and it is why the re-hash is a separate
   assertion from the leaf's existence.
2. **An unissued leaf must not resolve** — leaf `99000000` answers
   `unresolvable` / 404 while a leaf this run made answers `resolvable` / 200.
   Both directions, from the shell.
3. **The database refuses `verified` on a desktop leaf** — demonstrated on a
   COPY of the scratch schema, and the same INSERT with an honest basis is
   ACCEPTED, so the refusal is the CHECK constraint and not a broken statement.
4. **The certificate control** — see §4.3. It was RED before this work order
   and is GREEN after, and it is the most useful thing WO-D7 found.

⚑ **Two of these controls were wrong on their first run, and the gate caught
its own.** Recorded because a gate that has never been wrong has probably never
been checked:

- The `verified` control (3) copied the newest leaf row verbatim, so both its
  INSERTs collided on `UNIQUE(project_id, run_sequence)` and the *honest* one
  came back REFUSED for a reason that had nothing to do with the constraint
  under test. A control that fails for the wrong reason is not a control. It
  now takes a fresh sequence per attempt, and the honest INSERT is ACCEPTED.
- The surrogate-down control (§2) waited a bounded number of seconds on `ss`
  and then signed regardless of what it found. On one run the surrogate had not
  finished dying, the signature succeeded against a live surrogate, and the
  control printed "it signed anyway" — scoring a FAIL for a run in which the
  control had never actually run. It now waits for `/health` to stop answering
  and, if the surrogate is still up, says **INCONCLUSIVE** rather than passing
  or failing. An inconclusive control must never be scored either way.

  It also means the very first version of this control — which truncated the
  signer's output before reading it — passed vacuously. That is the failure
  mode the whole audit-sweep discipline exists to catch, and it happened here.

---

## 4. What is honestly missing

### 4.1 The leaves in this sandbox are not independently verifiable

`GET /api/v2/verify/{hash}` reports `independently_verifiable: false` and
`signature.state: unsigned` for every leaf this flow makes. The reason is
configuration, not code: the scratch witness on `:5899` runs with H-1 signing in
its default `disabled` mode (`SCRUPLE_WITNESS_KMS_ENDPOINT` and
`SCRUPLE_WITNESS_KMS_KEY_OCID` are unset in its environment), so leaves carry
the HMAC transport seal alone — which Scruple can forge and nobody else can
check.

This was NOT fixed here, deliberately: the witness process runs from
`/opt/scruple-witness`, and the rails for this series forbid touching it.
Enabling H-1 on the sandbox means restarting that process with two variables
pointed at `:8799`; it is a five-minute job for whoever owns that box, and it
would make the desktop flow's leaves surrogate-signed in the same sense the
credential already is.

**Needs: a human with authority over the sandbox witness process.**

### 4.2 Every leaf reads `stale`, and that is not the desktop's fault

The gate's own log says why: *"the witness and the verifier do not pass shared
Merkle vectors (canonical preimage, domain separation, tree ordering, root
calculation, proof format). Three live constructions disagree and the witness
anchors whichever root the caller supplies, so no checkpoint can be claimed
settled and every new leaf states `stale`."* That is WO-C6 on the server side,
and it pins every leaf in the estate — desktop or not.

On the desktop profile there is a second, permanent reason: the measured party
has root, and `verified` is unreachable by construction. The two reasons are
separately recorded and both appear in the basis string.

**Needs: the founder.** Whether to converge the three Merkle constructions is an
estate-level decision, not a desktop one.

### 4.3 ⚑ FOUND HERE: the C2PA signer will embed a certificate for a key that did not sign

With `SCRUPLE_C2PA_VAULT_KEY_OCID` + `SCRUPLE_C2PA_KMS_ENDPOINT` set, the signer
signs through the surrogate — a **different key** from the local dev one — and
still embeds `services/c2pa-signer/keys/signer.pem`, the certificate issued for
the LOCAL key. Nothing checks that the two agree. The route answers `ok: true`,
`signing_mode: kms-http`, and `c2pa.Reader` answers:

```
['signingCredential.untrusted', 'claimSignature.mismatch']
```

— a credential nothing can verify, produced by a call that reported success. It
is silent, and an operator switching to KMS signing would have no way to notice
short of reading a manifest back.

**Worked around here, not fixed at the source.**
`scripts/d7-surrogate-cert.sh` issues a leaf certificate whose public key IS the
surrogate's (from its own `/testnet/pubkey.pem`; the private half is never
touched) and the sandbox app is pointed at it, after which the same signature
validates:

```
['signingCredential.untrusted']
```

That is the correct residual status for a dev root and it must stay.

**Needs: a decision, then a small change on the server.** The fix belongs in
`lib/c2pa/signAsset.ts` or `services/c2pa-signer/sign.py`: compare the
certificate's public key against the public half of the signing key before
signing, and REFUSE on a mismatch with a named code. This work order did not
make that change — it is the server's signing path, it affects every caller
including Fusion, and it deserves its own control rather than being smuggled in
under a desktop work order.

### 4.4 A desktop artifact cannot earn a credential above tier `bare`

`POST /api/scruple/c2pa/sign` refuses tiers `witnessed`/`local`/`chain` with
*"project has no SCR-ID (never witnessed)"*, and it is right to: those tiers
build a Scruple assertion out of `projects.scr_id`, `merkle_root` and
`lock_server_signature`, which only the legacy lock routes (`/api/lock/local`,
`/api/lock/chain`) ever set. The v2 witness door does not.

So the credential this flow produces **carries no Scruple assertion binding it
to the leaf.** The binding exists in the other direction — the sign request
names the iteration, and the response returns its `leaf_hash` — but a verifier
holding only the signed file cannot follow it.

The refusal is asserted positively by the gate (`TIER-ABOVE-BARE-IS-REFUSED`)
because the failure mode worth preventing is the opposite one: a signer
producing a credential that claims a tier it cannot substantiate.

**Needs: the founder.** "How does a desktop project earn an SCR-ID under the v2
door" is a product question about what a lock tier means now that the v0 lock
routes are retired (docs/DESIGN.md, "what is kept, what is replaced").

### 4.5 The sign event's own audit leaf is not emitted here

Every credential comes back with
`witness_error: "stream scruple.c2pa.sign not found — run scripts/seed-c2pa-stream.mjs"`.
The internal-tenant stream is unseeded on the scratch deployment and its ingest
(`SCRUPLE_INTERNAL_INGEST_BASE`, default `localhost:3005`) is not running here.
The route is fail-open by design — not emitting the leaf must never block the
credential — and it reports the error rather than hiding it.

🔴 Not seeded here on purpose: the only other thing listening in that range on
this box is `:3001`, which the rails forbid contacting. Whoever seeds it should
confirm what the ingest base points at first.

Probing this left one artefact behind: `/data/scruple-web/data/witness/` holds
the internal tenant's auto-provisioned dev credentials, written by the route's
first-use fallback. It is untracked, it is dev-only, and it is not this repo's.

**Needs: a human, in an environment where that ingest is running.**

### 4.6 The desktop and the signer share a filesystem, and a real split would not

`asset_path` is a path **on the signer host**. In this sandbox the desktop and
the Next server are the same box, so handing over a path works. A real desktop
talking to a real server would have to upload the bytes, and the signed asset
would have to come back over the wire rather than being read out of the
server's `TMPDIR`.

Nothing about the custody claim changes — the key stays where the desktop cannot
reach it either way — but the transport is unwritten.

**Needs: a work order.** It is small and it is not proved here.

---

## 5. Built but unproven

Things that exist in this repo and have no observable behind them yet:

- **`app/ipc-profile.js`'s host facts under a real user.** WO-D5 proves the
  dashboard renders the desktop shape from a real window and that inapplicable
  regions are absent. What is not proved is a human looking at it: there is no
  display on this box, and `docs/DESIGN.md` records that a screenshot under
  llvmpipe comes back blank, verified three ways. Nothing here has ever been
  gated on a pixel and nothing should be.
- **Store-and-forward under a witness that is actually down.** The queue exists
  and drains (`queueDepth: 0` on every run), and docs/DESIGN.md is explicit that
  it must not be deleted. A run against a stopped witness, asserting that the
  artifact is still delivered and the leaf arrives afterwards, has not been
  written.
- **Kohya.** `GET /api/v2/capabilities` reports it and nothing launches it.
- **Everything in `app-legacy/`.** Five IPC handler modules — lock, project,
  settings, training, wallet — are the seam the preload bridge will expose and
  none has been rewritten onto the SDK. `app-legacy/lock/merkle.js` is retired
  by WO-C6's cutover and should not be revived at all.

---

## 6. What needs a human before anything else

🔴 **The wallet.** 18 files under `app-legacy/wallet/` touching private keys,
mnemonics and WIF, plus `app-legacy/ipc/ipc-wallet-handlers.js`. docs/DESIGN.md
requires a security review **before** any of it is revived, and the reason is
worth restating: an Electron app holding spending keys is a different posture
from a gate holding a signing key, and it should not be inherited simply because
it was already in the box. Nothing in the D-series has touched it. Nothing
should, until that review happens.

Also for a human, in rough order of how cheap the fix is:

1. Enable H-1 leaf signing on the sandbox witness (§4.1) — five minutes, and it
   upgrades every leaf this flow makes.
2. Decide on the cert/key mismatch guard (§4.3) — small change, real defect,
   affects Fusion as well as desktop.
3. Seed the `scruple.c2pa.sign` stream where its ingest actually runs (§4.5).

For the founder:

1. The Merkle construction disagreement that pins every leaf at `stale` (§4.2).
2. What a lock tier means under the v2 door, and how a desktop project earns an
   SCR-ID (§4.4).
3. The real trust anchor — an OCI Vault key and a certificate chain — without
   which every credential this product issues reads
   `signingCredential.untrusted`, correctly.

---

## 7. The suites, as of this writing

Desktop, `npm run gate`: D1 ✅ D2 ✅ D3 ✅ D4 ✅ D5 ✅ D6 ✅ D7 ✅ — every gate
with its own controls firing.

Server (`/data/scruple-web`), unchanged by this work order and run to prove it:

| suite | result |
|---|---|
| `npm run test:v2` | **863 pass, 0 fail** |
| `npm run test:conformance` | **47 pass, 0 fail** |
| `npm run test:integration` | **19 pass, 0 fail** |
| `npm run test:sdk` | 214 pass, **2 fail** — `test_model_write.py`, pre-existing and recorded by WO-D6 before this work order began |

⚑ WO-D7 changed **no server code**. The only thing it changed about the server
is how the sandbox app on `:3902` is *launched* — three environment variables
so it signs through the surrogate (§4.3) — and `scripts/d7-app-signing.sh`
re-applies that, and proves it by signing.

---

## 8. How to re-establish all of this from scratch

```bash
cd /mnt/corpus/scruple-desktop
npm install                       # electron 38.8.6
npm run gate                      # WO-D1 … WO-D7, each with its controls
bash scripts/d7-gate.sh           # the whole flow on its own, and the D7 controls
```

`scripts/d7-gate.sh` restarts the sandbox app on `:3902` if it is not already
signing through the surrogate, and it proves that by SIGNING rather than by
reading an environment variable. It leaves the surrogate running.
