# Phase 1 — Studio leaves are unsigned: verification and exact specification

**Scope:** Gap 2 of `docs/canon/STUDIO_L2_MERGE.md`. Read-only investigation.
**Date:** 2026-08-29. **Signing target:** the surrogate at `http://127.0.0.1:8799` only.
**Production witness `127.0.0.1:5799` was not contacted at any point in this investigation.**

---

## Headline: the premise is confirmed, but it is incomplete in one decisive way

`STUDIO_L2_MERGE.md` says the fix is "three columns on `iterations`, three assignments in `ingest.ts`, and Studio's leaves become independently verifiable." The code half of that is correct and I have specified it below.

It is **not sufficient**, because **H-1 is not deployed**.

```
$ grep -c "leaf_signature" /opt/scruple-witness/server.js
0
$ grep -c "leaf_signer\|signLeaf\|independently_verifiable" /opt/scruple-witness/server.js
0
$ diff -q /opt/scruple-witness/server.js services/witness-server/server.js
Files ... differ
```

The deployed `server.js` is dated **2026-07-16**; `services/witness-server/server.js` in git is dated 2026-08-29. The deployed copy *is* v2.2-capable (`grep -c machine_manifest_hash` → 13, `model_fingerprints_hash` → 11), so the leaf scheme work reached production — but the H-1 leaf signer did not. Nor is it configured to: `/etc/systemd/system/scruple-witness.service` sets only `SCRUPLE_WITNESS_SECRET` and `PORT`. There is no `SCRUPLE_WITNESS_KMS_ENDPOINT`, no `SCRUPLE_WITNESS_KMS_KEY_OCID`, no `SCRUPLE_WITNESS_SIGNER`. Even if the new `server.js` were deployed today, `leaf_signer.js:85-88` would compute `mode() === 'disabled'` and every leaf would come back with `leaf_signature: null`.

So the honest statement of Gap 2 is that it has **three** prerequisites, not one:

| # | Change | Where | Size |
|---|---|---|---|
| **2a** | Store the fields instead of discarding them | `lib/iterations/ingest.ts` + migration 041 | small — specified below |
| **2b** | Read the right column in `/api/v2/verify` | `app/api/v2/verify/[content_hash]/route.ts` **and** `app/api/v2/witness/route.ts` | small — specified below |
| **2c** | Deploy H-1 to `/opt/scruple-witness/` and configure a signer | ops, gated on the CVM decision | **not free** |

2a and 2b are worth doing regardless: they are correct in themselves, they are testable today against the surrogate, and 2b fixes a live correctness bug that is *currently overstating* Scruple's assurance. But nobody should describe Studio's leaves as independently verifiable until 2c lands, and the report of Gap 2 should say so.

This is exactly the failure `services/witness-server/README.md:36-40` warns about: *"Putting code in git does not make a deployment track it, and this directory has a long history of being edited in place."* `check-deployment.mjs` exists precisely to catch this and has evidently not been run against H-1.

---

## 1. What `ingestIteration` stores today, and what it drops

### 1a. What it stores — quoted

`lib/iterations/ingest.ts:321-331`, the column list:

```sql
INSERT INTO iterations (
  project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
  previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id,
  execution_backend, execution_attestation, storage_pointer,
  output_kind, output_content_type, output_bytes, input_artifacts,
  workflow_hash, leaf_scheme,
  model_fingerprints, model_fingerprints_hash,
  witnessed, witness_id, witness_timestamp, witness_signature,
  compute_machine_id, machine_manifest_hash, workflow_publication,
  container_machine_manifest
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

Thirty-two columns, thirty-two placeholders. The four bound values that come from the witness response are `lib/iterations/ingest.ts:358-361`:

```ts
witnessResult ? 1 : 0,
witnessResult?.witness_id ?? null,
witnessResult?.server_timestamp ?? null,
witnessResult?.signature ?? null,
```

That is the whole of what survives the round trip. `leafHash` (line 308) and `leafScheme` (line 309) are also taken from the response; `prev_record_hash` is likewise discarded, though that is a separate and much smaller loss since it is re-derivable from the previous row.

`witnessResult?.signature` is the **HMAC**. Its provenance is unambiguous — `services/witness-server/server.js:249-256`:

```js
// The HMAC. H-2 demotes this to a TRANSPORT SEAL between the application
// tier and this service — it is no longer an evidence claim. Evidence is
// the ECDSA signature from leaf_signer, which a third party can verify
// without Scruple. See docs/canon/L2_FLOOR.md.
function sign(data) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('hex');
}
```

Called at `server.js:615` (`const signature = sign(leaf_hash);`) and returned as `signature` at `server.js:652`.

### 1b. What the response now contains — quoted

`services/witness-server/server.js:651-663`:

```js
  send(res, 200, {
    witness_id, server_timestamp, signature,
    leaf_hash, prev_record_hash, leaf_scheme,
    // H-1 — the evidence signature, and an honest statement of what it
    // is worth. `independently_verifiable: false` means this leaf can be
    // checked by Scruple and nobody else, which anything presenting it
    // to a user must say rather than imply parity with a C2PA manifest.
    leaf_signature: leafSig ? leafSig.signature : null,
    leaf_signer_key_id: leafSig ? leafSig.key_id : null,
    leaf_signature_alg: leafSig ? leafSig.alg : null,
    signer_surrogate: leafSig ? Boolean(leafSig.surrogate) : false,
    independently_verifiable: Boolean(leafSig),
  });
