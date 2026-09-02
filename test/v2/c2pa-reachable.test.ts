// The C2PA signer is reachable, honest about what it takes, and one list
// says what it signs.
//
// WHAT THIS PINS, AND WHY IT DID NOT EXIST
//
// The 2026-09-02 demo-readiness survey signed a real MP4 through the real
// path and read back `validation_state: Valid` — and found that
// `/api/scruple/c2pa/sign` has zero in-repo callers, so nothing exercised
// any of it. The suite that did exist stubbed the Python signer with a
// shell shim and never signed, and four hand-maintained lists disagreed
// about which formats the signer accepts. None of the survey's findings
// would have turned a test red.
//
// Three things are pinned here:
//
//   1. lib/c2pa/formats.ts and services/c2pa-signer/formats.py agree,
//      entry for entry. formats.py is the EMITTING source — the
//      evidence-bundle builder enumerates it and the Conformance Intake
//      Form mirrors it — so it is parsed from disk rather than trusted,
//      the same idiom services/c2pa-signer/tests/test_assertion_contract.py
//      uses for assertion labels.
//   2. A real PNG and a real MP4 sign end to end, through the actual
//      subprocess, and read back Valid.
//   3. An unsignable format is REFUSED by name, before python is spawned.
//      WebM was the live case: `.webm` routed to a signer with no WebM
//      handler and the caller got a 500, not "unsupported".
//
// The fixtures are the bytes that went to the C2PA conformance reviewer,
// already in the repository under docs/c2pa-conformance-evidence/.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  C2PA_FORMATS,
  C2PA_GENERATE_MIMES,
  C2PA_SIGNABLE_MIMES,
  C2PA_UNSUPPORTED,
  C2PA_VALIDATE_MIMES,
  mimeFromPath,
  signRefusalReason,
} from '../../lib/c2pa/formats';

const REPO = path.resolve(__dirname, '..', '..');
const SIGNER_DIR = path.join(REPO, 'services', 'c2pa-signer');
const FORMATS_PY = path.join(SIGNER_DIR, 'formats.py');
const CAPABILITIES_TS = path.join(REPO, 'lib', 'v2', 'capabilities.ts');
const ROUTE_TS = path.join(REPO, 'app', 'api', 'scruple', 'c2pa', 'sign', 'route.ts');
const README_MD = path.join(REPO, 'app', 'api', 'scruple', 'c2pa', 'README.md');
const FIXTURES = path.join(REPO, 'docs', 'c2pa-conformance-evidence', '2026-07-14');
const KEY = path.join(SIGNER_DIR, 'keys', 'signer.key');
const CERT = path.join(SIGNER_DIR, 'keys', 'signer.pem');

// ── the emitting source, parsed ─────────────────────────────────────────

interface PyFormat { mime: string; extensions: string[]; generate: boolean; validate: boolean }

function parseFormatsPy(): { formats: PyFormat[]; unsupported: { mime: string; extensions: string[] }[] } {
  const src = readFileSync(FORMATS_PY, 'utf8');
  const exts = (raw: string) =>
    [...raw.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const formats: PyFormat[] = [];
  for (const m of src.matchAll(
    /Format\(\s*'([^']+)',\s*\(([^)]*)\),\s*(True|False),\s*(True|False)\s*\)/g,
  )) {
    formats.push({
      mime: m[1],
      extensions: exts(m[2]),
      generate: m[3] === 'True',
      validate: m[4] === 'True',
    });
  }
  assert.ok(formats.length > 0, 'no Format(...) rows parsed out of formats.py');

  const unsupported = [...src.matchAll(/Unsupported\(\s*'([^']+)',\s*\(([^)]*)\),/g)].map((m) => ({
    mime: m[1],
    extensions: exts(m[2]),
  }));
  assert.ok(unsupported.length > 0, 'no Unsupported(...) rows parsed out of formats.py');
  return { formats, unsupported };
}

