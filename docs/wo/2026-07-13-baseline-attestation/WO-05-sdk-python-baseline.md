# WO-05 — Python SDK baseline machinery + SEV-SNP fetcher

**Phase:** 2 (SEV-SNP)
**Depends on:** WO-01, WO-02, WO-03, WO-04
**Blocks:** WO-06
**Owner:** SDK (Python)
**Effort:** ~2 days

## Purpose

Ship the customer-side machinery: the baseline manifest schema, the hash
computation, the SEV-SNP attestation fetcher, and the auto-injection of
the platform_attestation envelope into every witness call. This closes
the customer-facing loop for the SEV-SNP path.

## Deliverables

### 1. SDK package

New package at `packages/scruple-sdk-python/`:

```
packages/scruple-sdk-python/
├── pyproject.toml   (name: "scruple", version: 0.1.0)
├── scruple/
│   ├── __init__.py
│   ├── client.py            (WitnessClient — the top-level object)
│   ├── baseline.py          (manifest parsing + hash computation)
│   ├── envelope.py          (AttestationEnvelope dataclass + validation)
│   ├── attestation/
│   │   ├── __init__.py
│   │   └── amd_sev_snp.py   (fetch() → envelope)
│   └── canonical.py         (canonical JSON serialization)
└── tests/
    ├── test_baseline_hash.py
    ├── test_envelope.py
    └── test_sev_snp_fetch.py  (skipped if not on SEV-SNP host)
```

### 2. Baseline manifest schema

`scruple-baseline.yaml` schema (documented in the package README):

```yaml
integration_id: <string>
version: <string>
declared_at: <RFC 3339>
code:
  - path: <glob or literal path relative to repo root>
  - path: <...>
dependencies:
  - path: <string>
deployment:
  runtime: <string>
  process_manager: <string>
  service_units:
    - <path>
config:
  env:
    - name: <string>
      value: <string>          # for non-secret env
      handle: <string>          # for secret env (e.g. vault://scruple/api-key)
attestation:
  provider: none | amd-sev-snp | intel-tdx | aws-nitro-enclave
          | gcp-confidential-space | azure-attestation-service
          | nvidia-h100-cc | tpm-2.0-quote | <passthrough type>
  verifier_reference: <optional URL for passthrough>
```

### 3. Baseline hash computation

`scruple.baseline.compute_baseline_hash(manifest_path: str) -> str`:

1. Parse the manifest YAML.
2. Expand each `code[].path` glob; hash each resolved file's bytes via SHA-256.
3. Hash each dependency file (package.json, package-lock.json, requirements.txt, etc.).
4. Hash each service_unit file.
5. Resolve each `config.env` entry's current value (for `value:` entries) or handle (for `handle:` — do NOT dereference secret values).
6. If `attestation.provider != 'none'`, fetch a fresh attestation (via the appropriate fetcher; nonce = SHA-256 of the pubkey SPKI, not yet computed here — that comes from the signer keypair generated at install).
7. Canonicalize the aggregate into a single JSON blob per the format spec (below); return `sha256(canonical_bytes).hex()`.

**Canonical baseline blob format** (deterministic across runs of same content):

```json
{
  "manifest_hash_hex": "<sha256 of the manifest yaml canonicalized>",
  "code_files": [
    {"path": "<relative>", "sha256_hex": "<hex>"}
  ],
  "dep_files": [
    {"path": "<relative>", "sha256_hex": "<hex>"}
  ],
  "service_units": [
    {"path": "<absolute>", "sha256_hex": "<hex>"}
  ],
  "config_env": [
    {"name": "<key>", "value_or_handle": "<value or handle string>"}
  ],
  "attestation_provider": "<string>",
  "signer_pubkey_spki_sha256_hex": "<hex>"
}
```

All arrays sorted lexicographically by first field. `canonical.canonicalize(obj)` = compact JSON, sorted keys.

### 4. SEV-SNP fetcher

`scruple.attestation.amd_sev_snp.fetch(nonce_hex: str) -> AttestationEnvelope`:

1. Call `/dev/sev-guest` (via `sev-snp-measure` tool or ioctl wrapper) with `report_data` = 64 bytes where first 32 = bytes.fromhex(nonce_hex), rest zero.
2. Parse the returned AttestationReport bytes.
3. Fetch VCEK from local `/sys/kernel/config/tsm/report/<report_id>/certs` OR from `https://kdsintf.amd.com/vcek/v1/Genoa/<chip_id>`.
4. Construct envelope:

```python
AttestationEnvelope(
    attestation_type='amd-sev-snp',
    attestation_report=base64.b64encode(report_bytes).decode(),
    certificate_chain=[vcek_pem, ask_pem, ark_pem],
    nonce=nonce_hex,
    attestation_time=datetime.now(timezone.utc).isoformat(),
)
```

Cache within freshness window (default 15 min); refresh on expiry.

### 5. Client integration

`scruple.WitnessClient`:

```python
client = scruple.WitnessClient(
    api_base='https://witness.scruple.ai',
    tenant='ford',
    api_key=os.environ['SCRUPLE_API_KEY'],
    baseline_manifest_path='scruple-baseline.yaml',
)

# On construction:
# 1. Compute baseline hash
# 2. GET /baseline/current — compare to computed hash
# 3. If mismatch, raise BaselineDriftError (user resolves by calling
#    submit_baseline() or rebaseline())

# For each witness call, client:
# 1. Attaches X-Baseline-Hash header
# 2. If attestation.provider != 'none', fetches fresh envelope
#    via the appropriate fetcher, injects into request body
# 3. Sets nonce = sha256(canonical_leaf_preimage_without_envelope)

receipt = client.witness_iteration(
    project_id='p_123',
    workflow_hash='...',
    output_hash='...',
    model_fingerprints_hash='...',
    ...
)
```

Include `client.submit_baseline()` and `client.rebaseline(reason)` for install/re-install flows.

## Acceptance criteria

- [ ] `pytest packages/scruple-sdk-python/tests/` passes:
  - `test_baseline_hash.py`: fixture manifest + fixture files produces expected hash (byte-stable across two runs).
  - `test_envelope.py`: canonicalize is byte-stable; validator throws on malformed envelopes.
  - `test_sev_snp_fetch.py`: on SEV-SNP host, fetch returns a valid envelope with correct nonce; skipped otherwise.
- [ ] `pip install -e packages/scruple-sdk-python` works; `python -c "import scruple; print(scruple.__version__)"` prints 0.1.0.
- [ ] Manual smoke on the AI Council box: instantiate WitnessClient against a mock server; baseline drift detection works; witness call auto-injects envelope.

## Notes

- Do NOT hard-code the witness API URL. Config-driven so customers can point at their custom-deployment tenant instance.
- Cache the baseline hash after first computation; re-compute only on manifest change (mtime check).
- Errors should be actionable: on baseline drift, tell the customer exactly which files' hashes changed.

## Landing

One commit: `feat(sdk-python): baseline machinery + SEV-SNP fetcher + auto-inject`. Full package, tests, README with quickstart.
