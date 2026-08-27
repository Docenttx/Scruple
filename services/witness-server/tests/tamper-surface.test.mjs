import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tamperSurface, TRACKED } from '../tamper-surface.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function copyOfSource() {
  const d = mkdtempSync(path.join(tmpdir(), 'witness-ts-'));
  for (const f of TRACKED) cpSync(path.join(HERE, f), path.join(d, f));
  return d;
}

describe('tamper surface', () => {
  test('is stable across runs', () => {
    assert.equal(tamperSurface(HERE).tamper_surface_hash, tamperSurface(HERE).tamper_surface_hash);
  });

  test('an identical copy hashes identically — location does not matter', () => {
    const d = copyOfSource();
    try {
      assert.equal(tamperSurface(d).tamper_surface_hash, tamperSurface(HERE).tamper_surface_hash);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('one changed byte in any tracked file changes the hash', () => {
    for (const target of TRACKED) {
      const d = copyOfSource();
      try {
        const p = path.join(d, target);
        writeFileSync(p, ' ', { flag: 'a' });
        assert.notEqual(
          tamperSurface(d).tamper_surface_hash,
          tamperSurface(HERE).tamper_surface_hash,
          `appending a byte to ${target} did not change the surface`,
        );
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
  });

  test('an untracked file dropped in the directory does NOT change the hash', () => {
    // Deliberate. The surface is an explicit list, not a directory walk:
    // adding a file must change the hash for a reason we can name, not
    // because a glob happened to widen. The cost is that the list has to
    // be maintained, which is the right cost.
    const d = copyOfSource();
    try {
      const before = tamperSurface(d).tamper_surface_hash;
      writeFileSync(path.join(d, 'notes.txt'), 'hello');
      assert.equal(tamperSurface(d).tamper_surface_hash, before);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a missing tracked file is reported, not silently skipped', () => {
    const d = copyOfSource();
    try {
      rmSync(path.join(d, 'testnet-locker.js'));
      const r = tamperSurface(d);
      assert.equal(r.complete, false);
      assert.ok(r.files.find((f) => f.file === 'testnet-locker.js').missing);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('the canonical form is reproducible with sha256sum by hand', () => {
    // A reviewer must be able to check this without running our code.
    const r = tamperSurface(HERE);
    for (const line of r.canonical.trim().split('\n')) {
      assert.match(line, /^[0-9a-f]{64}  \S+$/);
    }
    assert.ok(r.canonical.endsWith('\n'));
  });
});

describe('what the surface does NOT claim', () => {
  test('node_modules is not part of it', () => {
    assert.ok(!TRACKED.includes('node_modules'));
  });
  test('neither is the database or any key material', () => {
    for (const f of TRACKED) {
      assert.ok(!/witness\.db|arweave-key/.test(f), `${f} must never be in the tamper surface`);
    }
  });
});
