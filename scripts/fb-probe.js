// Does an Electron capturePage under xvfb/llvmpipe actually come back blank?
// docs/DESIGN.md says it does, citing a detector that exists nowhere. Measure it.
// Scores RAW RGBA from nativeImage.toBitmap() — no PNG decode, no dependency.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

function score(buf) {                      // buf = BGRA/RGBA raw
  const lum = []; const colours = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i], g = buf[i+1], r = buf[i+2];
    lum.push(0.2126*r + 0.7152*g + 0.0722*b);
    if (colours.size < 4096) colours.add((r<<16)|(g<<8)|b);
  }
  const mean = lum.reduce((a,x)=>a+x,0)/lum.length;
  const sd = Math.sqrt(lum.reduce((a,x)=>a+(x-mean)**2,0)/lum.length);
  return { mean:+mean.toFixed(2), stddev:+sd.toFixed(2), colours: colours.size,
           blank: sd < 1.0 || colours.size <= 2 };
}
// ── controls, synthesized as raw buffers. No verdict unless all pass. ──
function synth(n, fn) { const b = Buffer.alloc(n*4);
  for (let i=0;i<n;i++){ const [r,g,bl]=fn(i); b[i*4]=bl; b[i*4+1]=g; b[i*4+2]=r; b[i*4+3]=255; } return b; }
const CONTROLS = [
  ['uniform grey MUST be blank',   synth(4096, ()=>[58,58,58]),   s=>s.blank===true],
  ['uniform black MUST be blank',  synth(4096, ()=>[0,0,0]),      s=>s.blank===true],
  ['gradient MUST NOT be blank',   synth(4096, i=>[i%256,64,255-(i%256)]), s=>s.blank===false],
  ['noise MUST NOT be blank',      synth(4096, ()=>{const v=()=>Math.floor(Math.random()*256);return [v(),v(),v()];}), s=>s.blank===false],
];
const out = { controls: [], captures: [], verdict: null };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let ok = true;
  for (const [name, buf, pred] of CONTROLS) {
    const s = score(buf); const pass = pred(s);
    out.controls.push({ name, pass, ...s }); if (!pass) ok = false;
  }
  if (!ok) { out.verdict = 'NO VERDICT — detector failed its own controls';
    fs.writeFileSync(process.env.OUT, JSON.stringify(out,null,2)); app.exit(3); return; }

  const shots = [
    ['real content', 'file:///mnt/corpus/canon-textbook-scratch/claude-1001/-data-ai-council-ai-council/f23f09c5-4b54-489a-a484-2641b710abbd/scratchpad/real.html'],
    ['UNIFORM page (must be BLANK)', 'file:///mnt/corpus/canon-textbook-scratch/claude-1001/-data-ai-council-ai-council/f23f09c5-4b54-489a-a484-2641b710abbd/scratchpad/uniform.html'],
  ];
  // ⚑ ALL WINDOWS UP FRONT. A BrowserWindow created immediately after destroy()ing
  // the previous one fails ERR_FAILED(-2) on its next load — observed on Windows
  // by the travel-laptop session (its W1-5, filed UNRESOLVED) and reproduced here
  // on Linux/xvfb in the first run of this probe. Creating them before any
  // destroy() is the arrangement observed to work; nothing here fixes the cause.
  const wins = shots.map(() => new BrowserWindow({ width: 600, height: 400, show: true, webPreferences:{ offscreen:false } }));
  for (let i = 0; i < shots.length; i++) {
    const [label, url] = shots[i]; const w = wins[i];
    try { await w.loadURL(url); } catch (e) { out.captures.push({label, loadError:String(e)}); w.destroy(); continue; }
    await new Promise(r => setTimeout(r, 900));
    const img = await w.capturePage();
    const size = img.getSize();
    const s = score(img.toBitmap());
    out.captures.push({ label, width:size.width, height:size.height, ...s });
  }
  for (const w of wins) w.destroy();
  const real = out.captures[0], uniform = out.captures[1];
  out.verdict = (!real.blank && uniform.blank)
    ? 'FRAMEBUFFER IS LIVE — real content non-blank AND the uniform control blank'
    : (real.blank && uniform.blank) ? 'BLANK — capture returns a uniform image, as DESIGN.md claims'
    : 'INCONCLUSIVE — the control did not behave, no verdict';
  fs.writeFileSync(process.env.OUT, JSON.stringify(out,null,2));
  app.exit(0);
});
