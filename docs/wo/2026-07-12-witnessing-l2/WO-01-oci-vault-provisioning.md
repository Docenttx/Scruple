# WO-01 — OCI Vault provisioning (both signing keys)

**Sprint:** 1
**Estimate:** 6 owner-hours
**Blocking:** none — can start immediately
**Blocks:** WO-02 (needs pubkey for CSR), WO-03 (needs Vault OCID), WO-07 (needs
checkpoint-key OCID)

## Goal

Stand up two OCI Vault keys in Virtual Private (HSM) mode plus the surrounding
IAM, dynamic group, audit archive, and network policy. After this WO, the
Scruple signer compute instance can call `Sign` on both keys and nothing
else can.

## What to build

1. **New compartment** `scruple-crypto` in the production tenancy. Reason:
   isolation from the general Scruple compartment for blast radius + audit
   scope.
2. **OCI Vault** in the new compartment, protection mode **Virtual Private
   (HSM)**. If the region does not have Virtual Private available, escalate —
   do not silently fall back to Default (software).
3. **Key #1 — `scruple-c2pa-signer-prod`:**
   - Shape: `ECDSA`, curve `NIST_P256`
   - Protection mode: Virtual Private (HSM)
   - Rotation: **manual** (we do not want automatic rotation invalidating a
     C2PA cert mid-flight)
4. **Key #2 — `scruple-witness-checkpoint-prod`:**
   - Shape: prefer `EDDSA` / Ed25519 if OCI Vault supports it in Virtual
     Private at your region — check `oci kms management key list-shapes` and
     the region matrix. If Ed25519 is NOT available in Virtual Private at
     production tier, use `ECDSA` / `NIST_P256` and note the fallback in the
     `docs/architecture/lifecycle/key-generation.md` runbook.
   - Protection mode: Virtual Private (HSM)
   - Rotation: manual
5. **Dynamic Group `scruple-signer-dg`:** matches the compute instance
   principal that will run the signer daemon (matching rule on
   `instance.compartment.id` OR `instance.tag.*` — use tag to allow multiple
   candidate instances behind an OCI load balancer).
6. **IAM Policy** on the `scruple-crypto` compartment:
   ```
   Allow dynamic-group scruple-signer-dg
     to use keys in compartment scruple-crypto
     where target.key.id in ('<c2pa-key-ocid>', '<checkpoint-key-ocid>')
     and (
       request.operation = 'Sign' or
       request.operation = 'GetPublicKey' or
       request.operation = 'GetKey'
     )
   ```
   Explicitly not granted: `Rotate`, `Update`, `Delete`, `Backup`, `Restore`,
   `Import`, `Export`, `Schedule*`.
7. **Human-admin IAM group `scruple-key-admin`:** MFA-required, break-glass
   only, holds `Rotate` + admin rights. Members: at minimum two people so
   nobody is a single point of failure. Membership review quarterly.
8. **OCI Audit archive:** Object Storage bucket
   `scruple-vault-audit-archive` in the production tenancy, retention mode
   **Compliance** (not Governance — Compliance is immutable), retention 7 years.
   Configure OCI Audit forwarding to write daily archive files to the bucket.
9. **VCN security list on the signer subnet:** egress allowed ONLY to:
   - `vault.<region>.oci.oraclecloud.com` — Vault control plane
   - `kms.<region>.oci.oraclecloud.com` — Vault crypto plane
   - Any TSA endpoint that will be used at `enhanced`/`qualified` tier
     (added later under WO-11; for Sprint 1 no TSA egress needed)
   - Ingress: only from Next.js compute instance security group, only Unix
     socket (which means: no ingress rule needed if we use Unix sockets;
     if we later shift to HTTP+mTLS internal, add a specific ingress rule).

## What NOT to build in this WO

- Do not put any Vault credentials in Next.js's environment.
- Do not create keys in the general `scruple` compartment.
- Do not enable automatic rotation on either key.
- Do not use Default (software) protection mode for either production key.
- Do not create a shared IAM user that both humans and instances authenticate as.

## Deliverables (add to `docs/architecture/lifecycle/key-generation.md`)

- OCIDs of both keys (redacted last 4 chars is fine for public docs; full OCID
  in a private secrets doc / OCI Bastion access notes).
- Screenshot of Vault console showing both keys, Protection Mode = Virtual
  Private, Origin = OCI KMS.
- IAM policy JSON committed to `infra/oci/policies/scruple-crypto-policy.json`.
- Dynamic group matching rule committed.
- Audit archive bucket ARN and retention config screenshot.
- A `README.md` in this directory that includes the "how to rotate manually"
  procedure (referenced later in WO-17 lifecycle doc).

## Acceptance criteria

- [ ] Both keys exist in Virtual Private mode; `oci kms management key get`
      returns `"protectionMode": "HSM"`.
- [ ] `oci kms crypto sign` from the signer compute instance succeeds for
      both keys with an arbitrary 32-byte message.
- [ ] The same command from any OTHER instance in the tenancy fails with
      `NotAuthorizedOrNotFound`.
- [ ] `oci kms management key list-key-versions` shows exactly one version
      per key (fresh keys).
- [ ] OCI Audit shows the test Sign call within 5 minutes; the audit event
      lands in the Object Storage archive bucket within 24 hours.
- [ ] IAM policy JSON + dynamic group matching rule + audit bucket ARN
      committed to `infra/oci/`.
- [ ] `docs/architecture/lifecycle/key-generation.md` written and
      committed (stub is fine for now; full runbook lands in WO-17).

## Cost estimate

- Each Virtual Private Vault key: ~$1/month key + $0.03 per 10k ops. At
  ~1 sign/sec sustained: ~$8/month. Negligible.
- Object Storage compliance-mode bucket: dependent on volume; well under
  $10/month at this scale.
- Total ongoing: <$25/month.

## Related

- Canonical design §4 (Key Custody).
- WO-02 depends on this WO having produced the C2PA key's public key
  (extracted via `GetPublicKey`) for CSR generation.
