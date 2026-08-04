# Runbook — Scruple C2PA Signer CVM lifecycle

**Cited from:** `01-GPSA.md` §C.2.2, §C.2.3, §C.2.5, §C.2.6.
**Audience:** Scruple operator with tenancy-admin OCI credentials, access
to the Program-designated Trust List CA account, and access to the
`scruple-web` repository's `deploy/oci-signer-rotation/` Terraform.

The Scruple Signer role runs as a fleet of AMD SEV-SNP Confidential VMs
under an OCI Instance Pool with fleet-manager-enforced 60-day maximum
instance age. Individual CVMs are not manually provisioned or manually
rotated in steady state — the Instance Pool provisions replacements
automatically, and the rotation Function terminates aged instances on
a 6-hour cadence.

Two operator surfaces are described in this document:

- **§12 — steady-state operations and when operator action is required.**
  This is the surface an operator uses day-to-day.
- **§§0–11 — Instance Configuration bootstrap reference.** These
  sections describe what happens on a Signer CVM's first boot. The
  same steps are embedded as the `cloud-init` payload in the Instance
  Configuration
  (`deploy/oci-signer-rotation/terraform/instance-configuration.tf`)
  and as the golden-image overlay. Operators do not run §§0–11 by
  hand in steady state; they are documented here as reference for
  what the Instance Configuration bootstraps and for one-off
  bare-metal reproduction when needed.

**Wall time:** ~30 minutes to reproduce §§0–11 by hand for a one-off
verification; 0 minutes of operator time for steady-state Pool
operations under §12.

**Companion runbook:** `cert-enrollment.md` describes the Trust List
end-entity CSR ceremony, run once per generation of the C2PA signing
identity.

---

## 0. Prerequisites

- OCI CLI installed and configured for the target region (default `us-ashburn-1`). `oci setup config` completed; `oci iam region list` returns successfully.
- Compartment OCID for the Signer CVM: `${SIGNER_COMPARTMENT_OCID}`. Dedicated compartment recommended (per `01-GPSA.md` §C.2.6 IAM boundary).
- Subnet OCID for the private VCN subnet the CVM will land on: `${SIGNER_PRIVATE_SUBNET_OCID}`. This subnet has NO Internet Gateway route — only a Service Gateway (for AMD kdsintf, OCI Vault, and OCI Object Storage) and a Local Peering Gateway or same-VCN route back to Backend-Web.
- Backend-Web Compute Instance OCID: `${BACKEND_WEB_INSTANCE_OCID}` — needed for the VCN Security List rule that whitelists inbound TCP 8443 from Backend-Web only.
- Trust List CA account (DigiCert Content Credentials or SSL.com C2PA Signer) provisioned under Docent LLC. Not exercised in this runbook (see `cert-enrollment.md`); noted so the operator knows the follow-on step exists.
- DNS control for the internal name `sign.scruple.internal` (private DNS zone in the same VCN). No public DNS or Cloudflare record — Signer is not Internet-facing.
- OCI Vault Secret pre-provisioned with two entries the CVM will read at boot:
  - `scruple-c2pa-signer/softhsm-pin` — 12+ char SoftHSM user PIN (`CKU_USER`)
  - `scruple-c2pa-signer/softhsm-so-pin` — 12+ char SoftHSM security-officer PIN (`CKU_SO`)
  Both generated with `openssl rand -base64 24` on an admin workstation and stored via the OCI Console (Vault → Secrets → Create Secret). See §5.
- Local admin workstation has `openssl`, `xxd`, and `sha256sum` for the cross-binding check.

---

## 1. Provision the CVM

Launch a Confidential Compute VM with SEV-SNP enabled. Shape and image are pinned to what the 2026-07-12 evidence run captured (`docs/l2-evidence/2026-07-12T174954Z/POPULATED_SECURITY_ARCH_DOC.md`).

