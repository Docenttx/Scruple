#!/usr/bin/env node
// scruple-verify — reference verifier CLI for the Scruple witness chain.
//
// Sprint 1 shape: `leaf` subcommand only. `c2pa` + `trust-manifest` land
// under WO-08 + WO-09 completion respectively.
//
// Usage:
//   scruple-verify leaf --witness <url> --stream <name> --seq <n>
//   scruple-verify leaf --proof <path/to/proof.json> --trust-manifest <url|path>
//
// Exits 0 on VALID, 1 on any verification failure. Prints human summary
// by default; --json emits a structured verdict.

import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { leafHashV23 } from './core/canonicalLeafV23.mjs';
import { canonicalCheckpointV1 } from './core/canonicalCheckpointV1.mjs';
import { rootFromInclusion } from './core/merkle.mjs';

function usage(exitCode = 2) {
  console.error(`scruple-verify — reference verifier for the Scruple witness

Usage:
  scruple-verify leaf --witness <url> --stream <name> --seq <n>
      Fetch and verify a leaf's inclusion proof end-to-end.

  scruple-verify leaf --proof <file.json> [--trust-manifest <url|path>]
      Verify an on-disk proof bundle. --trust-manifest defaults to the
      witness_url derived from the proof, or SCRUPLE_TRUST_MANIFEST_URL.

  scruple-verify baseline --receipt <url|path> [--history <url|path>]
      Verify baseline chain integrity: the receipt's baseline_hash is
      in the tenant's chain and each prev_baseline_hash link is valid
      back to genesis.

  scruple-verify attestation --receipt <url|path>
      Re-verify every platform_attestation envelope on the receipt
      via the same shared verifier plugins the server uses (SEV-SNP,
      NVIDIA H100 CC, AWS Nitro, Azure MAA, Intel TDX, TPM 2.0).
      Passthrough attestations are reported with their verifier_reference
      URL and NOT counted as failure — see Standard §15.4.

  scruple-verify full --receipt <url|path>
      Runs baseline + attestation in sequence. Overall verdict is
      VALID only if both pass.

Common flags:
  --json          Emit structured verdict on stdout.
  --quiet         Print only PASS/FAIL.

Exit codes:
  0  All checks passed.
  1  One or more verification steps failed.
  2  Usage error.
`);
  process.exit(exitCode);
}

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  return process.argv[i + 1];
}

function argFlag(name) {
  return process.argv.includes(name);
}

async function fetchOrRead(source) {
  // If it looks like a URL, fetch; otherwise treat as filesystem path.
  if (/^https?:\/\//.test(source) || source.startsWith('http://localhost')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source} → HTTP ${res.status}`);
    return await res.json();
  }
  const text = await readFile(source, 'utf-8');
  return JSON.parse(text);
}

async function loadProof({ witness, stream, seq, proofPath }) {
  if (proofPath) {
    return { proof: await fetchOrRead(proofPath), source: proofPath };
  }
  if (!witness || !stream || !seq) usage();
  const url = `${witness.replace(/\/+$/, '')}/api/v1/proof/leaf/${encodeURIComponent(stream)}/${encodeURIComponent(seq)}`;
  return { proof: await fetchOrRead(url), source: url };
}

async function loadTrustManifest(explicit, witnessUrl) {
  const src =
    explicit ??
    process.env.SCRUPLE_TRUST_MANIFEST_URL ??
    (witnessUrl ? `${witnessUrl.replace(/\/+$/, '')}/.well-known/witness-trust.json` : null);
  if (!src) throw new Error('no trust manifest source (pass --trust-manifest or SCRUPLE_TRUST_MANIFEST_URL)');
  return { manifest: await fetchOrRead(src), source: src };
}

function findCheckpointKey(manifest, keyId) {
  const key = (manifest.checkpoint_keys ?? []).find((k) => k.key_id === keyId);
  if (!key) throw new Error(`trust manifest has no key_id ${keyId}`);
  if (key.deprecated_at) {
    // Deprecation isn't fatal for verifying old signatures, just a warning.
    process.stderr.write(`  warn — key ${keyId} was deprecated at ${key.deprecated_at}\n`);
  }
  return key;
}

function verifyLeafSubcommand() {
  const witness = argVal('--witness');
  const stream = argVal('--stream');
  const seq = argVal('--seq');
  const proofPath = argVal('--proof');
  const trustManifestSrc = argVal('--trust-manifest');
  const json = argFlag('--json');
  const quiet = argFlag('--quiet');

  return { witness, stream, seq, proofPath, trustManifestSrc, json, quiet };
}

