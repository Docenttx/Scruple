// Input resolution for the run pipeline.
//
// A run's source materials can come from several places — the canvas is
// just one of them. The CC dev pipeline (and later the canvas valve) hand
// us a *reference* per input; we resolve it to bytes server-side so the
// same capture path applies regardless of source:
//
//   inline      — base64 in the request (true remote callers)
//   local       — a path on the witness/host filesystem (CC dev runs)
//   iteration   — a prior captured artifact by hash (chain img2img etc.)
//   storage     — the user's connected storage provider (Drive/OneDrive/…)
//
// Each resolves to { kind, filename, bytes, contentType }. The filename is
// what the workflow's LoadImage/LoadVideo node references on the runner.

import fs from 'node:fs';
import path from 'node:path';
import { readArtifact } from '@/lib/scruple/artifacts';
import { getActiveProvider } from '@/lib/storage/dispatch';
import type { InputArtifactKind } from '@/lib/iterations/ingest';
import type { StoragePointer } from '@/lib/storage/types';

export interface RunInputSpec {
  kind: InputArtifactKind;
  /** Name the workflow references on the runner (LoadImage `image` field). */
  filename: string;
  contentType?: string;
  // exactly one source:
  inlineBase64?: string;
  localPath?: string;
  iterationHash?: string;
  storagePointer?: StoragePointer;
}

export interface ResolvedInput {
  kind: InputArtifactKind;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Roots a `localPath` input may come from. WO-61.
 *
 * Deliberately NOT the repository root: `.env.local`, `data/scruple.db` and
 * the artifact store all live there, and the artifact store is reachable
 * through /api/artifact anyway. The defaults are the two places a dev run
 * legitimately stages input bytes.
 *
 * `SCRUPLE_LOCAL_INPUT_ROOTS` (colon-separated) widens it deliberately, which
 * is the point: widening should be a recorded act, not the default.
 */
export const LOCAL_INPUT_ROOTS: readonly string[] = (
  process.env.SCRUPLE_LOCAL_INPUT_ROOTS
    ? process.env.SCRUPLE_LOCAL_INPUT_ROOTS.split(':')
    : ['/mnt/corpus/scruple-web-scratch', '/tmp']
).map((r) => path.resolve(r.trim())).filter(Boolean);

export function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'png': return 'image/png';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'safetensors':
    case 'ckpt': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

export async function resolveInput(userId: string, spec: RunInputSpec): Promise<ResolvedInput> {
  const contentType = spec.contentType ?? contentTypeFor(spec.filename);
  let bytes: Buffer;

  if (spec.inlineBase64 != null) {
    bytes = Buffer.from(spec.inlineBase64, 'base64');
  } else if (spec.localPath) {
    // WO-61 — THIS COMMENT USED TO CLAIM A GUARD IT DID NOT IMPLEMENT.
    //
    // It read "Guard against path traversal surprises but allow absolute dev
    // paths", and the guard was `path.resolve()`. `path.resolve` NORMALISES;
    // it does not CONFINE. There was no root and no allowlist, so any
    // authenticated caller could name any file the process could read —
    // verified by reading /etc/hostname through this branch.
    //
    // It is worse than a file read because of what the pipeline then does
    // with the bytes: they are hashed, stored content-addressed, and served
    // back by /api/artifact/<hash>. `.env.local` holds AUTH_SECRET, the Modal
    // tokens, the Stripe keys and the BDK. That is an exfiltration primitive
    // wearing the shape of provenance capture.
    //
    // The affordance is kept because the CC dev pipeline needs it — a local
    // path is how a run supplies an input without a round trip through
    // storage. It is confined instead of removed.
    const resolved = path.resolve(spec.localPath);
    const allowed = LOCAL_INPUT_ROOTS.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!allowed) {
      throw new Error(
        `local input refused: ${resolved} is outside every permitted root. ` +
          `Permitted: ${LOCAL_INPUT_ROOTS.join(', ')}. Set SCRUPLE_LOCAL_INPUT_ROOTS to widen it.`,
      );
    }
    if (!fs.existsSync(resolved)) throw new Error(`local input not found: ${resolved}`);
    bytes = fs.readFileSync(resolved);
  } else if (spec.iterationHash) {
    const a = readArtifact(spec.iterationHash);
    if (!a) throw new Error(`iteration artifact not found: ${spec.iterationHash}`);
    bytes = a;
  } else if (spec.storagePointer) {
    const provider = getActiveProvider(userId);
    if (!provider) throw new Error('no storage provider connected for storage-sourced input');
    bytes = await provider.readFile(userId, spec.storagePointer);
  } else {
    throw new Error('input spec needs one of: inlineBase64 | localPath | iterationHash | storagePointer');
  }

  if (!bytes.length) throw new Error(`resolved input ${spec.filename} is empty`);
  return { kind: spec.kind, filename: spec.filename, contentType, bytes };
}
