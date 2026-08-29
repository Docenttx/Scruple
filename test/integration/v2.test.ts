// The /v2 canon surface, driven over real HTTP against a real database.
//
// Every assertion here corresponds to a decision in
// docs/canon/CANON_SKELETON.md. Where a test exists because a live bug
// was found, the comment says so — those are the ones worth keeping when
// someone later decides this file is too slow.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, ensureUser, api, sha256, type Harness } from './harness';

let h: Harness;
let key: string;
let call: ReturnType<typeof api>;
let anon: ReturnType<typeof api>;

const SURFACE = sha256('integration addon v1');

before(async () => {
  h = await boot();
  await ensureUser();
  key = h.issueKey(['baseline:write', 'witness:write', 'mark:write', 'read']);
  call = api(h.base, key);
  anon = api(h.base);
});

after(async () => { if (h) await h.stop(); });

describe('D-2 · one auth model, scopes enforced', () => {
  test('no credential is 401', async () => {
    assert.equal((await anon('GET', '/baseline/current')).status, 401);
  });

  test('an unknown key is 401', async () => {
    assert.equal((await api(h.base, 'sk_test_nope')('GET', '/baseline/current')).status, 401);
  });

  test('a key without the scope is 403, naming what it needs', async () => {
    const readOnly = h.issueKey(['read']);
    const r = await api(h.base, readOnly)('POST', '/baseline', {
      host: 'blender', integration_version: '1.0.0', tamper_surface_hash: sha256('x'),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden_scope');
    assert.match(r.body.error.message, /baseline:write/);
  });
});

describe('D-3 · no baseline, no witness', () => {
  test('witnessing before baselining is refused', async () => {
    const r = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'document_save',
      content_hash: sha256('a'), mime: 'image/png',
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'baseline_required');
  });

  test('a baseline can be established', async () => {
    const r = await call('POST', '/baseline', {
      host: 'blender', integration_version: '1.0.0', tamper_surface_hash: SURFACE,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.baseline_ref, SURFACE);
  });

  test('a second baseline is refused — §4 wants a transition, not a replacement', async () => {
    const r = await call('POST', '/baseline', {
      host: 'blender', integration_version: '1.0.1', tamper_surface_hash: sha256('other'),
    });
    assert.equal(r.status, 409);
  });

  test('an unknown baseline_ref is refused', async () => {
    const r = await call('POST', '/witness', {
      baseline_ref: sha256('never established'), kind: 'artifact',
      content_hash: sha256('b'), mime: 'image/png',
    });
    assert.equal(r.status, 409);
  });
});

describe('witnessing', () => {
  test('a witnessed leaf comes back with an explicit witnessed flag (D-8)', async () => {
    const r = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'document_save',
      content_hash: sha256('first'), mime: 'image/png',
    });
    assert.equal(r.status, 201);
    assert.equal(typeof r.body.witnessed, 'boolean',
      'witnessed must always be present — it is never implied by the status code');
    assert.equal(r.body.baseline_ref, SURFACE);
  });

  test('REGRESSION: witnessing repeatedly does not collide', async () => {
    // run_sequence was hardcoded to 0, colliding with UNIQUE
    // (project_id, run_sequence) on the SECOND call. The first always
    // worked, so nothing but witnessing twice could find it.
    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call('POST', '/witness', {
        baseline_ref: SURFACE, kind: 'document_save',
        content_hash: sha256(`repeat-${i}`), mime: 'image/png',
      });
      assert.equal(r.status, 201, `witness #${i + 1} failed: ${JSON.stringify(r.body)}`);
      seqs.push(r.body.run_sequence);
    }
    assert.deepEqual(seqs, [...new Set(seqs)], 'run_sequence repeated');
  });

  test('REGRESSION: no project_id is required from the caller', async () => {
    // /witness 500'd on NOT NULL iterations.project_id. The §4 hook
    // contract has no project step, so the surface must not need one.
    const r = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'artifact',
      content_hash: sha256('no-project'), mime: 'image/jpeg',
    });
    assert.equal(r.status, 201);
  });

  test('mime is required and never guessed', async () => {
    const r = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'artifact', content_hash: sha256('nomime'),
    });
    assert.equal(r.status, 400);
  });
});

describe('D-4/D-5 · marking', () => {
  let leafId: string;

  before(async () => {
    const r = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'artifact',
      content_hash: sha256('markable'), mime: 'image/png',
    });
    leafId = r.body.leaf_id;
  });

  test('a local lock is always applied, even with no modalities (§9.4)', async () => {
    const r = await call('POST', '/mark', { leaf_id: leafId, host: 'blender', modalities: [] });
    assert.equal(r.status, 200);
    assert.ok(r.body.modalities_applied.includes('local'));
  });

  test('the selection is recorded in the leaf (§9.5)', async () => {
    const r = await call('POST', '/mark', {
      leaf_id: leafId, host: 'blender', modalities: ['c2pa', 'watermark'],
    });
    assert.deepEqual(r.body.modalities_requested, ['c2pa', 'watermark']);

    const receipt = await anon('GET', `/receipt/${leafId}`);
    assert.deepEqual(receipt.body.modalities_requested, ['c2pa', 'watermark'],
      'the selection must survive into the receipt — it cannot be reconstructed later');
  });

  test('unavailable modalities are outstanding, never silently dropped (§7)', async () => {
    const r = await call('POST', '/mark', {
      leaf_id: leafId, host: 'blender', modalities: ['c2pa'],
    });
    assert.equal(r.body.outstanding.length, 1);
    assert.ok(r.body.outstanding[0].reason.length > 20,
      'an outstanding item must say why, since it reaches a user');
  });
});

describe('D-7 · applicability fails closed', () => {
  test('watermark on parametric CAD is 422 with a readable reason', async () => {
    const w = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'document_save',
      content_hash: sha256('cad'), mime: 'model/step',
    });
    assert.equal(w.status, 201);
    const r = await call('POST', '/mark', {
      leaf_id: w.body.leaf_id, host: 'inventor', modalities: ['watermark'],
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'modality_unavailable');
    assert.match(r.body.error.message, /pixel or audio/i);
  });

  test('chain on the same CAD asset IS applied — a hash ignores media type', async () => {
    const w = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'document_save',
      content_hash: sha256('cad2'), mime: 'model/step',
    });
    const r = await call('POST', '/mark', {
      leaf_id: w.body.leaf_id, host: 'inventor', modalities: ['chain'],
    });
    assert.equal(r.status, 200);
  });

  test('capabilities is public and agrees with what mark enforces', async () => {
    const r = await anon('GET', '/capabilities?host=inventor&mime=model/step');
    assert.equal(r.status, 200);
    const wm = r.body.modalities.find((m: any) => m.modality === 'watermark');
    assert.equal(wm.available, false);
    assert.ok(wm.reason.length > 20);
  });
});

describe('public reads need no credential', () => {
  test('receipt and verify are open', async () => {
    const w = await call('POST', '/witness', {
      baseline_ref: SURFACE, kind: 'artifact',
      content_hash: sha256('public'), mime: 'image/png',
    });
    assert.equal((await anon('GET', `/receipt/${w.body.leaf_id}`)).status, 200);

    const v = await anon('GET', `/verify/${sha256('public')}`);
    assert.equal(v.status, 200);
    assert.equal(v.body.found, true);
    assert.equal(typeof v.body.independently_verifiable, 'boolean');
  });

  test('an unknown hash says so without implying the file is fake', async () => {
    const v = await anon('GET', `/verify/${sha256('never seen')}`);
    assert.equal(v.body.found, false);
    assert.match(v.body.note, /says nothing about the file/i);
  });
});
