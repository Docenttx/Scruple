# Deployment record — witness server

## 2026-08-31 · `/opt/scruple-witness/` brought to repo parity

**Deployed:** `services/witness-server/server.js` (1425 lines) and
`leaf_signer.js`. Previously the 2026-07-16 build, 1252 lines, six weeks stale.

**Verified after deploy:** `server.js` and `leaf_signer.js` byte-identical to
repo · H-1 leaf-signing path present · fail-closed `SCRUPLE_WITNESS_SECRET`
guard present (the unit supplies a 64-char secret, so it passes) ·
synthetic-prefix guard at `server.js:554` · **171 leaves, 74 projects, unchanged
across the deploy** · health endpoint OK.

**Backup:** `/opt/scruple-witness/history/redeploy-20260831T021546Z/` —
`server.js.bak` and a `VACUUM INTO` copy of `witness.db`.

### The outage I caused, recorded because it was avoidable

**~17 seconds down** (02:15:54 → 02:16:11). I diffed the *tracked-file list*
from `tamper-surface.mjs` rather than the repo directory, so I copied
`server.js` without `leaf_signer.js` — which is **new in the repo and did not
exist in the deployment** — and the service died on `MODULE_NOT_FOUND` at
`server.js:247`.

The tamper surface is an explicit list by design, for good reasons stated in its
own comment. **It is not a deployment manifest**, and using it as one is how a
new dependency gets left behind. A deploy should diff the directory.

### H-1 is deployed and inert

`leaf_signer.mode()` returns **`disabled`** — correctly fail-soft: signing
returns null and the leaf's signature fields stay null rather than the service
failing. So leaves are still HMAC-sealed, not ECDSA-signed by a TOE-resident
key, and **§2's "witnessed through the same signing key" remains aspirational
until a signer exists.**

Also noted: **31 of 171 leaves carry a null `leaf_hash`**, predating the v2 leaf
scheme.

### Blocked

**The CVM cannot be started from this host.** `~/.oci/config` is missing
`user`, `fingerprint`, `key_file`, `tenancy` and `region`; the `scruple-l2`
session directory holds a keypair from 2026-07-12 and no live token. Requires
`oci session authenticate` (interactive browser), which is the founder's to run.

### Unrelated but visible during this work

The systemd unit carries `SCRUPLE_WITNESS_SECRET` and **two Stripe test keys in
plaintext**. Moving to a root-owned `0600` EnvironmentFile is a standing item.

## 2026-08-31 · H-1 made live against the surrogate — and the CVM overreach, corrected

**Two env vars.** `SCRUPLE_WITNESS_KMS_ENDPOINT=http://127.0.0.1:8799` and the
surrogate's key OCID, added to the unit. `leaf_signer` left `disabled` and now
returns `ECDSA_SHA_256`, a 71-byte DER signature, `surrogate: true`.

Leaves are now **asymmetrically signed and third-party verifiable** — the actual
substance of H-1 — and honestly labelled as surrogate-signed. Unit backed up
alongside the binary.

### What I got wrong, twice

I said the demo needed the CVM and that the audience "will read an OCID." Both
halves were wrong:

1. **I skipped a free step.** H-1 read `disabled` — production was using neither
   the CVM *nor* the surrogate. The gap was two environment variables, not a
   $135/month instance. I went from "H-1 is inert" straight to "start the CVM"
   without checking what sat between.
2. **I pointed at the wrong key.** A C2PA or EU AI Office conversation is about
   the **C2PA manifest's certificate chain** — `services/c2pa-signer/`, a
   different key on a different layer. The witness leaf signer is Scruple's own
   substrate. Nobody reviewing a content credential is inspecting our leaf's key
   OCID.

### When the CVM actually becomes necessary

**Only when we make the GPSR C.2.2 custody claim externally** — that the signing
key is HSM-resident inside an attested TOE. That is a *conformance submission*,
not a demo.

So: demo on the surrogate, honestly labelled. `L2_FLOOR.md`'s principle is
unchanged — an evidence standard cannot sit below a compliance standard — but it
binds when we **claim** L2, not while we build toward it. The surrogate marks
every signature `surrogate: true` precisely so this distinction cannot be
fudged.

**The CVM stays down.** `PRIORITIES.md`'s reversal is itself reversed, and the
OCI authentication blocker is not on the critical path.
