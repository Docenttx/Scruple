# Witness server

The Node service that seals witness leaves. Runs at `:5799`, deployed to
`/opt/scruple-witness/`, managed by systemd as `scruple-witness`.

**Until 2026-08-26 this code was not in version control.** It was edited
in place on the box under a convention of saving `server.js.bak.<unix_ts>`
beside each change. Eleven such files existed; they are preserved under
`history/` because they were the only record of how this service evolved.

## Why it was brought in (H-3)

Standard §3 says a baseline covers "the code, configuration, and attested
compute environment" of an integration, and §4 says silent modification
must be cryptographically impossible.

The witness server computes everyone else's baseline. It could not be
measured itself, which made the component that decides what counts as
unmodified the one component nothing could check. That is circular, and
§3 does not allow it.

See `../../docs/canon/L2_FLOOR.md` for where this sits in the wider
harmonization.

## Measuring it

```
node tamper-surface.mjs              # hash the tracked source
node tamper-surface.mjs --json       # machine-readable
node check-deployment.mjs            # does /opt match this source?
node --test tests/                   # 8 tests
```

`check-deployment.mjs` exits 0 on match, 1 on drift, 2 if it cannot tell.
**Run it before trusting a baseline.** Putting code in git does not make
a deployment track it, and this directory has a long history of being
edited in place.

### What the tamper-surface hash covers

Six files, by content, listed explicitly in `tamper-surface.mjs`. It is a
list rather than a directory walk on purpose: adding a file should change
the hash for a reason someone can name, not because a glob widened.

### What it does not cover

`node_modules` (pinned by `package-lock.json`, not hashed), the Node
runtime, the OS, the systemd unit, its environment, or the machine. **A
matching hash means the source is what we think it is. It does not mean
the server is trustworthy.** Do not let it be read as the stronger claim.

## Secrets

Everything comes from the environment; nothing is hardcoded. Three things
about that are worth knowing:

1. `SCRUPLE_WITNESS_SECRET` used to fall back to the literal
   `'dev-secret-replace-in-production'` when unset — silently. A leaf
   sealed with a constant published in the source is forgeable by anyone
   who has read it, and the seal still verifies perfectly, against a key
   everybody has. It now **fails closed**: no secret, no start. Set
   `SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1` to accept a forgeable seal
   deliberately, in development.

2. The deployed unit passes secrets with `Environment=` directly in the
   unit file, which `systemctl show scruple-witness` will print **to any
   unprivileged user on the host**. They belong in an `EnvironmentFile`
   owned by root with mode 0600.

3. `/opt/scruple-witness/arweave-key.json` is a live wallet key with mode
   0664 — world-readable on a shared host. It is `.gitignore`d here and
   its permissions want fixing where it lives.

## What is deliberately not committed

`node_modules/`, `witness.db*` (the actual signed leaves),
`arweave-key.json`, `arlocal-data/`. See `.gitignore`.

## H-1 — leaves are now independently verifiable

Until 2026-08-27 a leaf's only seal was an HMAC over `SCRUPLE_WITNESS_SECRET`.
Two properties, fine for a transport check and disqualifying for evidence:
Scruple could forge any leaf, and nobody but Scruple could verify one.

`leaf_signer.js` now ECDSA-signs the leaf hash through the same OCI Vault
KMS Sign API the C2PA signer uses, and the verifying key is published at
`/api/signer/pubkey`. A third party can check a leaf with no Scruple
cooperation and no OCI credentials.

**The HMAC stays, demoted to what it always was** — a transport seal
between the application tier and this service (H-2). Nothing in a receipt
derives its trustworthiness from it any more.

```
SCRUPLE_WITNESS_KMS_ENDPOINT=http://127.0.0.1:8799       # or the OCI crypto endpoint
SCRUPLE_WITNESS_KMS_KEY_OCID=ocid1.key...
SCRUPLE_WITNESS_KMS_PUBKEY_URL=http://127.0.0.1:8799/testnet/pubkey.pem
```

Unset either of the first two and signing is **disabled** — leaves carry
the HMAC alone and every response says `independently_verifiable: false`.
Disabled is the default on purpose: enabling H-1 should be a deliberate
act, not something that happens because a variable was set somewhere.

`GET /api/signer` reports the current mode, the key, whether it is a
surrogate key, and whether leaves are independently verifiable.

### When the signing service is unreachable

The leaf is still recorded, with its signature fields null and
`independently_verifiable: false`. Losing the event entirely would be
worse than recording one whose independent verifiability is pending — and
the failure is reported, never hidden.

### Three modes

| `SCRUPLE_WITNESS_SIGNER` | Path | Use |
|---|---|---|
| `vault-py` | shells to `services/c2pa-signer/sign_leaf.py` | **production** |
| *(unset, with KMS env vars)* | plain HTTP to the crypto endpoint | surrogate / wire testing |
| *(unset, no env vars)* | disabled | default |

**`vault-py` shells out rather than reimplementing, on purpose.**
`vault_sign.py` already does draft-cavage request signing with
instance-principal credentials — and not theoretically: it signed the 33
conformance samples on the production Signer CVM for the GPSA v3
resubmission. A second implementation in Node would be a second thing to
get right, a second thing to keep right, and almost certainly a second
key.

That last point decides it. **Standard §2 says Scruple witnesses events
and the integration "through the SAME signing key."** Signing leaves
through the same `SCRUPLE_C2PA_VAULT_KEY_OCID` the C2PA signer uses makes
that sentence literally true. A separate client would leave it
aspirational.

The cost is a subprocess per leaf. Accepted: correctness and a true §2
claim are worth more than the latency, and if it becomes a bottleneck the
answer is a persistent local signing sidecar, not a reimplementation.

### Self-check

`GET /api/signer` signs a probe and verifies it against the key it
publishes.

Publishing a public key that does not match the signing key is a silent
catastrophe — every leaf looks signed, every verification fails, nothing
notices. It is the same shape as the assertion-allowlist bug: two places
that must agree, with nothing checking that they do. A test caught
exactly this during development, where a stale `PUBKEY_URL` won over the
derived key. In local `vault-py` mode that URL is now ignored and the key
is derived from the signing key itself.
