# Governance — internal responsibility + incident response

Small-organisation posture. Docent Technologies (DBA Scruple) has ≤10
headcount. The Code's Section 1 SME proportionality clause applies.

## Responsibility

- **Signatory of record** (with authority to bind under Section 1 of the
  Code): Shaun Hargadine, Docent Technologies (US).
- **Technical owner** of the Scruple Standard (marking regime, cryptographic
  parameters, canonical leaf preimage schemas): same. Contact
  `partners@scruple.ai`.
- **Compliance contact** for Code obligations, questions from the AI
  Office, third-party verification issues: `compliance@scruple.ai`.
- **Security contact** for cryptographic-integrity issues (e.g. suspected
  signer compromise, trust anchor drift): `security@scruple.ai`.
- **Public disclosure contact**: same three inboxes.

## Incident response

Incidents in scope:

1. **Signer key compromise** — actual or suspected exposure of a
   production ES256 signing key.
2. **Trust anchor drift** — a Scruple root or intermediate cert unexpectedly
   present or missing from our published trust manifest.
3. **Marking-layer break** — a Scruple-produced output found in the wild
   that does not carry the expected 1.1.1 + 1.1.3 marks (i.e., a bug in
   our marking pipeline).
4. **Reader / verifier discrepancy** — an independent C2PA reader returns
   a different validation state than `scruple-verify` on the same artefact.

Response pattern for each:

1. **Detect** — automated via CI checks on published trust manifest, weekly
   independent-reader sample from production, `_bundle_report.json`-style
   regression on the Conformance evidence.
2. **Contain** — for signer compromise, rotate the key via OCI Vault
   (hardware-backed rotation completes without re-signing historical
   outputs; the compromised cert is added to a Scruple-published CRL-style
   revocation list).
3. **Communicate** — public statement to `security@scruple.ai` subscribers
   and a post at `scruple.ai/security-advisories`; notification to the AI
   Office within 72 hours per Section 1 SME expectations.
4. **Remediate** — the incident is fully closed only when the marking-layer
   integrity of every affected output is either restored (via re-signing
   or supplemental annotation) or documented as un-restorable, and the
   root cause has a permanent CI regression preventing recurrence.

## Change management for the marking regime

Any change to the canonical leaf preimage (v2.4 → v2.5, etc.), the C2PA
manifest structure we emit, or the cryptographic algorithm requires:

1. New canonical module version + parallel-run against the previous version
   for at least one checkpoint epoch.
2. Update to `docs/api/witness-integration.md`.
3. Update to this bundle's `03-marking-implementation/marking-technical-spec.md`.
4. Notification to any AI-Office bilateral contact.

## Internal cadence

Per the SME proportionality clause: internal review of marking-regime
integrity against internal benchmarks every quarter, published summary of
integrity metrics with each release.