```

`leafSig` comes from `server.js:617` — `const leafSig = await leafSigner.signLeaf(leaf_hash);` — i.e. `leaf_signer.js:159-205`, base64 of the **DER-encoded ECDSA P-256 signature over the raw 32 leaf-hash bytes**, deliberately stored "unchanged so a verifier can decode it with any standard library" (`leaf_signer.js:190-193`).

**Five fields are returned that `ingest.ts` never reads: `leaf_signature`, `leaf_signer_key_id`, `leaf_signature_alg`, `signer_surrogate`, `independently_verifiable`.** (`prev_record_hash` makes six, out of scope here.)

### 1c. A field-name trap worth naming

The witness server's **own database column** is `leaf_signer_surrogate` (`server.js:234-236`), but the field on the **wire** is `signer_surrogate` (`server.js:661`). Reading `witnessResult.leaf_signer_surrogate` in `ingest.ts` would silently produce `undefined` forever, and because `WitnessIterationResult` carries an index signature (`lib/scruple/witness.ts:39`, `[k: string]: unknown`) TypeScript would not object. The client must read **`signer_surrogate`**.

### 1d. Three columns or four?

The doc says three. I recommend **four**, adding `leaf_signer_surrogate`, and the argument is the surrogate's own:

> *"Key metadata reports `protectionMode: SOFTWARE`, never `HSM`. A surrogate claiming hardware protection would be precisely the dev-indistinguishable-from-production failure this exists to avoid."* — `services/cvm-surrogate/README.md`

Every leaf signed between now and the CVM coming back up will be signed by a software key. If that flag is not persisted, a surrogate-signed leaf and an HSM-signed leaf are byte-indistinguishable at rest, and `/api/v2/verify` cannot tell a caller which it is holding. The witness server already stores the flag on its side (`server.js:234-236`, written at `server.js:657`); dropping it on the application side re-creates the exact ambiguity the surrogate was built to prevent. The marginal cost is one nullable INTEGER column and one assignment.

---

## 2. The migration

Next number is **041** — `039_v2_modalities_and_attestation_status.sql` and `040_baseline_witness_ref.sql` are the current tail, and `lib/db/migrate.ts:20-23` orders by filename with a plain lexical sort, so zero-padded three-digit prefixes are load-bearing.

**New file: `lib/db/migrations/041_iterations_leaf_signature.sql`**

```sql
-- Migration 041 — the leaf's asymmetric signature, stored rather than discarded.
--
-- H-1 taught the witness server to ECDSA-sign every leaf hash with the same
-- key the C2PA signer uses (services/witness-server/leaf_signer.js), and to
-- return leaf_signature / leaf_signer_key_id / leaf_signature_alg /
-- signer_surrogate on /api/witness (server.js:658-661).
--
-- scruple-web read none of them. lib/iterations/ingest.ts:358-361 stored the
-- witness_id, the server_timestamp and the HMAC — and the HMAC is a transport
-- seal (H-2), not evidence. So every leaf on the ingest path — Studio's
-- included — carried a seal only Scruple can check, while the signature any
-- third party CAN check was thrown away at the door.
--
-- witness_signature is NOT repurposed. It stays exactly what it is: the HMAC.
-- Overloading it would make old and new rows indistinguishable, and the whole
-- point of L2_FLOOR.md is that the two seals are not the same kind of thing.
--
-- NOT BACKFILLABLE. Re-signing a historical leaf would produce a signature
-- dated now over a record witnessed then, which is a stronger claim than the
-- evidence supports. Pre-041 rows stay NULL and read, correctly, as not
-- independently verifiable.

ALTER TABLE iterations ADD COLUMN leaf_signature        TEXT;
ALTER TABLE iterations ADD COLUMN leaf_signer_key_id    TEXT;
ALTER TABLE iterations ADD COLUMN leaf_signature_alg    TEXT;

-- A surrogate- or local-key-signed leaf must be distinguishable at rest, not
-- only at the moment of signing (services/cvm-surrogate/README.md). With the
-- real Signer CVM down, every leaf signed until it returns is software-keyed;
-- a verifier is entitled to know that from the row.
-- 1 = signed by a surrogate or local dev key. 0 = signed by the vault key.
-- NULL = no asymmetric signature at all.
ALTER TABLE iterations ADD COLUMN leaf_signer_surrogate INTEGER;

-- "How many leaves can a third party actually check?" is the question this
-- whole exercise exists to answer. Make it cheap to ask.
CREATE INDEX IF NOT EXISTS idx_iterations_leaf_signed
  ON iterations(leaf_signature) WHERE leaf_signature IS NOT NULL;
```

Notes on correctness of the SQL:

- `lib/db/migrate.ts:35-39` wraps each file in a transaction and `db.exec()`s it whole. Multiple `ALTER TABLE ... ADD COLUMN` statements in one `exec` are fine in SQLite.
- All four columns are nullable with no default, which is the only form of `ADD COLUMN` SQLite accepts without a constant default. Existing rows get NULL, which is the semantically correct value.
- The partial index requires SQLite ≥ 3.8.0; `better-sqlite3` ^11.3.0 bundles far newer.

**Adjacent, and I would put it in the same migration:** `/api/v2/verify` looks rows up by `output_hash` (`route.ts:46`), and there is **no index on `iterations(output_hash)`** — `001_core.sql:66-68` indexes `project_id`, `(project_id, run_sequence)` and `leaf_hash` only, and nothing later adds one (`014`, `034`, `038`, `039` add other columns). The public, unauthenticated verification endpoint therefore full-scans `iterations` on every call. One line:

```sql
CREATE INDEX IF NOT EXISTS idx_iterations_output_hash ON iterations(output_hash);
```

I flag it rather than fold it in silently, because it is a different concern from H-1 and the reviewer may prefer it as its own migration.

---

## 3. `ingest.ts` — before/after, line by line

Four edits, plus one type edit in `lib/scruple/witness.ts` without which the others do not typecheck cleanly.

### Edit 1 — `lib/scruple/witness.ts:30-40`, declare the H-1 fields

**Before:**
```ts
export interface WitnessIterationResult {
  witness_id: string;
  server_timestamp: string;
  signature: string;
  // v2 fields (absent from pre-v2 servers; treat as optional).
  leaf_hash?: string;       // sha256(canonical(record)) — the Merkled leaf
  prev_record_hash?: string;
  leaf_scheme?: 'v1' | 'v2' | 'v2.2';
  // Whatever else the server returns
  [k: string]: unknown;
}
```

**After:** same, with these inserted after `leaf_scheme?` (line 37):
```ts
  // H-1 fields (services/witness-server/server.js:658-662). Optional because
  // a pre-H-1 witness omits them and a witness with signing disabled returns
  // them as null — both are legitimate states that must not be errors.
  //
  // `signature` above is the HMAC and remains a TRANSPORT seal (H-2).
  // `leaf_signature` is the evidence: base64 of the DER-encoded ECDSA P-256
  // signature over the raw bytes of leaf_hash, verifiable by anyone holding
  // the key published at the witness's /api/signer/pubkey.
  leaf_signature?: string | null;
  leaf_signer_key_id?: string | null;
  leaf_signature_alg?: string | null;
  /** NOTE THE NAME. The witness's own column is `leaf_signer_surrogate`;
   *  the wire field is `signer_surrogate` (server.js:661). Reading the
   *  column name here yields undefined forever, and the index signature
   *  below means the compiler will not say so. */
  signer_surrogate?: boolean;
  independently_verifiable?: boolean;
