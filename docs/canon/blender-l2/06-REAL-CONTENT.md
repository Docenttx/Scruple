# WO-B6 — Real content, end to end

_2026-09-07. Blender 3.0.1 (Python 3.10.12), headless, Cycles CPU, on the
scratch stack: app `:3902`, witness `:5899`, CVM surrogate `:8799`.
Production (`:5799`, `:3001`) was never contacted._

Fourteen leaves from two runs of the same harness, seven each. Four
distinct Cycles renders, one `.blend` save and two mesh exports per run.
Every artifact re-hashed from disk, every receipt fetched, every leaf
read out of both databases, four PNG/JPEG renders C2PA-signed against the
surrogate and read back `Valid`, and the whole integration graded by
`@scruple/conformance`.

**Every leaf in both runs is `passthrough (software-signed)`. None is
`verified`, and none claims hardware backing.** That is the honest answer
and the run asserts it rather than hoping for it.

---

## The gate

> at least 5 leaves from at least 3 distinct renders. For each: the
> artifact exists on disk, its bytes re-hash to the recorded
> `content_hash`, the receipt fetches, and the assurance tier is recorded
> honestly. Print the table.

**7 leaves. 4 distinct renders.** The table below is the
`key-address-published` run, reproduced from
`06-evidence-key-address-published.json`.

| leaf | kind | mime | artifact | bytes | re-hash == `content_hash` | receipt | seal | checked here | tier |
|---|---|---|---|---:|---|---|---|---|---|
| 76 | render | `image/png` | `torus.png` | 10,496 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 77 | render | `image/png` | `monkey.png` | 15,851 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 78 | render | `image/png` | `cone.png` | 9,067 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 79 | render | `image/jpeg` | `sphere.jpg` | 1,534 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 80 | save | `application/x-blender` | `b6-scene.blend` | 429,620 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 81 | export | `model/obj` | `b6-scene.obj` | 6,961 | **YES** | yes | signed | verified here | passthrough (software-signed) |
| 82 | export | `model/stl` | `b6-scene.stl` | 4,084 | **YES** | yes | signed | verified here | passthrough (software-signed) |

Four MIMEs, all **declared** and never sniffed. The renders differ in
geometry, sample count, resolution *and* container, so four leaves are
four different content hashes rather than one file witnessed four times.

**Re-derived from the shell, outside the harness process** — the artifacts
re-hashed with `hashlib`, the rows read from `scruple-scratch.db` and
`witness-scratch.db`, and each signature verified against the key served
by `:5899/api/signer/pubkey`:

```
leaf rehash app.output_hash wit.row sig==wit  ecdsa  tier
  76    YES             YES     YES      YES    YES  passthrough (software-signed)
  ...  (all seven identical)
leaves: 7 | distinct render hashes: 4 | surrogate flag on every app row: True
```

`sig==wit` is the column that distinguishes a field the application tier
**copied** from one it invented: the signature on the `iterations` row is
byte-identical to the one in the witness server's own `witnesses` table,
which is where it came from.

---

## C2PA, signed against the surrogate

Four credentials, through `services/c2pa-signer/sign.py` **unmodified** —
the same subprocess `lib/c2pa/signAsset.ts` spawns, with the same job
spec. Not a lookalike built for this report.

| leaf | source | signed asset | bytes | `signing_mode` | readback |
|---|---|---|---:|---|---|
| 76 | `torus.png` | `torus.png.c2pa.png` | 45,508 | `kms-http` | **Valid** |
| 77 | `monkey.png` | `monkey.png.c2pa.png` | 59,097 | `kms-http` | **Valid** |
| 78 | `cone.png` | `cone.png.c2pa.png` | 43,361 | `kms-http` | **Valid** |
| 79 | `sphere.jpg` | `sphere.jpg.c2pa.jpg` | 38,276 | `kms-http` | **Valid** |

```
signer_identity: kms-http:http://127.0.0.1:8799:...arealkey surrogate=true message_type=RAW
signature_info:  {"alg":"Es256","issuer":"Scruple B6 Surrogate Signing Cert",
                  "common_name":"Scruple CVM Surrogate Signer"}
```

