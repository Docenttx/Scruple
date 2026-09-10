/**
 * Why does capturePage() return 1275x833 for a 1000x700 BrowserWindow?
 *
 * Windows reported DPI 96 / scale 1.0 via System.Drawing, so the obvious
 * explanation (display scaling) is not obviously the one. This asks Electron
 * directly instead of inferring: if the driver stores screenshots as artifacts,
 * anyone who later asserts on their dimensions needs to know what the numbers
 * actually are and where they come from.
 */
const { app, BrowserWindow, screen } = require('electron');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, backgroundColor: '#3a3a3a' });
  await win.loadURL('about:blank');
  await new Promise((r) => setTimeout(r, 600));

  const img = await win.capturePage();
  const s = img.getSize();

  console.log(JSON.stringify({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    display: {
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,
      workArea: d.workArea,
      size: d.size,
      rotation: d.rotation,
    },
    window: {
      requested: { width: 1000, height: 700 },
      getBounds: win.getBounds(),
      getContentBounds: win.getContentBounds(),
      getSize: win.getSize(),
      getContentSize: win.getContentSize(),
      zoomFactor: win.webContents.getZoomFactor(),
    },
    capture: {
      size: s,
      ratioToRequestedWidth: +(s.width / 1000).toFixed(4),
      ratioToContentWidth: +(s.width / win.getContentSize()[0]).toFixed(4),
      ratioToContentHeight: +(s.height / win.getContentSize()[1]).toFixed(4),
    },
  }, null, 2));

  app.exit(0);
});
