# WO-02 — C2PA production cert application

**Sprint:** 1
**Estimate:** 4 owner-hours to submit; then wait weeks for issuer turnaround
**Blocking:** WO-01 (need C2PA-signer key's public half to form CSR)
**Blocks:** WO-18 (final L2 evidence package needs the production cert loaded)
**External dependency:** issuer processing time

## Goal

Apply for a production C2PA end-entity signing certificate from a recognized
C2PA-trust-list issuer, using a CSR whose public key comes from the OCI Vault
key provisioned in WO-01. The private key never leaves Vault at any point in
this process.

## Issuer choice

Two viable options as of 2026-07:

- **DigiCert Content Credentials** — Adobe's direct-partner issuer. Standard
  choice, well-documented, ~$300–$600/year. Best fit if we ever want Adobe-
  ecosystem interop weight.
- **SSL.com C2PA** — the other C2PA-trust-list issuer with a document-signing
  product. Slightly cheaper. Faster onboarding for smaller orgs.

Recommendation: **DigiCert Content Credentials** unless procurement pushes
back on price. Both terminate at C2PA-trust-list roots.

## What to do

1. **Extract the public key** from the OCI Vault key `scruple-c2pa-signer-prod`
   using `oci kms crypto get-public-key --key-id <c2pa-key-ocid>`. Save as
   PEM (`prod-signer.pub.pem`).

2. **Generate the CSR** using the extracted public key. This is the tricky
   part: openssl's CSR generation normally reads the private key to sign the
   CSR itself, but our private key is non-exportable. Two options:

   - **Option A (preferred):** Build the CSR TBS structure (distinguished
     name + public key + extensions), hash it, sign the hash via
     `oci kms crypto sign` on the Vault key, then assemble the DER CSR from
     TBS + algorithm + signature. Script this in
     `infra/oci/scripts/vault-csr.py` (~50 lines using `cryptography`
     package to build TBS and `oci` SDK to sign). Commit the script.
   - **Option B:** Use OCI Certificates Service to create a CA-signed
     certificate against the Vault key — Vault has native CSR generation
     for keys it holds. Verify at provisioning time that OCI Certificates
     supports our key OCID; use this if it does.

3. **CSR content:**
   - Common Name: "Scruple by Docent Technologies"
   - Organization: "Docent Technologies LLC" (verify exact legal entity name
     with counsel — this appears in the signer's cert subject and will be
     visible to every verifier)
   - Organization Unit: "Scruple Provenance"
   - Country / State / Locality: per issuer requirements
   - Key usage: `digitalSignature`
   - Extended key usage: `1.3.6.1.5.5.7.3.36` (id-kp-documentSigning) —
     **this is the C2PA EKU. Do not use the legacy Adobe OID.**

4. **Prepare identity documents** the issuer will require:
   - Docent Technologies LLC certificate of formation / articles.
   - EIN / tax ID document.
   - Proof of domain control for `scruple.stooges.ai` and `stooges.ai`
     (DNS TXT record challenge or email challenge to `admin@stooges.ai`).
   - Authorized signatory letter (counsel to prepare) naming the person
     with authority to bind Docent to the cert-issuance agreement.

5. **Submit the CSR and identity docs** to the chosen issuer. Save the
   ticket number / order ID to `infra/oci/certs/order-id.txt` (gitignored
   — this is a live procurement reference).

6. **On issuance:**
   - Download the end-entity cert + full issuer chain from the issuer.
   - Verify cert chains cleanly with `openssl verify -CAfile <chain>
     <signer.pem>`.
   - Verify EKU with `openssl x509 -in signer.pem -noout -ext extendedKeyUsage`
     shows `1.3.6.1.5.5.7.3.36`.
   - Verify cert public key matches Vault key's public half exactly:
     `openssl x509 -in signer.pem -noout -pubkey | sha256sum` should equal
     `sha256sum prod-signer.pub.pem`.
   - Commit the chain PEM as `infra/oci/certs/scruple-c2pa-prod-chain.pem`
     (public, safe to commit; contains only cert and issuer chain, no key
     material).
   - Update `docs/architecture/lifecycle/key-generation.md` with cert
     serial, issuer, notBefore, notAfter, subject key ID.

## What NOT to do

- Do not generate the CSR using a locally-held private key. If the CSR
  comes from a key that isn't in Vault, the whole L2 story is undermined
  from the first step.
- Do not download or attempt to store the C2PA private key anywhere. The
  Vault key is the only signing key that will ever exist.
- Do not use the legacy Adobe OID `1.3.6.1.4.1.62558.2.1` for EKU. The
  spec-compliant OID is `1.3.6.1.5.5.7.3.36`.
- Do not commit the CSR generation script to a public repo without redacting
  order IDs and issuer contact details.

## Deliverables

- `infra/oci/scripts/vault-csr.py` — CSR generation script (or note
  documenting Option B path).
- `infra/oci/certs/scruple-c2pa-prod-chain.pem` (committed only after
  issuance; contains only cert + issuer chain).
- Order ticket / receipt in secure secrets store (not git); reference in
  `docs/architecture/lifecycle/key-generation.md`.
- Update to lifecycle doc with cert details.
- Timeline note: expected issuer turnaround (typical DigiCert Content
  Credentials: 5–15 business days depending on validation).

## Acceptance criteria

- [ ] CSR submitted to issuer with correct EKU and Vault-derived public key.
- [ ] Identity documents accepted by issuer.
- [ ] On issuance: cert chain verifies, EKU correct, public key matches
      Vault key.
- [ ] Cert loaded via `SCRUPLE_C2PA_CERT_CHAIN` env in the signer daemon
      (WO-03 wires this up) — verified by signing a test asset and
      confirming `openssl x509 -in <chain> -noout -subject` matches
      the signer daemon logs.
- [ ] Interop v2 pass (WO-18) uses production cert and reports zero
      `signingCredential.*` failures on any verifier.

## Interim behavior (before cert issues)

While waiting on issuer turnaround, the signer daemon (WO-03/04) can
continue using the C2PA sample dev cert with `SCRUPLE_C2PA_DEV=1` set
(gated to non-prod systemd units only). Sprint 1 E2E smoke (WO-10) is
runnable with the dev cert; L2 evidence package (WO-18) is not.

## Related

- Canonical design §4.1 (C2PA signer key)
- Canonical design §11 checklist item #2
- WO-01 — provides the public key
- WO-03 — consumes the cert chain
- WO-18 — final evidence package requires production cert
