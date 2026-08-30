// digitalSourceType is declared, never defaulted — WO-13.
//
// The bug this pins: lib/c2pa/signAsset.ts defaulted digitalSourceType to
// TRAINED_ALGORITHMIC_MEDIA, services/c2pa-signer/sign.py carried the same
// fallback, and no plugin path overrode either. The plugin market is proof
// that an artifact was made WITHOUT generative AI — Fusion, Blender,
// Meshroom and Toon Boom run no inference — so the default put the exact
// opposite claim into a signed, third-party-verifiable manifest. Latent on
// Fusion (no CAD MIME is C2PA-signable today), live on Blender's PNG and
// JPEG renders.
//
// CANON_SKELETON.md §5 property 2: an unknown modality fails closed. Same
// posture here. Three things are pinned:
//
//   1. an undeclared, empty, or unrecognised digitalSourceType is REFUSED,
//      before the signer is spawned and before the asset is even read
//   2. a declared one reaches the signer subprocess byte-for-byte — no
//      normalisation, no substitution, no silent fallback
//   3. the default is gone from the source and cannot creep back
//
// No database, no network, no real signing. Point (2) is proved against a
// stand-in for the Python signer that echoes the job spec it received, so
// this file needs neither python3 nor c2pa nor a signing key. The manifest
// half of the round trip — that the value becomes the right IPTC URI — is
// proved in services/c2pa-signer/tests/test_digital_source_type.py, which
// is where the real c2pa SDK lives.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The stand-in signer must be on disk BEFORE signAsset.ts is imported:
// the module reads SCRUPLE_C2PA_PYTHON once, at module load.
const WORK = mkdtempSync(path.join(tmpdir(), 'scruple-dst-test-'));
const SHIM = path.join(WORK, 'echo-signer.mjs');
const ASSET = path.join(WORK, 'asset.png');

// Reads the job spec sign.py would have read, and reports back what it saw
// instead of signing. signAsset treats ok:false as a signer error and hands
// the `error` string straight through, which is all the channel we need.
writeFileSync(
  SHIM,
  `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const job = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    ok: false,
    error: 'ECHO ' + JSON.stringify({
      digital_source_type: job.digital_source_type,
      has_key: Object.prototype.hasOwnProperty.call(job, 'digital_source_type'),
      intent: job.intent,
    }),
  }));
});
`,
  { mode: 0o755 },
);
chmodSync(SHIM, 0o755);
process.env.SCRUPLE_C2PA_PYTHON = SHIM;

// A real 2x2 PNG, so the fs.access guard in signAsset passes.
writeFileSync(
  ASSET,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATEwMDAwMDAAOFgEBGxLXfwAAAABJRU5ErkJggg==',
    'base64',
  ),
);

// signAsset.ts reads SCRUPLE_C2PA_PYTHON once, at module load, so it is
// imported lazily — after the assignment above. Top-level await is not
// available under the CJS transform test:v2 runs.
type SignAssetModule = typeof import('../../lib/c2pa/signAsset');
let mod: SignAssetModule;
const signAsset = (input: unknown) => mod.signAsset(input as never);

before(async () => {
  mod = await import('../../lib/c2pa/signAsset');
});

// Restated here rather than imported, so a value quietly dropped from the
// union is a failing test and not a silently shrinking loop.
const C2PA_DIGITAL_SOURCE_TYPES = [
  'TRAINED_ALGORITHMIC_MEDIA',
  'ALGORITHMIC_MEDIA',
  'ALGORITHMICALLY_ENHANCED',
  'COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA',
  'HUMAN_EDITS',
  'DIGITAL_CREATION',
  'DATA_DRIVEN_MEDIA',
  'EMPTY',
] as const;

const SIGN_ASSET_TS = path.join(process.cwd(), 'lib', 'c2pa', 'signAsset.ts');
const SIGN_PY = path.join(process.cwd(), 'services', 'c2pa-signer', 'sign.py');

function baseInput(): Record<string, unknown> {
  return {
    assetPath: ASSET,
    outputPath: path.join(WORK, 'out.png'),
    product: 'fusion',
    tier: 'bare',
  };
}

after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('the accepted vocabulary', () => {
  test('matches what signAsset exports', () => {
    assert.deepEqual([...mod.C2PA_DIGITAL_SOURCE_TYPES], [...C2PA_DIGITAL_SOURCE_TYPES]);
  });
});

