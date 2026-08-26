# Runbook — B2B Customer Onboarding (Witness API + C2PA Signing)

**Cited from:** `01-GPSA.md` §C.1.3 (intended use case #2: B2B marking infrastructure), §C.2.2 (mutual authentication), §C.2.6 (rate limits and quotas).
**Audience:** Scruple operator onboarding a third-party integrator (a generative-AI product like ComfyOrg, an inference platform, a creative-AI cloud service) that wants to use Scruple's Witness API and C2PA signing under their own product surface.
**Goal:** provision a tenant, issue an API key + HMAC secret, hand the integrator the credentials and integration docs, and confirm a smoke test round-trips before closing the ticket.
**Wall time:** ~20 minutes hands-on. Legal (MSA + Rider) is out-of-band and typically closed before this runbook is invoked.
**Companion doc:** the integrator-facing documentation at `docs/api/witness-integration.md`.

---

## 0. Prerequisites

- **Signed MSA + Data Processing Addendum** between Docent LLC and the integrator, including the Independent AI Witnessing Rider (template at `docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md`) executed as an attachment. The Rider is what makes the emission obligation and the direct-access-for-principals model contractual — without it, the integrator has an API key but no legal shape for the audit chain that the API produces.
- **A tenant slug** agreed with the integrator. Format `[a-z0-9-]{3,32}`. Convention: use the integrator's product name lower-cased with dashes. Examples: `comfyorg`, `acme-avatars`, `blueprint-video`.
- **Scope decision.** Which scopes the API key can exercise. Sprint 1 supports:
  - `witness:write` — POST leaves to `/v1/log/<stream>` on streams the tenant owns.
  - `c2pa:sign` — invoke `/api/scruple/c2pa/sign` to produce a C2PA-signed asset under Scruple's cert.
  - `streams:manage` — create and update streams via `POST /v1/streams`.
- **Assurance tier decision** per stream. Per `CANONICAL_SCRUPLE_WITNESSING_L2.md` §8: `standard` (checkpoint 1h, no TSA), `enhanced` (5m, RFC 3161), `qualified` (1m, eIDAS TSA). Default `enhanced` unless the integrator's product is EU AI Act Article 50 regulated, in which case `qualified`.
- Operator has SSH access to Backend-Web with `pnpm` installed and the `db/scruple.db` SQLite file writable by the `scruple` user.
- OCI Vault permission to create a new Secret under the KEK for the tenant HMAC (Sprint 1 skips the KEK wrap per `lib/witness/tenantAuth.ts` comment — the HMAC secret is stored plaintext until the WO-17 lifecycle work lands).

---

## 1. Provision the tenant

The tenant row and HMAC secret are created together. The current Sprint 1 provisioning path is a shell script referenced from `lib/db/migrations/030_scruple_log.sql` and `lib/witness/tenantAuth.ts`:

> [proposed — add to admin CLI] The current tree references `deploy/scripts/provision-c2pa-tenant.sh` in three places but the script itself has not landed. This runbook uses the intended shape. Until the script lands, an operator can do the same work via a `pnpm tsx` one-liner (§1a). Both produce the same DB row.

### 1a. Interim provisioning (until the shell script lands)

```bash
# On Backend-Web, in /data/scruple-web:
pnpm tsx -e '
  import { conn } from "./lib/db/sqlite";
  import { createHash, randomBytes } from "node:crypto";

  const slug   = process.argv[2] || "acme-avatars";
  const name   = process.argv[3] || "Acme Avatars, Inc.";

  // API key: sk_live_ prefix + 32 bytes base64url.
  const apiKey = "sk_live_" + randomBytes(32).toString("base64url");
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  // HMAC secret: 32 raw bytes hex-encoded, per lib/witness/hmacMiddleware.ts.
  const hmac = randomBytes(32).toString("hex");

  const tenantId = "TEN_" + slug.replace(/-/g, "_");
  conn().prepare(`
    INSERT INTO tenants
      (tenant_id, name, api_key_hash, hmac_secret_enc, status,
       is_internal, rate_limit_rps, created_at)
    VALUES (?, ?, ?, ?, "active", 0, ?, datetime("now"))
  `).run(tenantId, name, keyHash, hmac, 100);

  console.log(JSON.stringify({tenant_id: tenantId, api_key: apiKey, hmac_secret: hmac}, null, 2));
' "acme-avatars" "Acme Avatars, Inc."
```

Output (the entire block is displayed **once** — the plaintext API key and HMAC secret are not recoverable from the DB):

```json
{
  "tenant_id":   "TEN_acme_avatars",
  "api_key":     "sk_live_...",
  "hmac_secret": "..."
}
```

Immediately paste the block into the integrator handover channel (encrypted email, 1Password vault, etc.). Do not persist it on the operator laptop.

### 1b. Intended (future) admin CLI

> [proposed — add to admin CLI] Once the following commands land in `package.json`'s `scripts` block and a companion script in `deploy/scripts/`, prefer them over §1a:
>
> ```bash
> pnpm run admin:tenant -- \
>   --slug "acme-avatars" \
>   --name "Acme Avatars, Inc." \
>   --rate-limit-rps 100 \
>   --hmac-provision
>
> pnpm run admin:api-key -- \
>   --tenant "TEN_acme_avatars" \
>   --scopes "witness:write,c2pa:sign,streams:manage" \
>   --expires 365d
> ```
>
> These wrap the same DB writes as §1a and route the HMAC secret through the KEK path (WO-17). Until then, use §1a and treat the `hmac_secret_enc` column as plaintext.

---

## 2. Create the integrator's stream(s)

Every leaf the integrator emits lands on a named stream. Convention: the stream name namespaces the tenant slug — `acme.avatars.render` for the integrator's rendering pipeline, `acme.avatars.publish` for outputs going to their end-users, etc.

The integrator can create their own streams via the API once they have the credentials (§4), but for the first stream during onboarding, the operator seeds one so the smoke test in §6 has somewhere to land:

```bash
# On Backend-Web, HMAC-authenticated POST:
timestamp=$(date -u +%s)
body='{"name":"acme.avatars.render","tier":"enhanced","retention_days":365,"principal_mode":"tenant"}'
signature=$(printf '%s\n%s' "$timestamp" "$(printf '%s' "$body" | sha256sum | awk '{print $1}')" | \
            openssl dgst -sha256 -mac HMAC -macopt "hexkey:${HMAC_SECRET_HEX}" -binary | \
            xxd -p -c 256)

curl -sS -X POST 'https://witness.scruple.ai/v1/streams' \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "X-Scruple-Timestamp: ${timestamp}" \
  -H "X-Scruple-Signature: ${signature}" \
  -H "Content-Type: application/json" \
  --data-raw "${body}"
```

Confirm the stream is created:

```bash
curl -sS -H "Authorization: Bearer ${API_KEY}" \
  'https://witness.scruple.ai/v1/streams' | jq '.streams[] | select(.name=="acme.avatars.render")'
```

---

## 3. Hand off the integration documentation

Send the integrator:

1. **`docs/api/witness-integration.md`** — the canonical integrator-facing guide. Covers auth headers, leaf schema, HMAC computation, batching rules, and the pre-built per-app endpoints for Adobe/Fusion/Kohya if the integrator's product uses any of those hosts.
2. **`docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md`** — deep reference. Not required reading for the integration itself, but the integrator's security team will want it during their vendor-review.
3. **The two primary endpoints** they'll use day-to-day:
   - `POST /v1/log/<stream_name>` — emit one witness leaf. Request body = canonical leaf v23 (see `lib/witness/canonicalLeafV23.ts`); response `{leaf_hash, chain_hash, pending_checkpoint_epoch}`.
   - `POST /api/scruple/c2pa/sign` — sign an asset with Scruple's C2PA cert. Request body `{asset_bytes_b64, manifest: {claim_generator, format, title, assertions}}`; response `{signed_asset_b64, manifest_urn, leaf_hash}` (the sign event auto-emits to `_scruple.c2pa.sign`, and the returned `leaf_hash` is that emission's leaf).
