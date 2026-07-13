# WO-13 — Reference verifier CLI: baseline + attestation re-verification

**Phase:** 5 (Reference verifier CLI)
**Depends on:** WO-04, WO-07, WO-08–WO-11 (any verifier plugins ready to ship)
**Blocks:** none
**Owner:** CLI (Node/TypeScript)
**Effort:** ~2 days

## Purpose

Ship the reference verifier CLI upgrades so any third party (auditor,
regulator, publisher) can independently re-verify a Scruple receipt's
baseline chain AND all attestations, without calling Scruple's API. This
is what makes Scruple-verified attestations truly self-authenticating.

## Deliverables

### 1. Import shared verifier library

`packages/scruple-verify/package.json` adds dependency on
`@scruple/attestation-verifiers` (workspace protocol reference).

### 2. New subcommands

Extend the existing `scruple-verify` CLI:

**`scruple-verify baseline <receipt-file>`**

- Load the receipt (JSON or `.c2pa` sidecar).
- Extract the receipt's `baseline_hash`.
- Walk the baseline chain (via receipt's declared audit endpoint or a
  local baseline dump) to verify:
  - Every baseline's `prev_baseline_hash` links correctly.
  - Every baseline's signature verifies against Scruple's witness
    signer (chain to Scruple substrate attestation).
- Print a summary: baseline hash, activation time, prev chain length.
- Exit 0 on all baselines verify; 1 on any break.

**`scruple-verify attestation <receipt-file>`**

- Load the receipt.
- Extract every `platform_attestation` envelope on every leaf.
- For each envelope:
  - If `attestation_type` is a built-in, dispatch to the shared library
    verifier plugin and print the result.
  - If passthrough, print the `verifier_reference` URL + a "not
    verified by this CLI — see the reference URL" line.
- Print per-leaf summary + overall pass/fail.
- Exit 0 on all attestations verify (or passthrough acknowledged); 1 on
  any failed verification.

**`scruple-verify full <receipt-file>`** — runs `baseline`, `attestation`,
and existing `c2pa` verification in sequence; single overall verdict.

### 3. Output format

Human-readable by default. `--json` flag emits machine-parseable output
for programmatic consumers.

### 4. Documentation

Update `packages/scruple-verify/README.md` with:
- Install instructions
- All subcommands with examples
- The two-chain receipt architecture (from Standard §15.1) explained in
  the context of what the CLI verifies

## Acceptance criteria

- [ ] `scruple-verify --help` lists all new subcommands.
- [ ] Sample receipt with a SEV-SNP attestation verifies via `scruple-verify attestation` (exit 0).
- [ ] Sample receipt with a mutated attestation fails (exit 1 with specific error).
- [ ] Passthrough attestation prints the `verifier_reference` and reports "not verified by CLI" (exit 0 — not a CLI failure, just a scope note).
- [ ] Full run (`scruple-verify full`) covers baseline + attestation + existing c2pa in one call.
- [ ] `--json` output validates against a documented schema.

## Notes

- The CLI is the customer-shippable proof-of-independence. Its verifier
  plugins MUST be the same code as the server's (imported from the shared
  library), so any bug fix or new verifier lands in both places
  simultaneously.
- If a customer's receipt references a Scruple witness endpoint that's
  down, the CLI MUST still be able to verify the leaf integrity from
  local data + public-ledger anchor. Only baseline-chain walking
  requires the receipt to contain the chain (or an accessible endpoint).

## Landing

One commit: `feat(cli): baseline + attestation re-verification via shared library`.
