# WO-12 — Passthrough handling for uncommon attestation types

**Phase:** 4 (Remaining verifiers, parallelizable)
**Depends on:** WO-01, WO-03
**Blocks:** none
**Owner:** shared library + server
**Effort:** ~1 day

## Purpose

Handle attestation types Scruple does not natively verify (uncommon
formats, emerging standards, customer-proprietary). These are stored
opaquely with a `verifier_reference` URL; downstream verifiers use that
reference to re-verify. Receipts distinguish these from Scruple-verified.

## Deliverables

### 1. Dispatch layer passthrough

Update `packages/scruple-attestation-verifiers/src/dispatch.ts`:

- If `attestation_type` is not registered as a built-in plugin:
  - Require `verifier_reference` in the envelope; reject if missing.
  - Validate `verifier_reference` is a valid `https://` URL (basic format check; no fetch at ingest time).
  - Return `VerifyResult { ok: true, provider: '<type>', passthrough: true, verifier_reference: <url> }`.
- The `ok: true` here means "accepted for storage", not "cryptographically verified" — the passthrough flag is what distinguishes.

Update `VerifyResult` type to include `passthrough?: boolean` and `verifier_reference?: string`.

### 2. Server-side ingest handling

In `lib/baseline/ingest_check.ts`:

- On passthrough dispatch result, set `platform_attestation_verified = 2` (stored, not verified).
- Continue accepting the leaf.

### 3. Receipt hydration

Wherever receipts are rendered (`app/receipt/[scrId]/page.tsx` and any
JSON receipt endpoint), the receipt data model MUST distinguish:

- **Scruple-verified attestation** (`platform_attestation_verified == 1`): display in an "attested" section with the extracted measurements + a "Verified by Scruple against <vendor> root" line.
- **Passthrough attestation** (`platform_attestation_verified == 2`): display in a visually distinct "Stored — third-party verifier reference" section with the `verifier_reference` URL clearly presented. The word "verified" MUST NOT appear in this block per Standard §15.4.

For this WO, adding the data-model distinction is required; the visual
rendering is a nice-to-have (can be a separate polish WO if the receipt
page rewrite is scoped larger).

### 4. Documentation

Update `docs/api/witness-integration.md` (once it exists in updated
form) to include an example of a passthrough submission. For this WO,
land the doc snippet as an appendix in the WO itself; move to the
integration guide when that doc is updated.

## Acceptance criteria

- [ ] Dispatch returns `passthrough: true` for an unknown attestation type with `verifier_reference`.
- [ ] Dispatch rejects (throws) for unknown type without `verifier_reference`.
- [ ] Ingest sets `platform_attestation_verified = 2` for passthrough leaves.
- [ ] Receipt data model exposes the distinction (JSON field explicitly).
- [ ] Unit tests cover both branches.

## Notes

- Do NOT fetch the `verifier_reference` URL at ingest — that's the
  receipt-consumer's job, not ours. Doing so would create a downtime /
  latency dependency on customer infra.
- If we later want to *offer* a verifier-registry service, that's a
  separate product.

## Landing

One commit: `feat(baseline): passthrough attestation handling + receipt data-model distinction`.