```

Why this edit is required rather than cosmetic: with only `[k: string]: unknown`, `witnessResult?.leaf_signature` has type `unknown`, which `better-sqlite3`'s `.run()` will not accept as a bind parameter without a cast. Declaring the fields is what makes edit 3 read as ordinary code.

### Edit 2 — `lib/iterations/ingest.ts:328-331`, the column list and placeholders

**Before** (lines 328-331):
```
           witnessed, witness_id, witness_timestamp, witness_signature,
           compute_machine_id, machine_manifest_hash, workflow_publication,
           container_machine_manifest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

**After:**
```
           witnessed, witness_id, witness_timestamp, witness_signature,
           compute_machine_id, machine_manifest_hash, workflow_publication,
           container_machine_manifest,
           leaf_signature, leaf_signer_key_id, leaf_signature_alg,
           leaf_signer_surrogate
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

32 columns → 36; 32 placeholders → 36. Count them before running: the statement is positional and a miscount produces a row that is wrong rather than a query that fails.

### Edit 3 — `lib/iterations/ingest.ts:361-365`, the bound values

**Before** (361, then 362-365 unchanged, closing at 366):
```ts
        witnessResult?.signature ?? null,
        p.computeMachineId ?? null,
        machineManifestHash,
        getDefaultPublicationMode(p.userId),
        p.containerMachineManifest ? JSON.stringify(p.containerMachineManifest) : null,
      );
```

**After** — line 361 unchanged (the HMAC keeps its column), four values appended after line 365:
```ts
        witnessResult?.signature ?? null,          // the HMAC — transport seal (H-2), unchanged
        p.computeMachineId ?? null,
        machineManifestHash,
        getDefaultPublicationMode(p.userId),
        p.containerMachineManifest ? JSON.stringify(p.containerMachineManifest) : null,
        // H-1 — the evidence signature. NULL when the witness is pre-H-1, has
        // signing disabled, or could not reach the KMS. All three are honest
        // states meaning "no third party can check this leaf", and nothing
        // downstream may read NULL as anything else.
        witnessResult?.leaf_signature ?? null,
        witnessResult?.leaf_signer_key_id ?? null,
        witnessResult?.leaf_signature_alg ?? null,
        // `signer_surrogate`, not `leaf_signer_surrogate` — see witness.ts.
        // Only meaningful alongside a signature, so NULL when there is none:
        // "signed by a real key" and "not signed" must not both read as 0.
        witnessResult?.leaf_signature
          ? (witnessResult.signer_surrogate ? 1 : 0)
          : null,
      );
```

The three-way NULL/0/1 on the surrogate flag matters. `leafSig.surrogate` is `false` for a genuine vault key (`leaf_signer.js:199`) and the response defaults `signer_surrogate` to `false` when there is *no* signature at all (`server.js:661`). A naive `witnessResult?.signer_surrogate ? 1 : 0` would write `0` — "signed by a production key" — onto every unsigned leaf in the estate.

### Edit 4 — `lib/iterations/ingest.ts:111-131`, surface it on `IngestResult`

The interface already carries `witnessed` with a long comment (lines 112-129) explaining why callers must not imply a witness that never happened. The same argument applies one level up: a caller that cannot distinguish an HMAC-only leaf from an ECDSA-signed one will describe both the same way.

**After** — add after `leafScheme` (line 130):
```ts
  /**
   * Whether this leaf carries an asymmetric signature a third party can
   * check without Scruple's cooperation (H-1).
   *
   * Same discipline as `witnessed` above and for the same reason: a caller
   * that cannot tell an HMAC-sealed leaf from an ECDSA-signed one will
   * present both as "verified", and §12.4 says stored must not read as
   * verified. False here is a normal outcome, not an error.
   */
  independentlyVerifiable: boolean;
  /** True when the signing key was a surrogate or local dev key rather than
   *  the vault key. Meaningless unless independentlyVerifiable. */
  signerSurrogate: boolean;
```

and at the return (`lib/iterations/ingest.ts:404-411`), after `leafScheme,`:
```ts
    independentlyVerifiable: Boolean(witnessResult?.leaf_signature),
    signerSurrogate: Boolean(witnessResult?.leaf_signature && witnessResult.signer_surrogate),
```

This is additive to an interface, so no existing caller breaks (see §7).

### Edit 5 — `lib/types.ts:93-94`, the row type

**Before** (lines 92-95):
```ts
  // Canvas v2 (migration 021 / WO-3 + WO-8 + WO-9)
  machine_manifest_hash?: string | null;   // v2.2 — pinned-manifest hash committed to leaf preimage
  workflow_publication?: 'full' | 'hash-only' | 'witness-only'; // WO-9 redaction control (default 'full')
}
```

**After:**
```ts
  // Canvas v2 (migration 021 / WO-3 + WO-8 + WO-9)
  machine_manifest_hash?: string | null;   // v2.2 — pinned-manifest hash committed to leaf preimage
  workflow_publication?: 'full' | 'hash-only' | 'witness-only'; // WO-9 redaction control (default 'full')
  // H-1 asymmetric leaf signature (migration 041). Distinct from
  // witness_signature above, which is and remains the HMAC transport seal.
  leaf_signature?: string | null;          // base64 DER ECDSA over the raw leaf_hash bytes
  leaf_signer_key_id?: string | null;      // OCI key OCID, or 'local:<path>' in dev mode
  leaf_signature_alg?: string | null;      // 'ECDSA_SHA_256'
  leaf_signer_surrogate?: 0 | 1 | null;    // 1 = software/surrogate key; NULL = unsigned
}
```

Optional properties, so `SELECT *`-based casts (`ingest.ts:400-402`) continue to typecheck.

---

## 4. `/api/v2/verify` reads the wrong column — confirmed, and the fix

### 4a. Confirmed, and it is worse than the doc states

`app/api/v2/verify/[content_hash]/route.ts:62-64`:

```ts
  // An ECDSA leaf signature is stored in witness_signature. Its presence
  // is what makes this leaf checkable by someone who does not trust us.
  const independentlyVerifiable = Boolean(row.witness_signature);
