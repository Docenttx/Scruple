// scruple-verify attestation — re-verify platform_attestation envelopes
// on a receipt using the shared @scruple/attestation-verifiers library.
//
// Imports the compiled JS from packages/scruple-attestation-verifiers/dist/
// (same code the server uses at ingest — no drift possible).

import { readFile } from 'node:fs/promises';

async function fetchOrRead(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source} → HTTP ${res.status}`);
    return await res.json();
  }
  const text = await readFile(source, 'utf-8');
  return JSON.parse(text);
}

async function loadShared() {
  // Import the built shared verifier library. Registers all plugins
  // via all_verifiers.js side-effect module.
  await import('../../scruple-attestation-verifiers/dist/plugins/all_verifiers.js');
  return await import('../../scruple-attestation-verifiers/dist/dispatch.js');
}

export async function verifyAttestations({ receiptSource, json, quiet }) {
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    if (!quiet && !json) {
      const mark = ok ? 'ok  ' : (detail === 'passthrough' ? 'note' : 'FAIL');
      console.log(`  ${mark} — ${name}${detail ? '  ' + detail : ''}`);
    }
  };

  let overall = true;

  try {
    if (!receiptSource) {
      throw new Error('receipt source required (--receipt <url|path>)');
    }
    const receipt = await fetchOrRead(receiptSource);
    const { dispatch } = await loadShared();

    // Receipts may contain a single envelope or a list of leaves each
    // with an envelope. Handle both shapes.
    const envelopes = [];
    if (receipt.platform_attestation) {
      envelopes.push({
        envelope: receipt.platform_attestation,
        expected_nonce_hex: receipt.expected_nonce_hex ?? receipt.leaf?.expected_nonce_hex,
        label: 'receipt.platform_attestation',
      });
    }
    if (Array.isArray(receipt.leaves)) {
      for (const leaf of receipt.leaves) {
        if (leaf.platform_attestation) {
          envelopes.push({
            envelope: leaf.platform_attestation,
            expected_nonce_hex: leaf.expected_nonce_hex,
            label: `leaf ${leaf.tenant_seq ?? '?'}`,
          });
        }
      }
    }

    if (envelopes.length === 0) {
      record('receipt has any platform_attestation envelopes', false, '0 found');
      throw new Error('no attestations to verify');
    }
    record(`envelopes found`, true, String(envelopes.length));

    for (const { envelope, expected_nonce_hex, label } of envelopes) {
      if (!expected_nonce_hex) {
        record(`${label} — expected_nonce_hex present in receipt`, false);
        overall = false;
        continue;
      }
      const result = await dispatch(envelope, expected_nonce_hex, 15 * 60);
      if (result.passthrough) {
        record(
          `${label} → passthrough`,
          true,
          `attestation_type=${envelope.attestation_type}, see ${result.verifier_reference}`,
        );
      } else if (result.ok) {
        record(`${label} → verified (${result.provider})`, true, JSON.stringify({
          cvm_measurement_hex: result.cvm_measurement_hex,
          chip_id: result.chip_id?.slice(0, 16) + '...',
          gpu_id: result.gpu_id,
          benign_codes: result.benign_codes,
        }));
      } else {
        record(`${label} → ${result.provider ?? envelope.attestation_type}`, false, result.error);
        overall = false;
      }
    }
  } catch (e) {
    record('verifier ran without unexpected errors', false, `  ${e.message}`);
    overall = false;
  }

  if (json) {
    console.log(JSON.stringify({ verdict: overall ? 'VALID' : 'INVALID', steps }, null, 2));
  } else if (quiet) {
    console.log(overall ? 'PASS' : 'FAIL');
  } else {
    console.log(`\nAttestation verdict: ${overall ? 'VALID' : 'INVALID'}`);
  }
  return overall;
}
