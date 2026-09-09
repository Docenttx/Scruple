// THE VAULT MANIFEST — what replaces the merkle root, and why it is not one.
//
// The legacy vault ended with:
//
//     const merkleRoot = buildMerkleRoot(fileHashes);   // sorted-pair
//     const scrId = 'SCR_' + merkleRoot.substring(0, 6).toUpperCase();
//
// docs/DESIGN.md retires that construction outright: "`lock/merkle.js`: the
// sorted-pair construction, retired by the WO-C6 cutover. IT CANNOT BIND AN
// INDEX." The estate agrees loudly — `lib/leaf/attestationBasis.ts` records
// three live Merkle constructions that do not agree, a witness that anchors
// whichever root the caller supplies, and a second-preimage weakness
// (CVE-2012-2459) in the survivor. Building a fourth here would be the worst
// available option.
//
// SO THE SET IS BOUND BY A DOCUMENT, NOT BY A TREE.
//
// The manifest is a canonical JSON document listing every entry in a defined
// order, each with its index, its outcome and its three-state measurements.
// Its sha256 is the vault digest. That binds the index — position is written
// down rather than implied by tree geometry — and it is recomputable by anyone
// holding the directory, with `canonicalize()` from lib/leaf/canonicalJson.ts,
// which is the same canonicalization the leaf preimage uses (`jcs-2`). No
// second implementation, no domain-separation question, no ordering question.
//
// What it costs: no inclusion proofs. You cannot hand a third party one file
// and a short path. You hand them the manifest, which is a few kilobytes.
// For a vault — a directory somebody is claiming as a unit — that is the right
// trade, and it is the honest one while no two parties in this estate agree on
// what a root is.
//
// THE MANIFEST IS ITSELF WITNESSED. That is what makes a refusal "a recorded
// outcome" rather than a line in a log: the refusals are IN this document, the
// document's bytes are on disk, and its content hash is on a leaf. A verifier
// re-hashes the manifest, reads the refusals, and can check every accepted
// file's hash against its own leaf.

import crypto from 'node:crypto';

import { canonicalize, CANONICALIZATION_PROFILE } from './sdk';
import type { VaultEntry, VaultObservationReport } from './vaultSurface';

export const MANIFEST_VERSION = 'scruple-vault-manifest/v1';

export interface VaultManifest {
  manifest_version: string;
  /** The canonicalization the digest below is taken over. Named, so a
   *  recomputation cannot silently use a different one. */
  canonicalization_profile: string;
  vault_id: string;
  vault_path: string;
  observed_at: string;
  ceiling_bytes: number;
  declared_by: string;
  declaration: { filename: string; content_hash: string | null; state: string; reason: string | null };
  counts: Record<string, number>;
  /** ORDERED, and each row carries its own index. This is the "bind an index"
   *  the sorted-pair construction could not do. */
  entries: Array<{
    index: number;
    path: string;
    outcome: string;
    mime: { state: string; value: string | null; source: string; reason: string | null };
    content_hash: { state: string; value: string | null; source: string; reason: string | null };
    bytes_counted: { state: string; value: number | null; source: string; reason: string | null };
    stat_size: { state: string; value: number | null; source: string; reason: string | null };
    note: string | null;
  }>;
  declared_but_absent: string[];
  skipped: string[];
}

export interface BuiltManifest {
  manifest: VaultManifest;
  /** The exact bytes written to disk. The digest is over THESE. */
  bytes: Buffer;
  /** sha256 of `bytes`. The vault digest. */
  digest: string;
}

function tally(entries: VaultEntry[]): Record<string, number> {
  // EVERY OUTCOME GETS A KEY, INCLUDING THE ZEROES. An absent key is a fact
  // nobody reads: a manifest with no `refused_over_ceiling` line reads as a
  // vault where nothing was too big AND as a vault produced by a build that
  // did not have a ceiling, and those are different claims.
  const counts: Record<string, number> = {
    files: entries.length,
    captured: 0,
    refused_mime_undeclared: 0,
    refused_mime_declared_absent: 0,
    refused_over_ceiling: 0,
    refused_unreadable: 0,
  };
  for (const e of entries) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  return counts;
}

export function buildManifest(report: VaultObservationReport): BuiltManifest {
  const manifest: VaultManifest = {
    manifest_version: MANIFEST_VERSION,
    canonicalization_profile: CANONICALIZATION_PROFILE,
    vault_id: report.vaultId,
    vault_path: report.vaultDir,
    observed_at: report.observedAt,
    ceiling_bytes: report.ceilingBytes,
    declared_by: report.declaredBy,
    declaration: {
      filename: 'scruple-vault.json',
      content_hash: report.declarationHash.value,
      state: report.declarationHash.state,
      reason: report.declarationHash.reason,
    },
    counts: tally(report.entries),
    entries: report.entries.map((e, index) => ({
      index,
      path: e.path,
      outcome: e.outcome,
      mime: { state: e.mime.state, value: e.mime.value, source: e.mime.source, reason: e.mime.reason },
      content_hash: {
        state: e.contentHash.state, value: e.contentHash.value,
        source: e.contentHash.source, reason: e.contentHash.reason,
      },
      bytes_counted: {
        state: e.bytesCounted.state, value: e.bytesCounted.value,
        source: e.bytesCounted.source, reason: e.bytesCounted.reason,
      },
      stat_size: {
        state: e.statSize.state, value: e.statSize.value,
        source: e.statSize.source, reason: e.statSize.reason,
      },
      note: e.note,
    })),
    declared_but_absent: report.declaredButAbsent,
    skipped: report.skippedDirectories,
  };

  // canonicalize(), not JSON.stringify(). The whole value of the digest is
  // that a second party recomputes it and agrees, and `JSON.stringify` is the
  // defect WO-66 filed against `input_hash`: V8 and Python do not order or
  // escape identically, and a mismatch READS AS TAMPERING.
  const bytes = Buffer.from(canonicalize(manifest), 'utf8');
  return { manifest, bytes, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}
