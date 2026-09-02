// What the run committed to on the way IN — WO-30.
//
// ---------------------------------------------------------------------------
// THE FIELD THE REGULATOR ACTUALLY ASKS ABOUT
// ---------------------------------------------------------------------------
//
// `docs/canon/demo-readiness/training.md` §4 puts it plainly: a receipt showing
// a checkpoint's content hash with nothing else is a log line, and the question
// it invites — *what data was this trained on, and how do you know?* — is
// answered by `input_hash` and by nothing else on the leaf. Until this file
// existed, `job-runner.ts` set `inputHash` and `modelFingerprintsHash` to null
// with an honest comment saying the ingest path, not the component, establishes
// them.
//
// That comment was right about ATTRIBUTION and wrong about AVAILABILITY. The
// component is holding the dataset directory and the base-model file — they are
// mounted under roots it owns and `buildTrainerArgv` has already resolved and
// containment-checked both paths — so it can commit to the BYTES it is about to
// hand the trainer. That is a weaker claim than "Studio's upload path minted
// this id for these files", and it is the claim that can actually be made from
// here, so it is the one made: these are the bytes the trainer read.
//
// ---------------------------------------------------------------------------
// BOTH PREIMAGES ARE MIRRORS, NOT NEW RULES
// ---------------------------------------------------------------------------
//
// `packages/scruple-api/scruple_api/model_write.py` already defines
// `dataset_root_hash()` and `fingerprint_model_file()` in Python. This file is
// the TypeScript half of the same two rules, deliberately field-for-field, and
// `test/v2/training-receipt.test.ts` pins the shapes. Where a formula already
// exists in `lib/leaf/hashes.ts` it is IMPORTED — `hashModelFingerprints` and
// `hashRunInputs` are not re-implemented here, for that module's own reason:
// two implementations of a preimage are two preimages.
//
// THE DATASET PREIMAGE IS NOT IN `lib/leaf/registry.yaml`, and saying so is
// part of the deliverable rather than a caveat on it. The registry has no
// dataset field at all; where the commitment lands on the wire is `input_hash`,
// as a single `{kind: 'dataset', hash: root_hash}` entry. The reduction from a
// directory to that one hash is defined here and in `MODEL_WRITE_HOOK.md` §4,
// in prose, so a third party can reproduce it without reading this file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashModelFingerprints, hashRunInputs } from '../../../lib/leaf/hashes';
import { hashHeaderBytes, readSafetensorsHeader } from './safetensors';

/* ────────────────────────────────────────────────────────────────────────
 * The dataset
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A dataset directory reduced to one hash, plus what was left out.
 *
 * `skipped` IS NOT DIAGNOSTICS. A root hash that silently excluded symlinks
 * would be a commitment to a set of files nobody can enumerate from the hash,
 * and "we looked and found none" is a claim an unpopulated field must not
 * make — the rule `model_fingerprints_hash` already states in the registry.
 */
export interface DatasetCommitment {
  rootHash: string;
  fileCount: number;
  totalBytes: number;
  skipped: readonly string[];
  /** Only when asked for. A dataset of ten thousand captions is not something
   *  to carry around in memory by default. */
  manifest?: Readonly<Record<string, string>>;
}

const MAX_DATASET_FILES = 100_000;

