# scruple — Python SDK

Customer-side SDK for integrating with the Scruple witnessing API.

## Install (from workspace)

```bash
pip install -e /data/scruple-web/packages/scruple-sdk-python
```

## Quickstart

```python
import scruple

client = scruple.WitnessClient(
    api_base="https://witness.scruple.ai",
    tenant="TEN_ford",
    api_key=os.environ["SCRUPLE_API_KEY"],
    baseline_manifest_path="./scruple-baseline.yaml",
    signer_pubkey_spki_sha256_hex="<32-byte hex>",
    on_baseline_drift="raise",  # or 'warn' | 'auto_rebaseline'
)

# On first install:
client.submit_baseline()

# On subsequent runs, verify no drift:
client.check_baseline_drift()

# For platforms with hardware attestation:
from scruple.attestation import amd_sev_snp
client.register_attestation_fetcher(amd_sev_snp.fetch)

# Submit a witness call:
receipt = client.call_witness(
    "scruple.myapp.inference",
    {
        "tenant_seq": 42,
        "idempotency_key": "inference_abc",
        "event_time": "2026-07-13T00:00:00Z",
        "payload_hash": "sha256:...",
    },
)
```

## What's shipped in v0.1.0 (WO-05)

- `scruple.baseline` — manifest parsing + deterministic hash computation
- `scruple.envelope` — AttestationEnvelope + validation
- `scruple.canonical` — cross-language canonical JSON
- `scruple.client.WitnessClient` — API auth, drift detection, auto-inject
- `scruple.attestation.amd_sev_snp` — SEV-SNP fetcher (requires
  `/dev/sev-guest` + `snpguest` CLI)

## Coming next (per WO plan)

- `scruple.attestation.nvidia_h100_cc` (WO-07)
- `scruple.attestation.aws_nitro` (WO-08)
- `scruple.attestation.azure_maa` (WO-09)
- `scruple.attestation.intel_tdx` (WO-10)
- `scruple.attestation.tpm_2` (WO-11)