async function verifyLeaf() {
  const {
    witness, stream, seq, proofPath, trustManifestSrc, json, quiet,
  } = verifyLeafSubcommand();

  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    if (!quiet && !json) {
      const mark = ok ? 'ok  ' : 'FAIL';
      console.log(`  ${mark} — ${name}${detail ? '  ' + detail : ''}`);
    }
  };

  let overall = true;

  try {
    const { proof, source: proofSource } = await loadProof({ witness, stream, seq, proofPath });
    if (!quiet && !json) console.log(`\nProof source: ${proofSource}`);

    if (!proof.leaf || !proof.inclusion || !proof.checkpoint) {
      record('proof bundle has all required sections', false, JSON.stringify(Object.keys(proof)));
      throw new Error('malformed proof');
    }
    record('proof bundle has all required sections', true);

    // 1. Recompute leaf_hash from canonical leaf fields.
    const recomputedLeafHash = leafHashV23({
      tenant_id: proof.leaf.tenant_id,
      principal_id: proof.leaf.principal_id ?? '',
      stream_id: proof.leaf.stream_id,
      tenant_seq: proof.leaf.tenant_seq,
      event_time: proof.leaf.event_time,
      payload_hash: proof.leaf.payload_hash,
      dims: proof.leaf.dims ?? {},
    });
    const claimedLeafHash = String(proof.leaf.leaf_hash).replace(/^sha256:/, '');
    const leafOk = recomputedLeafHash === claimedLeafHash;
    record('leaf_hash re-derives from canonical fields', leafOk,
      leafOk ? undefined : `  expected ${claimedLeafHash}, got ${recomputedLeafHash}`);
    if (!leafOk) overall = false;

    // 2. Walk the inclusion proof up to a Merkle root.
    const reconstructedRoot = rootFromInclusion(recomputedLeafHash, proof.inclusion);
    const rootOk = reconstructedRoot === proof.checkpoint.bundle.merkle_root;
    record('inclusion path recomputes to checkpoint merkle_root', rootOk,
      rootOk ? undefined : `  expected ${proof.checkpoint.bundle.merkle_root}, got ${reconstructedRoot}`);
    if (!rootOk) overall = false;

    // 3. Verify Ed25519 signature over the canonical checkpoint bundle,
    //    using the pubkey from the trust manifest for this witness_key_id.
    const { manifest } = await loadTrustManifest(trustManifestSrc, witness);
    const key = findCheckpointKey(manifest, proof.checkpoint.witness_key_id);
    if (key.alg !== 'ED25519' && key.alg !== 'Ed25519') {
      record(`checkpoint key alg supported`, false, `  got ${key.alg}, only ED25519 in v0.1`);
      overall = false;
    } else {
      const bundleBytes = canonicalCheckpointV1(proof.checkpoint.bundle);
      const pubKey = createPublicKey(key.public_key_pem);
      const sigBytes = Buffer.from(proof.checkpoint.witness_sig, 'hex');
      const sigOk = nodeVerify(null, bundleBytes, pubKey, sigBytes);
      record('checkpoint signature verifies against trust manifest', sigOk);
      if (!sigOk) overall = false;
    }

    // 4. Anchor step — Sprint 1 skips (WO-12 wires anchor verification).
    if (proof.anchor && proof.anchor.rvn_txid) {
      record('anchor RVN txid verification', false, '  not implemented in v0.1');
    } else {
      record('anchor step (deferred until WO-12 super-root anchoring)', true, '  skipped');
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
    console.log(`\nVerdict: ${overall ? 'VALID' : 'INVALID'}`);
  }
  process.exit(overall ? 0 : 1);
}

const subcommand = process.argv[2];
if (subcommand === 'leaf') {
  await verifyLeaf();
} else if (subcommand === 'baseline') {
  const { verifyBaseline } = await import('./baseline_verify.mjs');
  const ok = await verifyBaseline({
    receiptSource: argVal('--receipt'),
    historySource: argVal('--history'),
    json: argFlag('--json'),
    quiet: argFlag('--quiet'),
  });
  process.exit(ok ? 0 : 1);
} else if (subcommand === 'attestation') {
  const { verifyAttestations } = await import('./attestation_verify.mjs');
  const ok = await verifyAttestations({
    receiptSource: argVal('--receipt'),
    json: argFlag('--json'),
    quiet: argFlag('--quiet'),
  });
  process.exit(ok ? 0 : 1);
} else if (subcommand === 'full') {
  // Run leaf + baseline + attestation in sequence; overall verdict.
  const receipt = argVal('--receipt');
  const { verifyBaseline } = await import('./baseline_verify.mjs');
  const { verifyAttestations } = await import('./attestation_verify.mjs');
  const bOk = await verifyBaseline({ receiptSource: receipt, json: false, quiet: false });
  const aOk = await verifyAttestations({ receiptSource: receipt, json: false, quiet: false });
  console.log(`\nOverall: ${bOk && aOk ? 'VALID' : 'INVALID'}`);
  process.exit(bOk && aOk ? 0 : 1);
} else if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
  usage(0);
} else {
  console.error(`unknown subcommand: ${subcommand}`);
  usage();
}
