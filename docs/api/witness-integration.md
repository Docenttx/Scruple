# Integrating with the Scruple Witness API

**Audience:** Vendors and enterprises running an AI inference or training stack
(on AWS, Azure, GCP, Modal, RunPod, on-prem, or anywhere else) who want their
outputs cryptographically witnessed by Scruple.

**Read time:** 10 minutes.

**Depth:** This document covers what to integrate against and how the trust
boundary works. For the full protocol spec (leaf canonicalization, checkpoint /
anchor pipeline, C2PA L2 signer isolation, GDPR-erasure-compatible
immutability), see
[`docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md`](../architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md).

---

## What you're integrating with

`https://witness.scruple.ai` — the Scruple witness server. It signs a canonical
record of every event you send it (HMAC leaf + Ed25519 checkpoint), chains the
leaves, publishes a Merkle root to a public ledger on a fixed cadence, and can
optionally counter-sign a C2PA manifest for your output artifact.

**Zero-content by design.** The witness server accepts only hashes and small
metadata. Payloads — prompts, images, model weights, PII — stay in your
storage. This is what makes GDPR erasure and the [Independent AI Witnessing
Rider](../architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md) work: your
customer can delete their raw payload from their WORM store while the
cryptographic commitment on our chain survives as an orphaned hash of bytes
that no longer exist anywhere.

**Zero coupling to your stack.** The witness server doesn't care where your
compute lives, what model you're running, or how you serve it. If you can
POST JSON over HTTPS from your inference path, you can integrate.

---

## Two integration modes

### Mode A — pre-built per-app endpoints (shipping today)

For Adobe apps (Photoshop / Illustrator / InDesign / Premiere / Lightroom /
After Effects), Fusion 360, and Kohya-ss training runs, hit the corresponding
per-app endpoint. Each accepts a fixed schema tailored to that host app.

| Host app | Endpoint | Body shape |
|---|---|---|
| Adobe CC apps (all six) | `POST /api/scruple/witness/adobe` | `{host_app, output_hash, file_size, filename, structural_summary?}` |
| Fusion 360 | `POST /api/scruple/witness/cad` | `{output_hash, file_size, filename, structural_summary?}` |
| Kohya-ss training | `POST /api/apps/kohya/witness` | `{run_id, model_hash, header_hash, output_path, structural_summary}` |

Auth is `Authorization: Bearer <api_key>`. Keys are product-scoped — a
`photoshop`-scoped key cannot post to the `illustrator` endpoint.

### Mode B — generic Continuous Audit API (M3 milestone, Sprint 2)

For anything else — your own inference server, a custom pipeline, a training
loop nobody's written an adapter for — you post canonical leaves directly to
the ingest API. This is the general-purpose surface, and it's what every future
per-app endpoint is being refactored to sit on top of.

Design details are in
[`SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md`](../architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md)
§5. The 30-second version:

```
POST https://witness.scruple.ai/v1/tenants/<tenant>/streams/<stream>/leaves
Authorization: Bearer <tenant_key>
X-Signature: <hmac-sha256 over body with tenant HMAC secret>

{
  "principal_id": "<the end-customer this leaf is on behalf of>",
  "sequence": 42,
  "event_time": "2026-07-13T02:00:00.000Z",
  "content_hash_sha256": "<hex>",
  "input_hash_sha256": "<hex>",
  "model_fingerprints_hash_sha256": "<hex>",
  "machine_manifest_hash_sha256": "<hex>",
  "kind": "inference.completed",
  "prev_leaf_hash_sha256": "<previous leaf's hash, or 32 zero bytes if first>"
}
```

Response includes the signed leaf hash, the witness signature, and the
`checkpoint_epoch` it will be included in.

Availability: private beta for design partners, GA on Sprint 3 close.

---

## Getting a key

Two paths, depending on which mode you need.

**Self-serve (Mode A only):** Sign in to `app.scruple.ai`, go to Settings →
API Keys, click **Mint key**, pick the product scope. Keys are shown once at
creation — copy immediately. Revoke from the same page.