The private key never entered the signing process. `sign.py` called
`/20180608/sign` on the surrogate for every signature; the surrogate holds
the key and `surrogate_cert.py` minted a leaf certificate over its
**published public key**, so the certificate binds the key that actually
signed. Each manifest carries an `ai.scruple.provenance` assertion with
the leaf id, leaf hash, content hash, baseline ref, assurance tier and:

```json
"signer_protection_mode": "SOFTWARE",
"hardware_backed": false,
"note": "the surrogate reports protectionMode='SOFTWARE' for ocid1.key...surrogate...
         A certificate cannot attest key custody, so nothing in this chain claims any."
```

`SOFTWARE` was read off `GET /20180608/keys/{ocid}` at mint time, not
typed into the harness. The signed asset's bytes necessarily differ from
the witnessed bytes — embedding a manifest changes the file — and the
evidence records `differs_from_witnessed_bytes: true` so the two hashes
are not read as one broken one.

### What it took, and what that says

Three things were in the way, and all three are findings rather than
setup.

**There was no mode that could reach the surrogate.** `vault_sign.py` had
`vault` (needs the `oci` SDK — not installed — and instance-principal
credentials) and `local` (this process holds the key). Neither is "a key
this process does not hold, reachable today". `kms-http` was added,
copying the witness server's `leaf_signer.js`, which has had exactly that
mode since H-1. Committed in `/data/scruple-web` at `b6cb1fd`.

**The production-signer guard fired on the wrong machine.**
`_is_production_signer()` reads the vault OCID as a proxy for "routes
through OCI Vault". `kms-http` sets the same OCID. The age guard then read
*this app-tier VM's* IMDS, found it 156.58 days old, and refused to sign:

```
{"ok": false, "error": "signer age guard refused sign",
 "guard": {"refuse": true, "age_days": 156.57, "max_age_days": 60.0,
           "imds_available": true}}
```

The refusal was the visible half. The invisible half is worse:
`runtime_assertion()` would then have stamped this host's instance and
image OCIDs into a signed C2PA manifest as the signing runtime — a false
claim about the signing environment, signed, inside a credential third
parties verify. `SCRUPLE_C2PA_FORCE_DEV=1` would have silenced it and also
disarmed `/dev/sev-guest`, the signal that is actually about hardware. So
kms-http now falls through to that signal alone.

**c2pa-rs refuses a leaf certificate with no AuthorityKeyIdentifier.**
`Signature: the certificate is invalid`, raised before any signature is
computed. `openssl x509 -req` emits AKI by default, so the dev chain has
one and `regen-dev-cert.sh` never had to mention it; a chain built with
`cryptography` does not. Measured: identical chain minus that one
extension fails, with it succeeds.

---

## The addon's own C2PA button, on the same leaf, at the same moment

```json
{"leaf_id": "76", "modalities_applied": ["local"],
 "outstanding": [{"modality": "c2pa",
   "reason": "The Signer CVM is not running. Nothing was signed and nothing
              was charged..."}]}
```

`GET /api/v2/capabilities?host=blender&mime=image/png` answers
`c2pa: available: true`. `POST /api/v2/mark` then returns that reason
**unconditionally** — the branch never attempts a signature, so a running
signer makes no difference to the answer. A surrogate was reachable and
answering at `127.0.0.1:8799` when this was recorded, and four credentials
were signed against it in the same process, minutes apart.

The message is not false — the Signer *CVM* is indeed down — but it is the
wrong sentence for the state the system is in, and no operator reading it
would learn that the modality is unwired rather than unavailable. Wiring
`app/api/v2/mark/route.ts` to call the signer is a scruple-web change and
is **not** done here; B6's scope is the addon, and the WO that owns that
route should decide whether an outstanding reason may be computed from
signer reachability.

---

## The assurance tier, and the bug that was hiding it

WO-S1 landed migration 052 and made `/api/v2/receipt` disclose the seal.
The addon could not read it: `with_receipt` looked for **top-level**
`leaf_signature`, S1 emits the fields **nested** under `signature`, and
the flat reader matched nothing. Every leaf came back `undisclosed` while
the receipt in the same function's argument said:

```json
"signature": {"state": "signed", "key_protection": "software",
              "leaf_signer_surrogate": true, "leaf_signature": "MEYCIQ..."}
```

