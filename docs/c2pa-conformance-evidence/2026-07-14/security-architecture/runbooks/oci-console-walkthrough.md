# OCI Console Walkthrough — provision the Scruple Signer CVM

**Companion to** `cvm-provision.md` (which is CLI-heavy). This doc is
click-by-click for the OCI Console UI. Do this in order; each phase
must complete before the next.

**Time estimate:** ~45–75 minutes end-to-end, most of which is Ubuntu
image download after boot. Actual clicking + form-filling is under 20
minutes.

**Region:** Recommend **US East (Ashburn / `us-ashburn-1` / IAD)** —
this is the region where the 2026-07-12 ceremony ran; VM.Standard.E5.Flex
Confidential Computing is confirmed available there. VM.Standard.E5.Flex
Confidential Computing is available in **all OC1 public regions except
Zurich, Singapore, and Chicago** ([Oracle docs](https://docs.oracle.com/en-us/iaas/Content/Compute/References/confidential_compute.htm)).

**Naming convention used below:** `scruple-*` prefix for everything.
Change if you prefer.

---

## Phase 0 — Prerequisites & login

1. **Log in to OCI Console** at `https://cloud.oracle.com`.
2. **Top-right region selector** — set to `US East (Ashburn)` (or your
   chosen region). Confirm the "Home Region" chip matches; if not,
   some IAM operations may need to be done in the Home Region first.
3. **Top-left hamburger menu** — verify your Compartment is set to
   the one you want Scruple to live in. Recommend creating a
   dedicated `scruple-prod` compartment if you don't already have
   one:
   - Menu → **Identity & Security → Compartments**
   - Click **Create Compartment**
   - Name: `scruple-prod`, Parent: your tenancy root, Description:
     "Scruple production infrastructure"
   - Click **Create Compartment**
4. **Note the compartment OCID** — click the new compartment name,
   scroll to "OCID" at the bottom, click "Copy". Save it somewhere
   (you'll reference it repeatedly).

---

## Phase 1 — IAM: Dynamic Group + Policy for the CVM

The CVM's Instance Principal (its cloud identity, issued per-boot by
OCI) needs permission to read the SoftHSM PIN Secret from Vault. We
set that up first so the CVM is ready to use it the moment it boots.

### 1.1 Create the Dynamic Group

1. Menu → **Identity & Security → Domains**
2. Click your **Default** domain
3. Left sidebar → **Dynamic groups**
4. Click **Create dynamic group**
5. **Name:** `scruple-signer-cvm`
6. **Description:** "The Scruple C2PA Signer Confidential VM"
7. **Matching rules (single rule):**
   ```
   ALL {instance.compartment.id = 'ocid1.compartment.oc1..<YOUR-SCRUPLE-PROD-COMPARTMENT-OCID>', tag.oracle-tags.CreatedBy.value = 'ScrupleSigner'}
   ```
   Replace `<YOUR-SCRUPLE-PROD-COMPARTMENT-OCID>` with the OCID you
   copied above. The `CreatedBy` tag is what we'll apply to the CVM
   at launch so no other instance in this compartment can be picked
   up by this group.
8. Click **Create**

> [verify] If your tenancy doesn't have the `oracle-tags` namespace
> enabled by default, the tag reference will error at policy
> evaluation. Alternative matching rule (less specific, more likely
> to work everywhere): `instance.compartment.id = '<OCID>'`. Only
> the CVM you plan to launch should live in this compartment if you
> use that form.

### 1.2 Create the IAM Policy

1. Menu → **Identity & Security → Policies**
2. Click **Create Policy**
3. **Name:** `scruple-signer-cvm-policy`
4. **Description:** "Grants the Scruple Signer CVM read access to the
   SoftHSM PIN Secret in Vault"
5. **Compartment:** your tenancy root (policies at tenancy scope are
   necessary for Dynamic Group references)
6. **Show manual editor** (toggle) and paste:
   ```
   Allow dynamic-group scruple-signer-cvm to read secret-family in compartment scruple-prod
   ```
   If you want tighter scope (recommended), narrow later to a
   specific secret OCID once the secret exists:
   ```
   Allow dynamic-group scruple-signer-cvm to read secret-bundles in compartment scruple-prod where target.secret.id = 'ocid1.vaultsecret.oc1..<SOFTHSM-PIN-SECRET-OCID>'
   ```
7. Click **Create**

**Optional:** if you'll additionally wrap SoftHSM token backups with
an OCI Vault master key (recommended for DR):
```
Allow dynamic-group scruple-signer-cvm to use keys in compartment scruple-prod where target.key.id = 'ocid1.key.oc1..<WRAP-KEY-OCID>'
```
Add this later when the wrap key exists.

---

## Phase 2 — Vault: create the Vault + PIN Secret (+ optional wrap key)

### 2.1 Create the Vault

1. Menu → **Identity & Security → Vault**
2. **Left sidebar → Vaults**, confirm compartment = `scruple-prod`
3. Click **Create Vault**
4. **Name:** `scruple-prod-vault`
5. **Make it a virtual private vault:** leave **unchecked** for cost;
   toggle **checked** if you want FIPS 140-2 Level 3 HSM isolation
   (higher monthly cost but the L2 §6.2.2 wrap-key story is
   stronger). Recommend **checked** for production.
6. Click **Create Vault**
7. Wait ~2 minutes for state to reach "Active"
8. **Note the Vault OCID** and the **Cryptographic Endpoint** URL
   (both visible on the Vault detail page)

### 2.2 Create the SoftHSM PIN Secret

1. On the Vault detail page → left sidebar → **Secrets** → **Create
   Secret**
2. **Name:** `scruple-softhsm-pin`
3. **Description:** "SoftHSM PIN gating access to the Scruple C2PA
   signing key inside the SEV-SNP CVM"
4. **Encryption Key:** pick any existing master key in this vault OR
   click **Create master encryption key** first and set:
   - Name: `scruple-secrets-mek`
   - Protection mode: **HSM** (required for L2 §6.2.2 hardware wrapping)
   - Key shape: **AES**, **256 bits**
   - Click Create; return to secret creation
5. **Secret type template:** Plain-Text
6. **Secret contents:** generate a strong PIN. From a trusted terminal:
   ```
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```
   Paste output as the secret value. **Save this value in a password
   manager under `scruple-softhsm-pin@prod`** — you will need it
   during the SoftHSM init step and never again after that.
7. Click **Create Secret**
8. **Note the Secret OCID.** Go back to §1.2 and update the tight
   IAM policy variant if you took that path.

### 2.3 (Optional but recommended) Create the SoftHSM-token wrap key

For SoftHSM token disaster-recovery backups.

1. On the Vault detail page → **Master Encryption Keys** → **Create
   Key**
2. **Name:** `scruple-softhsm-wrap-key`
3. **Protection mode:** **HSM**
4. **Key shape:** **AES**, **256 bits**
5. Click **Create Key**
6. Note the Key OCID; update §1.2 policy to grant `use keys` on it.

---

## Phase 3 — Networking: VCN + subnets + security lists

The Signer CVM will live on a **private subnet** with no public IP.
The Web host will reach it over an internal security-list-gated port.

### 3.1 Create the VCN

1. Menu → **Networking → Virtual Cloud Networks**
2. Confirm compartment = `scruple-prod`
3. Click **Start VCN Wizard**
4. Select **Create VCN with Internet Connectivity** (this gives you
   both a public subnet for the Web host and a private subnet for
   the Signer; you can also do "VCN with VCN peering" if you already
   have a VCN)
5. Click **Start VCN Wizard**
6. **VCN name:** `scruple-vcn`
7. **Compartment:** `scruple-prod`
8. **VCN CIDR:** `10.20.0.0/16` (or your convention)
9. **Public Subnet CIDR:** `10.20.0.0/24`
10. **Private Subnet CIDR:** `10.20.1.0/24`
11. Click **Next**, review, **Create**

You now have:
- `scruple-vcn`
- `public subnet-scruple-vcn` (for Backend-Web, has NAT/Internet GW)
- `private subnet-scruple-vcn` (for Backend-Signer CVM, egress via NAT only)

### 3.2 Tighten the Signer's private subnet security list

1. Menu → **Networking → Virtual Cloud Networks → scruple-vcn**
2. Left sidebar → **Security Lists**
3. Click **Default Security List for scruple-vcn**
4. **Ingress Rules → Add Ingress Rules**:
   - **Stateless:** No
   - **Source Type:** CIDR
   - **Source CIDR:** `10.20.0.0/24` (public subnet — Web host will
     be there)
   - **IP Protocol:** TCP
   - **Destination Port Range:** `8443`
   - **Description:** "Scruple Web → Signer mTLS"
5. Click **Add Ingress Rules**
6. Delete or narrow any default `0.0.0.0/0` port-22 rule if you don't
   need public SSH into the private subnet (you'll SSH via a bastion
   or via the Web host)

### 3.3 (If not already present) Create a bastion for admin access

Recommended for the SoftHSM init ceremony. Menu → **Identity &
Security → Bastion** → **Create Bastion**:
- Name: `scruple-bastion`
- Target VCN: `scruple-vcn`
- Target subnet: **private subnet-scruple-vcn**
- CIDR allow list: your admin IP or `0.0.0.0/0` (narrow later)
- Click **Create Bastion**

---

## Phase 4 — Launch the Signer CVM

### 4.1 Launch

1. Menu → **Compute → Instances**
2. Confirm compartment = `scruple-prod`
3. Click **Create Instance**
4. **Name:** `scruple-signer-cvm`
5. **Compartment:** `scruple-prod`
6. **Placement:** any available AD in your region — but note down
   which AD you pick, you'll want the Web host in the same AD for
   private-subnet latency.
7. **Security:** section header **"Security"** →
   - Toggle **Enable Confidential Computing** to **ON**.
   - If the toggle is greyed out, the shape you picked below doesn't
     support Confidential Computing — switch shape.
8. **Image and shape:**
   - **Image:** click **Change image** → **Platform Images** tab →
     search **Ubuntu** → pick **Canonical Ubuntu 24.04** with the
     `[Confidential Computing]` variant marker. If you don't see a
     Confidential-Computing-marked variant, the standard
     Ubuntu 24.04 also works — SEV-SNP kernel support is in the
     stock Ubuntu 24.04 image with kernel 6.8+.
   - **Shape:** click **Change shape** → **Virtual machine** →
     **AMD** tab → select **VM.Standard.E5.Flex** →
     - **OCPUs:** 2 (upgrade later if signing throughput demands it)
     - **Memory (GB):** 8
   - **After picking the shape, scroll back up and confirm the
     Enable Confidential Computing toggle is still ON.**
9. **Networking:**
   - **Primary VNIC → Virtual cloud network:** `scruple-vcn`
   - **Subnet:** `private subnet-scruple-vcn`
   - **Do not assign a public IPv4 address** — leave the toggle
     OFF. This is the point of the private subnet.
10. **Add SSH keys:** upload your admin public key (or generate a
    new keypair; download the private key immediately, save in a
    secure keystore).
11. **Boot volume:** default 47 GB is fine; toggle **Boot volume
    encryption** ON with **Encrypt using customer-managed keys**
    and pick `scruple-secrets-mek` from your vault (adds another
    encryption-at-rest layer on top of SEV-SNP memory encryption).
12. **Show advanced options:**
    - **Tags** tab → add:
      - `oracle-tags.CreatedBy = ScrupleSigner`
      - This is what the Dynamic Group in §1.1 matches on.
13. Click **Create**
14. Wait ~90 seconds for the instance state to reach **Running**

### 4.2 Verify SEV-SNP is active

You need to SSH in — but the CVM has no public IP, so use the bastion.

1. Menu → **Identity & Security → Bastion → scruple-bastion**
2. **Sessions** → **Create session**
3. **Session type:** SSH port forwarding session (or Managed SSH if
   easier)
4. **Target resource:** paste the CVM's private IP + port 22
5. Click **Create session**
6. Under **Actions** for the session → **Copy SSH command**
7. Paste into your local terminal (adds the SSH command with a
   `-J` jump-host reference to the bastion). SSH in.
8. Once in, verify SEV-SNP:
   ```
   ubuntu@scruple-signer-cvm:~$ dmesg | grep -i "SEV\|SNP\|Memory Encryption"
   [    0.000000] Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP
   [    0.428933] SEV: SNP running at VMPL0
   ```
   Both lines MUST appear. If they don't:
   - Confidential Computing toggle wasn't on at launch → terminate
     the instance and relaunch.
   - Shape doesn't support SEV-SNP → switch shape.
9. Verify the guest device:
   ```
   ubuntu@scruple-signer-cvm:~$ ls -la /dev/sev-guest
   crw-------  1 root root 10, 122 Jul 15 03:14 /dev/sev-guest
   ```
   Present → good. Missing → kernel/firmware issue, check dmesg for
   SEV errors.
10. Note the CVM's private IP (visible in the Instance detail page
    under "Primary VNIC → Private IP").

---

## Phase 5 — SoftHSM initialization & key generation

Still SSH'd into the CVM.

### 5.1 Install packages

```
sudo apt-get update
sudo apt-get install -y softhsm2 opensc-pkcs11 python3 python3-pip python3-venv
python3 -m venv /opt/scruple-venv
sudo /opt/scruple-venv/bin/pip install --upgrade pip
sudo /opt/scruple-venv/bin/pip install "c2pa==0.36.0" "cryptography==42.0.5" "oci==2.129.1"
```

### 5.2 Create the `scruple-signer` OS user

```
sudo useradd --system --shell /usr/sbin/nologin \
    --home-dir /var/lib/scruple-signer --create-home \
    scruple-signer
sudo mkdir -p /var/lib/scruple-signer/softhsm
sudo chown -R scruple-signer:scruple-signer /var/lib/scruple-signer
```

### 5.3 Configure SoftHSM to use per-user token store

```
sudo tee /etc/softhsm/softhsm2.conf <<'EOF'
directories.tokendir = /var/lib/scruple-signer/softhsm/tokens
objectstore.backend = file
log.level = INFO
slots.removable = false
slots.mechanisms = ALL
library.reset_on_fork = false
EOF
sudo mkdir -p /var/lib/scruple-signer/softhsm/tokens
sudo chown -R scruple-signer:scruple-signer /var/lib/scruple-signer/softhsm
```

### 5.4 Fetch the PIN from OCI Vault

```
# Install oci-cli for this one-time ceremony
sudo apt-get install -y python3-oci-cli

# Auth via Instance Principal (CVM will auto-use its Dynamic Group identity)
export OCI_CLI_AUTH=instance_principal

# Look up the secret OCID (you noted it in §2.2)
export PIN_OCID=ocid1.vaultsecret.oc1.iad.<YOUR-SECRET-OCID>

# Fetch + decode
PIN=$(oci secrets secret-bundle get --secret-id "$PIN_OCID" \
    --raw-output --query 'data."secret-bundle-content".content' \
    | base64 -d)
echo "PIN retrieved: ${#PIN} chars"
```

If this fails with authorization errors, revisit §1.1 (dynamic group
matching rule) and §1.2 (policy).

### 5.5 Initialize the SoftHSM token

```
sudo -u scruple-signer bash -c "
  export SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf
  softhsm2-util --init-token --slot 0 \
      --label 'scruple-c2pa' \
      --pin '$PIN' \
      --so-pin '$PIN'
"
```

Verify:
```
sudo -u scruple-signer softhsm2-util --show-slots | head -20
# Should show: Slot 0, Label: scruple-c2pa, initialized: yes
```

### 5.6 Generate the ES256 signing key inside SoftHSM

```
sudo -u scruple-signer bash -c "
  export SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf
  pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
      --slot-index 0 \
      --login --pin '$PIN' \
      --keypairgen \
      --key-type EC:prime256v1 \
      --label 'scruple-c2pa-key' \
      --id 01 \
      --usage-sign \
      --sensitive \
      --extractable=false
"
```

Verify the key exists and is non-extractable:
```
sudo -u scruple-signer pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
    --slot-index 0 --login --pin "$PIN" --list-objects
# Look for: Private Key Object; EC ... label: scruple-c2pa-key
# EXTRACTABLE flag should NOT be set
```

### 5.7 Export the public key for CSR + attestation binding

```
sudo -u scruple-signer bash -c "
  export SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf
  pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
      --slot-index 0 --login --pin '$PIN' \
      --read-object --type pubkey \
      --label 'scruple-c2pa-key' \
      --output-file /tmp/scruple-c2pa-pubkey.der
"
openssl ec -inform DER -pubin -in /tmp/scruple-c2pa-pubkey.der -pubout -out /tmp/scruple-c2pa-pubkey.pem
sha256sum /tmp/scruple-c2pa-pubkey.der | awk '{print $1}' > /tmp/scruple-c2pa-pubkey.sha256
```

The `.sha256` value is what you'll bind into the SEV-SNP attestation
report's `report_data` field (Phase 6).

### 5.8 IMMEDIATELY clear the PIN from your shell

```
unset PIN
history -c
```

You will retrieve the PIN again at boot via a systemd
`EnvironmentFile` populated by a boot oneshot; don't leave it in
this interactive shell.

---

## Phase 6 — SEV-SNP attestation ceremony

This binds the SoftHSM public key to the CVM's hardware measurement,
producing the artifact bundle that the C2PA assessor verifies.

### 6.1 Install the SEV-SNP report fetcher

Use `snpguest` (the maintained AMD SEV tool):

```
curl -sSL https://github.com/virtee/snpguest/releases/download/v0.5.0/snpguest \
    -o /tmp/snpguest
chmod +x /tmp/snpguest
sudo mv /tmp/snpguest /usr/local/bin/snpguest
snpguest --version
```

### 6.2 Fetch the attestation report with pubkey binding

```
REPORT_DATA=$(cat /tmp/scruple-c2pa-pubkey.sha256)
sudo snpguest report /tmp/sev-snp-report.bin /tmp/sev-snp-request.bin \
    --random <(printf '%s' "$REPORT_DATA")
```

> [verify] snpguest CLI syntax varies by version. If the `--random`
> flag isn't recognized in your installed version, use `--data
> $REPORT_DATA` or check `snpguest report --help`. The intent: the
> report's `report_data` field must equal the SHA-256 of the SoftHSM
> pubkey DER.

### 6.3 Fetch AMD's public certificates for the report

```
sudo snpguest fetch vcek der Genoa /tmp/vcek.der
sudo snpguest fetch ca pem Genoa /tmp/amd-cert-chain.pem
```

### 6.4 Verify the chain locally

```
sudo snpguest verify certs /tmp/vcek.der /tmp/amd-cert-chain.pem
# Should print: The AMD chain is verified
sudo snpguest verify attestation /tmp/sev-snp-report.bin /tmp/vcek.der
# Should print: Report is valid
```

### 6.5 Save the evidence bundle for the CA + assessor

```
sudo mkdir -p /var/lib/scruple-signer/attestation-$(date -u +%Y%m%dT%H%M%SZ)
cd /var/lib/scruple-signer/attestation-*/
sudo cp /tmp/sev-snp-report.bin /tmp/vcek.der /tmp/amd-cert-chain.pem .
sudo cp /tmp/scruple-c2pa-pubkey.{der,pem,sha256} .
sudo snpguest display report /tmp/sev-snp-report.bin | sudo tee report-summary.txt
```

Copy this whole directory back to your admin workstation for
archival — it's the evidence bundle you'll cite in future L2 audits.

---

## Phase 7 — Deploy the Signer service (systemd)

Still on the CVM.

### 7.1 Pull the Scruple signer code

```
sudo mkdir -p /opt/scruple-signer
sudo git clone https://github.com/Docenttx/Scruple.git /opt/scruple-src
sudo cp -r /opt/scruple-src/services/c2pa-signer /opt/scruple-signer/
sudo chown -R scruple-signer:scruple-signer /opt/scruple-signer
```

### 7.2 Boot-time PIN fetch oneshot

Create `/etc/systemd/system/scruple-fetch-pin.service`:
```
[Unit]
Description=Fetch SoftHSM PIN from OCI Vault (runs once at boot)
Before=scruple-c2pa-signer.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=OCI_CLI_AUTH=instance_principal
Environment=PIN_OCID=ocid1.vaultsecret.oc1.iad.<YOUR-SECRET-OCID>
ExecStart=/bin/bash -c '\
  install -o scruple-signer -g scruple-signer -m 0400 /dev/null /run/scruple-signer.env && \
  PIN=$$(oci secrets secret-bundle get --secret-id "$$PIN_OCID" \
    --raw-output --query "data.\"secret-bundle-content\".content" | base64 -d) && \
  echo "SOFTHSM_PIN=$$PIN" > /run/scruple-signer.env && \
  chmod 0400 /run/scruple-signer.env'

[Install]
WantedBy=multi-user.target
```

### 7.3 Signer service unit

Create `/etc/systemd/system/scruple-c2pa-signer.service`:
```
[Unit]
Description=Scruple C2PA Signer (inside SEV-SNP CVM)
After=network-online.target scruple-fetch-pin.service
Requires=scruple-fetch-pin.service
Wants=network-online.target

[Service]
Type=simple
User=scruple-signer
Group=scruple-signer
EnvironmentFile=/run/scruple-signer.env
Environment=SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf
Environment=SCRUPLE_C2PA_SIGNER_MODE=softhsm
Environment=SCRUPLE_C2PA_PKCS11_MODULE=/usr/lib/softhsm/libsofthsm2.so
Environment=SCRUPLE_C2PA_KEY_LABEL=scruple-c2pa-key
Environment=SCRUPLE_C2PA_LISTEN=0.0.0.0:8443
ExecStart=/opt/scruple-venv/bin/python -m services.c2pa_signer.sign_daemon
Restart=on-failure
RestartSec=5s

# Hardening (matches GPSA §C.2.3 claims)
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
LockPersonality=yes
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=/var/lib/scruple-signer /run/scruple-signer.env

[Install]
WantedBy=multi-user.target
```

> [proposed] `services.c2pa_signer.sign_daemon` — this is the HTTP
> wrapper that doesn't exist in the repo yet as of 2026-07-15. The
> current `sign.py` is subprocess-invoked. Add the daemon wrapper
> before enabling this unit — see `cvm-provision.md` §"Signer daemon
> wrapper" for a minimal reference implementation.

### 7.4 Enable + start

```
sudo systemctl daemon-reload
sudo systemctl enable scruple-fetch-pin scruple-c2pa-signer
sudo systemctl start scruple-fetch-pin
sudo systemctl status scruple-fetch-pin        # should be "active (exited)"
sudo systemctl start scruple-c2pa-signer
sudo systemctl status scruple-c2pa-signer      # should be "active (running)"
sudo journalctl -u scruple-c2pa-signer -n 50   # verify no errors
```

---

## Phase 8 — CSR generation & CA submission

Detailed in `cert-enrollment.md`. Quick reference on the CVM:
```
openssl req -engine pkcs11 -keyform engine \
    -key "pkcs11:token=scruple-c2pa;object=scruple-c2pa-key;type=private?pin-value=$PIN" \
    -new -subj "/CN=Scruple/O=Docent LLC/C=US" \
    -out /tmp/scruple-c2pa.csr
```

Copy `/tmp/scruple-c2pa.csr` off the CVM. Submit to DigiCert Content
Credentials or SSL.com C2PA Signer. Wait for the CA (days to weeks).
When the cert arrives, copy back into the CVM at
`/opt/scruple-signer/c2pa-signer/keys/es256.pub`, then
`sudo systemctl restart scruple-c2pa-signer`.

---

## Phase 9 — Web host: point the Signer client at the CVM

On the Scruple Web host (the OCI Compute instance running Next.js,
NOT the CVM):

1. Set env vars:
   ```
   export SCRUPLE_C2PA_SIGNER_URL=https://<CVM-PRIVATE-IP>:8443
   export SCRUPLE_C2PA_SIGNER_HMAC_SECRET=<generated at CVM provision>
   ```
2. Restart Next.js (or your process manager) to pick up new env
3. Smoke test — from the Web host:
   ```
   curl -sS -X POST https://<CVM-PRIVATE-IP>:8443/health \
       --cacert /path/to/cvm-mtls-ca.pem \
       --cert /path/to/web-client.pem \
       --key  /path/to/web-client.key
   # → {"status":"ok","attestation_available":true,"signer_key_label":"scruple-c2pa-key"}
   ```

---

## Phase 10 — End-to-end smoke

From your admin workstation:

```
# Get an API key from the Scruple admin (or use a session cookie)
curl -X POST https://scruple.ai/api/scruple/c2pa/sign \
    -H "Authorization: Bearer sk_test_..." \
    -F "content=@/path/to/test.png" \
    -F "manifest_template=default" \
    -o /tmp/signed.png

# Verify with c2patool
c2patool /tmp/signed.png
# Should show: validation_state: Valid; active_manifest: urn:c2pa:...
```

That signed asset was produced by the CVM-held key. You just closed
the loop end-to-end from browser → Web → CVM → SoftHSM → signed C2PA
manifest → verified.

---

## Cost estimate (very rough)

| Item | Est. monthly cost |
|---|---|
| VM.Standard.E5.Flex (2 OCPU, 8GB) with Confidential Computing | ~$40–70 |
| Boot volume 47 GB (customer-managed encryption) | ~$3 |
| Vault (standard, not virtual private) | ~$2 |
| Vault (virtual private, FIPS 140-2 L3) | ~$300 |
| Vault Secret + Master Key operations | <$1 for typical Scruple sign volume |
| Bastion sessions | free within OCI's fair-use |
| VCN + NAT Gateway (private subnet egress) | ~$30 (NAT flat) + $0.045/GB out |
| **Total (standard vault)** | **~$75–110/month** |
| **Total (virtual private vault)** | **~$375–410/month** |

For pre-production + low customer volume, standard Vault is fine.
Upgrade to virtual private vault when a customer's contract demands
formal FIPS 140-2 Level 3 attestation on the wrap key.

---

## Sanity checklist before flipping DNS or announcing the CVM to a customer

- [ ] `dmesg | grep SEV-SNP` shows the CVM active (§4.2)
- [ ] SoftHSM key is non-extractable (§5.6)
- [ ] SEV-SNP attestation report's `report_data` matches
      `sha256(pubkey.der)` (§6.4)
- [ ] `snpguest verify certs` and `verify attestation` both pass
      (§6.4)
- [ ] Systemd units are `enabled` + `active` (§7.4)
- [ ] Web host can reach `:8443` on the CVM's private IP but
      NOTHING else can (VCN security-list audit)
- [ ] Boot volume is customer-managed-key encrypted
- [ ] Instance tagged `oracle-tags.CreatedBy=ScrupleSigner` (§4.1)
- [ ] IAM policy grants Signer Dynamic Group `read` on the specific
      PIN Secret OCID only (§1.2 tight variant)
- [ ] SoftHSM PIN saved in password manager, NOT in shell history,
      NOT in git, NOT in Slack
- [ ] CSR submitted to Trust List CA; production cert not yet in
      place (dev cert acceptable for interop testing until
      production cert arrives)

## Sources referenced

- [OCI Confidential Computing on E5/E6 shapes](https://blogs.oracle.com/cloud-infrastructure/oci-confidential-computing-on-e5-e6-shapes)
- [OCI Confidential Computing docs](https://docs.oracle.com/en-us/iaas/Content/Compute/References/confidential_compute.htm)
- [Ubuntu on OCI: Enable Confidential Computing](https://ubuntu.com/docs/oracle/oracle-how-to/enable-confidential-computing/)
- [OCI Vault IAM policies](https://docs.oracle.com/en-us/iaas/Content/KeyManagement/home.htm)
