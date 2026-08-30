// The safetensors header, read from outside the process that wrote it.
//
// This is the one piece of the in-pod hook worth carrying out of the pod
// unchanged in SUBSTANCE and changed entirely in PLACEMENT. The hook computed
// `header_hash` inside the boundary being measured, which is why P2 called it
// unfixable in place — a hash of a file computed by the party that can rewrite
// the file proves nothing. The same bytes read by the component prove the same
// thing they always did, from somewhere the tenant cannot reach.
//
// FORMAT (safetensors, as the library writes it):
//   bytes 0..8    little-endian u64: length of the JSON header, N
//   bytes 8..8+N  the JSON header: one key per tensor, plus optional
//                 "__metadata__". Each value carries dtype, shape, offsets.
//   the rest      the tensor data.
//
// WHY THE HEADER IS HASHED SEPARATELY. The content hash covers everything and
// therefore distinguishes nothing: any change anywhere produces a different
// value. The header hash covers the STRUCTURE — every layer name, shape and
// dtype — so a file whose metadata was edited but whose tensor structure is
// intact keeps its header hash and changes its content hash, and the pair says
// which of the two happened. That distinction is the whole reason the field
// exists, and it survives the move.
//
// NOTHING HERE PARSES TENSOR DATA and nothing reads past the header. P6 /
// zero-content is a property of what this file is capable of, not of a policy
// applied to its output.

import crypto from 'node:crypto';
import fs from 'node:fs';

/** Sanity bound. A header larger than this is not a header we will treat as
 *  one — the same 20 MB the in-pod hook used, kept so the two agree on what
 *  counts as well-formed. */
const MAX_HEADER_BYTES = 20_000_000;

export interface SafetensorsHeader {
  /** The exact bytes hashed. Kept so the hash and the parse cannot diverge. */
  raw: Buffer;
  json: Record<string, unknown>;
}

/**
 * Read and parse the header, or return null.
 *
 * NULL IS A REAL ANSWER AND NOT AN ERROR PATH. A `.ckpt` pickle, a truncated
 * write, a file that is not safetensors at all: none of those is a failure of
 * this component, and none of them may become a guess. The caller records the
 * absence, which is a different fact from a header that parsed empty.
 */
export function readSafetensorsHeader(abs: string): SafetensorsHeader | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, 'r');
    const lenBuf = Buffer.alloc(8);
    if (fs.readSync(fd, lenBuf, 0, 8, 0) < 8) return null;
    const n = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_HEADER_BYTES) return null;

    const raw = Buffer.alloc(n);
    if (fs.readSync(fd, raw, 0, n, 8) < n) return null;

    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { raw, json: parsed as Record<string, unknown> };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the fd is going away with the process anyway */
      }
    }
  }
}

/** SHA-256 of the RAW header bytes — not of a re-serialised parse, which
 *  would be a different string on any JSON implementation that orders keys
 *  differently, and therefore a different hash for an identical file. */
export function hashHeaderBytes(h: SafetensorsHeader): string {
  return crypto.createHash('sha256').update(h.raw).digest('hex');
}
