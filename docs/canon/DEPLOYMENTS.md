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
