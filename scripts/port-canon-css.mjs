#!/usr/bin/env node
/**
 * port-canon-css.mjs — carry the canon desktop design into the shared theme.
 *
 * WO-D5. docs/DESIGN.md (scruple-desktop): "The UI is canon. ~2,951 lines of
 * CSS carrying 21 design tokens, which Web Studio was cloned from and then
 * drifted away from — the two share ZERO tokens today. The canon design is
 * ported INTO the shared theme once. After that there is one implementation
 * and nothing to diverge."
 *
 * ⚑ WHY THIS IS A SCRIPT AND NOT A HAND-EDITED FILE.
 *
 * "Ported once" is a claim that decays the moment someone edits the copy. A
 * generated file can be REGENERATED and compared, so `test/v2/canon-theme.test.ts`
 * asserts the committed app/theme/canon.css is byte-identical to what this
 * script produces from app/theme/canon-source/. Drift stops being something
 * anyone has to notice.
 *
 * WHAT IT DOES, AND THE THREE THINGS IT CHANGES.
 *
 *   1. SCOPES the rules. The canon shipped two stylesheets loaded globally into
 *      one document, and they COLLIDE: `.status-indicator` and `.btn-icon` and
 *      `.form-group` and `.help-text` are each defined in BOTH main.css and
 *      wallet.css, with different values, and wallet.css won because it loaded
 *      second. In a shared app those names would also collide with everything
 *      else. Every rule is therefore scoped under `.scruple-canon.workspace`
 *      or `.scruple-canon.wallet`, which both namespaces the design and makes
 *      the collision explicit instead of order-dependent.
 *
 *   2. LIFTS the tokens to a real :root — unscoped, because tokens are the
 *      shared theme's vocabulary and Tailwind reads them (tailwind.config.ts).
 *      Each colour token is emitted TWICE: as a space-separated channel triple
 *      `--x-rgb: 10 15 28` and as `--x: rgb(var(--x-rgb))`, which is the only
 *      form that lets a Tailwind opacity modifier (`bg-scruple-bg/10`, used in
 *      35 places today) work against a CSS variable. The hex is preserved in a
 *      comment and asserted against the canon source by the test.
 *
 *   3. NAMESPACES the keyframes (`spin` → `canon-spin`) so a canon animation
 *      cannot be shadowed by, or shadow, Tailwind's own.
 *
 * IT DOES NOT RESTYLE. No value is changed, no rule is dropped, no rule is
 * added. Two canon facts survive the port unrepaired, on purpose, and both are
 * pinned by the test:
 *
 *   - `--accent-hover` is REFERENCED by main.css (`.activate-btn:hover`) and
 *     DECLARED NOWHERE. That is the 21st token: the primary action button's
 *     hover background resolves to the initial value — transparent — leaving
 *     dark text on a dark panel. Carrying it across unrepaired is what makes
 *     the defect visible in the one implementation instead of invisible in two.
 *   - wallet.css declares no tokens at all; it reads 13 through `var(--x, #fallback)`
 *     where nothing declares `--x`, so the FALLBACK is what every wallet panel
 *     has always rendered. Those fallbacks are the wallet's real palette and
 *     they disagree with main.css: the wallet's accent is #4a9eff, main.css's
 *     is #00d9ff.
 *
 * Usage: node scripts/port-canon-css.mjs [--check]
 *   --check  regenerate and diff against the committed file; exit 1 on drift.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const postcss = require_('postcss');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'app', 'theme', 'canon-source');
const OUT = join(ROOT, 'app', 'theme', 'canon.css');

/** The canon's own scopes. One stylesheet each, one class each. */
const SHEETS = [
  { file: 'main.css', scope: '.scruple-canon.workspace', label: 'WORKSPACE — app-legacy/renderer/styles/main.css' },
  { file: 'wallet.css', scope: '.scruple-canon.wallet', label: 'WALLET — app-legacy/renderer/styles/wallet.css' },
];

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function hexToChannels(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
}

/**
 * Prefix one rule's selectors with the scope.
 *
 * `:root` is NOT scoped — it is hoisted out and handled separately, because a
 * token declared inside `.scruple-canon` would be invisible to Tailwind
 * utilities used anywhere else in the app, which is the whole point of moving
 * the tokens into the shared theme.
 */
function scopeSelector(sel, scope) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // `html`/`body` at the root of a scoped design would fight the app shell.
      // The canon's element-level rules become descendants of the scope like
      // everything else; `html`/`body` become the scope element itself — which
      // is what collapses `html, body, #root` into one selector, hence the dedupe.
      if (s === 'body' || s === 'html' || s === ':root') return scope;
      return `${scope} ${s}`;
    })
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(',\n');
}