That is not a conservative failure. `undisclosed` says *nobody told us*;
the server did tell us, and it told us the key was SOFTWARE. Fixed in
`adapter/assurance.py::_signature_from_receipt`, which reads both shapes
— a deployment on the pre-S1 build is still a deployment.

Three tiers that used to collapse now do not:

| state | tier | means |
|---|---|---|
| `signed` + `key_protection: software` | `passthrough (software-signed)` | a surrogate signed it |
| `unsigned` | `unsigned (Scruple audit record only)` | the witness answered and had none |
| `unknown` / no disclosure | `undisclosed` | nobody asked, nobody answered |
| checked here and rejected | `SIGNATURE DID NOT VERIFY` | ordered first, so nothing can dress it up |

`verified` remains unreachable and should: it needs an attestation the
server verified *and* a signature, and Blender declares no attestation
provider. A tier computed from the signature alone would read as the
attestation.

### The client now checks the signature itself

`assurance.check_signature` verifies the disclosed ECDSA signature against
the key the **receipt names**, using the **receipt's** instructions for
what was signed over — the 32 raw bytes of `leaf_hash`, not the 64-character
hex spelling, a distinction that produces a clean failure indistinguishable
from tampering if got wrong. `independently_verifiable_checked` is no
longer a hardcoded `False`.

The key is fetched through the SDK, never the adapter:
`http.fetch_published_key` sends no API key, is not queued, refuses any
scheme outside `http`/`https`, and does not choose the URL. A signature
checked against a key of the checker's choosing is not a check.

### One environment variable moves the honesty of every leaf

The two runs differ **only** in `SCRUPLE_WITNESS_PUBLIC_URL` on the app.

| | `verification.public_key_url` | `checked_ok` | tier |
|---|---|---|---|
| `06-evidence-key-address-unpublished.json` | `null` | `None` | passthrough (software-signed) |
| `06-evidence-key-address-published.json` | `http://127.0.0.1:5899/api/signer/pubkey` | `True` | passthrough (software-signed) |

Unset — which is the deployment default — the client holds a signature it
cannot check, while the same receipt reports `independently_verifiable:
true`. It says so rather than pretending:

> the receipt published no address for the verifying key
> (`signature.verification.public_key_url` is null), so this client has
> nothing to fetch. It will not guess one.

The tier does not move between the two runs, and that is correct: what
changed is whether the evidence could be *tested*, not what it is worth.

### The canonicalization labels still disagree, and are now visible

Every leaf: `canonicalization_profile` client `jcs-1`, server `jcs-2`.
WO-B3 measured the digests agreeing byte-for-byte and predicted the label
divergence; S1's receipt is the first surface that lets a client see it.
The label is what an auditor reads to know which rule to replay.

---

## Controls

Every must-fire check is paired with a must-NOT-fire control. A green test
with no control proves only that it cannot fail.

| # | control | result |
|---|---|---|
| C1 | one pixel of `torus.png` flipped with Blender's own image API, re-saved as a real PNG | original `found: true`; altered `found: false`. `71ea39c2…` vs `a16b2453…` |
| C2 | one byte of the DER signature flipped, run through the addon's own `check_signature` | `checked_ok: false`, tier `SIGNATURE DID NOT VERIFY`, note "the published key did not verify this signature" |
| C2′ | the same, in the run where no key address is published | **both** the good and the tampered signature come back `not checked`. Asserting "rejected" there would assert that a check which never ran came out right |
| C3 | a byte flipped deep in a signed C2PA asset | signed `Valid` → tampered **`Invalid`** |
| C4 | the surrogate's certificate used with the **local** key | readback **`Invalid`** |
| — | no leaf claims `verified` | asserted, all 14 |
| — | no leaf claims hardware backing | asserted, all 14 |
| — | every C2PA signature used `kms-http` with `surrogate=true` | asserted, all 8 |

**C4 is also a finding.** `sign.py` returned `ok: true` for a credential
whose certificate does not bind the key that signed it. Under
`SCRUPLE_C2PA_DEV=1`, `verify.verify_after_sign` is `false`, so the signer
emits an unverifiable credential and reports success; only the reader
catches it. That the *reader* catches it is what makes "signed against the
surrogate" a falsifiable claim rather than a label.