```

The comment is false. `witness_signature` is populated at `lib/iterations/ingest.ts:361` from `witnessResult.signature`, which `services/witness-server/server.js:615` produces via the HMAC at `server.js:250-256`. There is no path by which an ECDSA signature reaches that column.

The consequence is not "sometimes wrong". `witnessResult.signature` is non-null for **every** successful witness call — it has been since long before H-1, and the deployed witness has no H-1 code at all. So today:

- **Every witnessed row on the ingest path returns `independently_verifiable: true`.**
- Each such response also returns `verification_basis.kind: 'asymmetric_leaf_signature'` with `algorithm: 'ECDSA_SHA_256'` (route.ts:79-84), naming an algorithm no part of the stored evidence used, and instructing the caller to *"Fetch the verifying key from the witness at `/api/signer/pubkey` and check the signature over leaf_hash yourself."*
- On the deployed witness, `/api/signer/pubkey` **does not exist** — the route was added in the same undeployed commit. A verifier following those instructions gets a 404 and no way to tell whether the fault is theirs or ours.

This is the direction of error that matters. The route was written to replace a hardcoded `false` (route.ts:6-15); it replaced it with a value that is `true` whenever the witness was reachable. Under `L2_FLOOR.md` §H-5 — *"§12.4 verifiers chain to a vendor root or say they did not"* — a public endpoint asserting third-party verifiability of an HMAC is the same class of defect the floor document identifies as the one the estate actively violates.

The doc's framing ("it can answer `true` for a leaf that no third party can actually check") is accurate but understates the scope: it answers `true` for **all** of them, and rows written by three other routes are affected too (below).

### 4b. The fix

**Before** — `route.ts:22-30` (interface), `:43-44` (SELECT), `:62-64`, `:77-90`:

```ts
interface Row {
  ...
  witness_signature: string | null;
}
...
      `SELECT id, leaf_hash, witnessed, leaf_scheme, baseline_hash, timestamp,
              witness_signature
         FROM iterations
...
  const independentlyVerifiable = Boolean(row.witness_signature);
...
    verification_basis: independentlyVerifiable
      ? { kind: 'asymmetric_leaf_signature', independently_verifiable: true,
          algorithm: 'ECDSA_SHA_256', note: '...' }
      : { kind: 'scruple_record', independently_verifiable: false, note: '...' },
```

**After:**

```ts
interface Row {
  ...
  witness_signature: string | null;        // the HMAC. Deliberately NOT read for assurance.
  leaf_signature: string | null;
  leaf_signer_key_id: string | null;
  leaf_signature_alg: string | null;
  leaf_signer_surrogate: number | null;
}
```

```ts
      `SELECT id, leaf_hash, witnessed, leaf_scheme, baseline_hash, timestamp,
              witness_signature,
              leaf_signature, leaf_signer_key_id, leaf_signature_alg,
              leaf_signer_surrogate
         FROM iterations
```

```ts
  // CORRECTION. This read `witness_signature`, which is the HMAC — a
  // transport seal between the app tier and the witness (H-2), forgeable by
  // Scruple and checkable by nobody else. It is non-null on every witnessed
  // row, so this endpoint answered `true` for every leaf it had ever seen.
  //
  // The ECDSA signature lives in leaf_signature (migration 041). Its presence
  // is what makes a leaf checkable by someone who does not trust us.
  const independentlyVerifiable = Boolean(row.leaf_signature);
  const signerSurrogate = row.leaf_signer_surrogate === 1;
```

```ts
    verification_basis: independentlyVerifiable
      ? {
          kind: 'asymmetric_leaf_signature',
          independently_verifiable: true,
          // Reported from the row, not asserted. A hardcoded algorithm is a
          // claim about evidence rather than a reading of it.
          algorithm: row.leaf_signature_alg ?? 'ECDSA_SHA_256',
          key_id: row.leaf_signer_key_id,
          // A software key gives third-party verifiability but NOT GPSR C.2.2
          // custody. Both facts are true and a verifier is entitled to both.
          key_custody: signerSurrogate ? 'software_surrogate' : 'hsm_vault',
          note: signerSurrogate
            ? 'This leaf is ECDSA-signed and you can check it yourself: fetch the verifying key from the witness at /api/signer/pubkey and verify the signature over leaf_hash. The signing key was a SURROGATE — a real key with real signatures, held in software, never in an HSM. Verifiable, but not L2 key custody.'
            : 'This leaf is ECDSA-signed. Fetch the verifying key from the witness at /api/signer/pubkey and check the signature over leaf_hash yourself — no Scruple cooperation and no OCI credentials required.',
        }
      : {
          kind: 'scruple_record',
          independently_verifiable: false,
          note: 'This leaf carries no asymmetric signature — it was witnessed before H-1, or while the signing service was unreachable. It rests on Scruple\'s audit record alone and cannot be checked by a third party.',
        },
```

The `false` branch is unchanged and already correct; it simply becomes reachable, which today it is not.

### 4c. The second writer — `/api/v2/witness` needs the same change

`/api/v2/verify` queries `iterations` and does not care who wrote the row. `app/api/v2/witness/route.ts` **does not use `ingestIteration`** — it calls `witness.witnessIteration()` directly (line 114) and INSERTs itself (lines 171-199). At line 123:

```ts
        witnessSig = String(res.signature ?? '');
