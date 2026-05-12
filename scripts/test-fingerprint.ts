// Smoke test for safetensors parser + model fingerprinter.
// Builds a tiny synthetic safetensors file in /tmp (1 tensor, 16 bytes of
// payload) and verifies:
//   - parser extracts the right tensor count, dtype, shape, offsets
//   - fingerprinter returns deterministic contentHash + headerHash
//   - structural-only mode returns the same headerHash as full mode
//   - truncated / bad-JSON / oversize-header rejections all fire
//
// Run: npx tsx scripts/test-fingerprint.ts

import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSafetensorsHeader,
  readSafetensorsHeader,
  SafetensorsParseError,
  expectedTensorBytes,
} from '../lib/scruple/safetensors';
import {
  fingerprintModelFile,
  structuralFingerprintOnly,
} from '../lib/scruple/model-fingerprint';

// Construct a tiny but valid safetensors blob:
//   1 tensor named "lora_unet_down_blocks_0_attn1.lora_down.weight"
//   dtype F16, shape [2, 2] → 8 bytes
//   plus __metadata__ with ss_base_model_version=sd_v15
function buildBlob(): { buf: Buffer; headerJson: string; tensorBytes: Buffer } {
  const tensorBytes = Buffer.from([
    0x00, 0x3c,  // 1.0 in F16
    0x00, 0x40,  // 2.0
    0x00, 0x42,  // 3.0
    0x00, 0x44,  // 4.0
  ]);
  const headerObj = {
    __metadata__: {
      ss_base_model_version: 'sd_v15',
      ss_network_module: 'networks.lora',
    },
    'lora_unet_down_blocks_0_attn1.lora_down.weight': {
      dtype: 'F16',
      shape: [2, 2],
      data_offsets: [0, 8],
    },
  };
  const headerJson = JSON.stringify(headerObj);
  const headerBytes = Buffer.from(headerJson, 'utf8');
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(headerBytes.length), 0);
  return {
    buf: Buffer.concat([sizeBuf, headerBytes, tensorBytes]),
    headerJson,
    tensorBytes,
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

async function run() {
  const { buf, headerJson, tensorBytes } = buildBlob();
  console.log(`[test] built synthetic safetensors: ${buf.length} bytes total, header JSON ${headerJson.length} bytes, tensor region ${tensorBytes.length} bytes`);

  // ── parseSafetensorsHeader on Buffer ──
  const parsed = parseSafetensorsHeader(buf);
  assert(parsed.tensors.length === 1, 'expected 1 tensor');
  assert(parsed.tensors[0].dtype === 'F16', 'dtype F16');
  assert(parsed.tensors[0].shape.join('x') === '2x2', 'shape 2x2');
  assert(parsed.tensors[0].byteLength === 8, 'tensor byte length 8');
  assert(parsed.metadata.ss_base_model_version === 'sd_v15', 'metadata key roundtrips');
  assert(expectedTensorBytes(parsed.tensors[0]) === 8, 'expectedTensorBytes matches');
  console.log('[test] parseSafetensorsHeader: OK');

  // ── full fingerprint via file path ──
  const tmpPath = join(tmpdir(), `scruple-fp-${Date.now()}.safetensors`);
  await writeFile(tmpPath, buf);
  try {
    const fp = await fingerprintModelFile(tmpPath);
    assert(/^[0-9a-f]{64}$/.test(fp.contentHash), 'contentHash is 64-hex');
    assert(/^[0-9a-f]{64}$/.test(fp.headerHash), 'headerHash is 64-hex');
    assert(fp.tensorCount === 1, 'tensor count 1');
    assert(fp.fileSize === buf.length, 'fileSize matches buffer length');
    assert(fp.structuralSummary.modelTypeGuess === 'SD15Lora', `modelTypeGuess=${fp.structuralSummary.modelTypeGuess}, want SD15Lora`);
    assert(fp.structuralSummary.totalParamCount === 4, 'totalParamCount 4 (2×2)');
    assert(fp.structuralSummary.dtypes.length === 1 && fp.structuralSummary.dtypes[0] === 'F16', 'dtypes [F16]');
    console.log(`[test] fingerprintModelFile: OK  (content=${fp.contentHash.slice(0,12)}…, header=${fp.headerHash.slice(0,12)}…, guess=${fp.structuralSummary.modelTypeGuess})`);

    // determinism: run twice, must match
    const fp2 = await fingerprintModelFile(tmpPath);
    assert(fp2.contentHash === fp.contentHash, 'contentHash deterministic');
    assert(fp2.headerHash === fp.headerHash, 'headerHash deterministic');

    // structural-only must match the full-fingerprint header hash
    const struct = await structuralFingerprintOnly(tmpPath);
    assert(struct.headerHash === fp.headerHash, 'structuralFingerprintOnly headerHash matches');
    assert(struct.tensorCount === fp.tensorCount, 'structural tensor count matches');
    console.log('[test] structuralFingerprintOnly: OK (matches full)');

    // readSafetensorsHeader on file
    const { header, handle } = await readSafetensorsHeader(tmpPath);
    await handle.close();
    assert(header.tensors.length === 1, 'readSafetensorsHeader tensor count');
    console.log('[test] readSafetensorsHeader: OK');
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  // ── error cases ──
  console.log('[test] error cases…');
  try {
    parseSafetensorsHeader(Buffer.alloc(4));
    throw new Error('should have rejected 4-byte buffer');
  } catch (e) {
    assert(e instanceof SafetensorsParseError, 'rejected too-small as SafetensorsParseError');
  }
  {
    // header size 100 but only 10 bytes of payload
    const bad = Buffer.alloc(18);
    bad.writeBigUInt64LE(100n, 0);
    try {
      parseSafetensorsHeader(bad);
      throw new Error('should have rejected truncated header');
    } catch (e) {
      assert(e instanceof SafetensorsParseError, 'rejected truncated');
    }
  }
  {
    // garbage JSON
    const headerBytes = Buffer.from('not json at all');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(BigInt(headerBytes.length), 0);
    try {
      parseSafetensorsHeader(Buffer.concat([sizeBuf, headerBytes]));
      throw new Error('should have rejected bad JSON');
    } catch (e) {
      assert(e instanceof SafetensorsParseError, 'rejected bad JSON');
    }
  }
  {
    // oversize header (> 100 MB cap)
    const bad = Buffer.alloc(8);
    bad.writeBigUInt64LE(BigInt(200 * 1024 * 1024), 0);
    try {
      parseSafetensorsHeader(bad);
      throw new Error('should have rejected oversize header');
    } catch (e) {
      assert(e instanceof SafetensorsParseError, 'rejected oversize');
    }
  }
  console.log('[test] error cases: OK');

  console.log('\n✓ all fingerprint smoke tests pass');
}

run().catch(e => {
  console.error('✕', e);
  process.exit(1);
});
