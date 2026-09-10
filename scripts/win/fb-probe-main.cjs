/**
 * Electron framebuffer probe — does capturePage() return real pixels on Windows?
 *
 * This is the capture W1-A would store as an artifact, so it is the one whose
 * blankness actually matters. The desktop-level CopyFromScreen probe answers a
 * different question (is there a live framebuffer at all); this answers whether
 * ELECTRON can read its own window.
 *
 * ⚑ THE CONTROL IS THE POINT. Capturing a content-rich page and getting
 * NON-BLANK proves nothing on its own — a capturePage that returned uninitialised
 * memory, or a fixed test pattern, or the desktop behind the window, would also
 * read NON-BLANK. So we also capture a DELIBERATELY UNIFORM page and require it
 * to come back BLANK. Only if the two disagree in the predicted direction is
 * capturePage demonstrably reading this window's own pixels.
 *
 * Third capture: the same content page in a window created with show:false.
 * The driver may well run that way, and "headless in practice while believing
 * itself headed" is the failure the build box warned about.
 *
 * Writes <out>/<label>.raw + .json for scripts/win/score-capture.mjs.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? '.';

// ⚑ FILES, NOT data: URLs. The first data: navigation succeeded and the second
// failed with ERR_FAILED (-2) — Chromium is inconsistent about repeated data:
// top-level navigations. Whatever the cause, a probe whose loader sometimes
// fails cannot distinguish "the framebuffer is blank" from "the page never
// loaded", so the loader is removed from the experiment.
function pageFile(name, html) {
  const p = path.join(OUT, `${name}.html`);
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

const CONTENT_PAGE = pageFile('page-content', `
<html><body style="margin:0">
  <div style="width:100vw;height:100vh;background:linear-gradient(135deg,#0b1220 0%,#2563eb 45%,#f59e0b 100%);
              display:flex;align-items:center;justify-content:center;
              font:700 64px system-ui;color:#fff;text-shadow:0 2px 18px rgba(0,0,0,.6)">
    SCRUPLE W1 FRAMEBUFFER PROBE
  </div>
</body></html>`);

// Exactly one colour, edge to edge. If capturePage reads this window, this MUST
// score BLANK. If it scores NON-BLANK, the capture is not this window.
const UNIFORM_PAGE = pageFile('page-uniform', `
<html><body style="margin:0;background:#3a3a3a">
  <div style="width:100vw;height:100vh;background:#3a3a3a"></div>
</body></html>`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWindow(show) {
  return new BrowserWindow({
    width: 1000, height: 700, show,
    backgroundColor: '#3a3a3a',
    webPreferences: { offscreen: false },
  });
}

// ONE WINDOW, RELOADED — not a fresh window per capture. This tightens the
// control: content and uniform now differ only in the page, not in the window.
//
// ⚑ It also sidesteps something NOT understood. Two early runs failed right
// after a destroy() — once ERR_FAILED (-2) on the next load, once a silent
// process exit. scripts/win/window-lifecycle-probe.cjs was written to pin the
// cause and FAILED TO REPRODUCE IT in four configurations (show:false and
// visible, about:blank and real content, with and without a window-all-closed
// handler, capturePage before destroy). So the cause is UNKNOWN. This layout is
// chosen because it is the one observed to work, not because the failure is
// explained — and it is deliberately not written up as a platform finding,
// because an unreproduced observation is not one.
async function capture(label, file, opts, expectation) {
  const win = opts.win;
  await win.loadFile(file);
  // Let a frame actually composite. A capture taken before first paint is a
  // measurement of our own impatience, not of the framebuffer.
  await delay(1200);

  const image = await win.capturePage();
  const size = image.getSize();
  const buf = image.toBitmap(); // BGRA, raw — no PNG codec in the path

  fs.writeFileSync(path.join(OUT, `${label}.raw`), buf);
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify({
    label: `${label} (${opts.show ? 'visible window' : 'show:false window'})`,
    capturedAt: new Date().toISOString(),
    width: size.width, height: size.height, channels: 4,
    bytes: buf.length,
    source: 'Electron BrowserWindow.capturePage().toBitmap()',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    windowShown: opts.show,
    isEmptyPerElectron: image.isEmpty(),
    requestedLogicalSize: { width: 1000, height: 700 },
    expectation,
  }, null, 2));

  console.log(`[fb-probe] ${label}: ${size.width}x${size.height}, ${buf.length} bytes, electron says isEmpty=${image.isEmpty()} (expect ${expectation})`);
}

app.whenReady().then(async () => {
  try {
    // BOTH WINDOWS UP FRONT, for the reason in the header comment: the
    // post-destroy failures are unexplained and unreproduced, so this avoids
    // the shape they occurred in rather than claiming to have fixed it.
    const visible = makeWindow(true);
    const hidden = makeWindow(false);

    await capture('electron-content-visible', CONTENT_PAGE, { win: visible, show: true }, 'NON-BLANK');
    await capture('electron-uniform-visible', UNIFORM_PAGE, { win: visible, show: true }, 'BLANK');
    await capture('electron-content-hidden', CONTENT_PAGE, { win: hidden, show: false }, 'unknown — this is the question');

    console.log('[fb-probe] done');
    app.exit(0);
  } catch (err) {
    console.error('[fb-probe] FAILED', err);
    app.exit(1);
  }
});