/**
 * ⚑ THE CANON STYLESHEET DOES NOT PARSE.
 *
 * main.css:916 closes a rule that was already closed — a stray `}` at depth 0,
 * sitting between two conflicting `.console-logs` rules. Every browser silently
 * recovers from that (the CSS error-recovery rules say: discard, resynchronise,
 * carry on), which is why it shipped and why nobody saw it. postcss does not
 * recover, and that is a feature: a design being carried into a shared theme
 * should be parsed by something that tells the truth about it.
 *
 * This removes stray depth-0 closers and REPORTS each one, so the defect is
 * recorded in the generated file rather than fixed in the source copy — the
 * source copy stays byte-identical to the desktop original, which is what makes
 * the checksum in scripts/d5-gate.sh mean anything.
 *
 * It is deliberately the only repair. Nothing else about the bytes is touched.
 */
function desyntax(css, file) {
  let out = '', depth = 0, i = 0;
  const strays = [];
  while (i < css.length) {
    // comments and strings are not structure
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) {
        strays.push({ line: css.slice(0, i).split('\n').length, what: "unterminated '/*' comment, truncated at EOF" });
        break;                     // nothing after an unclosed comment is CSS
      }
      out += css.slice(i, end + 2); i = end + 2; continue;
    }
    const c = css[i];
    // A lone '/' where a selector would start: main.css ends in one, a comment
    // opener that was cut in half. A browser drops the rest of the sheet; there
    // is no rest, so dropping it loses nothing.
    if (c === '/' && css[i + 1] !== '*' && depth === 0 && !css.slice(i + 1).trim()) {
      strays.push({ line: css.slice(0, i).split('\n').length, what: "dangling '/' at EOF — half of a comment opener" });
      break;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0) {
        strays.push({ line: css.slice(0, i).split('\n').length, what: "stray '}' at depth 0" });
        i++; continue;             // drop it, exactly as a browser does
      }
      depth--;
    }
    out += c; i++;
  }
  for (const s of strays) {
    console.error(`  ⚑ ${file}:${s.line} — ${s.what}; dropped, as a browser drops it`);
  }
  return { css: out, strays };
}

