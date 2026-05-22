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
    // Guard against path traversal surprises but allow absolute dev paths.
    const p = path.resolve(spec.localPath);
    if (!fs.existsSync(p)) throw new Error(`local input not found: ${p}`);
    bytes = fs.readFileSync(p);
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