4. **The SDK.** Once shipped (WO-15), point them at `npm i @scruple/log`. Until then, the raw HTTP + HMAC recipe in §2 is the reference.
5. **The verifier CLI.** `npm i -g @scruple/verify` (or `packages/scruple-verify/` in the source repo). They'll want this on their own CI to verify their emitted leaves round-trip.

---

## 4. Rate limits and quotas

Per-tenant sliding-window rate limiter lives at `lib/witness/rateLimit.ts`. Default budget on a Sprint 1 provisioned tenant is **100 req/min** (`rate_limit_rps=100`, per-second bucket resetting each second). Adjust per tenant as needed:

```bash
# On Backend-Web:
pnpm tsx -e '
  import { conn } from "./lib/db/sqlite";
  conn().prepare(`UPDATE tenants SET rate_limit_rps=? WHERE tenant_id=?`)
        .run(500, "TEN_acme_avatars");
  console.log("rate_limit_rps updated");
'
```

Communicate the limit to the integrator explicitly. If they need higher throughput for a launch window, they can request a bump — the rate-limit change is live within one process restart cycle. The rate limiter is in-process only (per `lib/witness/rateLimit.ts` comment); on a multi-node deploy this is redundant per node.

**Quota (data volume)** is not enforced in Sprint 1 — the retention field on the stream sets how long leaves are kept, but there is no per-tenant leaf-count cap. Track leaf-count against the MSA's contracted volume out-of-band until quota enforcement lands.

