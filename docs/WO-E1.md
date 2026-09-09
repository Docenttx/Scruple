# WO-E1 — the C2PA signer refuses a certificate it did not sign with

_2026-09-09. **Server repo change**, committed in `/data/scruple-web`:
`6aeee18`, `2420608`, `4361aef`, `ae89b7f` (parent `caf7bc4`)._
_Gate: `bash /data/scruple-web/scripts/e1-gate.sh` — needs the scratch app on
`:3902` and the surrogate on `:8799`. **4 pass, 0 fail.**_

## The defect, stated once

`docs/STATE.md` §4.3, found by WO-D7. With `SCRUPLE_C2PA_VAULT_KEY_OCID` and
`SCRUPLE_C2PA_KMS_ENDPOINT` set, `lib/c2pa/signAsset.ts` signs through the CVM
surrogate with one key and embeds `services/c2pa-signer/keys/signer.pem` — the
certificate issued for the **local** key — because `cert_path` is chosen
(`?? DEV_CERT`) independently of which key `vault_sign_es256` dispatches to.
Nothing compared them. The route answered `ok: true`, HTTP 200,
`signing_mode: kms-http`; `c2pa.Reader` answered `['claimSignature.mismatch',
'signingCredential.untrusted']` and `get_validation_state() == "Invalid"`.

A credential nothing can verify, from a call that reported success, and silent:
an operator switching to KMS signing had no way to notice short of reading a
manifest back.

## What changed

| file | what |
|---|---|
| `services/c2pa-signer/vault_sign.py` | `assert_certificate_matches_signing_key()`, `CertificateKeyMismatch`, and the reasoning for the method. **The guard.** |
| `services/c2pa-signer/sign.py` | calls it after reading `cert_path`, before the builder and before anything is written; refuses with `code: certificate_key_mismatch` and a `key_binding` block; reports `key_binding` on success too. |
| `lib/c2pa/signAsset.ts` | `certificate_key_mismatch` in the error-code union, `SIGNER_CODES` allowlist, and `code` now survives the subprocess boundary. The `?? DEV_CERT` line carries the archaeology. |
| `app/api/scruple/c2pa/sign/route.ts` | the status mapping says in terms why this is a 500 and still a refusal. |
| `services/c2pa-signer/tests/test_certificate_key_binding.py` | 16 tests, 6 of them controls that must not fire. |
| `scripts/e1-gate.sh`, `scripts/e1-read-manifest.py` | the gate and the manifest reader. |

### The comparison is a challenge, not a public-key fetch

The obvious implementation is to obtain the signing key's public half and
compare SubjectPublicKeyInfo against the certificate's. That needs a different
answer per mode — the PEM in local mode, `/testnet/pubkey.pem` in kms-http, the
OCI KMS **management** API (a different endpoint from the crypto one this module
holds) in vault mode. Three code paths, two of which can only be exercised
where their service is.

It is also weaker. A public key served by an endpoint is a *claim* about the
signing key, and a claim that disagrees with the key is precisely what is being
guarded against.

So the signing path signs a domain-separated probe and the certificate's public
key verifies it. Same question, asked of the signer rather than about it; one
code path for all three modes; satisfiable only by the private key the next
signature will use. `vault_sign_es256` is the exact callback c2pa-python is
handed one line later, so there is no second resolution of the key that could
disagree with the first.

Cost: one extra ES256 signature per sign call — one more KMS round trip in
kms-http and vault mode — paid before anything is written.

### It is enforced in exactly one place

`services/c2pa-signer/vault_sign.py`, where the signing callback lives, called
from `sign.py`. **Not** repeated in TypeScript. That end would have to
re-derive which key signs, which is the mistake `local_key_path()` exists to
have ended — the same path was resolved independently in four places against a
key file purged on 2026-07-13, and every one of them was wrong for seven weeks.
It also could not reach a Vault key at all. `signAsset.ts` now says so at the
`?? DEV_CERT` line, where the next reader will be standing.

Same reasoning the format gate already uses one screen up in `sign.py`: this is
the end that owns the library, and a second caller of the subprocess must not
be able to route around it.

### There is no override

Not an env var, not a warning, not a repaired certificate, not a fall back to
the local key. Every other outcome ships a credential whose signature cannot be
checked against the certificate shipped inside it, and does so silently.

### Three reasons under one code

`not_an_ec_key`, `wrong_curve`, `signature_does_not_verify` — one code because
callers switch on one thing, three reasons because the corrections differ.

An **outage is none of them.** Only the verification step is caught, so an
unreachable KMS raises `URLError` and a missing local key still raises
`LocalKeyMissing`. "The signer is down" and "the certificate is for another
key" have different owners and only the second is permanent; a guard that
collapsed them would send an operator to rewrite a certificate over an outage.
Both are asserted as controls.

