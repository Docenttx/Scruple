// MODEL FINGERPRINTS, FROM THE LOCAL MODEL STORE.
//
// docs/DESIGN.md names this as one of the four things that genuinely require
// being on the user's machine: the desktop "computes model fingerprints from
// the local model store, which is the only way to answer *was a proprietary
// LoRA used* rather than *a file with that name was referenced*."
//
// WO-D4: `modal/scruple_runner.py` already does this — `_fingerprint_file`,
// `_hash_workflow_models`, `_safetensors_header_hash` — "the code exists, it
// just needs somewhere to stand." This is that somewhere. The construction is
// carried across unchanged where it was right, and THREE THINGS ARE REPLACED,
// each of which is the same defect the vault work closed one layer down.
//
//   1. A MISSING FILE IS NOT DROPPED.
//      The Python ends `_hash_workflow_models` with `if fp is not None:` — a
//      model the workflow named and the store does not hold simply vanishes
//      from the manifest. A run that loaded no LoRA and a run whose LoRA was
//      deleted before we looked then produce the SAME record. Here a
//      reference that cannot be measured is an entry whose `state` says why:
//      `absent` when the store genuinely does not hold it, `indeterminate`
//      when we could not finish reading it. Three states, as in
//      app/vault/measurement.ts, and never folded together.
//
//   2. AN UNBOUNDED READ BECOMES A COUNTED ONE.
//      `fh.read(1 << 20)` in a loop is already chunked, but nothing stops and
//      nothing counts: a file that grew under the read is indistinguishable
//      from one that was always that size. app/vault/countedRead.ts is reused
//      verbatim — one implementation of "hash what actually arrived, stop at
//      a ceiling, and record the count either way".
//
//   3. THE SEARCH FALLBACK IS RECORDED, NOT SILENT.
//      The Python probes eleven subdirectories for any input string ending in
//      a model extension and, on a hit, records the reference as though the
//      loader registry had produced it. That capability is real — custom
//      nodes use idiosyncratic field names — but a reference RESOLVED BY
//      GUESSING WHERE THE FILE LIVES is not the same fact as one resolved by
//      a registered loader, and the manifest now says which happened. A
//      reference that resolves neither way is `unresolved` and still gets an
//      entry.
//
// WHAT A FINGERPRINT IS AND IS NOT
// ---------------------------------------------------------------------------
// It is: the sha256 of the bytes at the path the workflow named, read from
// this machine's store, plus the safetensors header digest, which identifies
// the tensor names and shapes without the weights.
//
// It is NOT a hook inside the loader. Nothing here observes ComfyUI mmap the
// file; it observes the file. The interval between the two is real and is
// recorded rather than argued away — `app/comfy/modelSink.ts` carries the
// timestamps, and docs/STATE.md is where the residual gap is written down.
//
// ⚑ NOTHING TIME-VARYING GOES IN THE MANIFEST. `mtime` is in the Python's
// record and `lib/leaf/hashes.ts` strips it back out with the argument in
// full: "identical model weights on a different volume replica, or after a
// remount, therefore produced a DIFFERENT model_fingerprints_hash. One of the
// five headline hashes was not recomputable by anyone holding the model."
// So it is not put in. Neither is the time we looked. Every field below is a
// property of the bytes or of the reference, so a third party holding the
// store and the workflow recomputes the digest exactly.

import fs from 'node:fs';
import path from 'node:path';

import { countedHash } from '../vault/countedRead';

/**
 * Loader class → (field(s), subdirectory under the model root).
 *
 * Carried across from `modal/scruple_runner.py`'s MODEL_LOADERS verbatim,
 * including the comment it carries about `clip` having been renamed
 * `text_encoders`. A second, drifting copy of this table would mean two
 * answers to "which node names a model", so if it moves anywhere it should
 * move into the SDK and be imported by both.
 */
