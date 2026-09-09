/**
 * ipc-barrel.js - IPC Handler Registration Coordinator
 *
 * Called once from main.js after initialization.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const { registerSettingsHandlers } = require('./ipc-settings-handlers');
const { registerProjectHandlers } = require('./ipc-project-handlers');
const { registerLockHandlers } = require('./ipc-lock-handlers');
const { registerTrainingHandlers } = require('./ipc-training-handlers');
const { registerWalletHandlers } = require('./ipc-wallet-handlers');

function setupAllIpcHandlers({ initialize, sendToRenderer, notifyWebviewProjectChange }) {
  registerSettingsHandlers(initialize);
  registerProjectHandlers(notifyWebviewProjectChange);
  registerLockHandlers(sendToRenderer);
  registerTrainingHandlers(sendToRenderer);
  registerWalletHandlers();

  console.log('[IPC] All handlers registered');
}

module.exports = { setupAllIpcHandlers };
