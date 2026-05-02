/**
 * ipc-wallet-handlers.js - Wallet IPC Handler Registration
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const { ipcMain } = require('electron');
const { setupWalletHandlers } = require('../wallet/ravencoin/wallets-integration-native-testnet');
const ctx = require('../context');

function registerWalletHandlers() {
  setupWalletHandlers(ipcMain, ctx.get('configManager'));
}

module.exports = { registerWalletHandlers };
