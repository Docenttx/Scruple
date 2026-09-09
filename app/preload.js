/**
 * preload.js — the host↔page bridge.
 *
 * docs/DESIGN.md: the served Next UI is mounted by a desktop host, exactly as
 * app/embed/fusion/page.tsx is mounted by Fusion — "Electron is the same shape
 * with a preload script in place of sendInfoToHTML".
 *
 * WO-D1 exposes one method. The legacy surface in app-legacy/preload.js is the
 * shape the rest will take as those handlers are rewritten onto the SDK; it is
 * deliberately not copied across wholesale.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scruple', {
  host: 'electron',
  ping: (nonce) => ipcRenderer.invoke('scruple:ping', nonce),
});