### A bug fixed on the way

`signAsset()`'s result parser dropped `parsed.code`. `sign.py` re-checks the
format at its own end and refuses with `code: 'unsupported_format'`, and that
code was discarded — so a `.webm` refused by the **signer** reached the route as
an anonymous 500, which is the exact confusion the field was added to end.
Codes now cross the boundary through `SIGNER_CODES`, an allowlist rather than a
pass-through, so an arbitrary string from a subprocess cannot enter a typed
contract.

## The gate

Every stage observes a **signature read back**, never an environment variable.
An app that reported the right mode and embedded the wrong certificate passes an
env check and fails this. Validation is read with `get_validation_state()`, not
`is_valid()`, per the work order.

```
== stage 1  RED at the parent commit (worktree at caf7bc4) ==
   http 200 | ok True | mode kms-http | code None
   failure_codes=['claimSignature.mismatch','signingCredential.untrusted'] state=Invalid
   calibration: signed assets the stage-2 probe would have seen here: 1
   PASS  RED: the route called it ok and the manifest reads claimSignature.mismatch

== stage 2  GREEN at HEAD, same mismatched pair ==
   http 500 | ok None | code certificate_key_mismatch
   error the certificate does not belong to the key that would sign.
         signing_mode=kms-http, signer=kms-http:...surrogate=true, cert_subject=CN=Scruple Dev Signer
   signed assets written since the request: 0
   PASS  GREEN: refusal with code=certificate_key_mismatch and no output asset

== stage 3  CONTROL (a) the correctly-paired surrogate certificate ==
   http 200 | ok True | mode kms-http
   state=Valid failure_codes=['signingCredential.untrusted']
   PASS  CONTROL (a) MUST NOT FIRE

== stage 4  CONTROL (b) local key + local certificate ==
   http 200 | ok True | mode local
   state=Valid failure_codes=['signingCredential.untrusted']
   PASS  CONTROL (b) MUST NOT FIRE

== e1-gate: 4 pass, 0 fail ==
```

`signingCredential.untrusted` remains in both controls and **must**: it is the
correct residual status for a dev root, and nobody has any business trusting
this one.

The certificate serials in the manifests say which certificate was embedded, and
they are the whole story in one line:

| stage | signing key | embedded cert serial | which cert that is |
|---|---|---|---|
| 1 RED | surrogate | `74AAD0…0BCC` | the **local** dev leaf — the defect |
| 3 ctl a | surrogate | `5EC748…4D25` | the surrogate leaf from `d7-surrogate-cert.sh` |
| 4 ctl b | local | `74AAD0…0BCC` | the local dev leaf, correctly |

### The control that was inconclusive, and how it was caught

Stage 2's "no output asset" probe searched `${TMPDIR:-/tmp}` from the gate's own
shell. The route writes into `fs.mkdtemp(os.tmpdir())` inside the **app**, whose
`TMPDIR` here is `/mnt/corpus/scruple-council-impl/tmp`. The probe was looking
at a directory the route never writes to and returned a confident zero that
meant nothing — a passing gate on a blind instrument.

It is now calibrated in stage 1, where an asset certainly *is* written: if the
probe cannot see that one, the gate says so and stage 1 fails rather than
letting stage 2's zero stand. Uncalibrated it read 0 there too; calibrated it
reads 1. Commit `2420608`.

## Who signs through this path — enumerated, not counted

Callers of `signAsset()` in `/data/scruple-web` (excluding
`docs/c2pa-conformance-evidence/**`, which holds frozen snapshots, and tests):

- `app/api/scruple/c2pa/sign/route.ts` — `POST /api/scruple/c2pa/sign`. Its body
  takes `product: 'studio' | 'fusion'`, so **Scruple Fusion and Scruple Studio
  are the same call site**, differing only in which assertion is attached
  (`ai.scruple.cad.v1` vs `ai.scruple.workflow.v1`). Desktop Studio reaches the
  signer only through here.
- `lib/iterations/signOnIngest.ts` — `signIngestedArtifact()`, dynamic
  `import('@/lib/c2pa/signAsset')`, reached from `lib/iterations/ingest.ts`
  and surfaced by `lib/runs/execute.ts`. Flag-gated on
  `SCRUPLE_C2PA_SIGN_ON_INGEST`.
- `scripts/c2pa-sign.mjs` — the headless CLI. It does not import `signAsset`; it
  `fetch`es `POST /api/scruple/c2pa/sign`, so it is a caller of the route.

`lib/watermark/apply.ts` and `lib/witness/principalForUser.ts` name `signAsset`
in comments only — the first as work not yet done (it should sign with intent
`EDIT`), the second describing what dispatches to it. Neither calls it.

Direct callers of the subprocess `services/c2pa-signer/sign.py`: only
`lib/c2pa/signAsset.ts` and `services/c2pa-signer/tests/*`. The guard is
therefore on every path that produces a C2PA credential in this repo.