### Mutation sweep — 8 of 8 caught

`06-mutate.py`, log in `06-mutation-sweep.log`. Break one thing, name the
test that must fail, revert. Baseline and post-revert both **306 passed**.

```
CAUGHT  the nested S1 disclosure is ignored again
CAUGHT  check_signature never calls verify -- it just decodes the base64
CAUGHT  a network outage is reported as a bad signature
CAUGHT  a failed check no longer changes the tier
CAUGHT  the server's claim zeroes the client's own check
CAUGHT  `unsigned` collapses back into the generic tier
CAUGHT  the key fetch accepts file://
CAUGHT  the key fetch forwards the tenant API key
```

Two of these were `MISSED` on the first sweep and both are recorded
because the reasons differ:

- *check_signature short-circuits to True* was a **bad mutation** — the
  injected early return sat after a line the tampered case never reaches.
  Re-aimed at `pub.verify` itself.
- *the key fetch accepts `file://`* was a **weak test**. With the scheme
  guard removed, `urlopen` opens the file quite happily, `getcode()`
  returns `None`, and the `!= 200` branch raises the *same* exception
  class — so `pytest.raises(ScrupleTransportError)` stayed green while the
  client read `/etc/passwd` on the way past. The test now asserts the
  guard's message, not the type.

The distinction that matters: **`checked_ok` has three values, not two.**
`False` is "tested here and rejected". `None` is "not tested" — the key
server was unreachable, or no address was published. An outage reported as
a bad signature is an accusation of tampering, and the mutation that
collapses the two is caught.

---

## The conformance grade

`tests/conformance/run.sh` — derived from source, pinned to a commit, with
the same rule `packages/scruple-conformance/src/studio.ts` opens with: no
hand-written booleans, every anchor named, a missing anchor **throws**
rather than defaulting to the flattering value. It threw twice during
development and both times it was right.

Graded against the **server's** registered `blender` profile
(`lib/capture/surface.ts`), not one the addon wrote about itself.

| item | | |
|---|---|---|
| **P1** runtime boundary integrity | **FAIL** | `unattested-client`: the measured party can modify the capture code and reach its key |
| **P2** pipeline seal | **FAIL** (never sealed) | nothing describes a seal state for this deployment |
| **P3** API key custody | **FAIL** | the credential is a file on the user's own machine |
| **P4** principal identity | **FAIL** (derived from P3) | a bearer key the measured party holds |
| **P5** immutable event chain | **PASS** | nothing mutates or deletes prior leaves |
| **P6** zero-content posture | **PASS** | hashes and small metadata only; no payload bytes leave |
| **P7** attestation declaration | **FAIL** | a baseline exists and declares no provider |
| **P8** attestation import | n/a | imports none |

`compliant: false`, `lifecycle: integrating`, `classScope.inScope: true`,
`liveness: not-applicable`. Pinned to addon `c7ba1ed`. The `web_commit`
reads `b6cb1fd (WORKING TREE — dirty)`: `/data/scruple-web` carries an
unrelated `tsconfig.json` reformat that predates this WO and is not
committed here, so the grade says so rather than citing a commit that is
not what it read.

**Not compliant is the expected answer, and a compliant grade would mean
the harness is broken.** The registered profile is `attested-client` /
`enforcement: none` / `attestation: none`; `resolvePlacement` degrades that
to `unattested-client`, and at that placement `assuranceFor` fails P1 and
P3 outright. Same reasoning `conformance.test.ts` applies to Studio's two
published FAILs.

### The grader's own controls

Five mutations must move the cell they name — all five did:

```
MOVED  P1  FAIL -> PASS-CONDITIONAL  the zip is host-signed
MOVED  P3  FAIL -> PASS              placement fixed AND the key is out of reach
MOVED  P4  FAIL -> PASS              the principal comes from a server-side session
MOVED  P6  PASS -> FAIL              the capture carries payload bytes
MOVED  P5  PASS -> FAIL              no leaf is created at all
```

Two must **not** move, and the reason is the finding:

```
INERT  P1  FAIL -> FAIL   attestation becomes verified while the zip stays unsigned
INERT  P3  FAIL -> FAIL   the key moves out of reach while the zip stays unsigned
```