export const MODEL_LOADERS: Record<string, { fields: readonly string[]; subdir: string }> = {
  CheckpointLoaderSimple:    { fields: ['ckpt_name'],        subdir: 'checkpoints' },
  CheckpointLoader:          { fields: ['ckpt_name'],        subdir: 'checkpoints' },
  ImageOnlyCheckpointLoader: { fields: ['ckpt_name'],        subdir: 'checkpoints' },
  unCLIPCheckpointLoader:    { fields: ['ckpt_name'],        subdir: 'checkpoints' },
  LoraLoader:                { fields: ['lora_name'],        subdir: 'loras' },
  LoraLoaderModelOnly:       { fields: ['lora_name'],        subdir: 'loras' },
  VAELoader:                 { fields: ['vae_name'],         subdir: 'vae' },
  UNETLoader:                { fields: ['unet_name'],        subdir: 'unet' },
  CLIPLoader:                { fields: ['clip_name'],        subdir: 'text_encoders' },
  DualCLIPLoader:            { fields: ['clip_name1', 'clip_name2'], subdir: 'text_encoders' },
  TripleCLIPLoader:          { fields: ['clip_name1', 'clip_name2', 'clip_name3'], subdir: 'text_encoders' },
  ControlNetLoader:          { fields: ['control_net_name'], subdir: 'controlnet' },
  StyleModelLoader:          { fields: ['style_model_name'], subdir: 'style_models' },
  GLIGENLoader:              { fields: ['gligen_name'],      subdir: 'gligen' },
  UpscaleModelLoader:        { fields: ['model_name'],       subdir: 'upscale_models' },
};

/** The extensions the search fallback will consider. Same list as the Python. */
export const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.bin', '.gguf', '.pth'] as const;

/** The subdirectories the search fallback probes, in order. Same as the Python. */
export const SEARCH_SUBDIRS = [
  'checkpoints', 'loras', 'vae', 'text_encoders', 'clip', 'unet', 'controlnet',
  'style_models', 'upscale_models', 'gligen', 'diffusion_models',
] as const;

/**
 * 8 GiB. A configuration value said out loud rather than buried, exactly as
 * DEFAULT_CEILING_BYTES is in app/vault/vaultSurface.ts — except that a vault
 * holds documents and a model store holds weights, so the right number is
 * three orders of magnitude apart and a shared constant would be wrong for
 * one of them.
 */
export const DEFAULT_MODEL_CEILING_BYTES = 8 * 1024 * 1024 * 1024;

export type ReferenceResolution = 'loader-registry' | 'store-search' | 'unresolved';

export interface ModelReference {
  /** `<subdir>/<filename>` relative to the model root — the same key
   *  `_hash_workflow_models` uses, so a manifest from the desktop and one from
   *  the Modal runner are comparable key for key. */
  key: string;
  /** Verbatim from the workflow. What the NAME said, kept beside what the
   *  BYTES said, because the whole claim is that those are different facts. */
  declaredName: string;
  nodeId: string;
  classType: string;
  field: string;
  resolution: ReferenceResolution;
}

/** One manifest entry. Every value is a property of the bytes or of the
 *  reference; see the header on why nothing time-varying may appear here. */
export interface ModelFingerprint extends Record<string, unknown> {
  /** measured · absent · indeterminate. Present on EVERY entry, including the
   *  measured ones, so a reader never has to infer the state from a null. */
  state: 'measured' | 'absent' | 'indeterminate';
  resolution: ReferenceResolution;
  declared_name: string;
  node_id: string;
  class_type: string;
  content_hash: string | null;
  /** sha256 of the safetensors header — the tensor names and shapes, without
   *  the weights. null for a file that is not safetensors, which is a fact
   *  about the format and not a failure. */
  header_hash: string | null;
  header_size: number | null;
  /** Bytes THIS PROCESS COUNTED, never stat's claim. Null when nothing was
   *  read at all. */
  bytes: number | null;
  /** Why, when `state` is not `measured`. Null when it is. */
  reason: string | null;
}

