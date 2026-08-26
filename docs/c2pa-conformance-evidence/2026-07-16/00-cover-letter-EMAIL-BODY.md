# Response to the C2PA Conformance Program Reviewer

**From:** Shaun Hargadine, on behalf of Docent LLC (dba Docent Technologies)
**Date:** 2026-07-16
**Re:** Evidence samples + Generator Product Security Architecture
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`

---

Dear Scott,

This message responds to both halves of your evidence request in one
submission. Everything you asked for is inside the single attached zip:

**`scruple-c2pa-conformance-response-2026-07-16.zip`**

## Confirmations

- **Product role:** Generator Product (not capture-only). The
  bracketed "capture only" question is answered by the
  `Validate.output.<mime>/` folders in Part 1, which round-trip real
  ingested media through the signer.
- **Assurance level sought:** **Level 2**, with implicit Level 1.
- **Legal entity:** Docent LLC (Delaware), dba Docent Technologies.

## Where each ask lives in the zip

| Your ask | Location |
|---|---|
| Signed outputs, one per asserted generate MIME | `Part-1-Media-Samples/Generate.output.<mediatype>/` |
| Raw unsigned inputs, one per asserted validate MIME | `Part-1-Media-Samples/Raw.input.<mediatype>/` |
| Signed outputs after ingestion, per asserted validate MIME | `Part-1-Media-Samples/Validate.output.<mediatype>/` |
| Generator Product Security Architecture Document (Appendix C) | `Part-2-Security-Architecture/01-GPSA.md` |
| Architecture diagram | `Part-2-Security-Architecture/evidence/architecture-diagram.md` |
| Hardware Root-of-Trust attestation evidence for L2 §6.2.2 | `Part-2-Security-Architecture/evidence/l2-evidence-*/` |

## Documented gaps

Three MIMEs cannot yet be signed by the `c2pa-python` wrapper used
by our bundle producer (`application/pdf`, `application/x-pytorch`,
and pytorch on the generate side). Raw samples are provided and
each affected folder contains a `NOT_SUPPORTED.txt`. Signed samples
will follow once the wrapper exposes them.

## Architecture at a glance

Three roles: Client → Application tier → Signer. The Signer runs
inside a hardware-attested Trusted Execution Environment. The C2PA
end-entity ES256 private key is generated and held inside a PKCS#11
HSM inside that TEE. The key is non-extractable. Two independent
hardware Root-of-Trust attestation bundles are attached; each
cryptographically binds a specific HSM public key to a specific
attested TEE, and the two attestations show byte-identical VM
measurements, demonstrating a reproducible boot image. Full
per-objective mapping in §C.1.6 of the GPSA.

## Next steps

We are ready for the assessment queue and happy to answer any
follow-up questions or take a video-conference review at your
convenience.

Best regards,

**Shaun Hargadine**
Docent LLC (dba Docent Technologies)

- Contact: `scruple@docentechs.com`
- Public product site: `scruple.ai`