```

bound to `witness_signature` at line 175/192. So fixing `ingest.ts` alone leaves every leaf created through the canon surface still landing with the HMAC in the column verify used to read, and — once verify reads `leaf_signature` — landing with `NULL` there and correctly reporting `false`. That is not wrong, but it is a silent capability regression for the canon surface unless the same three fields are carried through.

**Before** (`app/api/v2/witness/route.ts:100-104`):
```ts
  let witnessed = false;
  let witnessId: string | null = null;
  let witnessSig: string | null = null;
```
**After:** add
```ts
  let leafSig: string | null = null;
  let leafSigKeyId: string | null = null;
  let leafSigAlg: string | null = null;
  let leafSigSurrogate: number | null = null;
```

**Before** (`:118-124`):
```ts
        witnessed = true;
        witnessId = String(res.witness_id ?? '');
        witnessSig = String(res.signature ?? '');
```
**After:**
```ts
        witnessed = true;
        witnessId = String(res.witness_id ?? '');
        witnessSig = String(res.signature ?? '');   // HMAC, transport only
        leafSig = res.leaf_signature ?? null;
        leafSigKeyId = res.leaf_signer_key_id ?? null;
        leafSigAlg = res.leaf_signature_alg ?? null;
        leafSigSurrogate = leafSig ? (res.signer_surrogate ? 1 : 0) : null;
```

with the four columns added to the INSERT at `:171-180` and their values at `:181-199`, and — matching the route's own D-8 discipline that `witnessed` is always reported — `independently_verifiable: Boolean(leafSig)` added to the 201 body at `:201-215`.

### 4d. Two more writers, for completeness

`app/api/scruple/witness/adobe/route.ts:169` and `app/api/scruple/witness/photoshop/route.ts:140` both take `witBody.signature` (the HMAC) into `witness_signature` (adobe `:186`, photoshop `:159`) and both write `output_hash`, so their rows are reachable by `/api/v2/verify` and are currently reported as independently verifiable too. They are superseded by `/api/v2/witness` per that route's header comment (`:3-5`) but are still live code. Either carry the fields through or accept that they report `false` after the fix — the latter is honest and I would take it.

*(Noticed in passing, out of Phase 1 scope: `adobe/route.ts:205` hardcodes `leaf_scheme` to `'v2.2'` whenever a leaf came back, but the route sends no `machine_manifest_hash` (`:152-158`), so `server.js:614` would have returned `'v2'`. The stored scheme names a preimage shape the leaf does not have.)*

---

## 5. Which other integrations gain from the same change

Everything that reaches `ingestIteration`. Six call sites across five files:

| # | Call site | What it is | Gains |
|---|---|---|---|
| 1 | `lib/canvas/witness.ts:126` (`captureOutput`) | **Scruple Web Studio** — the canvas-proxy path. `app/canvas-proxy/[sessionId]/[[...path]]/route.ts:216` tees `GET /view` output bytes into it | ✅ the target of this phase |
| 2 | `lib/runs/execute.ts:75` (`executeRun`) | Sync Modal-runner workflow runs — the `/api/runs` + CLI dev pipeline, the path that carries `modelFingerprints` from `modal/scruple_runner.py:674-676` | ✅ |
| 3 | `lib/runs/execute.ts:244` (`pollRunJob`) | Async/T4 version of the same, via `generation_jobs` | ✅ |
| 4 | `app/api/generate/route.ts:240` | `/api/generate` synchronous ComfyDeploy/Modal path | ✅ |
| 5 | `app/api/generate/route.ts:369` | `/api/generate` second (legacy/BYO provider) path | ✅ |
| 6 | `app/api/generate/status/route.ts:167` | Async job completion for `/api/generate` | ✅ |
| 7 | `app/api/iterations/route.ts:58` | `POST /api/iterations` — raw byte ingestion for manual upload and third-party hooks (`route.ts:1-6`) | ✅ |
| 8 | `app/api/witness/cad/route.ts:105` | Direct-witness for CAD source files — **the Fusion 360 add-in** is the named first caller (`route.ts:3-4`), and `public/lib/scruple_client.py` targets the same endpoint | ✅ |

So the reach is: **Studio (canvas), the run/CLI pipeline, `/api/generate` in all three of its shapes, the raw ingestion endpoint, and the Fusion 360 CAD add-in** — every one of them at once, from four assignments.

**What does *not* gain, and should be stated plainly rather than implied:**

- **`/api/v2/witness`** — the canon surface. Separate writer; needs §4c above.
- **Adobe / Photoshop** (`app/api/scruple/witness/{adobe,photoshop}/route.ts`) — separate writers; §4d.
- **Kohya.** This one is a correction to the estate's mental model. `app/api/apps/kohya/witness/route.ts` creates **no iteration row and no witness leaf at all**. Its own header comment says it "inserts an iterations row + training_runs row" (`route.ts:6-7`), and that is not what the body does — the code writes `app_kohya_progress` and `training_runs` only, and says so at `route.ts:113-118`:

  > *"We do NOT yet POST to the witness server for a leaf hash from this route — the leaf construction still runs through the canonical /api/v1/log/* ingest surface... Wiring the pod-side HMAC through to a witness leaf is a separate follow-up."*

  Since Studio is described as "ComfyUI **and Kohya** running inside it", this is worth flagging: the ComfyUI half of Studio is on the ingest path and gains from this change; **the Kohya half is not on it at all** and gains nothing, because it does not produce a leaf to sign. That is a fourth gap, smaller than Gap 1 but real, and it is not in `STUDIO_L2_MERGE.md`.

**One further observation about Studio's leaf content**, since the merge doc leans on it. `STUDIO_L2_MERGE.md` credits Studio with *"dual model fingerprints, content and structural"* and a container manifest with git-commit SHAs. `modal/scruple_runner.py` does compute both (`:281-282`, `:674-676`) — but the **canvas-proxy** ingest call at `lib/canvas/witness.ts:126-143` passes `machineManifestHash` only. It passes no `modelFingerprints`, no `containerMachineManifestHash`, no `containerMachineManifest`. So `ingest.ts:216-224` leaves `modelFingerprintsHash` NULL, and the canonical record sent to the witness (`ingest.ts:294-303`) carries `model_fingerprints_hash: ''` (`server.js:604`). **Studio's canvas leaves do not currently commit model fingerprints.** The runner-based paths (`lib/runs/execute.ts:264`, `:259`) do. I have not traced whether `modal/canvas_app.py` even surfaces the fingerprints to the proxy, so treat the *cause* as **UNVERIFIED**; the omission at the ingest call site is directly readable.

---

## 6. End-to-end test against the surrogate, without touching production

The design goal is that no process in this procedure can reach `127.0.0.1:5799` even if something is misconfigured, and that the assertion at the end is a **third party verifying a Studio leaf with no Scruple secret** — which is the only assertion that actually demonstrates the fix.

### 6.0 Safety, stated before the commands

The witness server's synthetic-project guard (`server.js:555-570`) refuses `tenant:` and `baseline:` prefixes. **It does not protect this path.** Studio ingests with `projectId: String(p.projectId)` (`ingest.ts:295`) — a bare integer, exactly the shape production traffic has. The only thing standing between this test and the production audit log is `WITNESS_SERVER_URL`. Set it first, in the same shell, before anything else.

`lib/scruple/witness.ts:5` defaults to `http://127.0.0.1:5799` when the variable is unset. An empty or forgotten export **is** production.

