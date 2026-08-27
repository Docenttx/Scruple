// Applicability is a server fact (canon D-7). These tests pin the two
// judgments that the sweep found every shell getting wrong privately.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, isModalityAvailable } from '../../lib/v2/capabilities';

const get = (host: any, mime: string, m: string) =>
  capabilitiesFor(host, mime).find((c) => c.modality === m)!;

describe('media that Scruple can mark', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/flac']) {
    test(`${mime} supports both Article 50 measures`, () => {
      assert.equal(get('blender', mime, 'c2pa').available, true);
      assert.equal(get('blender', mime, 'watermark').available, true);
    });
  }

  test('.jxl and .flac are signable — the two GPSA v3 named as broken by MIME auto-detect', () => {
    assert.equal(get('comfyui', 'image/jxl', 'c2pa').available, true);
    assert.equal(get('comfyui', 'audio/flac', 'c2pa').available, true);
  });
});

describe('parametric CAD', () => {
  const cadMimes = [
    'application/vnd.autodesk.inventor.part',
    'application/vnd.solidworks.assembly',
    'model/step',
  ];

  for (const mime of cadMimes) {
    test(`${mime}: neither C2PA nor watermark applies`, () => {
      assert.equal(get('inventor', mime, 'c2pa').available, false);
      assert.equal(get('inventor', mime, 'watermark').available, false);
    });
  }

  test('the reason is an explanation, not an error code — it gets shown to a user', () => {
    const r = get('solidworks', 'model/step', 'watermark').reason;
    assert.match(r, /pixel or audio/i);
    assert.ok(r.length > 30, 'a one-word reason reads as a bug, not an answer');
  });

  test('chain lock still applies to CAD — a hash does not care about media type', () => {
    assert.equal(get('inventor', 'model/step', 'chain').available, true);
  });
});

describe('SVG is signable but not watermarkable', () => {
  test('the distinction is real: bytes exist, a sampled grid does not', () => {
    assert.equal(get('illustrator', 'image/svg+xml', 'c2pa').available, true);
    assert.equal(get('illustrator', 'image/svg+xml', 'watermark').available, false);
    assert.match(get('illustrator', 'image/svg+xml', 'watermark').reason, /vector/i);
  });
});

describe('§9.4 local lock', () => {
  test('is available for every host and every media type', () => {
    for (const mime of ['image/png', 'model/step', 'application/octet-stream']) {
      assert.equal(get('fusion360', mime, 'local').available, true);
    }
  });
});

describe('octet-stream — what four shells send unconditionally', () => {
  test('gets no marking modality, which is the honest answer', () => {
    assert.equal(get('toonboom', 'application/octet-stream', 'c2pa').available, false);
    assert.equal(get('toonboom', 'application/octet-stream', 'watermark').available, false);
  });
});

describe('every capability carries a reason', () => {
  test('available or not', () => {
    for (const mime of ['image/png', 'model/step', 'application/octet-stream']) {
      for (const c of capabilitiesFor('blender', mime)) {
        assert.ok(c.reason && c.reason.length > 10, `${mime}/${c.modality} has no usable reason`);
      }
    }
  });
});

describe('unknown modality', () => {
  test('fails closed rather than defaulting to available', () => {
    const c = isModalityAvailable('blender', 'image/png', 'teleport' as any);
    assert.equal(c.available, false);
  });
});

describe('mime parsing', () => {
  test('parameters and case do not change the answer', () => {
    assert.equal(get('blender', 'IMAGE/PNG', 'c2pa').available, true);
    assert.equal(get('blender', 'image/png; charset=binary', 'c2pa').available, true);
  });
});
