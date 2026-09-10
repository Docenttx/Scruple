#!/usr/bin/env node
/**
 * Score a raw capture with the blank detector, controls first.
 *
 * The controls run in THIS process, immediately before the real verdict. If any
 * control fails the capture is reported INCONCLUSIVE and the process exits
 * non-zero — an instrument that cannot be shown to work does not get to say the
 * framebuffer is fine. docs/README-TRAVEL-LAPTOP.md: "An inconclusive control is
 * scored INCONCLUSIVE, never as a pass."
 *
 *   node scripts/win/score-capture.mjs <capture-basename> [more...]
 */
import fs from 'node:fs';
import { analyze, selftest } from './blank-detector.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/win/score-capture.mjs <basename-without-extension> [...]');
  process.exit(64);
}

const controlsOk = selftest();
console.log('');
if (!controlsOk) {
  console.log('INCONCLUSIVE — detector controls failed; no verdict is issued on any capture.');
  process.exit(3);
}

// ⚑ Scored against the DECLARED expectation, not against blankness. The uniform
// control is SUPPOSED to come back BLANK; a scorer that treated any blank frame
// as failure would mark a working control as a fault, which is the same class of
// error as a gate with no control — it just points the other way.
const results = [];
let mismatches = 0;

for (const base of args) {
  const rawPath = `${base}.raw`;
  const metaPath = `${base}.json`;
  if (!fs.existsSync(rawPath) || !fs.existsSync(metaPath)) {
    console.log(`MISSING  ${base} (.raw or .json absent)`);
    results.push({ base, verdict: 'MISSING' });
    continue;
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const buf = fs.readFileSync(rawPath);
  const r = analyze(buf, meta.width, meta.height, meta.channels ?? 4);

  console.log(`[capture] ${meta.label ?? base}`);
  console.log(`   captured   ${meta.capturedAt ?? '?'}`);
  console.log(`   geometry   ${r.width}x${r.height}x${r.channels}  (${r.pixels} px)`);
  console.log(`   luminance  mean=${r.luminance.mean} stddev=${r.luminance.stddev} range=${r.luminance.range} [${r.luminance.min}..${r.luminance.max}]`);
  console.log(`   colours    distinct=${r.distinctColours}  modalFraction=${r.modalFraction}`);
  console.log(`   VERDICT    ${r.verdict}`);

  const expected = meta.expectation;
  let outcome = 'RECORDED';
  if (expected === 'BLANK' || expected === 'NON-BLANK') {
    const ok = r.verdict === expected;
    if (!ok) mismatches++;
    outcome = ok ? `MATCHES declared expectation (${expected})` : `MISMATCH — declared ${expected}, measured ${r.verdict}`;
    console.log(`   CONTROL    ${outcome}`);
  } else if (expected) {
    console.log(`   CONTROL    no expectation declared (${expected})`);
  }
  console.log('');

  results.push({ base, label: meta.label, capturedAt: meta.capturedAt, expected: expected ?? null, outcome, ...r });
}

fs.writeFileSync('scripts/win/last-capture-scores.json', JSON.stringify(results, null, 2));
console.log(`scored ${results.length} capture(s), ${mismatches} mismatch(es); wrote scripts/win/last-capture-scores.json`);
process.exit(mismatches ? 1 : 0);
