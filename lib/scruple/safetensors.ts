// safetensors header parser. Pure functions; no I/O.
//
// Wire format (HuggingFace safetensors):
//   bytes  0..7   : little-endian uint64 = header length N
//   bytes  8..8+N : UTF-8 JSON header listing every tensor +
//                   { dtype, shape: [...], data_offsets: [start, end] }
//                   plus optional "__metadata__" key with author notes
//   bytes  8+N..  : raw tensor blobs (offsets are relative to this region)
//
// We only parse the header. The tensor blob bytes are content_hash territory
// and are streamed by lib/scruple/model-fingerprint.ts.
//
// Spec: https://github.com/huggingface/safetensors

import { open, type FileHandle } from 'node:fs/promises';

// Hard cap on header size we'll accept. Real safetensors headers run ~1 KB
// for a Lora and up to ~100 KB for a full checkpoint. Anything above this
// is malformed or hostile.
const MAX_HEADER_BYTES = 100 * 1024 * 1024; // 100 MB — Hugging Face's own limit

export interface TensorEntry {
  name: string;
  dtype: string;        // "F32" | "F16" | "BF16" | "I8" | etc.
  shape: number[];
  dataOffsets: [number, number]; // bytes, relative to tensor region start
  byteLength: number;
}

export interface SafetensorsHeader {
  headerSize: number;          // N — value of the leading uint64
  headerBytes: Buffer;          // raw bytes of the JSON region (for hashing)
  metadata: Record<string, string>;   // __metadata__ contents, may be empty
  tensors: TensorEntry[];
  tensorRegionStart: number;   // = 8 + headerSize
}

export class SafetensorsParseError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SafetensorsParseError'; }
}

export function parseSafetensorsHeader(buf: Buffer): SafetensorsHeader {
  if (buf.length < 8) {
    throw new SafetensorsParseError(`file too small (${buf.length} bytes, need at least 8)`);
  }
  const headerSize = Number(buf.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerSize) || headerSize <= 0) {
    throw new SafetensorsParseError(`invalid header size: ${headerSize}`);
  }
  if (headerSize > MAX_HEADER_BYTES) {
    throw new SafetensorsParseError(`header too large: ${headerSize} bytes (cap ${MAX_HEADER_BYTES})`);
  }
  if (buf.length < 8 + headerSize) {
    throw new SafetensorsParseError(
      `truncated header: file is ${buf.length} bytes, header claims ${8 + headerSize}`,
    );
  }
  const headerBytes = buf.subarray(8, 8 + headerSize);
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerBytes.toString('utf8'));
  } catch (e) {
    throw new SafetensorsParseError(`header is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SafetensorsParseError('header JSON is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  const tensors: TensorEntry[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === '__metadata__') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
          if (typeof mv === 'string') metadata[mk] = mv;
        }
      }
      continue;
    }
    const entry = parseTensorEntry(key, value);
    tensors.push(entry);
  }
  return {
    headerSize,
    headerBytes,
    metadata,
    tensors,
    tensorRegionStart: 8 + headerSize,
  };
}

function parseTensorEntry(name: string, value: unknown): TensorEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafetensorsParseError(`tensor "${name}" is not an object`);
  }
  const v = value as Record<string, unknown>;
  const dtype = v.dtype;
  const shape = v.shape;
  const dataOffsets = v.data_offsets;
  if (typeof dtype !== 'string') {
    throw new SafetensorsParseError(`tensor "${name}" missing string dtype`);
  }
  if (!Array.isArray(shape) || !shape.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
    throw new SafetensorsParseError(`tensor "${name}" has invalid shape`);
  }
  if (
    !Array.isArray(dataOffsets) ||
    dataOffsets.length !== 2 ||
    typeof dataOffsets[0] !== 'number' ||
    typeof dataOffsets[1] !== 'number' ||
    dataOffsets[1] < dataOffsets[0]
  ) {
    throw new SafetensorsParseError(`tensor "${name}" has invalid data_offsets`);
  }
  return {
    name,
    dtype,
    shape: shape as number[],
    dataOffsets: [dataOffsets[0], dataOffsets[1]],
    byteLength: dataOffsets[1] - dataOffsets[0],
  };
}

// Read just enough of a file on disk to parse the header — never loads the
// full multi-GB blob into memory. Returns the parsed header + the still-open
// file handle so the caller can stream the tensor region for content hashing
// without re-opening.
export async function readSafetensorsHeader(
  filePath: string,
): Promise<{ header: SafetensorsHeader; handle: FileHandle; fileSize: number }> {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 8) {
      throw new SafetensorsParseError(`file too small (${stat.size} bytes)`);
    }
    const sizeBuf = Buffer.alloc(8);
    await handle.read(sizeBuf, 0, 8, 0);
    const headerSize = Number(sizeBuf.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerSize) || headerSize <= 0) {
      throw new SafetensorsParseError(`invalid header size: ${headerSize}`);
    }
    if (headerSize > MAX_HEADER_BYTES) {
      throw new SafetensorsParseError(`header too large: ${headerSize} bytes`);
    }
    if (stat.size < 8 + headerSize) {
      throw new SafetensorsParseError(
        `truncated: file is ${stat.size} bytes, header claims ${8 + headerSize}`,
      );
    }
    const combined = Buffer.alloc(8 + headerSize);
    sizeBuf.copy(combined, 0);
    await handle.read(combined, 8, headerSize, 8);
    const header = parseSafetensorsHeader(combined);
    return { header, handle, fileSize: stat.size };
  } catch (e) {
    await handle.close();
    throw e;
  }
}

// Number of bytes a dtype encodes per scalar. Used for sanity-checking
// byteLength against shape × dtype size.
export function bytesPerDtype(dtype: string): number | null {
  switch (dtype) {
    case 'F64': case 'I64': case 'U64': return 8;
    case 'F32': case 'I32': case 'U32': return 4;
    case 'F16': case 'BF16': case 'I16': case 'U16': return 2;
    case 'F8_E4M3': case 'F8_E5M2': case 'I8': case 'U8': case 'BOOL': return 1;
    default: return null;
  }
}

export function expectedTensorBytes(t: TensorEntry): number | null {
  const per = bytesPerDtype(t.dtype);
  if (per === null) return null;
  const elements = t.shape.reduce((a, b) => a * b, 1);
  return elements * per;
}