```bash
# Pin the image explicitly to Ubuntu 24.04 LTS. Look the OCID up with:
oci compute image list \
  --compartment-id "${SIGNER_COMPARTMENT_OCID}" \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" \
  --shape "VM.Standard.E5.Flex" \
  --limit 5 --sort-by TIMECREATED --sort-order DESC \
  --query 'data[].{name:"display-name", ocid:id}'
export IMAGE_OCID="ocid1.image.oc1.iad.<pinned>"

oci compute instance launch \
  --compartment-id  "${SIGNER_COMPARTMENT_OCID}" \
  --availability-domain "$(oci iam availability-domain list --compartment-id "${SIGNER_COMPARTMENT_OCID}" --query 'data[0].name' --raw-output)" \
  --display-name    "scruple-c2pa-signer-prod-01" \
  --shape           "VM.Standard.E5.Flex" \
  --shape-config    '{"ocpus": 2, "memoryInGBs": 16}' \
  --image-id        "${IMAGE_OCID}" \
  --subnet-id       "${SIGNER_PRIVATE_SUBNET_OCID}" \
  --assign-public-ip false \
  --platform-config '{"type":"AMD_MILAN_BM_GPU","isMeasuredBootEnabled":true,"isSecureBootEnabled":true,"isTrustedPlatformModuleEnabled":true,"isMemoryEncryptionEnabled":true}' \
  --launch-options  '{"bootVolumeType":"PARAVIRTUALIZED","networkType":"PARAVIRTUALIZED"}' \
  --metadata        '{"ssh_authorized_keys": "<paste operator public key here>"}'
```