---

## 5. Trust manifest publication

The integrator's downstream verifiers (their end-users' C2PA readers, or their own audit tooling) pin the Scruple trust anchor at:

```
https://witness.scruple.ai/.well-known/witness-trust.json
```

This manifest carries:

- The currently-active Scruple C2PA signer certs (per `01-GPSA.md` §C.2.2 "Key rotation" and `cert-enrollment.md` §6).
- The witness checkpoint pubkeys (Ed25519, per `CANONICAL_SCRUPLE_WITNESSING_L2.md` §4.1).
- The currently-active signer topologies with their SEV-SNP attestation URLs (per `cvm-provision.md` §10).

Tell the integrator:

- Their verifier code (or their end-users' C2PA readers) should fetch this manifest at start-up and cache with a 24h TTL.
- For high-assurance verification, fetch fresh — the manifest is small and updated infrequently.
- The manifest itself is Ed25519-signed by the witness root key so a compromise of the CDN cannot forge manifest entries; verifiers must validate the signature against a pinned witness root key. The witness root key fingerprint is published in the Rider Schedule W-1.

---

## 6. Smoke test the integration

Give the integrator this exact `curl` recipe. They should be able to run it end-to-end within 5 minutes of receiving the credentials and confirm every layer is green.

```bash
# Fill in the two credentials from §1.
export API_KEY='sk_live_...'
export HMAC_SECRET_HEX='...'   # 32 bytes hex

# 1. API version — no auth needed. Confirms reachability.
curl -sS https://witness.scruple.ai/api/version | jq .

# 2. List streams — confirms API key + tenant lookup work.
curl -sS -H "Authorization: Bearer ${API_KEY}" \
  https://witness.scruple.ai/v1/streams | jq .

# 3. Submit a test leaf.
timestamp=$(date -u +%s)
body=$(jq -nc \
  --arg ts "$(date -u --iso-8601=seconds)" \
  '{
     tenant_id:    "TEN_acme_avatars",
     principal_id: "PRN_smoke001",
     stream_id:    "STR_acme_avatars_render",
     tenant_seq:   1,
     event_time:   $ts,
     payload_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
     dims: {},
     meta: {product: "smoke-test"}
   }')
signature=$(printf '%s\n%s' "$timestamp" "$(printf '%s' "$body" | sha256sum | awk '{print $1}')" | \
            openssl dgst -sha256 -mac HMAC -macopt "hexkey:${HMAC_SECRET_HEX}" -binary | \
            xxd -p -c 256)

curl -sS -X POST 'https://witness.scruple.ai/v1/log/acme.avatars.render' \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "X-Scruple-Timestamp: ${timestamp}" \
  -H "X-Scruple-Signature: ${signature}" \
  -H "Content-Type: application/json" \
  --data-raw "${body}" | jq .
# Expected response: {"leaf_hash": "...", "chain_hash": "...", "pending_checkpoint_epoch": N}

# 4. Fetch the inclusion proof after the next checkpoint fires (5 min on 'enhanced').
sleep 310
curl -sS -H "Authorization: Bearer ${API_KEY}" \
  'https://witness.scruple.ai/v1/proof/leaf/STR_acme_avatars_render/1' | jq .

# 5. Verify offline with the reference CLI:
scruple-verify leaf ./leaf.json ./proof.json
# Expected: 'OK — leaf hash matches, inclusion proof valid, checkpoint sig verified'
```

If all five steps return 2xx and the verifier CLI exits 0, the integration is live.

---

## 7. Support and escalation

- **Contact:** `scruple@docentechs.com` — all integration, security, compliance, credential, quota, Rider, incident, and audit questions.
- **On-call SLA:** per the MSA. Default response commitments during a Rider-active engagement:
  - P0 (witness ingest unavailable > 5 min): 15 min ack, 1h workaround.
  - P1 (auth failures blocking integrator writes): 1h ack, 4h fix.
  - P2 (functional bug not blocking emit): next business day.
- **Rotation notifications:** any C2PA cert rotation per `cert-enrollment.md` §7 auto-notifies all `witness:write`+`c2pa:sign` scoped tenants ≥30 days ahead of the deprecated_at date, so integrator verifier caches can refresh in time.

---

## 8. Deprovisioning

Triggered by MSA termination, non-payment, security-team decision, or integrator request.

1. **Revoke the API key.** Set `tenants.status = 'revoked'` — `lib/witness/tenantAuth.ts::lookupTenantByBearer` returns null for any bearer whose tenant is not `active`, so further writes fail 401 immediately.

   ```bash
   pnpm tsx -e '
     import { conn } from "./lib/db/sqlite";
     conn().prepare(`UPDATE tenants SET status=? WHERE tenant_id=?`)
           .run("revoked", "TEN_acme_avatars");
   '
   ```

2. **Backfill an export of the integrator's witness stream** for evidence preservation. The Rider §4 "Principal Direct Access" clause obliges Scruple to produce a proof-bundle export at no charge on delegation revoke:

   > [proposed — add to admin CLI] `pnpm run admin:export -- --tenant TEN_acme_avatars --output ./exports/` produces a tar containing every leaf under the tenant's streams plus the inclusion-proof bundle for each. Ship in `deploy/scripts/`.

   Deliver the export to the integrator's compliance contact.

3. **Publish a `_scruple.delegations` leaf** recording the revocation. Per `CANONICAL_SCRUPLE_WITNESSING_L2.md` §3.3, delegation grant + revocation events are themselves witnessed. Emit `{event: "delegation_revoked", tenant_id: "TEN_acme_avatars", timestamp: <now>, reason: "<contract termination | integrator request | security>"}` via the internal emitter (`lib/witness/scrupleInternalEmit.ts`).

4. **Retire the tenant's streams** per their configured `retention_days`. The scheduled purge job honors the setting; do not manually delete leaves — the retention is contractual and the auto-purge is the audit-clean path. Historical leaves remain verifiable via the exported proof bundle for the full retention period.

5. **Close the integrator record** in the internal partner tracker with the deprovision date and a link to the delivered export.

Deprovisioning is complete when steps 1–5 are done and the smoke test in §6 returns 401 for the revoked API key.
