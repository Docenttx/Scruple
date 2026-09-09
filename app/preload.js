/**
 * preload.js — the host↔page bridge.
 *
 * docs/DESIGN.md: the served Next UI is mounted by a desktop host, exactly as
 * app/embed/fusion/page.tsx is mounted by Fusion — "Electron is the same shape
 * with a preload script in place of sendInfoToHTML".
 *
 * Every method here is a channel into a main-process handler and nothing else.
 * Nothing is answered locally: a bridge that could answer in the renderer would
 * make `scripts/desktop-run.mjs` a test of the preload script rather than of the
 * app, which is exactly what the fake-bridge control in scripts/d1-gate.sh and
 * the `fake-bridge` mutation in scripts/d2-gate.sh exist to catch.
 *
 * The legacy surface in app-legacy/preload.js is the shape the rest will take as
 * lock/project/settings/training/wallet are rewritten onto the SDK; it is
 * deliberately not copied across wholesale.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scruple', {
  host: 'electron',
  ping: (nonce) => ipcRenderer.invoke('scruple:ping', nonce),
  // WO-D5. The served dashboard calls this from components/studio/HostFacts.tsx
  // to fill in what only this machine knows. No bridge, no host facts — and the
  // component says so instead of drawing a default.
  profile: () => ipcRenderer.invoke('scruple:profile'),
  captureFile: (req) => ipcRenderer.invoke('scruple:capture-file', req),
  vaultCapture: (req) => ipcRenderer.invoke('scruple:vault-capture', req),
  comfyLaunch: () => ipcRenderer.invoke('scruple:comfy-launch'),
  comfyGenerate: (req) => ipcRenderer.invoke('scruple:comfy-generate', req),
  comfyStop: () => ipcRenderer.invoke('scruple:comfy-stop'),
  // WO-D7. The last two stations of the flow: what the SERVER will tell anyone
  // about the leaves this machine made, and a C2PA credential signed by a key
  // this machine deliberately cannot reach.
  receipts: (req) => ipcRenderer.invoke('scruple:receipts', req),
  credential: (req) => ipcRenderer.invoke('scruple:credential', req),
});