describe('an undeclared digitalSourceType is refused', () => {
  test('omitted entirely — no default, no guess', async () => {
    // Cast because the type now forbids this. The cast is the point: a JS
    // caller, an `as any`, or a JSON body can still get here, so the
    // refusal has to exist at runtime and not only in the type.
    const r = await signAsset(baseInput() as never);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /requires an explicit digitalSourceType/);
    // The refusal has to explain the stakes, or the next person just
    // re-adds the default to make the error go away.
    assert.match((r as { error: string }).error, /opposite of what the plugin hosts exist to prove/);
  });

  for (const bad of [undefined, null, '', '   ', 42, {}, ['DIGITAL_CREATION']]) {
    test(`rejects ${JSON.stringify(bad) ?? 'undefined'}`, async () => {
      const r = await signAsset({ ...baseInput(), digitalSourceType: bad } as never);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted`);
      assert.match((r as { error: string }).error, /requires an explicit digitalSourceType/);
    });
  }

  test('an unrecognised name is refused, not passed through to the signer', async () => {
    const r = await signAsset({
      ...baseInput(),
      digitalSourceType: 'TOTALLY_MADE_UP',
    } as never);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /requires an explicit digitalSourceType/);
    // If it had reached the subprocess we would be looking at an ECHO.
    assert.doesNotMatch((r as { error: string }).error, /^ECHO/);
  });

  test('the refusal happens before the asset is touched', async () => {
    // No asset on disk at all. If the source-type check ran second we
    // would get "asset not found" instead — and a caller fixing that
    // error would never learn about the real problem.
    const r = await signAsset({
      ...baseInput(),
      assetPath: path.join(WORK, 'does-not-exist.png'),
    } as never);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /requires an explicit digitalSourceType/);
  });
});

describe('a declared digitalSourceType round-trips to the signer unchanged', () => {
  for (const declared of C2PA_DIGITAL_SOURCE_TYPES) {
    test(`${declared} arrives verbatim`, async () => {
      const r = await signAsset({ ...baseInput(), digitalSourceType: declared } as never);
      assert.equal(r.ok, false); // the stand-in never signs
      const err = (r as { error: string }).error;
      assert.ok(err.startsWith('ECHO '), `signer was not reached: ${err}`);
      const seen = JSON.parse(err.slice('ECHO '.length)) as {
        digital_source_type: string;
        has_key: boolean;
        intent: string;
      };
      assert.equal(seen.has_key, true, 'job spec omitted digital_source_type');
      assert.equal(seen.digital_source_type, declared);
      assert.equal(seen.intent, 'CREATE');
    });
  }

  test('DIGITAL_CREATION is the no-AI value and is not rewritten en route', async () => {
    // The one that matters: the plugin hosts' value must survive the trip
    // without being "corrected" to the old default.
    const r = await signAsset({ ...baseInput(), digitalSourceType: 'DIGITAL_CREATION' } as never);
    const err = (r as { error: string }).error;
    assert.ok(err.includes('"digital_source_type":"DIGITAL_CREATION"'));
    assert.ok(!err.includes('TRAINED_ALGORITHMIC_MEDIA'));
  });
});

describe('the default cannot creep back', () => {
  // Read the sources, the way test_assertion_contract.py does: a
  // behavioural test passes just as happily against a fallback that is
  // never reached in these cases, and the fallback is the bug.
  test('signAsset.ts has no fallback for digitalSourceType', () => {
    const src = readFileSync(SIGN_ASSET_TS, 'utf-8');
    const job = /const job = \{[\s\S]*?\n  \};/.exec(src);
    assert.ok(job, 'job spec literal not found in signAsset.ts');
    assert.doesNotMatch(
      job[0],
      /digital_source_type:[^\n]*(\?\?|\|\|)/,
      'digital_source_type has a fallback in the job spec — that is the bug',
    );
    assert.match(job[0], /digital_source_type:\s*input\.digitalSourceType,/);
  });

  test('the field is required on SignAssetInput', () => {
    const src = readFileSync(SIGN_ASSET_TS, 'utf-8');
    assert.doesNotMatch(
      src,
      /digitalSourceType\?:/,
      'digitalSourceType is optional again — an omitted claim is a guessed claim',
    );
  });

  test('sign.py does not default digital_source_type either', () => {
    // Both ends of the subprocess boundary have to refuse. A default on
    // the Python side would be reachable by anything that writes a job
    // spec without going through signAsset.ts.
    const src = readFileSync(SIGN_PY, 'utf-8');
    assert.doesNotMatch(
      src,
      /job\.get\(\s*["']digital_source_type["']\s*,/,
      'sign.py supplies a default for digital_source_type',
    );
    assert.match(src, /dst_name = job\.get\("digital_source_type"\)/);
  });
});