function port() {
  const out = [];
  const tokens = [];       // { name, value, hex }
  const defects = [];      // what the canon got wrong, recorded not repaired
  const keyframes = [];    // renamed names, in first-seen order
  const keyframeBodies = new Map();

  out.push(`/* GENERATED by scripts/port-canon-css.mjs — DO NOT EDIT.
 *
 * The canon desktop design, carried into the shared Next theme (WO-D5).
 * Source of truth: app/theme/canon-source/*.css, byte-identical to
 * scruple-desktop/app-legacy/renderer/styles/*.css.
 *
 * Regenerate:  node scripts/port-canon-css.mjs
 * Check drift: node scripts/port-canon-css.mjs --check
 */\n`);

  const bodies = [];
  // filled by the sheet loop below; the header is spliced in afterwards.

  for (const sheet of SHEETS) {
    const raw = readFileSync(join(SRC, sheet.file), 'utf8');
    const { css, strays } = desyntax(raw, sheet.file);
    for (const d of strays) defects.push(`${sheet.file}:${d.line} — ${d.what}`);
    const root = postcss.parse(css);

    // A name read with TWO different fallbacks is not a token, it is two
    // literals wearing one name. wallet.css does this, and it is why the
    // wallet's fallback palette is NOT hoisted into :root here: hoisting would
    // have to pick one of the two and would silently restyle the other site.
    const fallbacks = new Map();
    root.walkDecls((d) => {
      for (const m of d.value.matchAll(/var\((--[a-z-]+)\s*,\s*([^)]+)\)/g)) {
        if (!fallbacks.has(m[1])) fallbacks.set(m[1], new Set());
        fallbacks.get(m[1]).add(m[2].trim());
      }
    });
    for (const [name, vals] of fallbacks) {
      if (vals.size > 1) {
        defects.push(`${sheet.file} — ${name} is read with ${vals.size} different fallbacks (${[...vals].join(', ')}); left as written`);
      }
    }
    const localKeyframes = new Set();

    // Pass 1 — collect @keyframes names so references can be renamed too.
    root.walkAtRules('keyframes', (at) => localKeyframes.add(at.params.trim()));

    root.walk((node) => {
      if (node.type !== 'decl') return;
      if (!/^(animation|animation-name)$/i.test(node.prop)) return;
      for (const name of localKeyframes) {
        node.value = node.value.replace(new RegExp(`\\b${name}\\b`, 'g'), `canon-${name}`);
      }
    });

    // KEYFRAMES CANNOT BE SCOPED BY A CLASS — @keyframes lives in one global
    // namespace whatever the rules around it say. The canon relies on that: it
    // declares `spin` in BOTH sheets and `pulse` twice in main.css. Every
    // duplicate is byte-identical, so hoisting one copy changes nothing; if one
    // ever were NOT identical this refuses rather than silently picking a
    // winner, which is what load order was doing before.
    root.walkAtRules('keyframes', (at) => {
      const name = `canon-${at.params.trim()}`;
      at.params = name;
      const body = at.toString();
      if (keyframeBodies.has(name)) {
        if (keyframeBodies.get(name) !== body) {
          throw new Error(
            `@keyframes ${at.params} is declared twice with DIFFERENT bodies ` +
            `(${sheet.file}). Load order decided this before; it is not something to guess at.`
          );
        }
        defects.push(`${sheet.file} — @keyframes ${at.params} declared again, byte-identical; one copy kept`);
      } else {
        keyframeBodies.set(name, body);
        keyframes.push(name);
      }
      at.remove();
    });

    // Pass 2 — hoist :root tokens, scope everything else.
    root.walkRules((rule) => {
      if (rule.parent && rule.parent.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;
      if (rule.selector.trim() === ':root') {
        rule.walkDecls((d) => {
          if (!d.prop.startsWith('--')) return;
          const value = d.value.trim();
          tokens.push({ name: d.prop, value, hex: HEX.test(value) ? value : null });
        });
        rule.remove();
        return;
      }
      rule.selector = scopeSelector(rule.selector, sheet.scope);
    });

    bodies.push(`/* ═══ ${sheet.label} ═══ */\n\n${root.toString().trim()}\n`);
  }

  // ── the token layer ──────────────────────────────────────────────────────
  const lines = [];
  lines.push('/* ═══ CANON TOKENS ═══');
  lines.push(' *');
  lines.push(` * ${tokens.length} declared by the canon, verbatim. A 21st name, --accent-hover, is`);
  lines.push(' * REFERENCED by .activate-btn:hover and declared by nothing; it is left');
  lines.push(' * undeclared here for the same reason it is left undeclared there, and');
  lines.push(' * test/v2/canon-theme.test.ts pins that so it cannot change by accident.');
  lines.push(' *');
  lines.push(' * Colours are emitted as channels + rgb() so `bg-scruple-bg/10` works.');
  lines.push(' */');
  lines.push(':root {');
  for (const t of tokens) {
    if (t.hex) {
      lines.push(`  ${t.name}-rgb: ${hexToChannels(t.hex)};       /* ${t.hex} */`);
      lines.push(`  ${t.name}: rgb(var(${t.name}-rgb));`);
    } else {
      lines.push(`  ${t.name}: ${t.value};`);
    }
  }
  lines.push('}\n');

  if (defects.length) {
    out.push(
      '/* ⚑ CANON DEFECTS FOUND BY THE PORT — dropped here exactly as a browser\n' +
      ' * drops them, and NOT repaired in app/theme/canon-source/, which stays\n' +
      ' * byte-identical to the desktop original:\n' +
      defects.map((d) => ` *   - ${d}`).join('\n') +
      '\n */\n'
    );
  }
  out.push(lines.join('\n'));
  out.push(
    '/* ═══ CANON KEYFRAMES ═══ @keyframes has one global namespace, so these\n' +
    ' * are prefixed rather than scoped, and every `animation:` in the ported\n' +
    ' * rules was rewritten to match. */\n\n' +
    [...keyframeBodies.values()].join('\n\n') + '\n'
  );
  out.push(bodies.join('\n'));

  return { css: out.join('\n'), tokens, keyframes, defects };
}

const { css, tokens, keyframes, defects } = port();

if (process.argv.includes('--check')) {
  const have = readFileSync(OUT, 'utf8');
  if (have !== css) {
    console.error('DRIFT: app/theme/canon.css is not what canon-source/ ports to.');
    process.exit(1);
  }
  console.log(`canon.css is current — ${tokens.length} tokens, ${keyframes.length} keyframes`);
  process.exit(0);
}

writeFileSync(OUT, css);
console.log(`wrote ${OUT}`);
console.log(`  ${tokens.length} tokens: ${tokens.map((t) => t.name).join(', ')}`);
console.log(`  keyframes: ${keyframes.join(', ')}`);
for (const d of defects) console.log(`  canon defect recorded: ${d}`);