function sha256File(abs: string): string {
  // Streamed in chunks rather than read whole: a dataset is images, and
  // `readFileSync` on a 4 GB video would be a different failure mode than the
  // one this function is for.
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Reduce a dataset directory to one re-derivable hash.
 *
 * PREIMAGE, stated so a verifier can reproduce it without this code:
 *
 *     manifest  = { posix relative path : sha256 hex of the file bytes }
 *                 for every REGULAR file under `root`, recursively
 *     preimage  = JSON of that manifest with keys sorted ascending,
 *                 no whitespace, non-ASCII left literal
 *     root_hash = sha256(preimage)
 *
 * The shape is deliberately `hashModelFingerprints`' shape — top-level keys
 * sorted, values verbatim — so a verifier learns one rule and applies it twice
 * rather than learning two.
 *
 * SYMLINKS ARE NOT FOLLOWED and are reported in `skipped`. Following them would
 * make the hash depend on something outside the directory being committed to,
 * and a dataset that hashes differently depending on what a link happens to
 * point at today is not a commitment.
 */
export function datasetRootHash(
  root: string,
  opts: { keepManifest?: boolean } = {},
): DatasetCommitment {
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error(`datasetRootHash(): '${root}' does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`datasetRootHash(): '${root}' is not a directory`);

  const manifest: Record<string, string> = {};
  const skipped: string[] = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Sorted so the WALK is deterministic too. The preimage sorts anyway, but
    // `skipped` is an ordered list on the receipt and an unstable order there
    // would make two identical datasets produce two different-looking reports.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) {
        skipped.push(e.isDirectory() ? `${rel}/` : rel);
        continue;
      }
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) {
        skipped.push(rel);
        continue;
      }
      if (Object.keys(manifest).length >= MAX_DATASET_FILES) {
        throw new Error(
          `datasetRootHash(): more than ${MAX_DATASET_FILES} files under '${root}'. Refusing ` +
            'rather than hashing an unbounded tree inside a request path.',
        );
      }
      try {
        manifest[rel] = sha256File(abs);
        totalBytes += fs.statSync(abs).size;
      } catch (err) {
        // Recorded, not dropped. A file the walk could see and could not read
        // is exactly the kind of hole that must not close silently.
        skipped.push(`${rel} (UNREADABLE: ${String(err)})`);
      }
    }
  };
  walk(root);

  return {
    rootHash: stringifySortedToplevelHash(manifest),
    fileCount: Object.keys(manifest).length,
    totalBytes,
    skipped: Object.freeze(skipped),
    ...(opts.keepManifest ? { manifest: Object.freeze({ ...manifest }) } : {}),
  };
}

/** `JSON.stringify` over top-level-sorted keys, hashed. The Python mirror is
 *  `_stringify_sorted_toplevel`. */
function stringifySortedToplevelHash(mapping: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(mapping).sort()) ordered[k] = mapping[k];
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * `input_hash` for a training run: one dataset commitment, in the shape
 * `hashRunInputs` already defines.
 *
 * `provider`, `prompt` and `spec` are null and they are HONESTLY null here
 * rather than null-because-zero-content: a training run had no provider and no
 * prompt. Same formula as the canvas path, same preimage, one call site.
 */
export function trainingInputHash(datasetRoot: string): string {
  return hashRunInputs({
    provider: null,
    prompt: null,
    spec: null,
    inputs: [{ kind: 'dataset', hash: datasetRoot }],
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * The base model
 * ──────────────────────────────────────────────────────────────────────── */

/** One base-model file, in the shape `model_fingerprints` expects.
 *
 *  A TYPE ALIAS, NOT AN INTERFACE, and the difference is load-bearing rather
 *  than stylistic: TypeScript gives an alias an implicit index signature and an
 *  interface none, so only the alias is assignable to the
 *  `Record<string, ModelFingerprint>` that `hashModelFingerprints` takes.
 *  Declaring it as an interface compiles everywhere except the one call that
 *  matters.
 *
 *  KEY ORDER MATTERS AND IS FIXED HERE, because `hashModelFingerprints` sorts
 *  only the TOP-LEVEL keys and leaves these nested objects in their original
 *  order (`lib/leaf/hashes.ts` — "DO NOT tidy these"). Two callers building
 *  this object in two orders would produce two hashes for identical weights. */
export type ModelFileFingerprint = {
  content_hash: string;
  header_hash: string | null;
  header_size: number | null;
  bytes: number;
};

export function fingerprintModelFile(abs: string): ModelFileFingerprint {
  const header = readSafetensorsHeader(abs);
  return {
    content_hash: sha256File(abs),
    header_hash: header ? hashHeaderBytes(header) : null,
    header_size: header ? header.raw.length : null,
    bytes: fs.statSync(abs).size,
  };
}

export interface BaseModelCommitment {
  /** `{ relPath: fingerprint }` — the manifest, sent so the leaf's stored copy
   *  says WHICH weights, not merely that some were enumerated. */
  manifest: Record<string, ModelFileFingerprint>;
  /** `model_fingerprints_hash`, via `lib/leaf/hashes.ts`. */
  hash: string;
}

/**
 * Fingerprint the one base-model file this run loaded.
 *
 * Note what `header_hash` does here, because it is the ONLY place in the whole
 * leaf where a header hash currently has a home: it rides INSIDE this manifest,
 * for the model the run READ. The checkpoint the run WROTE has no such home —
 * `lib/leaf/registry.yaml` has no `header_hash` field and the /v2 Zod body has
 * none either, so the written checkpoint's structural fingerprint travels
 * uncovered on `capture.header_hash` and is not in the MAC preimage. That is
 * `MODEL_WRITE_HOOK.md` §4.2's finding, restated at the one place a reader
 * would otherwise assume symmetry.
 */
export function baseModelCommitment(
  absPath: string,
  relPath: string,
): BaseModelCommitment | null {
  if (!fs.existsSync(absPath)) return null;
  const manifest = { [relPath]: fingerprintModelFile(absPath) };
  const hashed = hashModelFingerprints(manifest);
  if (!hashed) return null;
  return { manifest, hash: hashed.hash };
}
