# WO-08 — C2PA signer emits sign event to `scruple.c2pa.sign` stream

**Sprint:** 1
**Estimate:** 6 owner-hours
**Blocking:** WO-04 (isolated signer daemon), WO-06 (ingest API), WO-05
(canonicalLeafV23 + seed `scruple.c2pa.sign` stream row)
**Blocks:** WO-09 (verifier CLI's `c2pa` subcommand pulls the leaf via
correlation), WO-10 (E2E smoke), WO-18 (L2 evidence uses the emitted trail)

## Goal

Wire the isolated C2PA signer daemon to write a leaf into the
`scruple.c2pa.sign` audit stream on every sign attempt (success OR failure).
Surface the leaf correlation in the `/api/scruple/c2pa/sign` API response so
callers can fetch inclusion proofs against the sign event. Enforce the
zero-content posture — the leaf carries hashes only, never payload bytes.

After this WO, every C2PA sign is a witnessed event on the same audit chain
we contractually promise to enterprise customers under the Rider.

## What to build

### 1. Correlation model

Add columns to the correlation surface:

- Signer daemon returns to Next.js (`sign.sock` response JSON):
  ```json
  {
    "ok": true,
    "output_path": "...",
    "bytes": 69555,
    "witness": {
      "stream_id": "STR_c2pa_sign",
      "tenant_seq": 918273,
      "leaf_hash": "sha256:...",
      "chain_hash": "sha256:...",
      "pending_checkpoint_epoch": 4412,
      "idempotency_key": "sign-<uuid>"
    }
  }
  ```
- `/api/scruple/c2pa/sign` response body adds a `witness` field mirroring
  the above. Callers use it to fetch the inclusion proof once the checkpoint
  emits (default 5-min wait at `enhanced` tier).
- Optionally also embed the correlation into the C2PA JUMBF as a
  Scruple-namespace assertion so the signed asset is self-describing:
  ```json
  {
    "label": "ai.scruple.witness.v1",
    "data": {
      "stream_id": "STR_c2pa_sign",
      "tenant_seq": 918273,
      "leaf_hash": "sha256:...",
      "witness_url": "https://scruple.stooges.ai/v1/proof/leaf/STR_c2pa_sign/918273"
    }
  }
  ```
  This lands in `lib/c2pa/signAsset.ts` `buildManifest()` at the end of the
  assertions array. Verifiers can pull the proof URL directly out of the
  manifest.

### 2. Signer-side leaf emission `services/c2pa-signer/emit_leaf.py`