> [verify] The exact `--platform-config` key set that switches on SEV-SNP on OCI E5 shapes has drifted between OCI API versions. As of the 2026-07-12 evidence run the enabling knob was `isMemoryEncryptionEnabled: true` on an `AMD_MILAN_BM_GPU` platform config. If the API returns `InvalidParameter` on that shape+config, consult the current OCI docs: [`https://docs.oracle.com/en-us/iaas/Content/Compute/References/confidential-compute.htm`](https://docs.oracle.com/en-us/iaas/Content/Compute/References/confidential-compute.htm). Do not proceed with a non-confidential VM — silently falling back to a normal E5.Flex would break the entire §6.1.2 evidence chain.

Wait for the instance to reach `RUNNING`:

```bash
oci compute instance get --instance-id "${SIGNER_INSTANCE_OCID}" \
  --query 'data.{state:"lifecycle-state", ocid:id}'
```

Record `${SIGNER_INSTANCE_OCID}` for the trust-manifest entry later.

---

## 2. Post-boot SEV-SNP verification

SSH into the CVM via a bastion (there is no public IP by design). The dmesg check must show the same lines captured on 2026-07-12:

```bash
sudo dmesg | grep -Ei 'SEV|memory encryption'
# Expected (matches ENVIRONMENT.txt from the evidence run):
#   Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP
#   SEV: Status: SEV SEV-ES SEV-SNP
#   SEV: Using SNP CPUID table, ...
#   SEV: SNP running at VMPL0.

ls -l /dev/sev-guest
# Expected: crw------- 1 root root 10, 261 ... /dev/sev-guest

uname -r
# Expected: 6.17.0-1011-oracle (or a later Ubuntu-oracle kernel with SNP support)

cat /etc/os-release | head -3
# Expected: PRETTY_NAME="Ubuntu 24.04.4 LTS" (or later 24.04.X)
```

If ANY of the four checks fails, **terminate the instance and re-launch** — a signer that is not attesting under SEV-SNP does not satisfy §6.1.2, and continuing would silently produce non-conformant evidence.

---

## 3. Install SoftHSM 2, c2pa-python 0.36, and the OCI SDK

```bash
sudo apt-get update
sudo apt-get install -y \
  softhsm2 opensc-pkcs11 gnutls-bin libengine-pkcs11-openssl \
  python3.12 python3.12-venv python3-pip \
  jq unzip

# Isolated venv under /opt/scruple so nothing lands in system site-packages.
sudo mkdir -p /opt/scruple
sudo python3.12 -m venv /opt/scruple/venv
sudo /opt/scruple/venv/bin/pip install --upgrade pip

# Versions pinned to what the 2026-07-12 evidence run used.
sudo /opt/scruple/venv/bin/pip install \
  'c2pa-python==0.36.0' \
  'cryptography==41.0.7' \
  'python-pkcs11==0.9.5' \
  'oci'
```

> [proposed] `c2pa-python 0.36.0` has a known bug in the `Signer.from_callback` path (see `docs/l2-evidence/2026-07-12T174954Z/NOTES-c2pa-python-0.36-bug.md`). Until upstream fixes land, prod signing goes via `c2patool 0.9.12` shelled from the daemon. Add `c2patool` to the install manifest by downloading its static binary from the c2pa-org release page and placing it at `/opt/scruple/bin/c2patool`. Pin by SHA-256.

Verify the versions match the evidence run:

```bash
/opt/scruple/venv/bin/pip list | grep -Ei 'c2pa|crypt|pkcs11|^oci '
```

---

## 4. Initialize the SoftHSM token

Retrieve the PIN and SO-PIN from OCI Vault (Instance Principal auth — the CVM's Dynamic Group has `read` on the two Vault Secrets and nothing else):

```bash
export SOFTHSM_PIN="$(oci vault secret get-secret-bundle \
  --secret-id 'ocid1.vaultsecret.oc1.iad.<softhsm-pin-ocid>' \
  --auth instance_principal --query 'data."secret-bundle-content".content' \
  --raw-output | base64 -d)"

export SOFTHSM_SO_PIN="$(oci vault secret get-secret-bundle \
  --secret-id 'ocid1.vaultsecret.oc1.iad.<softhsm-so-pin-ocid>' \
  --auth instance_principal --query 'data."secret-bundle-content".content' \
  --raw-output | base64 -d)"
```

Provision the token as the `softhsm` user (SoftHSM's default install creates it):

```bash
sudo -u softhsm softhsm2-util --init-token \
  --slot 0 \
  --label 'scruple-c2pa' \
  --pin "${SOFTHSM_PIN}" \
  --so-pin "${SOFTHSM_SO_PIN}"

sudo -u softhsm softhsm2-util --show-slots
# Expected: one initialized slot, label='scruple-c2pa', empty of objects.
```

**Immediately** zero the PIN vars from the interactive shell:

```bash
unset SOFTHSM_PIN SOFTHSM_SO_PIN
history -c
```

The daemon systemd unit (§8) reads the PIN via `EnvironmentFile` — the interactive shell should never re-hold them past this step.

---

## 5. Generate the ES256 key inside SoftHSM

Non-exportable, sensitive, sign-only. Matches `01-GPSA.md` §C.2.2's `CKA_EXTRACTABLE=CK_FALSE` + `CKA_SENSITIVE=CK_TRUE` claim.

```bash
export SOFTHSM_PIN="$(oci vault secret get-secret-bundle \
  --secret-id 'ocid1.vaultsecret.oc1.iad.<softhsm-pin-ocid>' \
  --auth instance_principal --query 'data."secret-bundle-content".content' \
  --raw-output | base64 -d)"

sudo -u softhsm pkcs11-tool \
  --module /usr/lib/softhsm/libsofthsm2.so \
  --slot-index 0 \
  --pin "${SOFTHSM_PIN}" \
  --keypairgen \
  --key-type EC:prime256v1 \
  --label 'scruple-c2pa-key' \
  --id 01 \
  --usage-sign \
  --sensitive \
  --extractable=false

# Verify attributes on the newly-generated private key.
sudo -u softhsm pkcs11-tool \
  --module /usr/lib/softhsm/libsofthsm2.so \
  --slot-index 0 --pin "${SOFTHSM_PIN}" \
  --list-objects --type privkey
# Confirm: label='scruple-c2pa-key', Sign=1, Extract=0, Sensitive=1
```

Export the public key SPKI DER for the attestation binding (§6) and for the CSR ceremony (`cert-enrollment.md`):

```bash
sudo -u softhsm pkcs11-tool \
  --module /usr/lib/softhsm/libsofthsm2.so \
  --slot-index 0 --pin "${SOFTHSM_PIN}" \
  --read-object --type pubkey --label 'scruple-c2pa-key' \
  --output-file /tmp/signer-pubkey.der

# Convert to PEM for cross-tool convenience.
openssl pkey -inform DER -pubin -in /tmp/signer-pubkey.der \
  -outform PEM -out /tmp/signer-pubkey.pem

unset SOFTHSM_PIN
```

---

## 6. Fetch the SEV-SNP attestation report and cross-bind the pubkey

The `report_data` field in the AMD SEV-SNP attestation report is a caller-supplied 64-byte value. Populating its first 32 bytes with `sha256(SoftHSM SPKI DER)` produces the cryptographic binding claimed in `01-GPSA.md` §C.2.2 (§6.2.2 L2(d)(i) evidence). This is the exact bytes shown at line 33 of `POPULATED_SECURITY_ARCH_DOC.md`.

```bash
# Compute the report_data value.
sha256sum /tmp/signer-pubkey.der | awk '{print $1}'
# Save it as REPORT_DATA_HEX for the fetch call.
export REPORT_DATA_HEX="$(sha256sum /tmp/signer-pubkey.der | awk '{print $1}')"
```

Fetch the attestation report. Two paths, pick whichever your kernel exposes:

**Path A — configfs-tsm (kernel 6.7+, our 6.17-oracle has this).** This is what the 2026-07-12 run used; `configfs-tsm` was present per `sev-devices.txt`.

```bash
sudo mkdir -p /sys/kernel/config/tsm/report/scruple
echo "${REPORT_DATA_HEX}" | xxd -r -p | \
  sudo tee /sys/kernel/config/tsm/report/scruple/inblob >/dev/null

sudo cat /sys/kernel/config/tsm/report/scruple/outblob > /tmp/sev-snp-report.bin
sudo cat /sys/kernel/config/tsm/report/scruple/auxblob > /tmp/sev-snp-auxblob.bin
sudo rmdir /sys/kernel/config/tsm/report/scruple

ls -l /tmp/sev-snp-report.bin
# Expected: -rw-r--r-- 1 root root 1184 ... /tmp/sev-snp-report.bin
```

**Path B — `/dev/sev-guest` ioctl fallback.** If configfs-tsm isn't wired, use a small helper:

> [proposed] Ship `/opt/scruple/bin/sev-snp-fetch` as a small statically-linked Rust binary wrapping the `SEV_GUEST_REPORT_REQ` ioctl on `/dev/sev-guest`. Interface: `sev-snp-fetch --report-data <hex> --out report.bin --vcek vcek.der --chain amd-chain.pem`. Source tree: `services/sev-snp-fetch/`.

Fetch the VCEK and AMD chain from the AMD Key Distribution Service (needed by any downstream verifier — same URL structure that closes the chain in the 2026-07-12 evidence):

```bash
# The report body carries chip_id + reported_tcb. Read them out to build the URL.
# Tool of choice: sevsnpmeasure or a small Python decoder shipped with the daemon.
# For the URL template used in evidence, see:
#   https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id_hex}?blSPL=..&teeSPL=..&snpSPL=..&ucodeSPL=..
curl -sS -o /tmp/vcek.der \
  "https://kdsintf.amd.com/vcek/v1/Genoa/${CHIP_ID_HEX}?blSPL=${BL}&teeSPL=${TEE}&snpSPL=${SNP}&ucodeSPL=${UCODE}"

curl -sS -o /tmp/amd-cert-chain.pem \
  "https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain"
```

### Cross-binding proof — must pass before continuing

The report's first 32 bytes of `report_data` must equal `sha256(SoftHSM SPKI DER)`. The exact field offset is documented in AMD's SEV Secure Nested Paging Firmware ABI Specification; on ABI v5 it lives at bytes 0x50–0x8f of the report body. The one-liner:

```bash
python3 -c "
import hashlib, sys
r = open('/tmp/sev-snp-report.bin','rb').read()
report_data = r[0x50:0x90]   # 64 bytes
pub = open('/tmp/signer-pubkey.der','rb').read()
expect = hashlib.sha256(pub).digest()
assert report_data[:32] == expect, f'MISMATCH\\n  got: {report_data[:32].hex()}\\n  want: {expect.hex()}'
print('OK — pubkey cryptographically bound to SEV-SNP report')
print('report_data[:32] =', report_data[:32].hex())
"
```

If this fails, **do not proceed**. A key that is not cross-bound to the attestation cannot back the §6.2.2 evidence claim.

Archive the four artifacts (`signer-pubkey.der`, `sev-snp-report.bin`, `vcek.der`, `amd-cert-chain.pem`) to `/data/scruple/attest/<yyyymmdd-hhmmss>/` inside the CVM and to the L2 evidence bucket on OCI Object Storage. The trust-manifest publisher (§10) picks them up from the local path.

---

## 7. Configure the systemd unit for the Signer daemon

Cited in `01-GPSA.md` §C.2.3, §C.2.4, §C.2.5. All hardening flags shown are load-bearing for the L2 evidence claim — do not remove any without updating the GPSA.

Create the OS user (nologin, no home directory, no shell):

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin scruple-signer
sudo usermod -a -G softhsm scruple-signer   # PKCS#11 module access
```

Write the environment file (root-owned, 0400, holds the SoftHSM PIN retrieved at boot):

```bash
sudo mkdir -p /etc/scruple
sudo install -o root -g root -m 0400 /dev/null /etc/scruple/c2pa-signer.env
sudo tee /etc/scruple/c2pa-signer.env >/dev/null <<'EOF'
# Populated by the c2pa-signer-boot.service oneshot (below) from OCI Vault.
# The Signer daemon reads this file once at start-up, calls C_Login,
# then zeros the env in-process.
SCRUPLE_C2PA_SOFTHSM_MODULE=/usr/lib/softhsm/libsofthsm2.so
SCRUPLE_C2PA_SOFTHSM_SLOT=0
SCRUPLE_C2PA_SOFTHSM_LABEL=scruple-c2pa-key
SCRUPLE_C2PA_SIGNER_MODE=softhsm
SCRUPLE_C2PA_CERT_CHAIN=/etc/scruple/c2pa-cert-chain.pem
SCRUPLE_C2PA_TA_URL=http://timestamp.digicert.com
# SCRUPLE_C2PA_SOFTHSM_PIN gets injected below by the boot oneshot.
EOF
```

Write the boot oneshot that fetches the PIN from OCI Vault and appends it to the env file:

```ini
# /etc/systemd/system/scruple-c2pa-signer-boot.service
[Unit]
Description=Fetch SoftHSM PIN from OCI Vault into c2pa-signer.env
Before=scruple-c2pa-signer.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/scruple/bin/fetch-softhsm-pin.sh
```

> [proposed] `/opt/scruple/bin/fetch-softhsm-pin.sh` is a 10-line script: `oci vault secret get-secret-bundle --auth instance_principal ... | jq -r ... | base64 -d` piped into `printf 'SCRUPLE_C2PA_SOFTHSM_PIN=%s\n' >> /etc/scruple/c2pa-signer.env`. Ship in `deploy/scripts/`.

Write the Signer daemon unit itself:

```ini
# /etc/systemd/system/scruple-c2pa-signer.service
[Unit]
Description=Scruple C2PA Signer (SEV-SNP + SoftHSM)
After=scruple-c2pa-signer-boot.service network-online.target
Requires=scruple-c2pa-signer-boot.service

[Service]
Type=notify
User=scruple-signer
Group=scruple-signer
EnvironmentFile=/etc/scruple/c2pa-signer.env

ExecStart=/opt/scruple/venv/bin/python /opt/scruple/services/c2pa-signer/sign_daemon.py \
  --listen 0.0.0.0:8443 \
  --mtls-ca  /etc/scruple/backend-web-ca.pem \
  --mtls-crl /etc/scruple/backend-web-crl.pem \
  --server-cert /etc/scruple/signer-server-cert.pem \
  --server-key  /etc/scruple/signer-server-key.pem
Restart=on-failure
RestartSec=5s

# Hardening cited in GPSA §C.2.3 + §C.2.4 — do not remove without a GPSA update.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=no                   # SoftHSM daemon needs /dev; PKCS#11 fine.
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
MemoryDenyWriteExecute=yes
LockPersonality=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @mount
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/softhsm /var/log/scruple
ReadOnlyPaths=/etc/scruple
InaccessiblePaths=/data/scruple-web/services/c2pa-signer/keys

[Install]
WantedBy=multi-user.target
```

> [proposed] `sign_daemon.py` is the long-lived HTTP wrapper around `services/c2pa-signer/sign.py`. Ship it alongside `sign.py`; interface = HTTP POST body identical to the current subprocess job spec. Backend-Web already speaks that shape from `lib/c2pa/signAsset.ts`.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scruple-c2pa-signer-boot.service
sudo systemctl enable --now scruple-c2pa-signer.service
sudo systemctl status scruple-c2pa-signer.service
sudo journalctl -u scruple-c2pa-signer -n 50 --no-pager
```

Confirm the daemon is listening only on the intended NIC:

```bash
ss -ltnp | grep 8443
# Expected: LISTEN 0 128 <private-ip>:8443 users:(("python",pid=...))
```

---

## 8. Configure OCI VCN Security List / NSG

Ingress rule on the Signer's subnet — only Backend-Web's Compute instance may reach TCP 8443. Everything else denied.

```bash
# Preferred: put both the Web host and the Signer host in NSGs, and reference
# the Web NSG as the source.
oci network nsg rules add \
  --nsg-id "${SIGNER_NSG_OCID}" \
  --security-rules '[{
    "direction":"INGRESS",
    "protocol":"6",
    "source":"'"${BACKEND_WEB_NSG_OCID}"'",
    "sourceType":"NETWORK_SECURITY_GROUP",
    "tcpOptions":{"destinationPortRange":{"min":8443,"max":8443}}
  }]'
```

> [verify] The exact JSON shape for `oci network nsg rules add` occasionally moves between OCI CLI versions. If it errors, generate a template with `oci network nsg rules add --generate-full-command-json-input` and hand-edit.

Egress on the Signer's subnet: allow to the AMD KDS endpoint (`kdsintf.amd.com`) and to the OCI Vault crypto endpoint for the region. Deny everything else. This matches the "no general Internet" invariant in `CANONICAL_SCRUPLE_WITNESSING_L2.md` §5.3.

---

## 9. Cloudflare / cloudflared — explicitly none

**Signer is NOT exposed via Cloudflare.** The private VCN subnet has no Internet Gateway, no `cloudflared` tunnel, no public DNS. Backend-Web reaches it via the internal DNS name `sign.scruple.internal` resolved by the VCN's private DNS zone. Do not add a Cloudflare tunnel to the Signer host — the whole point of §C.2.6's network segmentation claim in the GPSA is that Signer is unreachable from the public Internet regardless of Cloudflare state.

---

## 10. Publish the CVM identity in the witness trust manifest

The trust manifest at `https://witness.scruple.ai/.well-known/witness-trust.json` (served by `app/.well-known/witness-trust.json/route.ts` on Backend-Web) gains a new `topologies[]` entry per §18.9 of `CANONICAL_SCRUPLE_WITNESSING_L2.md`:

```jsonc
{
  "id": "scruple-hosted-oci-cvm-01",
  "signer_public_key_pem": "<contents of /tmp/signer-pubkey.pem>",
  "signer_key_id_hash": "sha256:<hex of signer-pubkey.der>",
  "attestation": {
    "type": "amd-sev-snp",
    "cvm_instance_ocid_hash": "sha256:<hex of SIGNER_INSTANCE_OCID>",
    "vm_measurement": "<hex from measurement in the report body>",
    "reported_tcb": "0x581c00000000000a",
    "attestation_report_url": "https://witness.scruple.ai/attest/reports/<id>",
    "vcek_der_url": "https://witness.scruple.ai/attest/vcek/<id>",
    "amd_psp_ca_chain_url": "https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain"
  },
  "activated_at": "<UTC ISO-8601 now>"
}
```

Post the entry via the admin endpoint (or hand-edit the JSON file on Backend-Web and restart):

> [proposed] `POST /api/admin/trust-manifest/topology` on Backend-Web, auth = admin API key. Payload = the JSONC above. Persists to the DB row that backs the route handler.

---

## 11. Health check + end-to-end smoke

From Backend-Web, invoke the existing `test-c2pa-sign-witness-e2e.ts` smoke script, pointed at the new Signer:

```bash
# On Backend-Web:
SCRUPLE_C2PA_SIGNER_ENDPOINT="https://sign.scruple.internal:8443" \
SCRUPLE_C2PA_SIGNER_MTLS_CERT=/etc/scruple/backend-web-client.pem \
SCRUPLE_C2PA_SIGNER_MTLS_KEY=/etc/scruple/backend-web-client.key \
pnpm tsx scripts/test-c2pa-sign-witness-e2e.ts
```

Success criteria:

1. Signer returns a `.png` with an embedded C2PA manifest.
2. `c2patool /tmp/scruple-smoke.c2pa.png` reads the manifest, chain validates against `signer-cert-chain.pem`.
3. A leaf appears on `_scruple.c2pa.sign` in the Witness DB (`sqlite3 db/scruple.db "SELECT tenant_seq, leaf_hash FROM log_leaves WHERE stream_id='STR_c2pa_sign' ORDER BY tenant_seq DESC LIMIT 1"`).
4. `scruple-verify c2pa /tmp/scruple-smoke.c2pa.png --fetch-leaf` exits 0.

If steps 1–3 pass but 4 fails, the leaf is emitting but the inclusion proof isn't ready yet — wait one checkpoint interval (`enhanced` tier = 5 min) and retry.

---
## 12. Rotation — automated via Instance Pool max-age

Rotation is fully automated. No operator action is required for
routine 60-day age-based rotation. The rotation Function terminates
aged instances; the Instance Pool auto-provisions replacements from
the current Instance Configuration; the Signer LB drains outgoing
instances and registers new ones as they attest healthy.

### 12.1. Steady-state operational picture

Continuously:

- **N ≥ 2** Signer CVMs run concurrently in the Signer Instance Pool.
- Each CVM was provisioned within the last 60 days from the current
  golden image.
- On boot, each CVM runs the cloud-init payload documented in §§3–7
  above (SoftHSM init, ES256 key generation, SEV-SNP report fetch +
  cross-binding), then starts `scruple-c2pa-signer.service` per §7.
- Each CVM publishes an `ai.scruple.signer-runtime.v1` assertion in
  every signed manifest carrying its `instance_id`, `image_id`,
  `instance_born_at`, `age_days_at_sign`, `max_age_days`, and
  `rotation_policy_version`.
- The Signer LB routes incoming sign requests round-robin across Pool
  members.

Every 6 hours:

- OCI Resource Scheduler fires the `rotate-signer-cvms` Function.
- Function enumerates Pool members, computes each member's `age_days`
  from OCI Compute API's `time_created`, terminates any member with
  `age_days > 60`.
- Terminated member is drained from the LB (30 s drain window) and
  its underlying resources released.
- Pool detects target-size shortfall and provisions a replacement
  from the current Instance Configuration.
- New CVM boots, attests, joins the LB backend set, begins serving
  traffic.

### 12.2. When operator action IS required

Only when one of the following occurs:

**A. Golden image update (new patched base image published):**

1. Build a new Signer golden image via CI (the reproducible image
   build already runs through the OSV-Scanner / Grype / Semgrep /
   SBOM gates per `01-GPSA.md` §C.2.3).
2. Publish a new Instance Configuration referencing the new image
   OCID:
   ```bash
   cd deploy/oci-signer-rotation/terraform
   terraform apply -var signer_image_ocid=ocid1.image.oc1.iad.<new>
   ```
3. The Instance Pool picks up the new Instance Configuration on next
   replacement. Existing CVMs continue on the previous config until
   they hit the max-age threshold (up to 60 days later); they will be
   replaced from the new image on their scheduled rotation. To force
   immediate rollover, `terraform apply` then manually invoke the
   rotation Function:
   ```bash
   oci fn function invoke \
     --function-id $(terraform output -raw rotation_function_ocid) \
     --file - --body ''
   ```

**B. Trust-manifest update (per §10 above):**

New CVMs' HSM public keys publish to `witness-trust.json` on first
attestation. When replacing an entire generation of CVMs, add the
incoming SPKI hashes as a new `topologies` entry with
`activated_at = now`. Set `deprecated_at = activated_at + 30d` on the
previous entry. Verifiers accept both during the overlap window, only
the new after.

**C. Suspected compromise:**

Bypass the 60-day rotation for the affected generation:

1. Set `deprecated_at = now` on the compromised trust-manifest
   topology entry so verifiers immediately stop accepting signatures
   from that generation.
2. Force-terminate all Pool members: `oci compute-management
   instance-pool stop --instance-pool-id <ocid>` then `start`; the
   Pool provisions a fresh set from the current Instance
   Configuration.
3. Notify affected Principals per Rider §8 remediation flow.

**D. Rotation Function outage recovery:**

If the rotation Function fails to run for an extended period
(Function outage, IAM breakage, scheduler misconfig), Signer CVMs may
age past 60 days. The **secondary in-guest actuator** described in
`01-GPSA.md` §C.2.3.5 prevents these instances from signing —
`age_guard_verdict` returns `refuse=True` and every sign attempt
returns a structured refuse-to-sign error. To recover:

1. Diagnose the Function outage
   (`oci logging search --...`), fix the underlying issue.
2. Manually invoke the rotation Function to clear the backlog:
   ```bash
   oci fn function invoke --function-id <ocid> --file - --body ''
   ```
3. Confirm the Pool has provisioned replacements and the LB shows
   only under-age instances in the healthy backend set.

### 12.3. Cross-references

- Architecture: `01-GPSA.md` §C.2.3
- Terraform: `deploy/oci-signer-rotation/terraform/`
- Function: `deploy/oci-signer-rotation/function/`
- In-guest actuator: `services/c2pa-signer/signer_runtime.py`
- Wiring: `services/c2pa-signer/sign.py` (age-guard check +
  runtime-assertion emission)
