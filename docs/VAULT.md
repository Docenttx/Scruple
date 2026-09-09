# The vault — contract, states, and what a leaf from it says

_WO-D3. Code: `app/vault/`. Gate: `bash scripts/d3-gate.sh`._

A **vault** is a directory of files at a moment, recorded as a unit. It is the
one measurement a server-side gate structurally cannot make: a gate observes a
wire and never sees a directory (`docs/DESIGN.md`).

## What a vault must carry

One file at its root, `scruple-vault.json`, written by whoever filled the
directory:

```json
{
  "vault_declaration": "v1",
  "declared_by": "kohya-ss/sd-scripts 21.8.5",
  "files": {
    "model.safetensors": { "mime": "application/octet-stream" },
    "opaque.bin": { "mime": null, "reason": "no type is declarable for these bytes" }
  }
}
```

There is **no extension table** in the surface and there must not be one. A file
the declaration does not name is refused; the surface does not read `.png`.
`scripts/d3-gate.sh` stage 1 greps for one and fails if it finds it.

## Three states, kept apart

| the declaration | state | outcome |
|---|---|---|
| names it, with a mime | `measured` | `captured` — one leaf |
| names it, `mime: null` | `absent` — asked, and there is genuinely none | `refused_mime_declared_absent` |
| does not name it | `indeterminate` — nobody entitled was asked | `refused_mime_undeclared` |

Plus the read: over the counted ceiling is `refused_over_ceiling` with the
content hash `indeterminate` **and the byte count `measured`** — the count is
what separates "too big" from "skipped". Unreadable is `refused_unreadable`.

Collapsing `absent` into `indeterminate` is WO-62's original defect and both
refuse, so nothing forces them apart except this table and the manifest.

## The ceiling is configuration

`SCRUPLE_VAULT_CEILING_BYTES`, read in the **main process**, never from the
renderer. A page that could raise the ceiling could make an over-ceiling
refusal disappear. Default 64 MiB (`DEFAULT_CEILING_BYTES`). It is a **counted**
ceiling: the read is stopped when the bytes actually received pass it, not when
`stat` claims a size the file's owner controls.

## The unit is a document, not a tree

`merkle.js`'s sorted-pair construction is retired (`docs/DESIGN.md`; three live
constructions in the estate disagree). The replacement is
`app/vault/manifest.ts`: a canonical JSON document (`jcs-2`, the same
canonicalization the leaf preimage uses) listing every entry **in order, each
with its index**, and its sha256 is the vault digest. Recomputable by anyone
holding the directory. No inclusion proofs — for a directory claimed as a unit
that is the right trade, and the honest one while no two parties agree what a
root is.

**The manifest is itself witnessed.** That is what makes a refusal a recorded
outcome rather than a log line, and what makes the record tamper-evident: edit
one refusal and the digest no longer matches the leaf.

## What a vault leaf says

`unattested-client` / `none` → profile `desktop` → basis **`stale`**,
`component_verified = 1`, `attestation_profile = 'desktop'`. Migration 053
refuses `verified` on this profile at the database, and
`lib/leaf/attestationBasis.ts` refuses it twice more. Storage confinement reads
`degraded_shared_storage` on an ordinary desktop, measured; upstream reads
`not_queried`, because a vault has no upstream process to ask.

## Wiring

```
renderer → window.scruple.vaultCapture({vaultDir, vaultId})
         → ipcMain 'scruple:vault-capture'   (app/ipc-vault.js — a LAUNCHER)
         → bash scripts/tsx.sh app/vault/run.ts <request.json>   (the sidecar)
         → VaultSurface → Submitter (the SDK's ObservationSink) → POST /api/v2/witness
```

The renderer names a directory. The key, the baseline, the token, the store,
the state directory and the ceiling all come from the environment, in main.

Config the sidecar needs: `SCRUPLE_VAULT_API_KEY`, `SCRUPLE_VAULT_BASELINE_REF`,
`SCRUPLE_VAULT_STATE`, `SCRUPLE_RUN_STORE`, `SCRUPLE_APP_URL`, and — on first
run only — `SCRUPLE_VAULT_PROVISIONING_TOKEN`. `scripts/d3-sandbox.ts` mints all
of them against the scratch app.
