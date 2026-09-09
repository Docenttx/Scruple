// The canon design lives here now, and it is the same canon design.
//
// WO-D5 (scruple-desktop/docs/WORK-ORDERS.md): "Port the canon design — 21
// tokens, the workspace and wallet layouts from
// app-legacy/renderer/styles/main.css — INTO the shared Next theme. Do not
// restyle; carry the design across."
//
// "Carried across once" is a claim with a shelf life, so these tests are about
// the SHELF LIFE rather than about the port: they check that the committed
// theme is still what the canon source ports to, that the palette exists in one
// place rather than two, and that the canon's own defects are still recorded as
// defects instead of quietly becoming decisions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'app', 'theme', 'canon-source');
const THEME = readFileSync(join(ROOT, 'app', 'theme', 'canon.css'), 'utf8');
const TAILWIND = readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf8');
const CANON_MAIN = readFileSync(join(SRC, 'main.css'), 'utf8');
const CANON_WALLET = readFileSync(join(SRC, 'wallet.css'), 'utf8');

/** The canon's :root, parsed from the canon's own bytes. */
function canonTokens(): Map<string, string> {
  const root = CANON_MAIN.slice(CANON_MAIN.indexOf(':root'));
  const block = root.slice(root.indexOf('{') + 1, root.indexOf('}'));
  const out = new Map<string, string>();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*(--[a-z-]+)\s*:\s*([^;]+);/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function hexToChannels(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
}

describe('the theme is what the canon ports to', () => {
  test('regenerating from canon-source/ reproduces the committed canon.css', () => {
    // The strongest form of "one implementation": the file is not maintained,
    // it is DERIVED, and a hand edit to it fails here.
    execFileSync('node', [join(ROOT, 'scripts', 'port-canon-css.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  });

  test('every token the canon declares is in the theme, at the canon’s value', () => {
    const tokens = canonTokens();
    assert.equal(tokens.size, 20, 'the canon declares 20 tokens; a 21st is referenced and never declared');

    for (const [name, value] of tokens) {
      if (/^#[0-9a-f]{3,6}$/i.test(value)) {
        // Colours are carried as channels so a Tailwind opacity modifier can
        // reach them. The channels must be the SAME colour.
        assert.match(
          THEME,
          new RegExp(`${name}-rgb:\\s*${hexToChannels(value)};`),
          `${name} (${value}) is not in the theme as channels`,
        );
        assert.match(THEME, new RegExp(`${name}: rgb\\(var\\(${name}-rgb\\)\\);`), `${name} has no rgb() form`);
      } else {
        assert.match(THEME, new RegExp(`${name}: ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`), `${name} is not in the theme`);
      }
    }
  });

  test('the workspace and wallet layouts both came across, each in its own scope', () => {
    // The canon's two stylesheets collide — .status-indicator, .btn-icon,
    // .form-group and .help-text are defined in both, and load order decided
    // the winner. Scoping is what stops that being a property of an import.
    for (const cls of ['.sidebar', '.app-container', '.main-content', '.lock-buttons', '.active-project', '.project-item']) {
      assert.ok(THEME.includes(`.scruple-canon.workspace ${cls}`), `workspace layout is missing ${cls}`);
    }
    for (const cls of ['.wallet-container', '.panel-header', '.panel-body', '.connection-flags', '.mnemonic-display']) {
      assert.ok(THEME.includes(`.scruple-canon.wallet ${cls}`), `wallet layout is missing ${cls}`);
    }
    for (const collide of ['.status-indicator', '.btn-icon', '.form-group', '.help-text']) {
      assert.ok(THEME.includes(`.scruple-canon.workspace ${collide}`), `${collide} lost its workspace copy`);
      assert.ok(THEME.includes(`.scruple-canon.wallet ${collide}`), `${collide} lost its wallet copy`);
    }
  });

  test('nothing outside the scope was touched — no bare canon selector leaks', () => {
    // A rule that escaped the scope would restyle every existing Tailwind page.
    for (const line of THEME.split('\n')) {
      if (!/^\s*\.[a-z]/i.test(line)) continue;
      assert.ok(
        line.trimStart().startsWith('.scruple-canon'),
        `a canon rule escaped its scope and would hit the whole app: ${line.trim()}`,
      );
    }
  });
});

describe('the palette has one definition, not two', () => {
  test('tailwind reads the tokens instead of copying their hex', () => {
    // This is the drift the WO exists to end: before it, main.css said #00d9ff
    // and tailwind.config.ts said #00d9ff, and nothing connected them.
    for (const [name, value] of canonTokens()) {
      if (!/^#[0-9a-f]{3,6}$/i.test(value)) continue;
      assert.ok(
        !TAILWIND.includes(value),
        `tailwind.config.ts still hard-codes ${value} (${name}); it must read the token`,
      );
    }
    assert.match(TAILWIND, /rgb\(var\(--accent-primary-rgb\) \/ <alpha-value>\)/);
    assert.match(TAILWIND, /sidebar: 'var\(--sidebar-width\)'/);
  });

  test('the wallet fallbacks are NOT hoisted, and the reason is in the file', () => {
    // wallet.css reads --code-bg with two different fallbacks at two sites.
    // A token can hold one value; hoisting would have to pick one and would
    // silently restyle the other. So they stay literal, and the theme says so.
    assert.match(THEME, /--code-bg is read with 2 different fallbacks/);
    assert.ok(TAILWIND.includes("'code-bg': '#2a2a2a'"), 'the wallet literals are still literals');
  });
});

describe('the canon’s defects are recorded, not repaired', () => {
  test('--accent-hover is referenced by the canon and declared by nobody', () => {
    // The 21st token. `.activate-btn:hover { background: var(--accent-hover) }`
    // resolves to the initial value, so the primary action button goes
    // transparent on hover. Carrying it across unrepaired is what makes the
    // defect visible in ONE implementation instead of invisible in two.
    assert.match(CANON_MAIN, /--accent-hover/, 'the canon no longer references it — this test is stale');
    assert.ok(
      !/^\s*--accent-hover\s*:/m.test(CANON_MAIN),
      'the canon now declares it; the port should stop calling it undeclared',
    );
    assert.ok(
      !/^\s*--accent-hover\s*:/m.test(THEME),
      'the theme declared it. That is a repair, and a repair is a restyle: it changes what the button does on hover.',
    );
    assert.ok(THEME.includes('.activate-btn:hover'), 'the rule itself came across');
  });

  test('the two syntax defects are still recorded in the generated header', () => {
    // main.css does not parse: a stray `}` at 916 and a half-written comment
    // opener at EOF. Browsers recover silently, which is why it shipped.
    assert.match(THEME, /main\.css:916 — stray '\}' at depth 0/);
    assert.match(THEME, /main\.css:2176 — dangling '\/' at EOF/);
  });

  test('wallet.css still declares no tokens of its own', () => {
    assert.ok(
      !/^\s*--[a-z-]+\s*:/m.test(CANON_WALLET),
      'wallet.css now declares tokens; the port’s account of it is out of date',
    );
  });
});
