# cvm-provision.md — Delta for L2 Instance Pool + max-age rotation (2026-07-18)

**Source runbook:** `docs/c2pa-conformance-evidence/2026-07-14/security-architecture/runbooks/cvm-provision.md`

**Change summary:** the single-CVM provisioning + annual-rotation runbook is
superseded by an Instance-Pool-based lifecycle. Individual CVMs are no longer
manually provisioned or manually rotated; the Pool provisions and rotates
automatically per the OCI Signer Rotation stack at
`deploy/oci-signer-rotation/`.

Sections §1 – §11 of the source runbook are retained *as reference material for
what the Instance Configuration bootstraps*, not as an operator procedure to
run by hand. Their cloud-init YAML + systemd unit files are the exact bytes
consumed by the Instance Configuration's `user_data` and by the golden image's
overlay.

Section §12 (Rotation — annual or on suspected compromise) is replaced by §12'
below.

---

## §12'. Rotation — automated via Instance Pool max-age (revised 2026-07-18)

**Rotation is fully automated.** No operator action is required for
routine 60-day age-based rotation. The rotation Function terminates aged
instances; the Instance Pool auto-provisions replacements from the current
Instance Configuration; the Signer LB drains outgoing instances and
registers new ones as they attest healthy.

### §12'.1. Steady-state operational picture

Continuously:

- **N ≥ 2** Signer CVMs run concurrently in the Signer Instance Pool.
- Each CVM was provisioned within the last 60 days from the current
  golden image.
- On boot, each CVM runs cloud-init per §§3–7 of the source runbook (SoftHSM
  init, ES256 key generation, SEV-SNP report fetch + cross-binding), then
  starts `scruple-c2pa-signer.service` per §7.
- Each CVM publishes an `ai.scruple.signer-runtime.v1` assertion in every
  signed manifest carrying its `instance_id`, `image_id`,
  `instance_born_at`, `age_days_at_sign`, `max_age_days`, and
  `rotation_policy_version`.
- The Signer LB routes incoming sign requests round-robin across Pool
  members.

Every 6 hours:

- OCI Resource Scheduler fires the `rotate-signer-cvms` Function.
- Function enumerates Pool members, computes each member's `age_days` from
  OCI Compute API's `time_created`, terminates any member with
  `age_days > 60`.
- Terminated member is drained from the LB (30 s drain window) and its
  underlying resources released.
- Pool detects target-size shortfall and provisions a replacement from the
  current Instance Configuration.
- New CVM boots, attests, joins the LB backend set, begins serving traffic.

### §12'.2. When operator action IS required

Only when one of the following occurs:

**A. Golden image update (new patched base image published):**

1. Build a new Signer golden image via CI (this step is unchanged from the
   pre-Pool design — the reproducible image build already runs through the
   OSV-Scanner / Grype / Semgrep / SBOM gates per §C.2.3 of the source
   GPSA).
2. Publish a new Instance Configuration referencing the new image OCID:
   ```bash
   cd deploy/oci-signer-rotation/terraform
   terraform apply -var signer_image_ocid=ocid1.image.oc1.iad.<new>
   ```
3. The Instance Pool picks up the new Instance Configuration on next
   replacement. Existing CVMs continue on the previous config until they
   hit the max-age threshold (up to 60 days later); they will be replaced
   from the new image on their scheduled rotation. To force immediate
   rollover, `terraform apply` then manually invoke the rotation Function:
   ```bash
   oci fn function invoke \
     --function-id $(terraform output -raw rotation_function_ocid) \
     --file - --body ''
   ```

**B. Trust-manifest update (per §10 of the source runbook):**

New CVMs' HSM public keys are published to
`witness-trust.json` on first attestation. When replacing an entire
generation of CVMs, add the incoming SPKI hashes as a new `topologies`
entry with `activated_at = now`. Set `deprecated_at = activated_at + 30d`
on the previous entry per §4.3 of `CANONICAL_SCRUPLE_WITNESSING_L2.md`.
Verifiers accept both during the overlap window, only the new after.

**C. Suspected compromise:**

Bypass the 60-day rotation for the affected generation:

1. Set `deprecated_at = now` on the compromised trust-manifest topology
   entry so verifiers immediately stop accepting signatures from that
   generation.
2. Force-terminate all Pool members: `oci compute-management instance-pool
   stop --instance-pool-id <ocid>` then `start`; the Pool provisions a
   fresh set from the current Instance Configuration.
3. Notify affected Principals per Rider §8 remediation flow.

**D. Rotation Function outage recovery:**

If the rotation Function fails to run for an extended period (Function
outage, IAM breakage, scheduler misconfig), Signer CVMs may age past 60
days. The **secondary in-guest actuator** (per GPSA delta §4, Actuator 2)
prevents these instances from signing — `age_guard_verdict` returns
`refuse=True` and every sign attempt returns a structured refuse-to-sign
error. To recover:

1. Diagnose the Function outage (`oci logging search --...`), fix the
   underlying issue.
2. Manually invoke the rotation Function to clear the backlog:
   ```bash
   oci fn function invoke --function-id <ocid> --file - --body ''
   ```
3. Confirm Pool has provisioned replacements and the LB shows only
   under-age instances in the healthy backend set.

### §12'.3. Sections retained from the source runbook

For reference (not for direct operator use):

- §0. Prerequisites — unchanged; still describes the OCI tenancy, compartment,
  VCN, NSG, and Vault prereqs.
- §1 – §7. Individual CVM provisioning + configuration — these are consumed
  as `cloud-init` payload embedded in the Instance Configuration
  (`deploy/oci-signer-rotation/terraform/instance-configuration.tf`).
  Operators do not run these steps by hand.
- §8 – §9. Networking + Cloudflare (none) — unchanged.
- §10. Trust manifest publication — unchanged; new CVMs' pubkeys publish
  on first attestation.
- §11. Health check + end-to-end smoke — unchanged; use after golden-image
  updates to verify the Pool's newest generation.

### §12'.4. Cross-references

- Design: `docs/c2pa-conformance-evidence/2026-07-18-reviewer-response/security-architecture-delta/01-GPSA-delta.md`
- Terraform: `deploy/oci-signer-rotation/terraform/`
- Function: `deploy/oci-signer-rotation/function/`
- In-guest actuator: `services/c2pa-signer/signer_runtime.py`
- Wiring: `services/c2pa-signer/sign.py` (age-guard check + runtime-assertion
  emission)
