# Security Policy

Scruple is a C2PA-compliance provenance platform. Any weakness that lets an
attacker forge, spoof, or invalidate a signed provenance receipt is treated
as a first-order security bug. Please report suspected vulnerabilities using
the process below.

## Reporting a vulnerability

- **Primary contact:** `security@scruple.ai`
- **Alternate contact:** `compliance@scruple.ai`
- **PGP:** encryption is strongly preferred. Our public key and canonical
  contact record are published per RFC 9116 at
  `https://scruple.ai/.well-known/security.txt`.
- **Acknowledgment SLA:** we acknowledge every report within **48 hours**
  (business days, UTC).

When possible, include: affected component and version/commit, reproduction
steps, an exploit or PoC, observed impact, and any known mitigations.

## In scope

- C2PA signing pipeline (`services/c2pa-signer/`, generator + validator).
- Witness chain integrity: Merkle log, checkpoint signing, anchor publication.
- Key-management substrate: OCI SEV-SNP confidential-computing enclave and
  OCI Vault (attestation, sealing, key release).
- Authentication and authorization boundaries across the Next.js app,
  witness API, and Modal workers.
- Cross-tenant isolation (data, keys, receipts, audit logs).
- Any path that could produce a spoofed, replayed, or otherwise
  non-attributable provenance receipt.

## Out of scope

- Rate-limiting on public unauthenticated endpoints where the sole impact is
  service degradation.
- Missing security headers on non-sensitive marketing pages.
- Best-practice or hardening findings with no demonstrated exploit path.
- Vulnerabilities in third-party services outside our administrative
  control (please report those upstream).

## Triage and remediation timeline

Severity is scored under CVSS 3.x. Target remediation windows match the
C2PA GPSR §6.6 footnote for L2 conformants:

| Severity        | Target fix window |
|-----------------|-------------------|
| HIGH (7.0–10.0) | 30 days           |
| MEDIUM (4.0–6.9)| 90 days           |
| LOW (0.1–3.9)   | 180 days          |

## Coordinated disclosure

Default embargo is **90 days** from initial acknowledgment. We will publish
an advisory once a fix is generally available. Extensions may be agreed
mutually where a fix requires coordinated upstream or partner action.

## Bug bounty

We do not currently operate a paid bounty program. With the reporter's
permission, confirmed and materially valid reports will be credited at
`https://scruple.ai/security/hall-of-fame`.

## Related documentation

- Witnessing architecture: `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md`
- C2PA Conformance L2 evidence bundle: `docs/l2-evidence/`
- EU AI Office / GPAI response materials: `docs/eu-ai-office/`
