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
  captureFile: (req) => ipcRenderer.invoke('scruple:capture-file', req),
});