### 6.1 Environment

```bash
mkdir -p /tmp/studio-l2
cd /data/scruple-web

# ── The one that matters. Never unset, never empty. ──
export WITNESS_SERVER_URL="http://127.0.0.1:5899"       # scratch witness, NOT 5799
export SCRUPLE_DB_PATH="/tmp/studio-l2/app.db"          # scratch app DB, not data/scruple.db

# Belt and braces: assert before proceeding.
[ "${WITNESS_SERVER_URL}" = "http://127.0.0.1:5899" ] || { echo "REFUSING"; return 1; }

export SURROGATE_BASE="http://127.0.0.1:8799"
export SURROGATE_KEY_OCID="ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"
```

### 6.2 Surrogate (already running; start if not)

```bash
curl -sf -m 2 "$SURROGATE_BASE/health" \
  || nohup python3 services/cvm-surrogate/surrogate.py > /tmp/studio-l2/surrogate.log 2>&1 &
curl -s "$SURROGATE_BASE/health" | python3 -m json.tool
```
Verified live at time of writing: `{"ok": true, "service": "cvm-surrogate", "surrogate": true, "region": "us-surrogate-1", ...}` with header `X-Scruple-Surrogate: 1`.

### 6.3 A scratch witness on 5899, running the **git** copy with H-1 enabled

The git copy has no `node_modules`. Two options; the second avoids any install:

```bash
# Option A — install the declared deps (writes services/witness-server/node_modules)
npm --prefix services/witness-server install

# Option B — reuse the deployed modules read-only. Safe here because the
# systemd unit's ExecStart is node v20.20.2 and `node --version` on this host
# is also v20.20.2, so the better-sqlite3 native ABI matches.
export NODE_PATH=/opt/scruple-witness/node_modules
```

```bash
export SCRUPLE_WITNESS_SECRET="$(openssl rand -hex 32)"   # ≥32 chars or it exits (server.js:76-82)

PORT=5899 \
DB_PATH=/tmp/studio-l2/witness-scratch.db \
SCRUPLE_WITNESS_KMS_ENDPOINT="$SURROGATE_BASE" \
SCRUPLE_WITNESS_KMS_KEY_OCID="$SURROGATE_KEY_OCID" \
SCRUPLE_WITNESS_KMS_PUBKEY_URL="$SURROGATE_BASE/testnet/pubkey.pem" \
node services/witness-server/server.js > /tmp/studio-l2/witness.log 2>&1 &
```

`DB_PATH` is mandatory. Without it, `server.js:94` defaults to `services/witness-server/witness.db` — not production, but it would leave a database in the working tree.

Gate on the signer's own self-check before going further (`server.js:668-673`, `leaf_signer.js:273-302`):

```bash
curl -s http://127.0.0.1:5899/api/signer | python3 -m json.tool
```
Expected: `mode: "kms-http"`, `independently_verifiable: true`, `surrogate: true`, `self_check.ok: true`. If `self_check.ok` is false, stop — `leaf_signer.js:294-298` is telling you the published key does not verify what you sign, and every downstream assertion would fail for a reason that has nothing to do with `ingest.ts`.

```bash
curl -s "$SURROGATE_BASE/testnet/pubkey.pem" > /tmp/studio-l2/leaf-pub.pem
```

### 6.4 Scratch app database

```bash
npm run db:migrate          # runs scripts/migrate.ts → lib/db/migrate.ts against SCRUPLE_DB_PATH
sqlite3 /tmp/studio-l2/app.db "PRAGMA table_info(iterations);" | grep leaf_signature
```
That grep is the migration-041 gate. Empty output means 041 did not apply and everything below will silently store nothing.

### 6.5 Seed the minimum Studio state and drive the real capture path

This drives `captureOutput` — the actual function `app/canvas-proxy/.../route.ts:216` calls — so the test exercises the Studio path rather than a paraphrase of it. No Modal container and no ComfyUI are required, because the proxy's contract with `lib/canvas/witness.ts` is just bytes plus a pending row.

