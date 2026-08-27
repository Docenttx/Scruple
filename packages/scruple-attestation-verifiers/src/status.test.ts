// Standard §12.4, as tests.
//
//   "A receipt MUST visibly distinguish a Scruple-verified attestation
//    from a stored-but-unverified (passthrough) one. A passthrough
//    attestation MUST NOT present identically to a root-verified one.
//    'Stored' MUST NOT read as 'verified.'"
//
// This was the one clause the estate actively VIOLATED rather than merely
// failed to implement. All six built-in plugins performed structural
// checks — parse, nonce, cert subjects — and returned ok:true with the
// caveat tucked into an optional benign_codes array, so every consumer
// reading `ok` saw a root-verified attestation that did not exist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This suite scans SOURCE, not build output — the guarantee is about what
// the plugins are written to do. Tests execute from dist/, so walk back to
// the package root and look in src/plugins.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.basename(HERE) === 'dist' ? path.dirname(HERE) : path.dirname(HERE);
const PLUGIN_DIR = path.join(PKG_ROOT, 'src', 'plugins');

const pluginFiles = readdirSync(PLUGIN_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('.test.') && f !== 'all_verifiers.ts');

describe('no plugin may claim root verification it did not perform', () => {
  test('there are six built-in plugins', () => {
    assert.equal(pluginFiles.length, 6, `found ${pluginFiles.join(', ')}`);
  });

  for (const f of pluginFiles) {
    test(`${f} does not call verifyRootVerified`, () => {
      const src = readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
      assert.ok(
        !/verifyRootVerified/.test(src),
        `${f} claims root verification. No plugin implements signature chaining to a ` +
          `vendor root yet, so this is a §12.4 violation. If chaining HAS been ` +
          `implemented, delete this assertion in the same commit and say so.`,
      );
    });

    test(`${f} returns a stated reason with its passthrough`, () => {
      const src = readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
      assert.match(src, /verifyPassthrough\(/, `${f} must state which state it is in`);
      assert.match(
        src,
        /not verified (to|against)/i,
        `${f}'s passthrough reason must say what was NOT verified — it reaches the receipt`,
      );
    });

    test(`${f} never hand-builds a VerifyResult`, () => {
      // Precise on purpose: a bare `ok: true` is fine on an internal
      // helper (sev_snp's certChainSanity returns one). What must never
      // appear is a hand-built VERIFY RESULT — recognisable because it
      // carries `provider` — since that is the shape whose `status` can
      // be forgotten. Status has to come from a factory.
      const src = readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
      const offenders: string[] = [];
      for (const m of src.matchAll(/ok:\s*true/g)) {
        const window = src.slice(m.index!, m.index! + 300);
        if (/provider:/.test(window) && !/status:/.test(window)) {
          offenders.push(src.slice(0, m.index!).split('\n').length.toString());
        }
      }
      assert.deepEqual(
        offenders, [],
        `${f} hand-builds a VerifyResult at line(s) ${offenders.join(', ')} without a ` +
          `status. Use verifyPassthrough() or verifyRootVerified().`,
      );
    });
  }
});

describe('the factories', () => {
  test('verifyRootVerified demands evidence of what it chained to', async () => {
    const { verifyRootVerified } = await import('./verifier.js');
    const r = verifyRootVerified('x', { root_subject: 'CN=Root', chain_length: 3 });
    assert.equal(r.status, 'verified');
    assert.equal(r.passthrough, false);
    assert.equal(r.root_subject, 'CN=Root');
  });

  test('verifyPassthrough requires a reason and never reads as verified', async () => {
    const { verifyPassthrough } = await import('./verifier.js');
    const r = verifyPassthrough('x', 'chain not verified to root');
    assert.equal(r.status, 'passthrough');
    assert.equal(r.passthrough, true);
    assert.notEqual(r.status, 'verified');
    assert.match(r.verifier_reference!, /not verified/);
  });

  test('the ambiguous factory is gone', async () => {
    const mod = await import('./verifier.js');
    assert.ok(
      !('verifySuccess' in mod),
      'verifySuccess let a caller return ok:true without saying which kind of success it was',
    );
  });
});

describe('ok is not a verification claim', () => {
  test('a passthrough is ok:true — acceptance and verification are different questions', async () => {
    const { verifyPassthrough } = await import('./verifier.js');
    const r = verifyPassthrough('x', 'not verified to root');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'passthrough');
  });
});
