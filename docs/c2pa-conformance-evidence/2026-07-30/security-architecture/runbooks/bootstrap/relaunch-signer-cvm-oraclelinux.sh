#!/bin/bash
#
# Cloud Shell one-shot: terminate the current Ubuntu Signer CVM and
# relaunch a fresh one from Oracle Linux 9 with cloud-init-signer-cvm-
# oraclelinux.yaml attached.
#
# Paste the entire file into an OCI Cloud Shell tab. Runs ~6-10 min.
# When done, prints the new CVM's OCID + private IP.
#
# Prereqs (already in place from the initial provisioning session):
#   - Witness compartment exists
#   - scruple-vcn + scruple-signer-private-subnet exists (10.0.1.0/24)
#   - Service Gateway (scruple-sgw) exists, route table points to it
#   - Security list allows TCP 22 + 8443 from 10.0.0.0/24
#   - Dynamic Group scruple-signer-cvm matches instance.compartment.id = Witness
#   - IAM Policy allows DG to read the SoftHSM PIN Secret + blockstorage
#     service to use MEK
#   - OCI Vault + MEK + PIN Secret exist

set -eo pipefail

# ============================================================================
# Config — these are stable across relaunches
# ============================================================================

COMPARTMENT_OCID='ocid1.compartment.oc1..aaaaaaaam4xuyduwf6j5nqsstg3cncecw7n6c64wro6fgtq2256622isnpya'
TENANCY_OCID='ocid1.tenancy.oc1..aaaaaaaa5yaiyjquldpkgkdhx7iinfp7h4yjwxom3vrkbikps7tnimegl7wa'
SUBNET_OCID='ocid1.subnet.oc1.iad.aaaaaaaaql3pokcuk5eee2muhniatnj5v4f7xlw3gklmqagtvtpamo5i56tq'
AD='jeIn:US-ASHBURN-AD-1'
SHAPE='VM.Standard.E5.Flex'
SHAPE_CFG='{"ocpus":2.0,"memoryInGBs":8.0}'
PLATFORM_CFG='{"is-measured-boot-enabled":false,"is-memory-encryption-enabled":true,"is-secure-boot-enabled":false,"is-symmetric-multi-threading-enabled":true,"is-trusted-platform-module-enabled":false,"type":"AMD_VM"}'
NEW_NAME='scruple-signer-cvm'
CLOUD_INIT_URL='https://raw.githubusercontent.com/Docenttx/Scruple/feature/witnessing-l2-sprint1/docs/c2pa-conformance-evidence/2026-07-14/security-architecture/runbooks/cloud-init-signer-cvm-oraclelinux.yaml'

# ============================================================================
# [1/5] Find + terminate any existing scruple-signer-cvm in Witness
# ============================================================================
echo "=== [1/5] Terminating any existing scruple-signer-cvm ==="
OLD_OCID=$(oci compute instance list --compartment-id "$COMPARTMENT_OCID" \
    --lifecycle-state RUNNING \
    --query 'data[?"display-name"==`'"$NEW_NAME"'`].id | [0]' \
    --raw-output 2>/dev/null || echo "")
if [ -n "$OLD_OCID" ] && [ "$OLD_OCID" != "null" ]; then
    echo "  found existing instance: $OLD_OCID"
    oci compute instance terminate --instance-id "$OLD_OCID" \
        --preserve-boot-volume false --force
    echo "  waiting for TERMINATED..."
    while STATE=$(oci compute instance get --instance-id "$OLD_OCID" \
            --query 'data."lifecycle-state"' --raw-output 2>/dev/null); do
        [ "$STATE" = "TERMINATED" ] && break
        printf "  ...%s\n" "$STATE"; sleep 15
    done
    echo "  terminated."
else
    echo "  no existing instance to terminate"
fi

# ============================================================================
# [2/5] Look up latest Oracle Linux 9 image OCID
# ============================================================================
echo
echo "=== [2/5] Looking up Oracle Linux 9 image ==="
IMAGE_OCID=$(oci compute image list \
    --compartment-id "$TENANCY_OCID" \
    --operating-system "Oracle Linux" \
    --operating-system-version "9" \
    --shape "$SHAPE" \
    --sort-by TIMECREATED --sort-order DESC \
    --limit 1 \
    --query 'data[0].id' --raw-output)
echo "  Image: $IMAGE_OCID"

# ============================================================================
# [3/5] Fetch cloud-init user-data
# ============================================================================
echo
echo "=== [3/5] Fetching cloud-init YAML ==="
curl -sSL "$CLOUD_INIT_URL" > /tmp/cloud-init-signer.yaml
echo "  $(wc -l < /tmp/cloud-init-signer.yaml) lines"

# ============================================================================
# [4/5] Launch
# ============================================================================
echo
echo "=== [4/5] Launching Oracle Linux 9 CVM with cloud-init ==="
NEW_JSON=$(oci compute instance launch \
    --availability-domain "$AD" \
    --compartment-id "$COMPARTMENT_OCID" \
    --shape "$SHAPE" \
    --shape-config "$SHAPE_CFG" \
    --image-id "$IMAGE_OCID" \
    --subnet-id "$SUBNET_OCID" \
    --assign-public-ip false \
    --display-name "$NEW_NAME" \
    --platform-config "$PLATFORM_CFG" \
    --user-data-file /tmp/cloud-init-signer.yaml \
    --is-pv-encryption-in-transit-enabled true \
    --wait-for-state RUNNING \
    --max-wait-seconds 600)

NEW_OCID=$(echo "$NEW_JSON" | jq -r '.data.id')

# ============================================================================
# [5/5] Return connection details
# ============================================================================
echo
echo "=== [5/5] Fetching new private IP ==="
NEW_VNIC=$(oci compute instance list-vnics --instance-id "$NEW_OCID" \
    --query 'data[0].id' --raw-output)
NEW_IP=$(oci network vnic get --vnic-id "$NEW_VNIC" \
    --query 'data."private-ip"' --raw-output)

echo
echo "======================================================================"
echo "DONE. Report to Claude:"
echo "  OCID:       $NEW_OCID"
echo "  Private IP: $NEW_IP"
echo "  SSH user:   opc  (NOT 'ubuntu' on Oracle Linux)"
echo
echo "Cloud-init runs on first boot (~5-8 min). When complete, this file"
echo "exists on the CVM: /var/log/scruple-cvm-bootstrap.done"
echo "======================================================================"