```bash
sqlite3 /tmp/studio-l2/app.db <<'SQL'
INSERT OR IGNORE INTO users (id, email) VALUES ('studio-l2','studio@example.test');
INSERT INTO projects (user_id, name, type, status, created_at,
                      iteration_count, is_active, witnessed_count, is_archived)
  VALUES ('studio-l2','studio-l2-e2e','image','unlocked',datetime('now'),0,1,0,0);
INSERT INTO machines (id, user_id, label, manifest_json, manifest_hash,
                      build_status, created_at, ready_at)
  VALUES ('m-studio-l2','studio-l2','e2e','{"packs":[]}',
          '1111111111111111111111111111111111111111111111111111111111111111',
          'ready', strftime('%s','now'), strftime('%s','now'));
SQL
PROJECT_ID=$(sqlite3 /tmp/studio-l2/app.db \
  "SELECT id FROM projects WHERE name='studio-l2-e2e';")

sqlite3 /tmp/studio-l2/app.db "
INSERT INTO canvas_pending_iterations
  (prompt_id, session_id, user_id, project_id, workflow_api_json, status)
VALUES ('prompt-e2e-1','sess-e2e','studio-l2',${PROJECT_ID},
        '{\"3\":{\"class_type\":\"KSampler\",\"inputs\":{\"seed\":42}}}','pending');"
```

```bash
cat > /tmp/studio-l2/drive.ts <<'TS'
import crypto from 'node:crypto';
import { captureOutput } from '@/lib/canvas/witness';

const bytes = crypto.randomBytes(4096);   // stands in for a ComfyUI /view PNG
console.log('output_hash', crypto.createHash('sha256').update(bytes).digest('hex'));

await captureOutput({
  sessionId: 'sess-e2e',
  userId: 'studio-l2',
  machineId: 'm-studio-l2',
  filename: 'ComfyUI_00001_.png',
  bytes,
  contentType: 'image/png',
});
TS

node --import tsx /tmp/studio-l2/drive.ts
```

`captureOutput` writes a local artifact copy via `storeArtifact` (`ingest.ts:245`, `lib/scruple/artifacts.ts:8` → `process.cwd()/artifacts`). That directory is gitignored (`.gitignore:34`), so this is the only write into the repo tree and it leaves nothing tracked.

### 6.6 Assertions

**(a) The row carries the signature — the fix itself.**
```bash
sqlite3 -header -column /tmp/studio-l2/app.db "
SELECT id, leaf_scheme, witnessed,
       substr(witness_signature,1,16)  AS hmac,
       substr(leaf_signature,1,24)     AS ecdsa,
       leaf_signature_alg, leaf_signer_surrogate, leaf_signer_key_id
  FROM iterations ORDER BY id DESC LIMIT 1;"
```
Expect `leaf_scheme=v2.2`, `witnessed=1`, both `hmac` and `ecdsa` non-empty and **different**, `leaf_signature_alg=ECDSA_SHA_256`, `leaf_signer_surrogate=1`, and a `leaf_signer_key_id` containing `.surrogate.`.

**(b) The signature verifies with no Scruple secret — the claim.**
```bash
node -e '
const crypto=require("crypto"), fs=require("fs");
const db=new (require("/opt/scruple-witness/node_modules/better-sqlite3"))("/tmp/studio-l2/app.db",{readonly:true});
const r=db.prepare("SELECT leaf_hash, leaf_signature FROM iterations ORDER BY id DESC LIMIT 1").get();
const ok=crypto.verify("sha256", Buffer.from(r.leaf_hash,"hex"),
  crypto.createPublicKey(fs.readFileSync("/tmp/studio-l2/leaf-pub.pem")),
  Buffer.from(r.leaf_signature,"base64"));
console.log("leaf", r.leaf_hash.slice(0,16), "verifies:", ok);
if(!ok) process.exit(1);'
```
This is the whole point: the only inputs are the public row and a public PEM. `SCRUPLE_WITNESS_SECRET` is not used and is not needed. Mirrors `services/witness-server/tests/leaf_signer.test.mjs:71-84`.

**(c) A forged leaf does not verify.** Re-run (b) substituting `crypto.randomBytes(32)` for the leaf hash; expect `false`. Mirrors `leaf_signer.test.mjs:86-94`.

**(d) DER, not a house encoding.** `Buffer.from(leaf_signature,'base64')[0] === 0x30`. Mirrors `leaf_signer.test.mjs:96-101`.

**(e) The verify route now reports on the ECDSA signature.**
```bash
OUT_HASH=$(sqlite3 /tmp/studio-l2/app.db "SELECT output_hash FROM iterations ORDER BY id DESC LIMIT 1;")
SCRUPLE_DB_PATH=/tmp/studio-l2/app.db WITNESS_SERVER_URL=http://127.0.0.1:5899 \
  npx next dev -p 3101 > /tmp/studio-l2/next.log 2>&1 &
sleep 8
curl -s "http://127.0.0.1:3101/api/v2/verify/${OUT_HASH}" | python3 -m json.tool
```
Expect `independently_verifiable: true`, `verification_basis.kind: "asymmetric_leaf_signature"`, `algorithm` read from the row, and `key_custody: "software_surrogate"`.

**(f) The regression test that proves the bug was real.** Point `WITNESS_SERVER_URL` at a dead port (`http://127.0.0.1:1`, the same trick `test/integration/harness.ts:51-58` uses), drive `captureOutput` again, then hit verify for that row. Expect `witnessed: false` and `independently_verifiable: false`. **Before** the fix this second row would report `independently_verifiable: false` only because `witness_signature` is also null — so run the sharper variant: restore the live witness, but start it with `SCRUPLE_WITNESS_KMS_*` **unset** so `leaf_signer.js:87` yields `disabled`. That produces `witnessed: 1`, `witness_signature` non-null, `leaf_signature` NULL — the exact row shape the old code reported as independently verifiable and the new code reports as `false`. That single case is the whole bug, and it belongs in the permanent test suite.

**(g) Nothing touched production.**
```bash
grep -c 5799 /tmp/studio-l2/*.log            # expect 0
ss -tnp 2>/dev/null | grep ':5799'           # expect no connection from these PIDs
```
The production witness's own DB is not inspected, because inspecting it is not necessary and the discipline of not touching it is the point.

### 6.7 Teardown

```bash
kill %1 %2 %3 2>/dev/null           # next, witness, surrogate (if you started it)
rm -rf /tmp/studio-l2
```
Leave `services/witness-server/witness.db` non-existent; if `DB_PATH` was forgotten, delete it.