**Design-partner (Mode B):** Email `partners@scruple.ai` with (a) the tenant
name you want, (b) the initial principals you'll be witnessing on behalf of,
and (c) whether you need enhanced (RFC 3161 TSA) or qualified (eIDAS QTSA)
tier anchoring. We'll provision the tenant, mint the tenant key + HMAC secret,
and send them via the mechanism you specify.

---

## The four-part receipt you get back

Every witnessed event returns a receipt that a third party can verify offline.
The four parts are:

1. **Leaf hash** — HMAC-signed hash of your canonical record. The signature is
   over the exact JSON you sent, so a byte-level replay proves the record
   wasn't tampered with post-witnessing.

2. **Checkpoint** — an Ed25519 signature over the Merkle root of every leaf in
   a fixed time window (default: 60 s). Independent of any specific leaf. This
   is what tells a third party "leaves 1000–1240 were all signed by the
   witness at 02:00:00 UTC on 2026-07-13" without needing to fetch each leaf.

3. **Anchor** — the checkpoint's Merkle root committed to a public ledger. For
   Sprint 1 that's Ravencoin testnet asset issuance. Sprint 2 upgrades this to
   RFC 3161 TSA (standard tier) or eIDAS-qualified TSA (qualified tier),
   preserving RVN as the artist-controlled ledger option.

4. **(Optional) C2PA manifest counter-signature** — if you're witnessing an
   output that also carries a C2PA manifest, the witness will counter-sign
   with our L2-conformant end-entity certificate. This is what makes the output
   FRE 902 self-authenticating in a US court and admissible under the EU AI
   Act Article 50 evidence rules.

You can verify any receipt offline with the reference CLI:

```
$ scruple-verify <leaf-hash>
# or
$ scruple-verify --sidecar <path/to/asset.c2pa>
```

The CLI re-derives every hash and every signature from first principles. It
doesn't need network access, doesn't call any Scruple API, and doesn't trust
anything we tell it — it validates against the on-chain anchors and the
published witness pubkey.

---

## Cost

**Mode A endpoints:** free-tier included for all `app.scruple.ai` accounts,
usage-metered at higher volume. Pricing at
[`scruple.ai/pricing`](https://scruple.ai/pricing).

**Mode B tenant streams:** three tiers, matching your legal posture:

| Tier | Anchor | Best for | Order-of-magnitude cost per leaf |
|---|---|---|---|
| Standard | RFC 3161 TSA (RVN as artist option) | Commercial evidence, provenance receipts | fractions of a cent |
| Enhanced | RFC 3161 TSA + independent second timestamp | Regulatory audit trails (SEC, FDA, ISO) | single-digit cents |
| Qualified | eIDAS-qualified TSA + PKI-Trust-List issuer | EU AI Act Article 50 obligations, cross-border legal defensibility | tens of cents |

Every tier ships with the same C2PA-L2 counter-sign option and the same
zero-content posture.

---

## What we do NOT do

- **We do not host your inference.** You bring your own model, compute,
  storage, orchestration.
- **We do not see your prompts or outputs.** Only hashes. If you send us
  content bytes we will reject the request; this is enforced by the ingest
  schema, not by policy.
- **We do not accept custody of your customer's data.** The principal
  (your end customer) reads directly from us with their own credential — they
  do not go through you to get their receipts.
- **We are not a general-purpose signing service.** We witness AI-inference
  and AI-training events specifically. Other event types are out of scope.

---

## Support & escalation

- **Docs & integration:** `partners@scruple.ai`
- **Security:** `security@scruple.ai` (PGP key at [`scruple.ai/security`](https://scruple.ai/security))
- **Rider counsel:** the Independent AI Witnessing Rider template is at
  [`docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md`](../architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md)
  — send this to your MSA/DPA counsel; it's designed to be self-executing
  against this production stack.

---

## Change log

- 2026-07-13 — Initial draft. Sprint 1 (Mode A per-app endpoints) shipping;
  Sprint 2 (Mode B generic ingest) design-partner private beta.