```python
import base64, hashlib, hmac, json, os, socket, time, uuid
from canonical_leaf_v23 import canonical_leaf_v23, leaf_hash_v23

C2PA_STREAM_NAME = "scruple.c2pa.sign"
TENANT_ID = "TEN_scruple"
TENANT_SEQ_STATE = "/var/lib/scruple-signer/c2pa-sign.seq"
INGEST_SOCKET = os.environ.get("SCRUPLE_C2PA_LEAF_INGEST_URL", "unix:/run/scruple-signer/log.sock")
INTERNAL_API_KEY = os.environ["SCRUPLE_C2PA_INGEST_API_KEY"]  # Scruple-internal key for TEN_scruple
INTERNAL_HMAC_SECRET = os.environ["SCRUPLE_C2PA_INGEST_HMAC_SECRET"]

def next_tenant_seq() -> int:
    # File-lock on a small counter file. Atomic increment.
    # (Or: SELECT MAX(tenant_seq) + 1 FROM log_leaves at ingest side;
    # but doing it locally keeps this callsite decoupled from DB.)
    ...

def emit_c2pa_sign_leaf(
    *,
    principal_id: str,
    asset_sha256: str,
    output_manifest_sha256: str,
    cert_serial: str,
    kms_key_ocid: str,
    product: str,
    tier: str,
    status: str,     # "signed" | "failed:<reason>"
) -> dict:
    """Build canonical leaf, POST to ingest, return correlation dict.
       On ingest failure, RETURN the correlation with error field —
       do NOT swallow. The C2PA sign either succeeded or didn't; the
       audit-emit failure is a separate operational signal."""
    event_time = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    payload_hash_input = json.dumps({
        "asset_sha256": asset_sha256,
        "output_manifest_sha256": output_manifest_sha256,
        "cert_serial": cert_serial,
        "kms_key_ocid": kms_key_ocid,
        "product": product,
        "tier": tier,
        "status": status,
    }, separators=(",", ":"), sort_keys=True)
    payload_hash = "sha256:" + hashlib.sha256(payload_hash_input.encode()).hexdigest()

    idempotency_key = "sign-" + str(uuid.uuid4())
    body = {
        "tenant_seq": next_tenant_seq(),
        "idempotency_key": idempotency_key,
        "principal_id": principal_id,
        "event_time": event_time,
        "payload_hash": payload_hash,
        "payload_bytes": None,
        "dims": {},
        "meta": {"product": product, "tier": tier, "status": status},
    }
    body_bytes = json.dumps(body, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    sig = hmac.new(
        INTERNAL_HMAC_SECRET.encode(), (ts + "\n").encode() + body_bytes,
        hashlib.sha256,
    ).hexdigest()

    # HTTP over Unix socket, POST /v1/log/scruple.c2pa.sign
    resp = post_uds(
        socket_path=INGEST_SOCKET,
        path=f"/v1/log/{C2PA_STREAM_NAME}",
        headers={
            "Authorization": f"Bearer {INTERNAL_API_KEY}",
            "X-Scruple-Timestamp": ts,
            "X-Scruple-Signature": sig,
            "Content-Type": "application/json",
        },
        body=body_bytes,
    )
    if resp.status == 200:
        r = json.loads(resp.body)
        return {"witness": r["leaf"], "idempotency_key": idempotency_key}
    else:
        # Log; return error correlation. The sign succeeded (or failed) on
        # its own merits — this is an audit-side operational issue.
        return {"witness_error": f"HTTP {resp.status}: {resp.body[:200]}"}
```

Design intent: **the C2PA sign and the audit emit are decoupled**. If the sign
succeeds but the emit fails, we still return the signed asset to the caller
with a `witness_error` flag. Operators alert on `witness_error` rate; users
get a "witness attach pending, retry proof fetch later" UX later. The signer
must never refuse a sign because the audit path is down (fail-open on the
audit side; the sign path is the primary product surface).

Alternative (stronger, harder): the sign daemon caches unsent emits in a
local queue and retries. Sprint 1 does the simpler fail-open; Sprint 2 adds
the retry queue.

### 3. Signer daemon integration

In `sign_daemon.py` (from WO-04), after `builder.sign_file(...)` completes:

```python
# Compute output_manifest_sha256 from the JUMBF C2PA box we just wrote.
# (Parse the output PNG, extract the JUMBF box bytes, sha256 them.)
output_manifest_sha256 = extract_and_hash_manifest(output_path)
asset_sha256 = hashlib.sha256(open(asset_path, "rb").read()).hexdigest()
cert_serial = extract_cert_serial(cert_chain_pem)  # openssl-like

correlation = emit_c2pa_sign_leaf(
    principal_id=job["principal_id"],  # passed through from API route
    asset_sha256=asset_sha256,
    output_manifest_sha256=output_manifest_sha256,
    cert_serial=cert_serial,
    kms_key_ocid=os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"],
    product=job["product"],
    tier=job["tier"],
    status="signed",
)

response["witness"] = correlation.get("witness")
if "witness_error" in correlation:
    response["witness_error"] = correlation["witness_error"]
```

For sign failures, emit a leaf with `status="failed:<reason>"` before
returning the error — this makes the audit trail a superset of the successful
signs (which is what an evaluator wants).

### 4. Route change `app/api/scruple/c2pa/sign/route.ts`

- Add `principal_id` to the daemon job spec. Resolve it as follows:
  - If the caller is authenticated via API key (Fusion / Adobe / studio
    plugins), look up their user's linked `principal_id` (populate this
    on user signup — WO-14 formalizes the flow; for Sprint 1, auto-mint
    a principal on first sign call).
  - If the caller is a session user, same lookup on `users.principal_id`.
- Pass through `witness` and `witness_error` fields in the API response.