**One sibling that shares the callback and not the defect:**
`services/c2pa-signer/sign_leaf.py` signs witness leaves with the same
`vault_sign_es256`, but it embeds **no certificate** — it reports a public key
PEM instead — so there is nothing for a certificate to disagree with and the
guard does not apply to it. Named here so its absence from the change is a
decision rather than an oversight.

## Tests

All run **after** the change, on the committed tree:

| suite | result |
|---|---|
| `services/c2pa-signer` pytest | **134 pass**, 0 fail — 16 of them new |
| `npm run test:v2` | 863 pass, 0 fail |
| `npm run test:conformance` | 47 pass, 0 fail |
| `npm run test:integration` | 19 pass, 0 fail |
| `services/cvm-surrogate` pytest | 13 pass, 0 fail |
| `tsc --noEmit` | clean |

The first row is the only one that moved: `services/c2pa-signer` was 118
before. The other four match the figures `docs/STATUS.md` recorded at the end
of WO-D7 — that is where "nothing went red" comes from for those, since they
were not re-measured at the parent commit in this work order.

The new file is `services/c2pa-signer/tests/test_certificate_key_binding.py`.
Six of its sixteen are controls that must not fire:

- the matched pair is accepted in the same mode, over the same function — so the
  refusal is about the key and not about the mode;
- the paired kms-http certificate is accepted, so `d7-surrogate-cert.sh`'s
  output still works and kms-http signing is guarded rather than dead;
- an unreachable KMS is **not** reported as a mismatch;
- a missing local key is **not** reported as a mismatch;
- `sign.py` still signs the matched dev pair end to end;
- `sign.py` signs end to end against a KMS whose certificate matches.

Three assertions worth naming individually:

1. **A subject match is not a key match.** The dev leaf and the surrogate leaf
   carry the **identical** Distinguished Name — both are issued from
   `keys/cert.cnf` — and differ only in their public key. Any check that
   compared names would have waved the defect straight through. The fixtures
   are built by the same openssl procedure as `regen-dev-cert.sh` and
   `d7-surrogate-cert.sh`, including `-force_pubkey`, so they share a DN by
   construction and the test cannot quietly stop testing this.
2. **The leaf is what is checked.** A chain whose *first* certificate is wrong
   is refused even when a later block would have matched.
3. **The probe signs first and the claim signs last**, asserted off the fake
   KMS's own record: exactly two signatures, the first carrying the probe
   prefix, the last beginning `\x84\x6aSignature1` — a COSE `Sig_structure`,
   therefore the claim. This matters because `signer_identity()` reports
   `message_type` from the *last* signature and the route folds that string into
   the canonical payload whose sha256 becomes a witness leaf. A probe with the
   last word would commit a false statement about how the signature was made
   into an append-only record.

The probe prefix `scruple.c2pa.key-binding-probe.v1\0` cannot begin a COSE
`Sig_structure`, so a probe signature can never be replayed as a claim
signature. Asserted.

## What this does NOT buy

1. **It does not eliminate `claimSignature.mismatch`.** `keys/cert.cnf` records
   a second cause, isolated 2026-07-12: c2pa-rs emits the same code when the
   leaf's DN carries fewer than the C/ST/L/O/OU/CN attributes, even though the
   raw ECDSA signature is valid. The guard proves the certificate carries the
   signing key. It does not prove c2pa-rs will accept the certificate.
2. **Real OCI Vault mode is unexercised here.** Local mode and kms-http mode
   were measured — against the running surrogate and against an in-process fake
   KMS. `vault` mode dispatches through the same `vault_sign_es256` callback and
   so should behave identically, but that is inference from shared code, not a
   measurement. It needs a box with instance-principal credentials.
3. **Only the leaf is checked.** A chain whose leaf is right and whose
   intermediate or root is wrong is refused by c2pa-rs, not by this guard. The
   guard is about the key.
4. **The residual `signingCredential.untrusted` is untouched and should be.**
   Both controls still carry it. It says the dev root is not a trusted anchor,
   which is true, and the fix for it is a real certificate, not a code change.
5. **One more signature per sign.** In production Vault mode that is a second
   OCI KMS Sign call per credential — latency and cost. It buys the guarantee;
   it is not free, and nobody should discover it from a bill.

## For WO-E7

`docs/STATE.md` §4.3 is closed at the source. Its "**Needs:** a decision, then a
small change on the server" is answered: the decision is *refuse, with a code,
with no override*, and the change is `6aeee18`. §6 item 2 ("Decide on the
cert/key mismatch guard") can be struck. The workaround §4.3 describes —
`scripts/d7-surrogate-cert.sh` and the sandbox app pointed at its output —
stays, and is now the thing stage 3 proves still works.
