# Scruple — C2PA Conformance Program Evidence Bundle

**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`
**Product name:** Scruple
**Applicant:** Docent LLC
**Bundle date:** 2026-07-16

Evidence samples for the C2PA Conformance Program reviewer, per
the specification requested on 2026-07-14.

## Bundle structure

```
Generate.output.<mediatype>/       signed sample per asserted GENERATE MIME
Raw.input.<mediatype>/             unsigned input per asserted VALIDATE MIME
Validate.output.<mediatype>/       signed output per asserted VALIDATE MIME
_bundle_report.json                machine-readable coverage summary
certificates/                      dev cert chain to verify signatures
```

## Coverage vs. Intake assertions

| Aspect | Asserted MIMEs | Covered | Signed | Documented gap |
|---|---|---|---|---|
| Generate | 16 | 16 | 15 | 1 (`application/x-pytorch`) |
| Raw input | 20 | 20 | n/a (raw = unsigned) | 0 |
| Validate output | 20 | 20 | 18 | 2 (`application/pdf`, `application/x-pytorch`) |

The three documented gaps share one cause: signing those MIMEs is
not yet exposed by the `c2pa-python` wrapper used for the bundle
producer. Each affected folder contains a `NOT_SUPPORTED.txt` note.

## Signing identity

Signed samples in this bundle carry a **development** end-entity
certificate for interop testing. Production signing uses an
end-entity certificate that will be issued by a C2PA Trust List CA
following Program acceptance of this filing.

## Verification

Every signed sample verifies as `validation_state = Valid` via any
C2PA v2.x reader against the included dev cert chain in
`certificates/`.

## Confirmation of validate scope

Scruple is NOT a capture-only application. Every asserted validate
MIME is exercised end-to-end via the `Raw.input.*` and
`Validate.output.*` folders.

## Contact

- `scruple@docentechs.com`
