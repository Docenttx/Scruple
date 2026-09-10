/**
 * training/barrel.js - Training Module Exports
 *
 * Barrel export for all training modules.
 * Avoids Node's index.js convention to keep naming explicit.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const {
  startTomlWatcher,
  stopTomlWatcher,
  unwatchDir,
  handleTomlDetected,
  extractKohyaConfig,
  getLastDetectedToml,
  getWatchedDirs
} = require('./training-toml-watcher');

const {
  startTrainingOutputWatcher,
  handleCheckpointDetected,
  handleTrainingOutputDetected
} = require('./training-output-watcher');

const {
  detectKohyaPort,
  handleTrainingCapture
} = require('./training-capture-handler');

const {
  handleTrainingComplete,
  performTrainingLock,
  buildTrainingProvenancePackage
} = require('./training-completion-handler');

module.exports = {
  // TOML watcher
  startTomlWatcher,
  stopTomlWatcher,
  unwatchDir,
  handleTomlDetected,
  extractKohyaConfig,
  getLastDetectedToml,
  getWatchedDirs,

  // Output watcher
  startTrainingOutputWatcher,
  handleCheckpointDetected,
  handleTrainingOutputDetected,

  // Capture
  detectKohyaPort,
  handleTrainingCapture,

  // Completion & lock
  handleTrainingComplete,
  performTrainingLock,
  buildTrainingProvenancePackage
};