### 6.8 Where this belongs permanently

`test/integration/harness.ts:41-58` already refuses a production witness URL and substitutes a dead port. The natural home for (a)–(f) is a sibling — say `test/integration/leaf-signature.test.ts` — with the harness extended to optionally boot the surrogate and a scratch witness the way `services/witness-server/tests/leaf_signer.test.mjs:34-46` already does. That is the shape `9b9e313` ("Integration tests — the ones that would have caught what unit tests didn't") established, and this is precisely a bug no unit test finds: it lives in the gap between two databases and an HTTP response.

---

## 7. Risk

**Existing rows — none.** Four nullable `ADD COLUMN`s. No data is rewritten, no column is repurposed. `witness_signature` keeps its meaning exactly, which is deliberate: overloading it would make pre-041 and post-041 rows indistinguishable and destroy the ability to say which leaves are genuinely checkable.

**Backfill — do not.** Signing a historical leaf hash today produces a signature dated now over a record witnessed weeks ago. That is a stronger claim than the evidence supports, and it is the same error `039_v2_modalities_and_attestation_status.sql:9-12` refuses for modality selection: *"Absence of a credential proves nothing unless the selection was committed at signing time."* Pre-041 rows stay NULL and read as not independently verifiable, which is true.

**Existing callers of `ingestIteration` — none break.** `IngestResult` gains two properties; all eight call sites destructure (`const { iteration, leafHash, runSequence } = ...`) or bind the whole result and read named fields. Additive interface changes are safe for every one of them.

**`SELECT *` consumers — safe.** `ingest.ts:400-402` casts `SELECT *` to `IterationRow`, and the new fields are declared optional in `lib/types.ts`. Four extra columns flow into any `SELECT *` result but nothing enumerates positionally.

**The positional INSERT is the one place to be careful.** 32 → 36 columns and 32 → 36 placeholders must be changed together. A mismatch is caught immediately by `better-sqlite3` at prepare time — but a *count* that matches while the *order* is wrong is not caught by anything, and would write the key OCID into the surrogate flag. Assertion (a) in §6.6 checks the column semantics and not merely their presence, for exactly this reason.

**Latency.** In `kms-http` mode, one extra HTTP round trip to the KMS per leaf, inside the witness server, before it responds. `leaf_signer.js:75` defaults `TIMEOUT_MS` to 4000. In `vault-py` mode it is a Python subprocess per leaf, which `leaf_signer.js:55-58` acknowledges: *"The cost is a subprocess per leaf. Accepted for now."* `ingestIteration` awaits the witness call at `ingest.ts:294`, so this lands directly in `/api/generate` and in the canvas proxy's `/view` handler. `app/api/generate/route.ts:33` sets `maxDuration = 300`, so there is headroom, but for a batch of many outputs the added seconds are real. Not a blocker; worth measuring before enabling `vault-py` on a high-volume path.

**Failure modes are already correct and stay correct.** `signLeaf` never throws (`leaf_signer.js:152-157`, `:201-204`), returning `null` on outage; `ingest.ts:304-306` already swallows a total witness failure. So a dead KMS produces `leaf_signature = NULL`, `witnessed = 1` — a captured, witnessed, not-independently-verifiable leaf, which is exactly the state `leaf_signer.js:93` and `server.js:653-657` describe as the honest one.

**The real risk is presentational, and it is the reason to do 4a and 4b in the same change.** Between landing the ingest fix and landing the verify fix, `/api/v2/verify` continues to assert `independently_verifiable: true` on the HMAC while the correct value sits unread in the adjacent column. And after both land, if 2c never happens, every leaf will honestly report `false` — which will look like a regression to anyone reading the endpoint without reading this document. It is not a regression. It is the first time the endpoint has told the truth.

**One presentational fix that should ride along.** `app/receipt/[scrId]/page.tsx:263-268` tells the reader:

> *"HMAC `witness_signature` on each row is Scruple's per-record seal (symmetric); the on-chain mint wallet is the public issuer identity."*

That text is accurate today and becomes incomplete the moment `leaf_signature` is populated — a receipt that names only the symmetric seal understates a leaf that now carries an asymmetric one. Under `L2_FLOOR.md` H-2 the HMAC should be described as a transport seal there, with the ECDSA signature named as the evidence and the surrogate/vault custody distinction shown. Small, but it is the surface a customer actually reads.

---

## Summary of the proposed change set

| File | Change |
|---|---|
| `lib/db/migrations/041_iterations_leaf_signature.sql` | **new** — 4 nullable columns + partial index (+ optional `output_hash` index) |
| `lib/scruple/witness.ts:37` | declare 5 H-1 response fields on `WitnessIterationResult` |
| `lib/iterations/ingest.ts:328-331` | 32 → 36 columns and placeholders |
| `lib/iterations/ingest.ts:365` | 4 new bound values; 3-way NULL/0/1 on the surrogate flag |
| `lib/iterations/ingest.ts:130`, `:410` | `independentlyVerifiable` + `signerSurrogate` on `IngestResult` |
| `lib/types.ts:94` | 4 optional fields on `IterationRow` |
| `app/api/v2/verify/[content_hash]/route.ts:29,44,64,77-90` | read `leaf_signature`, not `witness_signature`; report algorithm and key custody from the row |
| `app/api/v2/witness/route.ts:102,123,175,192,205` | carry the same 4 fields through the canon surface's own INSERT; add `independently_verifiable` to the 201 body |
| `test/integration/leaf-signature.test.ts` | **new** — §6.6 (a)–(f) against the surrogate, especially (f) |
| **ops** | deploy `services/witness-server/` to `/opt/scruple-witness/`; add `SCRUPLE_WITNESS_KMS_*` (or `SCRUPLE_WITNESS_SIGNER=vault-py`) to the systemd unit; run `node services/witness-server/check-deployment.mjs` and require exit 0 |

The first nine rows are a morning's work and can be verified end to end against the surrogate today. The tenth is the one that decides whether any of it is true in production, and it is not an engineering decision.
