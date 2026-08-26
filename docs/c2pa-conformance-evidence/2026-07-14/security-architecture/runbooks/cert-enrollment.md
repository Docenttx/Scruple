# Runbook — C2PA Trust List End-Entity Certificate Enrollment

**Cited from:** `01-GPSA.md` §C.1.2, §C.2.1, §C.2.2 "Key rotation".
**Audience:** Scruple operator with SSH access to the production Signer CVM and Docent LLC's account credentials at the chosen Trust List CA.
**Goal:** obtain a production-issuable C2PA end-entity certificate over the SoftHSM-held ES256 key that was provisioned in `cvm-provision.md`, install it into the Signer, and publish it in the trust manifest.
**Wall time:** ~30 minutes hands-on on the Scruple side. CA processing time is out of our control — typically 1–5 business days for the first issuance, faster for renewals.

---

## 0. Which CA

Two Trust List members currently issue C2PA end-entity certs to third parties:

- **DigiCert — Content Credentials product.** Primary choice. C2PA-aware profile out-of-box; product page: [`https://www.digicert.com/tls-ssl/content-credentials`](https://www.digicert.com/tls-ssl/content-credentials). Docent LLC's DigiCert account is the account of record.
- **SSL.com — C2PA Signer product.** Alternate. C2PA-aware profile; product page: [`https://www.ssl.com/certificates/c2pa-signing/`](https://www.ssl.com/certificates/c2pa-signing/). Used only if DigiCert issuance is unavailable for a given ceremony window.

Both CAs are on the C2PA Trust List. Either one produces a cert whose chain terminates at a Trust-List-anchored root, which is what downstream C2PA verifiers pin against.

> [verify] The Trust-List roster is maintained by the C2PA. Confirm the CA is still listed at the current Trust List URL immediately before submission — the roster changes and a de-listed CA would produce a cert that verifiers reject.

---

## 1. Prerequisites

- **Docent LLC account** at the chosen CA. Subscriber agreement signed. Payment method on file. MFA enabled on the account. The account owner (`scruple@docentechs.com`) is the only human who can submit the CSR.
- **Signer CVM provisioned per `cvm-provision.md`** — the SoftHSM token has an ES256 key labeled `scruple-c2pa-key` at `CKA_EXTRACTABLE=CK_FALSE`, and the SEV-SNP report already binds that pubkey to the CVM's measurement.
- **Distinguished Name locked** per `01-GPSA.md` §C.1.2:
  - `CN = Scruple`
  - `O = Docent LLC`
  - `C = US`
  - `OU` omitted
- **Operator laptop** with `openssl`, SSH access to the CVM via bastion, and the CA portal open in a browser.

---

## 2. Generate the CSR inside the CVM

The private key never leaves the CVM. The `openssl req` invocation uses the `pkcs11` engine to route the signature over the CSR's TBS through SoftHSM — the resulting CSR contains the public key (extractable) plus a signature by the private key (proof of possession), and nothing else about the key material.

SSH into the CVM via bastion, retrieve the PIN from OCI Vault (Instance Principal auth):

```bash
export SOFTHSM_PIN="$(oci vault secret get-secret-bundle \
  --secret-id 'ocid1.vaultsecret.oc1.iad.<softhsm-pin-ocid>' \
  --auth instance_principal --query 'data."secret-bundle-content".content' \
  --raw-output | base64 -d)"
```

Generate the CSR. The PKCS#11 URI names the token by label and the key by label — matches what `cvm-provision.md` §5 set up (`scruple-c2pa-key` in slot 0, label `scruple-c2pa`):

```bash
openssl req -engine pkcs11 -keyform engine \
  -key "pkcs11:token=scruple-c2pa;object=scruple-c2pa-key;type=private;pin-value=${SOFTHSM_PIN}" \
  -new \
  -sha256 \
  -subj "/CN=Scruple/O=Docent LLC/C=US" \
  -out /tmp/scruple-c2pa.csr

unset SOFTHSM_PIN
history -c
```

Verify the CSR before sending it anywhere:

```bash
openssl req -in /tmp/scruple-c2pa.csr -noout -text
# Confirm:
#   Subject: CN=Scruple, O=Docent LLC, C=US
#   Public Key Algorithm: id-ecPublicKey
#   NIST CURVE: P-256
#   Signature Algorithm: ecdsa-with-SHA256
#   Signature valid (openssl reports 'Signature ok' on -verify)

openssl req -in /tmp/scruple-c2pa.csr -verify -noout
# Expected: 'Certificate request self-signature verify OK'
```

Also confirm the CSR's public key matches the SoftHSM public key exported in `cvm-provision.md` §5:

```bash
openssl req -in /tmp/scruple-c2pa.csr -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum
sha256sum /tmp/signer-pubkey.der
# The two hashes MUST be identical. If they differ, the CSR is over a different
# key than the one bound to the SEV-SNP attestation — do not submit; investigate.
```

Copy the CSR out (public information — the file contains only a public key and a signature over the subject):

```bash
# From operator laptop:
scp bastion:/tmp/scruple-c2pa.csr ./scruple-c2pa.csr
```

Zero the CVM copy:

```bash
# On the CVM:
shred -u /tmp/scruple-c2pa.csr
```

---

## 3. Submit the CSR to the CA

### 3a. DigiCert — Content Credentials product

1. Sign in at `https://www.digicert.com/account/` with MFA. Use the `scruple@docentechs.com` account.
2. Navigate to `CertCentral → Request a certificate → Content Credentials`.
3. Select **Content Credentials Signing certificate**, validity **1 year**, algorithm **ECDSA P-256**.
4. Upload `scruple-c2pa.csr`.
5. Fill the DN preview matches `CN=Scruple, O=Docent LLC, C=US` exactly — DigiCert will refuse if the CSR DN and the CertCentral form drift.
6. Set the requested extensions (DigiCert applies the C2PA-required extensions automatically; the operator does not hand-encode EKU OIDs):
   - Extended Key Usage: `id-kp-documentSigning` (OID `1.3.6.1.5.5.7.3.36`) + `id-kp-emailProtection` (OID `1.3.6.1.5.5.7.3.4`) — both required by c2pa-rs' cert-profile validator.
   - Key Usage: `digitalSignature` + `nonRepudiation`.
7. Confirm the C2PA-specific extension block is applied — DigiCert's product template adds it; verify in the "Review" step that the ordered list of extensions matches the C2PA v2.x cert profile spec.
8. Submit. Note the DigiCert order ID.

### 3b. SSL.com — C2PA Signer product

Analogous: Portal at `https://secure.ssl.com/`, product **C2PA Document Signing Certificate**, upload CSR, confirm DN, submit. SSL.com's product page describes the same C2PA extension set.

---

## 4. Receive and validate the issued cert

Once the CA issues:

1. Download the end-entity certificate PEM and the issuer chain PEM from the CA portal.
2. Concatenate into a single chain file with the end-entity cert first:

```bash
cat end-entity.pem intermediate.pem root.pem > scruple-c2pa-cert-chain.pem
```

3. Verify the chain terminates at a Trust-List anchor. Download the current C2PA Trust List anchors bundle and check:

```bash
openssl verify -CAfile c2pa-trust-list-anchors.pem -untrusted intermediate.pem end-entity.pem
# Expected: 'end-entity.pem: OK'
```

4. Verify the end-entity cert's public key matches the SoftHSM public key:

```bash
openssl x509 -in end-entity.pem -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum
sha256sum /tmp/signer-pubkey.der
# Must match. If not, the CA issued over the wrong key — do not install; contact CA support.
```

5. Verify the extensions match the C2PA v2.x cert profile:

```bash
openssl x509 -in end-entity.pem -noout -text | grep -A 3 'Extended Key Usage\|Key Usage'
# Expected: 'TLS Web ...' NOT present; documentSigning (1.3.6.1.5.5.7.3.36) present;
#           emailProtection (1.3.6.1.5.5.7.3.4) present; Key Usage: digitalSignature.
```

If any check fails, do not proceed — the wrong cert would silently produce non-conformant signs.

---

## 5. Install the cert into the Signer

Copy the validated cert chain onto the CVM:

```bash
scp scruple-c2pa-cert-chain.pem bastion:/tmp/scruple-c2pa-cert-chain.pem
```

On the CVM, install into the path the Signer daemon reads (`SCRUPLE_C2PA_CERT_CHAIN` from the systemd unit's EnvironmentFile — see `cvm-provision.md` §7):

```bash
sudo install -o root -g scruple-signer -m 0640 \
  /tmp/scruple-c2pa-cert-chain.pem \
  /etc/scruple/c2pa-cert-chain.pem

sudo systemctl restart scruple-c2pa-signer.service
sudo systemctl status  scruple-c2pa-signer.service
sudo journalctl -u scruple-c2pa-signer -n 30 --no-pager
```

Also update the file at the path the current `services/c2pa-signer/sign.py` reads for the cert (`cert_path` in the job spec, wired from Backend-Web's `lib/c2pa/signAsset.ts`). If the Backend-Web deploy stores its own copy at `services/c2pa-signer/keys/es256.pub`, update that file at the same time so the two paths do not drift.

Run the smoke sign end-to-end from Backend-Web to confirm the new cert is in the manifest:

```bash
pnpm tsx scripts/test-c2pa-sign-witness-e2e.ts
c2patool /tmp/scruple-smoke.c2pa.png
# The 'signing_credential' block in the c2patool output should show
#   issuer_common_name: 'DigiCert Content Credentials Intermediate CA' (or SSL.com equiv.)
#   subject_common_name: 'Scruple'
```

---

## 6. Publish the new cert in the witness trust manifest

The manifest at `https://witness.scruple.ai/.well-known/witness-trust.json` (served by `app/.well-known/witness-trust.json/route.ts`) carries all currently-active signer certs with `active_from` / `deprecated_at` metadata per `01-GPSA.md` §C.2.2 "Key rotation".

Add a fingerprint entry:

```bash
# Compute the SHA-256 of the end-entity cert DER (the pinning value).
openssl x509 -in end-entity.pem -outform DER | sha256sum
```

Post to Backend-Web:

> [proposed] `POST /api/admin/trust-manifest/cert` — auth = admin API key, body:
> ```jsonc
> {
>   "topology_id": "scruple-hosted-oci-cvm-01",   // matches the CVM entry
>   "cert_fingerprint_sha256": "<hex>",
>   "cert_pem": "<end-entity + chain, PEM>",
>   "active_from": "<UTC ISO-8601 now>",
>   "deprecated_at": null
> }
> ```

Refetch the manifest and confirm the new entry:

```bash
curl -sS https://witness.scruple.ai/.well-known/witness-trust.json | jq '.certs[] | select(.deprecated_at == null)'
```

---

## 7. Rotation

Cadence per `01-GPSA.md` §C.2.2 "Key rotation": **annually**, or **immediately on any suspected compromise**.

The full ceremony:

1. **Provision a fresh CVM** per `cvm-provision.md` §1–§7 with display name `scruple-c2pa-signer-prod-0(N+1)`. New CVM → new SoftHSM → new ES256 key. The old CVM stays running.
2. **Run this runbook end-to-end** against the new CVM: new CSR, new CA submission, new end-entity cert.
3. **Add the new cert to the trust manifest** per §6 with `active_from = now`, `deprecated_at = null`.
4. **Set the previous cert's `deprecated_at`** on the trust-manifest entry to `now + 30d`. Do NOT delete the previous entry — verifiers of historical signs still need it to validate manifests signed while it was active.
5. **Cut Backend-Web** to route sign requests to the new CVM (`sign.scruple.internal` DNS flip in the private VCN zone). Watch a checkpoint interval to confirm new signs land under the new signer identity.
6. **After the 30-day overlap window**, terminate the old CVM (`oci compute instance terminate --instance-id ...`). The SoftHSM key is destroyed with the CVM — no separate key-material teardown ceremony.

**On suspected compromise** (as opposed to routine annual rotation):

- Collapse the overlap to zero: set the old cert's `deprecated_at = now` on the trust manifest immediately after step 5.
- Force-terminate the old CVM as soon as Backend-Web is on the new one; do not wait for the 30-day window.
- Publish a `_scruple.rotation` leaf on the witness with `{event: "compromise_response", old_cert_fingerprint: ..., new_cert_fingerprint: ..., timestamp: ...}` so the rotation itself is witnessed.
- Notify affected Principals per the Rider §8 remediation flow (`docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md`).
- File an incident record in `docs/l2-evidence/incidents/` with the root cause, the compromise-window, and the set of C2PA signs made during the compromise window. Downstream verifiers may need to re-evaluate signs made under the old cert during that window.
