# WO-G2 — §9.1 and §9.2, live, on one artifact

_2026-09-10. Gate: `bash scripts/g2-gate.sh` — **36/36**, every control fired.
Nothing here contacted production: signing goes to the CVM surrogate on 8799._

Two output modalities, both required by the same law, neither part of the other:

- **§9.1** a C2PA content credential — in-band signed metadata, verifiable with
  `c2patool` or `verify.contentcredentials.org` without contacting Scruple.
- **§9.2** an imperceptible watermark whose payload encodes a signing timestamp,
  recoverable from the pixels with no metadata at all.

⚑ Both implement **Section 1 mandatory marking measures of the EU AI Act Article
50 Code of Practice**. Watermarking is not a C2PA feature and must never borrow
C2PA's conformance language. **§9.3** adds a third: a chain lock carries its own
watermark whose body is the **SCR_ID**, not a time.

---

## The ladder already fitted the app's buttons

`lib/watermark/embed.ts` has five tiers, and nobody had noticed they are the
legacy app's lock actions:

| App button | Tier | Body | Standard |
|---|---|---|---|
| — (sign only) | 1 `c2pa-signed` | signing timestamp | §9.2 |
| **Checkpoint** | 2 `checkpoint` | signing timestamp | §9.2 |
| **Local disc lock** | 3 `local-lock` | signing timestamp | §9.2 |
| **Chain lock** | 4 `chain-lock-basic` | SCR_ID | §9.3 |
| **Chain lock, pinned** | 5 `chain-lock-pinned` | SCR_ID + pinned hint | §9.3 |

All four lock handlers now call it. The buttons did not change.

---

## Proven, on real bytes

**§9.2.4 verified rather than assumed** — the work order said this check had
never been done. 16 bytes / 128 bits · magic gate `0x5C` · 4-bit version · 4-bit
tier · tier body. Three refusal controls: a broken magic byte, an unsupported
version and a truncated payload each raise; none decodes. §9.2.5's *"no
probabilistic confidence score is returned; the gate is binary"* holds — the
verdict carries no score field.

**The detector reads the pixels.** Tier 3 embedded into a 512² synthetic
photograph decodes back to `signed_at_unix_seconds: 1789000000`.
🔴 **Control: the clean file decodes to `null`** — a detector that always says
"found" is ruled out. And the payload is not hiding in metadata: no
`tEXt`/`iTXt`/`zTXt` chunks, and the hex string does not appear in the file.

**Both modalities survive on one artifact.** The watermarked derivative signed
through `kms-http` reads `get_validation_state() = Valid` — never `is_valid`,
which the rails call unreliable — ES256, `digitalSourceType` present. **And the
watermark still decodes out of the signed file.**

**The controls the work order demanded, all three:**

| Control | Result |
|---|---|
| certificate ≠ signing key | `certificate_key_mismatch`, **no output asset written** |
| CVM unreachable | fails, **no fall back to a local key**, no asset |
| unwatermarked vs watermarked | distinguishable — clean decodes to `null` |

---

## §5.3 — the isolation, built and NOT installed

`sign.py` is a subprocess, so the signer is Node's user, so every path the signer
can read Node can read — including the OCI credentials that authenticate to
Vault. §5.3 ends that.

**Built:** `services/c2pa-signer/sign_daemon.py` — the signer behind a Unix
socket at 0660, with `ping` and `whoami` control channels. It signs: through the
socket, `kms-http`, key binding `es256-challenge` verified, credential `Valid`.

⚑ **The daemon SPAWNS `sign.py` rather than importing it.** Importing meant
converting 18 `print(json.dumps(...)); return N` sites in the one code path in
this estate that must not acquire a new bug quietly, and it would have bought one
saved process spawn. It buys nothing else — the isolation is the unit and the
user, and a child of the daemon runs as `scruple-signer` exactly as the daemon
does. `sign.py` is byte-identical to what it was.

**Also built:** `.githooks/pre-commit`, refusing any private key under
`services/c2pa-signer/keys/`, and `SCRUPLE_C2PA_CERT_CHAIN` — which §5.2 names
as *the* way to load a certificate and which had **zero references anywhere in
the tree**, so an operator configuring the signer from the Standard configured
nothing and got the dev certificate with no complaint.

