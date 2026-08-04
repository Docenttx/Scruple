#!/bin/bash
#
# SEV-SNP attestation ceremony for the Scruple Signer CVM.
#
# Runs from the Web host, driving the CVM over SSH. Assumes cloud-init
# bootstrap has completed and the SoftHSM ES256 key exists.
#
# Produces the evidence bundle the C2PA Program assessor requires:
#   - sev-snp-report.bin  — attestation report with report_data =
#                            sha256(SoftHSM SPKI DER)
#   - vcek.der            — AMD Versioned Chip Endorsement Key cert
#   - amd-cert-chain.pem  — AMD Root Key → SEV-Genoa chain
#   - measurement.hex     — VM measurement pinned in the report
#   - signer-pubkey.*     — the SoftHSM public key (DER + PEM + sha256)
#   - verify.log          — output of snpguest verify certs + attestation
#
# Usage:  ./attestation-ceremony.sh <cvm-private-ip>

set -eo pipefail

CVM_IP="${1:?usage: $0 <cvm-private-ip>}"
KEY=~/.ssh/scruple-signer-drive
SSH="ssh -i $KEY -o BatchMode=yes opc@$CVM_IP"
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
LOCAL_OUT="/data/scruple-web/docs/l2-evidence/$STAMP"
mkdir -p "$LOCAL_OUT"

echo "=== [1/7] Confirm bootstrap done + SoftHSM key exists ==="
$SSH 'test -f /var/log/scruple-cvm-bootstrap.done && echo BOOTSTRAP_OK; sudo -u scruple-signer env SOFTHSM2_CONF=/etc/softhsm2.conf pkcs11-tool --module /usr/lib64/pkcs11/libsofthsm2.so --slot-index 0 --list-objects | head -20'

echo
echo "=== [2/7] Install snpguest on the CVM ==="
$SSH 'if ! command -v snpguest &>/dev/null; then
    sudo dnf install -y snpguest 2>/dev/null || {
      curl -sSL https://github.com/virtee/snpguest/releases/download/v0.5.0/snpguest -o /tmp/snpguest
      chmod +x /tmp/snpguest
      sudo mv /tmp/snpguest /usr/local/bin/snpguest
    }
fi
snpguest --version || /usr/local/bin/snpguest --version'

echo
echo "=== [3/7] Compute report_data = sha256(SoftHSM SPKI DER) ==="
$SSH 'sudo cat /var/lib/scruple-signer/scruple-c2pa-pubkey.sha256'

echo
echo "=== [4/7] Fetch SEV-SNP report with pubkey binding ==="
$SSH 'REPORT_DATA=$(sudo cat /var/lib/scruple-signer/scruple-c2pa-pubkey.sha256)
sudo mkdir -p /tmp/attest
sudo bash -c "printf %s \"\$REPORT_DATA\" > /tmp/attest/request-data.txt"
sudo snpguest report /tmp/attest/sev-snp-report.bin /tmp/attest/request-data.txt --random 2>&1 || \
sudo snpguest report /tmp/attest/sev-snp-report.bin /tmp/attest/request-data.txt 2>&1
ls -la /tmp/attest/'

echo
echo "=== [5/7] Fetch AMD certs ==="
$SSH 'sudo snpguest fetch vcek der Genoa /tmp/attest/vcek.der
sudo snpguest fetch ca pem Genoa /tmp/attest
ls -la /tmp/attest/'

echo
echo "=== [6/7] Local verify: chain + attestation ==="
$SSH 'sudo snpguest verify certs /tmp/attest 2>&1
sudo snpguest verify attestation /tmp/attest /tmp/attest/sev-snp-report.bin 2>&1'

echo
echo "=== [7/7] Copy evidence bundle back to Web host ==="
$SSH 'sudo cp /var/lib/scruple-signer/scruple-c2pa-pubkey.{der,pem,sha256} /tmp/attest/
sudo chmod -R a+r /tmp/attest/
sudo snpguest display report /tmp/attest/sev-snp-report.bin | sudo tee /tmp/attest/report-summary.txt >/dev/null'
scp -i "$KEY" -o BatchMode=yes "opc@$CVM_IP:/tmp/attest/*" "$LOCAL_OUT/"

$SSH 'echo "=== SEV dmesg ==="; sudo dmesg | grep -iE "SEV|Memory Encryption" | head -20
echo; echo "=== OS ==="; cat /etc/os-release
echo; echo "=== Kernel ==="; uname -a
echo; echo "=== CPU ==="; grep -m1 "model name" /proc/cpuinfo
echo; echo "=== SEV devices ==="; ls -la /dev/sev*
echo; echo "=== SoftHSM ==="; softhsm2-util --show-slots 2>&1 | head -15' > "$LOCAL_OUT/ENVIRONMENT.txt"

echo
echo "=== DONE ==="
echo "Evidence bundle: $LOCAL_OUT"
ls -la "$LOCAL_OUT/"
