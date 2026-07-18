# Scruple Signer CVM rotation

L2 remediation for C2PA GPSR 6.3.2 + 6.4.2 (OS patch recency on running
CVMs). Instead of extracting OS patch date from a running instance and
comparing to a 90-day window, this stack enforces a **60-day maximum
instance age** architecturally: no in-service Signer CVM can exceed the
window because the rotation Function replaces it before it can.

Full design in `docs/c2pa-conformance-evidence/2026-07-18-reviewer-response/security-architecture-delta/01-GPSA-delta.md`.

## Components

| File | Purpose |
|---|---|
| `terraform/instance-configuration.tf` | Immutable Signer CVM descriptor |
| `terraform/instance-pool.tf` | Fleet manager (N members) |
| `terraform/rotation-function.tf` | Actuator: Function + Scheduler |
| `terraform/iam-policies.tf` | Function's least-privilege identity |
| `function/rotate_signer_cvms.py` | Actuator logic (~150 lines) |
| `function/func.yaml` | Function build spec |
| `function/requirements.txt` | Function dependencies |

## Deploy

Prereqs:
- OCI CLI configured
- Terraform >= 1.5
- Function image built + pushed to OCIR (see below)

```bash
# 1. Build + push the Function image
cd function
fn build --verbose
fn deploy --app scruple-signer-rotation
export FN_IMAGE=$(fn inspect app scruple-signer-rotation --config | jq -r ...)

# 2. Apply Terraform
cd ../terraform
terraform init
terraform apply \
  -var tenancy_ocid=ocid1.tenancy.oc1..<tenant> \
  -var compartment_ocid=ocid1.compartment.oc1..<compartment> \
  -var signer_subnet_ocid=ocid1.subnet.oc1..<subnet> \
  -var signer_nsg_ocid=ocid1.networksecuritygroup.oc1..<nsg> \
  -var signer_image_ocid=ocid1.image.oc1..<image> \
  -var signer_availability_domain='hbAG:US-ASHBURN-AD-1' \
  -var signer_lb_backend_set_ocid='<backendset-name>,ocid1.loadbalancer.oc1..<lb>' \
  -var rotation_function_image=${FN_IMAGE}
```

## Verify

After apply, check:

```bash
# Instance Pool exists and has target size
oci compute-management instance-pool get --instance-pool-id $(terraform output -raw instance_pool_ocid)

# Function is deployed
oci fn function get --function-id $(terraform output -raw rotation_function_ocid)

# Schedule is active
oci resource-scheduler schedule get --schedule-id $(terraform output -raw rotation_schedule_ocid)
```

Force a rotation for testing:

```bash
oci fn function invoke --function-id $(terraform output -raw rotation_function_ocid) \
  --file - \
  --body ''
```

## Operational lifecycle

See runbook: `docs/c2pa-conformance-evidence/2026-07-14/security-architecture/runbooks/cvm-provision.md`.