🔴 **The hook returned 0 on a real private key until its own control caught it.**
The PEM pattern begins with a dash, so `grep -qE "$PEM_RE"` read it as an option,
printed usage and exited non-zero — which the loop took for "no match". `--` is
load-bearing.

### What still needs root, and was not done

**⚑ The daemon alone is not the isolation.** Run under the same user as Node it
buys a socket and nothing else. `scruple-c2pa-signer.service` is committed but
**not installed**, so the host work is reviewable before anyone runs it:

1. `useradd --system scruple-signer`, and `SupplementaryGroups=www-data` so Node
   reaches the socket through the shared group and only through it.
2. Install the unit; `/etc/scruple/c2pa-cert.pem` as the only certificate.
3. **`InaccessiblePaths=/data/scruple-web/services/c2pa-signer/keys`** — the line
   that matters. Without it a misconfigured `cert_path` signs with a dev key and
   every credential it makes is worthless in a way no verifier announces.
4. Point Node at `/run/scruple-signer.sock` instead of spawning `sign.py`.
5. OCI VCN egress: `vault.<region>.oci.oraclecloud.com` and `TSA_ALLOWED_URLS`
   only. No general internet.

**None of this was done by an agent, deliberately.** Creating a system user and
installing a unit on a box that serves live traffic is a founder decision.

---

## Who is allowed to do which part

|  | Who | Why |
|---|---|---|
| **payload** | the SERVER | For tiers 1-3 the body is a **signing timestamp**; a time this laptop invented is a claim about this laptop's clock. For 4-5 it is the SCR_ID, which the desktop does not assign. |
| **embed** | the DESKTOP | Embedding is not signing. The mark carries no key and proves nothing alone. |
| **signature** | the SERVER | `docs/DESIGN.md`: *"the key is deliberately somewhere the desktop cannot reach; that is the custody claim, not a limitation to engineer around."* |

`POST /api/scruple/watermark/payload` is new and exists for the first row. It
refuses to mint a chain payload with no SCR_ID, and a pinned payload with no
hint: **a lookup path that leads nowhere is worse than none, because it looks
like one.**

Order is watermark → sign, because the derivative is the file the public
receives and therefore the file the credential must cover. **The master is never
touched** (WATERMARK_DESIGN §4.3).

---

## 🔴 Findings — measured, not read

**1. Only one of four lock actions ever had these modalities.**
`/api/lock/local` (tier 3) calls the watermark. **`/api/lock/checkpoint` and
`/api/lock/chain` call neither the watermark nor C2PA.** The instruction that
these are "L2 live in the current web studio flow" is true of a quarter of it.

**2. C2PA has never been applied to the derivative.** Signing happens at ingest
(`lib/iterations/signOnIngest.ts`). `apply.ts:59-70` names the seam and says it
is another work order's — so the artifact the public receives has been the one
carrying no credential.

**3. `payload.py` cites test vectors at `services/watermark/tests/test_payload.py`.
That file does not exist.**

**4. `signer_age_guard` reports "IMDS unreachable — dev-mode signing permitted".**
A permissive fallback. Correct on a laptop; a production signer must not keep it.

**5. WO-03 specified the hook at `.githooks/pre-commit-c2pa-key-check`.** With
`core.hooksPath=.githooks`, git runs `pre-commit` and nothing else — that name
would never have fired. It is `.githooks/pre-commit`.

---

## What is NOT proven

**The credential half has not been exercised through the app's own lock button.**
The desktop channel produced correctly-tiered derivatives for checkpoint (tier 2)
and local lock (tier 3), read back out of the files. The signature step then
returned `credential_refused` — twice, for two different and entirely correct
reasons: *"project not Checkpointed (no lock_server_signature)"* and *"project has
no SCR-ID (never witnessed)"*. The server's own tier gate was doing its job on a
sandbox project that has never been witnessed.

So: the pipeline is proven end to end, and the **last hop has only been proven
independently** — four ways, including through the socket daemon. Closing that
gap needs a witnessed project in the desktop's own database, which is a lock
performed by a person. **That is WO-G3.**

The refusal shape is worth keeping: it returns `credential_refused` **with the
derivative attached**. A watermarked artifact with no credential is a real
outcome and the caller is told exactly that, rather than being handed a failure
that discards work already done.
