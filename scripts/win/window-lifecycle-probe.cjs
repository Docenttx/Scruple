/**
 * Is "a BrowserWindow created after destroy() is broken" a Windows fact, or my bug?
 *
 * Observed twice while building the framebuffer probe: creating a window after
 * destroy()ing the previous one produced ERR_FAILED (-2) on load the first time
 * and a SILENT PROCESS EXIT the second. That looked like a platform finding.
 *
 * It is much more likely to be Electron's documented default: when the last
 * window closes, 'window-all-closed' fires and the app quits. Neither probe
 * registered a handler, so destroying the only window would tear the app down
 * mid-flight — which would produce exactly both symptoms.
 *
 * ⚑ This is the difference between a finding and an artefact of the harness, and
 * filing the second as the first is how a rig loses its credibility. So: run the
 * same sequence WITH the handler and WITHOUT it, and let the two disagree.
 *
 *   --handle   register window-all-closed (expect create-after-destroy to work)
 *   (default)  do not register it         (expect the app to quit on destroy)
 */
const { app, BrowserWindow } = require('electron');

const HANDLE = process.argv.includes('--handle');
const tag = HANDLE ? 'WITH window-all-closed handler' : 'WITHOUT handler (Electron default)';

if (HANDLE) app.on('window-all-closed', () => { /* deliberately do not quit */ });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('quit', () => console.log(`[lifecycle] app 'quit' fired  (${tag})`));
app.on('window-all-closed', () => console.log(`[lifecycle] 'window-all-closed' fired  (${tag})`));

// The minimal sequence (show:false, about:blank, no capture) works with AND
// without the handler, so the handler hypothesis is dead too. --realistic
// reproduces the conditions the failure actually occurred under: a VISIBLE
// window, a real page, and a capturePage() before the destroy.
const REALISTIC = process.argv.includes('--realistic');
const SHOW = REALISTIC;
const URL = REALISTIC
  ? `data:text/html,${encodeURIComponent('<body style="margin:0"><div style="width:100vw;height:100vh;background:linear-gradient(45deg,#123,#abc)"></div></body>')}`
  : 'about:blank';

app.whenReady().then(async () => {
  console.log(`[lifecycle] ${tag}${REALISTIC ? '  [realistic: visible window + content + capturePage]' : ''}`);
  try {
    const w1 = new BrowserWindow({ show: SHOW });
    await w1.loadURL(URL);
    if (REALISTIC) {
      await delay(1000);
      const img = await w1.capturePage();
      console.log(`[lifecycle] window 1 captured ${img.getSize().width}x${img.getSize().height}`);
    }
    console.log('[lifecycle] window 1 loaded OK');

    w1.destroy();
    console.log('[lifecycle] window 1 destroyed');
    await delay(500);

    console.log('[lifecycle] creating window 2 ...');
    const w2 = new BrowserWindow({ show: SHOW });
    await w2.loadURL(URL);
    console.log('[lifecycle] window 2 loaded OK  <- create-after-destroy WORKS');

    w2.destroy();
    console.log('[lifecycle] RESULT: create-after-destroy is fine; the earlier failures were the missing handler');
    app.exit(0);
  } catch (err) {
    console.log(`[lifecycle] RESULT: create-after-destroy FAILED -> ${err.code ?? ''} ${err.message}`);
    app.exit(2);
  }
});
