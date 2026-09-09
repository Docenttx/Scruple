/**
 * ipc-ping.js — the IPC seam, at its minimum.
 *
 * The preload bridge exposes `window.scruple.ping()`. This is the main-process
 * half. It exists to prove the channel is real, so it answers with things only
 * the main process can know: the Electron and Chromium versions of the running
 * binary, the main process's pid, and a nonce minted once per process.
 *
 * The nonce matters. A renderer cannot manufacture it, so a reply carrying it is
 * evidence the call reached main and came back — not evidence that a stub in the
 * page returned a plausible object.
 */

'use strict';

const { ipcMain, app, BrowserWindow } = require('electron');
const crypto = require('crypto');

// Minted once, at require time, in the main process. Never injected into a page.
const SERVER_NONCE = crypto.randomBytes(16).toString('hex');

function registerIpc() {
  ipcMain.handle('scruple:ping', (event, clientNonce) => {
    // The sender must be a real window's webContents, not a stray frame.
    const sender = BrowserWindow.fromWebContents(event.sender);
    return {
      pong: true,
      serverNonce: SERVER_NONCE,
      echo: typeof clientNonce === 'string' ? clientNonce : null,
      mainPid: process.pid,
      senderWindowId: sender ? sender.id : null,
      senderURL: event.sender.getURL(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      },
      appVersion: app.getVersion(),
      at: new Date().toISOString(),
    };
  });
}

module.exports = { registerIpc, SERVER_NONCE };