export interface ModelStoreReport {
  modelRoot: string;
  ceilingBytes: number;
  references: ModelReference[];
  /** The manifest, keyed and ready for `hashModelFingerprints`. */
  fingerprints: Record<string, ModelFingerprint>;
  /** When the store was read. OUTSIDE the manifest on purpose — see the
   *  header. This is the desktop's own record of the interval, and it never
   *  enters the digest. */
  readStartedAt: string;
  readFinishedAt: string;
}

/**
 * (header_hash, header_size) for a safetensors file: the first 8 bytes are a
 * little-endian header length, followed by that many bytes of header JSON.
 *
 * Ported from `_safetensors_header_hash`, including its 100 MiB sanity bound
 * on the declared length — an 8-byte field read from an untrusted file will
 * happily claim to be 2^64 bytes long.
 */
export async function safetensorsHeaderHash(
  p: string,
): Promise<{ headerHash: string | null; headerSize: number | null }> {
  const none = { headerHash: null, headerSize: null };
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const len = Buffer.alloc(8);
    const { bytesRead } = await fh.read(len, 0, 8, 0);
    if (bytesRead !== 8) return none;
    const headerLen = Number(len.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > 100 * 1024 * 1024) return none;
    const header = Buffer.alloc(headerLen);
    const got = await fh.read(header, 0, headerLen, 8);
    if (got.bytesRead !== headerLen) return none;
    const { createHash } = await import('node:crypto');
    return { headerHash: createHash('sha256').update(header).digest('hex'), headerSize: headerLen };
  } catch {
    return none;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ComfyUI accepts the bare node map and `{prompt: {...}}`; the gate tees
 *  whichever the tenant sent, so both are unwrapped here. */
function nodesOf(graph: unknown): Record<string, unknown> {
  if (!isRecord(graph)) return {};
  const inner = graph.prompt;
  if (isRecord(inner)) return inner;
  return graph;
}

/**
 * Every model file this workflow names, with HOW each reference was resolved.
 *
 * The registry runs first and wins. The search fallback only sees values the
 * registry did not already claim, and a value it cannot place under any known
 * subdirectory is returned as `unresolved` rather than dropped — a reference
 * we could not locate is a fact about this store, and the Python's version of
 * this loop makes it look like a workflow that named nothing.
 */
export function referencedModels(graph: unknown, modelRoot: string): ModelReference[] {
  const byKey = new Map<string, ModelReference>();
  const add = (r: ModelReference) => {
    if (!byKey.has(r.key)) byKey.set(r.key, r);
  };

  for (const [nodeId, node] of Object.entries(nodesOf(graph))) {
    if (!isRecord(node)) continue;
    const classType = typeof node.class_type === 'string' ? node.class_type : '';
    const inputs = isRecord(node.inputs) ? node.inputs : {};
    const spec = MODEL_LOADERS[classType];
    if (spec) {
      for (const f of spec.fields) {
        const v = inputs[f];
        if (typeof v === 'string' && v !== '' && v !== 'None') {
          add({
            key: `${spec.subdir}/${v}`, declaredName: v, nodeId, classType, field: f,
            resolution: 'loader-registry',
          });
        }
      }
    }
  }

  // The fallback, over what the registry did not claim.
  const claimed = new Set([...byKey.values()].map((r) => r.declaredName));
  for (const [nodeId, node] of Object.entries(nodesOf(graph))) {
    if (!isRecord(node)) continue;
    const classType = typeof node.class_type === 'string' ? node.class_type : '';
    const inputs = isRecord(node.inputs) ? node.inputs : {};
    for (const [field, v] of Object.entries(inputs)) {
      if (typeof v !== 'string' || v === '') continue;
      if (!MODEL_EXTS.some((e) => v.toLowerCase().endsWith(e))) continue;
      if (claimed.has(v)) continue;
      let placed = false;
      for (const subdir of SEARCH_SUBDIRS) {
        let st: fs.Stats;
        try { st = fs.statSync(path.join(modelRoot, subdir, v)); } catch { continue; }
        if (!st.isFile()) continue;
        add({ key: `${subdir}/${v}`, declaredName: v, nodeId, classType, field, resolution: 'store-search' });
        placed = true;
        break;
      }
      if (!placed) {
        // No subdirectory holds it. The reference is recorded under the name
        // the workflow used, because that is all that is known about it, and
        // `unresolved` says so rather than a null that could mean anything.
        add({ key: `?/${v}`, declaredName: v, nodeId, classType, field, resolution: 'unresolved' });
      }
    }
  }

  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Fingerprint ONE reference. A refusal is a return value, never a throw and
 *  never a skip — the same rule app/vault/vaultSurface.ts follows. */
export async function fingerprintOne(
  ref: ModelReference,
  modelRoot: string,
  ceilingBytes: number,
): Promise<ModelFingerprint> {
  const base = {
    resolution: ref.resolution,
    declared_name: ref.declaredName,
    node_id: ref.nodeId,
    class_type: ref.classType,
    content_hash: null,
    header_hash: null,
    header_size: null,
    bytes: null,
  };

  if (ref.resolution === 'unresolved') {
    return {
      ...base, state: 'absent',
      reason: `the workflow names ${ref.declaredName} and no subdirectory of the model store holds it`,
    };
  }

  const abs = path.join(modelRoot, ref.key);
  try {
    if (!fs.statSync(abs).isFile()) {
      return { ...base, state: 'absent', reason: `${ref.key} is not a regular file` };
    }
  } catch (e) {
    const code = String((e as NodeJS.ErrnoException).code ?? e);
    return {
      ...base,
      // ENOENT is the entitled answer "the store does not hold this" — absent.
      // Anything else is a look that could not be completed — indeterminate.
      state: code === 'ENOENT' ? 'absent' : 'indeterminate',
      reason: `stat ${ref.key}: ${code}`,
    };
  }

  const read = await countedHash(abs, ceilingBytes);
  if (read.outcome !== 'read') {
    return {
      ...base, state: 'indeterminate',
      // THE COUNT SURVIVES THE REFUSAL, as it does in the vault: it is the
      // whole difference between "over the ceiling" and "skipped".
      bytes: read.bytesCounted,
      reason: read.reason ?? read.outcome,
    };
  }

  const { headerHash, headerSize } = await safetensorsHeaderHash(abs);
  return {
    ...base,
    state: 'measured',
    content_hash: read.contentHash,
    header_hash: headerHash,
    header_size: headerSize,
    bytes: read.bytesCounted,
    reason: read.sizeDisagreement,
  };
}

/**
 * The whole manifest for one workflow, against one model root.
 *
 * The port of `_hash_workflow_models`, with the three replacements above. No
 * cache: the Python's is keyed by (path, mtime_ns, size) and lives for a warm
 * container, which is a reasonable trade in a runner that re-executes the same
 * base checkpoint all day. Here the point of the measurement is that it was
 * taken for THIS run, and a cache keyed on metadata the file's owner controls
 * is exactly the way to miss a swap.
 */
export async function fingerprintWorkflow(opts: {
  graph: unknown;
  modelRoot: string;
  ceilingBytes?: number;
}): Promise<ModelStoreReport> {
  const modelRoot = path.resolve(opts.modelRoot);
  const ceilingBytes = opts.ceilingBytes ?? DEFAULT_MODEL_CEILING_BYTES;
  if (!Number.isInteger(ceilingBytes) || ceilingBytes <= 0) {
    throw new Error(`model store: ceiling must be a positive integer, got ${String(ceilingBytes)}`);
  }
  const readStartedAt = new Date().toISOString();
  const references = referencedModels(opts.graph, modelRoot);
  const fingerprints: Record<string, ModelFingerprint> = {};
  for (const ref of references) {
    fingerprints[ref.key] = await fingerprintOne(ref, modelRoot, ceilingBytes);
  }
  return {
    modelRoot, ceilingBytes, references, fingerprints,
    readStartedAt, readFinishedAt: new Date().toISOString(),
  };
}