### 5. Migration 023 — user → principal mapping

Add `users.principal_id` nullable column. On first sign, if null, mint a
principal (`INSERT INTO principals`, `INSERT INTO delegations` with
`tenant_id='TEN_scruple'`, scope `['scruple.c2pa.sign']`), set the column.
For existing users, this happens lazily on first sign.

Add a corresponding `principals.user_id` on the principals side (already in
WO-05 schema) — bidirectional lookup.

### 6. Internal API key for `TEN_scruple`

The signer needs credentials to POST to `/v1/log/*`. Provision at deploy time:

- Generate an API key + HMAC secret for `TEN_scruple`.
- Store in `/etc/scruple/c2pa-signer.env` (0640 root:scruple-signer):
  ```
  SCRUPLE_C2PA_INGEST_API_KEY=sk_int_<random>
  SCRUPLE_C2PA_INGEST_HMAC_SECRET=<random>
  ```
- Update `tenants` row for `TEN_scruple` with the sha256 of the API key.

These credentials NEVER leave the OCI signer subnet.

### 7. Zero-content enforcement (defense in depth)

- Signer emission code has NO code path that sends `payload_bytes`.
- Add a runtime assertion at emit: `assert body.get("payload_bytes") is None`.
- Add a code-review lint / grep-gate: any occurrence of `payload_bytes` in
  `services/c2pa-signer/` outside of an explicit `None` assignment fails
  the pre-commit hook.

## What NOT to build

- Do not block the sign response on audit-emit failure. Fail-open on emit.
- Do not batch sign leaves. C2PA signs are low-frequency (human triggered);
  single-leaf ingest is fine and produces cleaner audit trails.
- Do not embed the whole C2PA manifest in the leaf's `dims` or `meta`.
  Only its sha256. This preserves the zero-content posture.
- Do not compute the leaf hash on the daemon side and skip the ingest
  API. The ingest API's canonicalization + contiguity + delegation
  validation is what makes the audit trustworthy — bypassing it is bypassing
  the security model.

## Deliverables

- `services/c2pa-signer/emit_leaf.py`
- Updates to `services/c2pa-signer/sign_daemon.py` (integration hook)
- Migration `023_users_principal_id.sql`
- Updates to `app/api/scruple/c2pa/sign/route.ts`:
  - resolve/auto-mint `principal_id`
  - pass through `witness` correlation in response
- Provisioning script `deploy/scripts/provision-c2pa-tenant.sh` that
  creates `TEN_scruple`'s API key + HMAC secret + writes them into the
  signer env file (idempotent).
- Update `docs/deploy/README.md` with the provisioning step.
- Integration test: sign an asset through the API → verify a row appears
  in `log_leaves` with correct `stream_id` + `principal_id` + `leaf_hash`
  + `chain_hash`. Verify the API response contains the correlation.

## Acceptance criteria

- [ ] A successful C2PA sign via `/api/scruple/c2pa/sign` produces
      exactly one row in `log_leaves` for the `scruple.c2pa.sign` stream.
- [ ] A failed C2PA sign produces a leaf with `status="failed:*"` in
      `meta_json`.
- [ ] The API response contains `witness.leaf_hash`, `witness.tenant_seq`,
      and `witness.pending_checkpoint_epoch`.
- [ ] `payload_bytes` is null in every emitted leaf (verified by
      `SELECT COUNT(*) FROM log_leaves WHERE payload_bytes IS NOT NULL` = 0).
- [ ] Killing the ingest process temporarily → sign still succeeds and
      returns `witness_error` in the response (fail-open verified).
- [ ] Existing user's first sign auto-mints their `principal_id` and
      links via `users.principal_id`.
- [ ] The C2PA JUMBF of a signed asset contains an
      `ai.scruple.witness.v1` assertion with the correlation fields.

## Related

- Canonical design §5.4 (Sign event → leaf emission)
- Canonical design §9 (Zero-content posture)
- Canonical design §10 §5 Rider mapping (hash-only default)
- WO-04 — provides the isolated daemon this WO extends
- WO-06 — provides the ingest endpoint this WO calls
- WO-09 — verifier CLI's `c2pa` subcommand consumes this correlation