describe('one format registry, two languages', () => {
  const py = parseFormatsPy();

  test('every row matches, in order', () => {
    assert.deepEqual(
      C2PA_FORMATS.map((f) => ({
        mime: f.mime,
        extensions: [...f.extensions],
        generate: f.generate,
        validate: f.validate,
      })),
      py.formats,
      'lib/c2pa/formats.ts has drifted from services/c2pa-signer/formats.py. ' +
        'formats.py is the emitting source — the evidence-bundle builder ' +
        'enumerates it and the Conformance Intake Form mirrors it. Change it ' +
        'there first, then mirror it here.',
    );
  });

  test('the refusal list matches too', () => {
    assert.deepEqual(
      C2PA_UNSUPPORTED.map((u) => ({ mime: u.mime, extensions: [...u.extensions] })),
      py.unsupported,
      'the UNSUPPORTED rows have drifted. A format missing from one side ' +
        'reaches c2pa-rs and comes back as a 500 instead of an answer.',
    );
  });

  test('derived lists are derived, not typed', () => {
    assert.deepEqual([...C2PA_GENERATE_MIMES], py.formats.filter((f) => f.generate).map((f) => f.mime));
    assert.deepEqual([...C2PA_VALIDATE_MIMES], py.formats.filter((f) => f.validate).map((f) => f.mime));
  });

  test('capabilities.ts does not keep a fifth copy', () => {
    // It advertised image/vnd.adobe.photoshop for a year — a format no
    // version of this stack has ever signed. It now imports the set; a
    // re-hardcoded literal here is the drift this catches.
    const src = readFileSync(CAPABILITIES_TS, 'utf8');
    assert.match(
      src,
      /import \{ C2PA_SIGNABLE_MIMES \} from '@\/lib\/c2pa\/formats'/,
      'lib/v2/capabilities.ts must derive C2PA_SIGNABLE from the registry.',
    );
    const block = src.match(/const C2PA_SIGNABLE[^;]*;/)?.[0] ?? '';
    assert.equal(
      /['"][a-z]+\/[a-z0-9.+-]+['"]/.test(block),
      false,
      `lib/v2/capabilities.ts hardcodes MIME literals again: ${block}`,
    );
  });

  test('nothing advertised is refused, and nothing refused is advertised', () => {
    for (const mime of C2PA_GENERATE_MIMES) {
      assert.equal(signRefusalReason(mime), null, `${mime} is advertised but refused`);
    }
    for (const u of C2PA_UNSUPPORTED) {
      assert.equal(C2PA_SIGNABLE_MIMES.has(u.mime), false, `${u.mime} is refused but advertised`);
    }
  });

  test('formats the library cannot sign are not advertised', () => {
    for (const mime of [
      'image/vnd.adobe.photoshop',
      'application/x-pytorch',
      'video/webm',
      'application/octet-stream',
    ]) {
      assert.equal(
        C2PA_SIGNABLE_MIMES.has(mime),
        false,
        `${mime} is advertised as signable and c2pa-rs 0.36.0 refuses it outright.`,
      );
    }
    // PDF reads but does not write. Validate-only is the honest claim.
    assert.equal(C2PA_SIGNABLE_MIMES.has('application/pdf'), false);
    assert.ok(C2PA_VALIDATE_MIMES.includes('application/pdf'));
  });
});

describe('an unsignable format is refused by name, not by crashing', () => {
  test('.webm resolves to its true MIME', () => {
    // Not octet-stream. The refusal has to be able to say what it refused.
    assert.equal(mimeFromPath('/runs/take-01.webm'), 'video/webm');
    assert.equal(mimeFromPath('/runs/TAKE-01.WEBM'), 'video/webm');
  });

  test('the reason names the ceiling and the way out', () => {
    const reason = signRefusalReason('video/webm');
    assert.ok(reason);
    assert.match(reason!, /c2pa-rs/);
    assert.match(reason!, /MP4|video\/mp4/);
  });

  test('an unknown extension refuses rather than guessing', () => {
    assert.equal(mimeFromPath('/models/lora.safetensors'), 'application/octet-stream');
    assert.ok(signRefusalReason('application/octet-stream'));
  });
});

// ── the real thing ──────────────────────────────────────────────────────

const PNG = path.join(FIXTURES, 'Raw.input.image.png', 'scruple-png-seed2002.png');
const MP4 = path.join(FIXTURES, 'Raw.input.video.mp4', 'scruple-mp4-seed2012.mp4');

function haveSigner(): boolean {
  if (!existsSync(KEY) || !existsSync(CERT) || !existsSync(PNG) || !existsSync(MP4)) return false;
  try {
    execFileSync('python3', ['-c', 'import c2pa'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Read a signed asset back through c2pa.Reader and return its validation_state. */
function validationState(signedPath: string, mime: string): string {
  const out = execFileSync(
    'python3',
    [
      '-c',
      'import sys,json,c2pa;print(json.loads(c2pa.Reader(sys.argv[2],open(sys.argv[1],"rb")).json()).get("validation_state"))',
      signedPath,
      mime,
    ],
    { encoding: 'utf8' },
  );
  return out.trim();
}

describe('signAsset end to end, through the real subprocess', () => {
  const runnable = haveSigner();
  let signAsset: typeof import('../../lib/c2pa/signAsset').signAsset;
  let work: string;

  before(async () => {
    // Explicit: a sibling test file replaces this with a shell shim, and
    // signAsset.ts reads it once at module load.
    process.env.SCRUPLE_C2PA_PYTHON = 'python3';
    // Dev cert is not on a trust list; without this the signer's
    // verify-after-sign rejects its own output.
    process.env.SCRUPLE_C2PA_DEV = '1';
    work = mkdtempSync(path.join(tmpdir(), 'scruple-c2pa-reachable-'));
    ({ signAsset } = await import('../../lib/c2pa/signAsset'));
  });

  test('a real PNG signs and reads back Valid', { skip: !runnable && 'no python3/c2pa or no dev key' }, async () => {
    const outputPath = path.join(work, 'png.c2pa.png');
    const r = await signAsset({
      assetPath: PNG,
      outputPath,
      product: 'studio',
      tier: 'bare',
      digitalSourceType: 'TRAINED_ALGORITHMIC_MEDIA',
    });
    assert.equal(r.ok, true, `PNG sign failed: ${!r.ok ? r.error : ''}`);
    if (!r.ok) return;
    assert.ok(r.bytes > 0);
    assert.equal(r.signingMode, 'local');
    // The identity reaches a witness leaf's payload_hash. It must name a
    // key that exists, not a string someone typed.
    assert.match(r.signerIdentity ?? '', /^local:\//);
    assert.doesNotMatch(r.signerIdentity ?? '', /es256/);
    assert.ok(existsSync(r.signerIdentity!.slice('local:'.length)), 'signerIdentity names a file that is not there');
    assert.equal(validationState(outputPath, 'image/png'), 'Valid');
  });

  test('a real MP4 signs and reads back Valid', { skip: !runnable && 'no python3/c2pa or no dev key' }, async () => {
    // The capability the survey measured and nothing could call.
    const outputPath = path.join(work, 'video.c2pa.mp4');
    const r = await signAsset({
      assetPath: MP4,
      outputPath,
      product: 'studio',
      tier: 'bare',
      digitalSourceType: 'TRAINED_ALGORITHMIC_MEDIA',
    });
    assert.equal(r.ok, true, `MP4 sign failed: ${!r.ok ? r.error : ''}`);
    if (!r.ok) return;
    assert.ok(r.bytes > 0);
    assert.equal(validationState(outputPath, 'video/mp4'), 'Valid');
  });

  test('a WebM is refused before python is spawned', async () => {
    // Does not need a signer: the point is that it never gets there.
    const r = await signAsset({
      assetPath: MP4, // real bytes; the .webm format is declared explicitly
      outputPath: path.join(work, 'nope.webm'),
      product: 'studio',
      tier: 'bare',
      format: 'video/webm',
      digitalSourceType: 'TRAINED_ALGORITHMIC_MEDIA',
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'unsupported_format');
    assert.match(r.error, /video\/webm/);
    assert.match(r.error, /MP4|video\/mp4/);
  });

  test('a PSD is refused, and the reason is the library, not our config', async () => {
    const r = await signAsset({
      assetPath: PNG,
      outputPath: path.join(work, 'nope.psd'),
      product: 'studio',
      tier: 'bare',
      format: 'image/vnd.adobe.photoshop',
      digitalSourceType: 'DIGITAL_CREATION',
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'unsupported_format');
    assert.match(r.error, /c2pa-rs/);
  });

  test('digitalSourceType still fails closed, and first', async () => {
    // Checked before the format and before the asset has to exist, so a
    // caller cannot learn anything by omitting it.
    const r = await signAsset({
      assetPath: '/definitely/not/here.png',
      outputPath: path.join(work, 'x.png'),
      product: 'studio',
      tier: 'bare',
    } as never);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'undeclared_source_type');
    assert.match(r.error, /will not\s+guess/);
  });
});

// ── the entry point the caller-adding WO will use ───────────────────────

describe('the documented entry point matches the route', () => {
  test('README.md exists beside the route', () => {
    assert.ok(existsSync(README_MD), 'app/api/scruple/c2pa/README.md is the contract for callers');
  });

  test('every field the route requires is documented', () => {
    const route = readFileSync(ROUTE_TS, 'utf8');
    const doc = readFileSync(README_MD, 'utf8');
    const body = route.match(/const Body = z\.object\(\{([\s\S]*?)\n\}\);/);
    assert.ok(body, 'Body schema not found in the route');
    const fields = [...body![1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    assert.ok(fields.length >= 5, `parsed too few fields: ${fields}`);
    for (const f of fields) {
      assert.ok(doc.includes(f), `${f} is in the route body but not in the README`);
    }
  });

  test('the README says digital_source_type is required and fails closed', () => {
    const doc = readFileSync(README_MD, 'utf8');
    assert.match(doc, /digital_source_type/);
    assert.match(doc, /required/i);
    assert.match(doc, /fails? closed|no default|never inferred|will not guess/i);
  });

  test('the route maps a refusal to a refusal status, not a 500', () => {
    const route = readFileSync(ROUTE_TS, 'utf8');
    assert.match(route, /unsupported_format[\s\S]{0,40}415/);
    assert.match(route, /undeclared_source_type/);
  });
});