Both were written as ordinary mutations first and reported `NO CHANGE`.
They are kept, named as inert and asserted to be inert, because deleting
them would delete the answer: **no attestation evidence and no key-custody
improvement can move Blender's P1 or P3 while `build/build_addon.sh` has
no signing step.** `attested-client` requires `host-enforced-signature`
(`surface.ts`, `REQUIRED_ENFORCEMENT`), and signing the zip is the single
change that unlocks both.

### A finding the derivation turned up

**Every capture base64-encodes the whole artifact and nothing reads it.**
`capture()` returns `inline_base64: inline_base64(path)`; `witness()`
builds its body from `content_hash` alone and never looks at the field,
and no caller in the addon does either. So every witnessed save
materialises a full copy of the artifact in the process — 573 KB of base64
for the 429 KB `.blend` above — and discards it.

**This is not a P6 failure**, and the first cut of the derivation would
have reported it as one: it anchored on `capture()`, found the base64, and
would have graded Blender as carrying payload bytes. P6 asks what leaves
the machine. The anchor is now the dict that becomes the POST body, and
the encoding is reported as what it is — a cost, and a copy of user
content sitting in memory for no reason.

---

## What was changed

**`/data/scruple-blender`** (this repo):

- `adapter/assurance.py` — read S1's nested disclosure (both shapes);
  `state` / `key_protection` / `verification` on `SignatureRecord`;
  `check_signature`; four honest tiers where there were two.
- `adapter/flow.py` — `resolve_assurance` checks the seal, through
  `client.published_key`. The adapter opens no socket of its own; the
  AST scan in `test_sdk_adoption.py` enforces that and caught the first
  attempt, which put `urlopen` in `flow.py`.
- `tests/test_signature_check.py` — 15 tests, every must-fire paired.
- `tests/live/real_content_e2e_in_blender.py`, `tests/live/surrogate_cert.py`
- `tests/conformance/{derive_blender.ts,grade_blender.ts,run.sh}`
- `vendor/` re-vendored from `b6cb1fd` (was drifted: S1 changed four SDK
  files and the vendored copy still held the pre-S1 bytes, which
  `test_sdk_adoption.py` was failing on before this WO started).

**`/data/scruple-web`** at `b6cb1fd`, and this is outside the addon:
`kms-http` mode in `vault_sign.py`, the production-signer narrowing in
`signer_runtime.py`, `http.fetch_published_key` +
`Client.published_key`, and `test_kms_http_mode.py` (8 tests). Each is
something the client could not reach from here; none could be done in the
addon. Flagged rather than buried — the WO's scope is the addon.

## Suite

`306 passed` (was 291 at the start of this WO; 288 + 3 failing on the
vendor drift). `services/c2pa-signer/tests`: `118 passed`.

Two pre-existing failures in
`packages/scruple-host-sdk/tests/test_model_write.py`
(`test_the_dataset_lands_on_input_hash_with_the_shipped_formula`,
`test_a_float_cannot_sneak_into_a_fixed_order_preimage`) are unrelated to
this WO and fail identically at `7209d65`, checked against a pristine
`git archive` of that commit.

## Reproduce

```bash
cd /mnt/corpus/scruple-blender-l2 && . ./env.sh
./b6-driver.sh app_down && ./b6-driver.sh app_up ""                       # or a witness URL
./b6-driver.sh phase key-address-unpublished
./b6-driver.sh app_down && ./b6-driver.sh app_up "http://127.0.0.1:5899"
./b6-driver.sh phase key-address-published

python3 tests/live/surrogate_cert.py /mnt/corpus/scruple-blender-l2/b6/certs
python3 /mnt/corpus/scruple-blender-l2/b6-mutate.py
tests/conformance/run.sh --json 06-conformance-grade.json
```

## Files

| | |
|---|---|
| `06-evidence-key-address-unpublished.json` | 7 leaves, no verifying-key address published |
| `06-evidence-key-address-published.json` | 7 leaves, every signature checked by the client |
| `06-conformance-grade.json` | the P1–P8 grade, its mutations and its inert pair |
| `06-mutation-sweep.log` / `06-mutate.py` | 8 of 8 caught, and the two first-pass misses |
| `06-surrogate-chain-info.json` | the minted chain, and `protectionMode` off the wire |
