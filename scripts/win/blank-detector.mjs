#!/usr/bin/env node
/**
 * Is this capture a uniform (blank) frame, or does it carry real content?
 *
 * ⚑ THIS DETECTOR IS NEW AND WAS NOT INHERITED. docs/DESIGN.md says a screenshot
 * on the build box "will be blank — llvmpipe's framebuffer readback returns a
 * uniform image — three approaches were tried against Blender and a detector
 * proven on real renders." That detector is NOT in this repo, nor in
 * scruple-web, nor in the addon tree; it was ad hoc on the build box and did not
 * survive into the shared record. So this is a re-implementation, and by the
 * project's own rails an unproven instrument may not be used to score anything
 * until its controls are demonstrated.
 *
 * Hence --selftest, which is not decoration. It builds frames whose answer is
 * known by construction and requires the detector to separate them. Any run that
 * scores a real capture should run the selftest in the same process first; if a
 * control fails, the verdict on the real capture is INCONCLUSIVE, never a pass.
 *
 * Operates on RAW pixel bytes, never on PNG. Decoding a PNG would put an image
 * library between the framebuffer and the measurement, and the question here is
 * precisely what the framebuffer produced.
 */

/**
 * @param {Buffer|Uint8Array} buf raw pixels
 * @param {number} width
 * @param {number} height
 * @param {number} channels 4 = BGRA/RGBA, 3 = BGR/RGB
 */
export function analyze(buf, width, height, channels = 4) {
  const px = width * height;
  const expected = px * channels;
  if (buf.length < expected) {
    throw new Error(`buffer too small: got ${buf.length}, need ${expected} (${width}x${height}x${channels})`);
  }

  // Luminance stats via Welford, plus a colour census. Two independent signals:
  // a uniform frame has zero variance AND one colour. Requiring both means a
  // pathological frame that defeats one still has to defeat the other.
  let n = 0, mean = 0, m2 = 0;
  let min = 255, max = 0;
  const colours = new Map();
  const COLOUR_CAP = 4096; // stop counting once clearly non-uniform

  for (let i = 0; i < expected; i += channels) {
    const b = buf[i], g = buf[i + 1], r = buf[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    n++;
    const d = y - mean;
    mean += d / n;
    m2 += d * (y - mean);
    if (y < min) min = y;
    if (y > max) max = y;

    if (colours.size < COLOUR_CAP) {
      const key = (r << 16) | (g << 8) | b;
      colours.set(key, (colours.get(key) ?? 0) + 1);
    }
  }

  const stddev = Math.sqrt(m2 / n);
  let modalCount = 0;
  for (const c of colours.values()) if (c > modalCount) modalCount = c;
  const modalFraction = modalCount / n;

  // A frame is blank when it is flat by BOTH measures. The thresholds are loose
  // on purpose: llvmpipe's failure mode is an exactly-uniform buffer, not a
  // subtly flat one, so a detector that needs fine tuning to see it is a
  // detector that is measuring something else.
  const distinctColours = colours.size >= COLOUR_CAP ? `>=${COLOUR_CAP}` : colours.size;
  const flatByVariance = stddev < 0.5;
  const flatByColour = colours.size <= 2 && modalFraction > 0.999;
  const blank = flatByVariance && flatByColour;

  return {
    width, height, channels, pixels: px,
    luminance: {
      mean: +mean.toFixed(4),
      stddev: +stddev.toFixed(4),
      min: +min.toFixed(2),
      max: +max.toFixed(2),
      range: +(max - min).toFixed(2),
    },
    distinctColours,
    modalFraction: +modalFraction.toFixed(6),
    flatByVariance,
    flatByColour,
    blank,
    verdict: blank ? 'BLANK' : 'NON-BLANK',
  };
}

// ---- controls -------------------------------------------------------------
// Each case states what it proves. A detector that cannot fail these cannot be
// trusted to have failed on a real capture either.

function frameUniform(w, h, v) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < b.length; i += 4) { b[i] = v; b[i + 1] = v; b[i + 2] = v; b[i + 3] = 255; }
  return b;
}

function frameUniformPlusOnePixel(w, h, v) {
  const b = frameUniform(w, h, v);
  b[0] = 255 - v; b[1] = 255 - v; b[2] = 255 - v;
  return b;
}

function frameContent(w, h) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const box = (x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7) ? 90 : 0;
      b[i] = Math.min(255, (x * 255 / w) | 0);
      b[i + 1] = Math.min(255, ((y * 255 / h) | 0) + box);
      b[i + 2] = Math.min(255, 128 + box);
      b[i + 3] = 255;
    }
  }
  return b;
}

export function selftest(log = console.log) {
  const W = 160, H = 120;
  const cases = [
    { name: 'uniform black  (llvmpipe failure mode)', buf: frameUniform(W, H, 0),   expect: 'BLANK',
      proves: 'the detector CAN say BLANK — without this, a NON-BLANK verdict is unfalsifiable' },
    { name: 'uniform white', buf: frameUniform(W, H, 255), expect: 'BLANK',
      proves: 'blankness is flatness, not darkness — a white frame is just as blank' },
    { name: 'uniform mid-grey', buf: frameUniform(W, H, 128), expect: 'BLANK',
      proves: 'no dependence on the particular fill value' },
    { name: 'gradient + box (real content)', buf: frameContent(W, H), expect: 'NON-BLANK',
      proves: 'the detector CAN say NON-BLANK — without this it might call everything blank' },
    { name: 'uniform + ONE differing pixel', buf: frameUniformPlusOnePixel(W, H, 0), expect: 'NON-BLANK',
      proves: 'sensitivity floor: a frame that is 99.995% flat is still not uniform, and the detector must not round it to blank' },
  ];

  let pass = 0, fail = 0;
  log('[blank-detector] controls:');
  for (const c of cases) {
    const r = analyze(c.buf, W, H, 4);
    const ok = r.verdict === c.expect;
    ok ? pass++ : fail++;
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    log(`        expected ${c.expect}, got ${r.verdict}  (stddev=${r.luminance.stddev} colours=${r.distinctColours} modal=${r.modalFraction})`);
    log(`        proves: ${c.proves}`);
  }
  log(`[blank-detector] controls: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (process.argv[1] && process.argv[1].endsWith('blank-detector.mjs')) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else {
    console.log('usage: node scripts/win/blank-detector.mjs --selftest');
    console.log('       (import { analyze } from this module to score a real capture)');
  }
}
