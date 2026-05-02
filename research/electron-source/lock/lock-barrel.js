/**
 * lock-barrel.js - Lock Module Exports
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const { performLocalDiscLock, performTrainingProjectLock, buildMerkleRoot } = require('./lock-local-lock');
const { performSingleChainLock, performPersistentChainLock } = require('./lock-chain-lock');
const { buildScruplePackage, generateReportHtml, hashFile } = require('./lock-package-builder');

module.exports = {
  performLocalDiscLock,
  performTrainingProjectLock,
  buildMerkleRoot,
  performSingleChainLock,
  performPersistentChainLock,
  buildScruplePackage,
  generateReportHtml,
  hashFile
};
