/**
 * context.js - Shared Runtime Context
 *
 * Holds references to initialized manager instances.
 * Populated by main.js during app initialization.
 * Read by extracted modules (lock/, capture/, ipc/).
 *
 * SCRUPLE Studio — Patent Pending
 */

const _ctx = {
  // Core managers
  databaseManager: null,
  merkleManager: null,
  configManager: null,
  mainWindow: null,
  internalServer: null,
  sessionManager: null,
  fileWatcher: null,
  // Training state
  pendingTrainingCaptures: new Map(),
  trainingOutputWatchers: new Map(),
  activePreflightTasks: new Map(),
  preflightStatus: {},
  kohyaDetectedPort: null
};

function set(key, value) {
  _ctx[key] = value;
}

function get(key) {
  return _ctx[key];
}

module.exports = { set, get };
