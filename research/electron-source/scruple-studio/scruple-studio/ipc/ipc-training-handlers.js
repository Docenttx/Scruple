/**
 * ipc-training-handlers.js - Training and TOML Watcher IPC Handlers
 *
 * Registers: get-active-project-name, is-studio-connected, get-capture-status,
 *            detect-kohya-port, get-training-runs, get-all-training-runs,
 *            get-training-run, training-capture (on), training-complete (on),
 *            kohya-log (on), lock-training-run, preflight-training,
 *            get-preflight-status, cancel-preflight, get-ancestry-chain,
 *            can-unlock-training-run, get-training-descendants,
 *            watch-output-dir, stop-toml-watcher, get-watched-dirs,
 *            get-last-toml, process-toml
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const { ipcMain } = require('electron');
const ctx = require('../context');
const {
  detectKohyaPort,
  handleTrainingCapture,
  handleTrainingComplete,
  performTrainingLock,
  startTomlWatcher,
  stopTomlWatcher,
  handleTomlDetected,
  getLastDetectedToml,
  getWatchedDirs
} = require('../capture/training/training-barrel');
const {
  preflightTrainingInputs,
  cancelHashWorker
} = require('../capture/training/training-hasher');

function registerTrainingHandlers(sendToRenderer) {

  ipcMain.handle('get-active-project-name', async () => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return null;
    const project = databaseManager.getActiveProject();
    return project ? project.name : null;
  });

  ipcMain.handle('is-studio-connected', async () => {
    return ctx.get('databaseManager') !== null;
  });

  ipcMain.handle('get-capture-status', async () => {
    const databaseManager = ctx.get('databaseManager');
    const project = databaseManager?.getActiveProject();
    return {
      connected: databaseManager !== null,
      projectName: project?.name || null,
      projectId: project?.id || null,
      pendingCaptures: ctx.get('pendingTrainingCaptures').size
    };
  });

  ipcMain.handle('detect-kohya-port', async () => {
    const port = await detectKohyaPort();
    ctx.set('kohyaDetectedPort', port);
    return { port, detected: port !== null };
  });

  ipcMain.handle('get-training-runs', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getTrainingRuns(projectId);
  });

  ipcMain.handle('get-all-training-runs', async () => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getAllTrainingRuns();
  });

  ipcMain.handle('get-training-run', async (event, trainingId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return null;
    return databaseManager.getTrainingRun(trainingId);
  });

  ipcMain.on('training-capture', async (event, record) => {
    await handleTrainingCapture(record);
  });

  ipcMain.on('training-complete', async (event, data) => {
    await handleTrainingComplete(data);
  });

  ipcMain.on('kohya-log', (event, data) => {
    const timestamp = new Date().toISOString();
    const level = data.level || 'info';
    console.log('[' + timestamp + '] [' + level.toUpperCase() + '] [KOHYA] ' + data.message);
    sendToRenderer('log', { timestamp, level, message: '[KOHYA] ' + data.message });
  });

  ipcMain.handle('lock-training-run', async (event, trainingId, lockType, password) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) {
      return { success: false, error: 'Database not ready' };
    }
    try {
      const result = await performTrainingLock(trainingId, lockType, password);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('preflight-training', async (event, inputs) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) {
      return { success: false, error: 'Database not ready' };
    }
    try {
      const taskId = 'preflight-' + Date.now();
      let preflightStatus = {
        taskId,
        started: new Date().toISOString(),
        baseModel: inputs.baseModelPath ? { status: 'pending' } : null,
        dataset: inputs.datasetPath ? { status: 'pending' } : null,
        checkpoint: inputs.checkpointPath ? { status: 'pending' } : null
      };
      ctx.set('preflightStatus', preflightStatus);

      const onProgress = (progress) => {
        preflightStatus = ctx.get('preflightStatus');
        if (progress.type === 'baseModel') {
          preflightStatus.baseModel = { status: 'hashing', progress: progress.progress, speedMBps: progress.speedMBps, etaSeconds: progress.etaSeconds };
        } else if (progress.type === 'dataset') {
          preflightStatus.dataset = { status: progress.complete ? 'complete' : 'hashing', ...progress };
        } else if (progress.type === 'checkpoint') {
          preflightStatus.checkpoint = { status: 'hashing', progress: progress.progress, speedMBps: progress.speedMBps, etaSeconds: progress.etaSeconds };
        }
        ctx.set('preflightStatus', preflightStatus);
        sendToRenderer('preflight-progress', preflightStatus);
      };

      const preflightPromise = preflightTrainingInputs(inputs, databaseManager, onProgress);
      const activePreflightTasks = ctx.get('activePreflightTasks');
      activePreflightTasks.set(taskId, { promise: preflightPromise, inputs });

      const result = await preflightPromise;

      preflightStatus = ctx.get('preflightStatus');
      if (result.baseModel) preflightStatus.baseModel = { status: 'complete', hash: result.baseModel.hash, cached: result.baseModel.cached, fileSize: result.baseModel.fileSize };
      if (result.dataset) preflightStatus.dataset = { status: 'complete', merkleRoot: result.dataset.merkleRoot, imageCount: result.dataset.imageCount, captionCount: result.dataset.captionCount };
      if (result.checkpoint) preflightStatus.checkpoint = { status: 'complete', hash: result.checkpoint.hash, cached: result.checkpoint.cached };
      preflightStatus.completed = new Date().toISOString();
      preflightStatus.verified = result.verified;
      preflightStatus.errors = result.errors;
      ctx.set('preflightStatus', preflightStatus);
      activePreflightTasks.delete(taskId);
      sendToRenderer('preflight-complete', preflightStatus);

      return { success: true, taskId, result: preflightStatus };
    } catch (error) {
      console.error('Preflight error: ' + error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-preflight-status', async () => {
    return ctx.get('preflightStatus');
  });

  ipcMain.handle('cancel-preflight', async (event, taskId) => {
    const activePreflightTasks = ctx.get('activePreflightTasks');
    const task = activePreflightTasks.get(taskId);
    if (task && task.worker) {
      cancelHashWorker(task.worker);
      activePreflightTasks.delete(taskId);
      const preflightStatus = ctx.get('preflightStatus');
      preflightStatus.cancelled = true;
      ctx.set('preflightStatus', preflightStatus);
      return { success: true };
    }
    return { success: false, error: 'Task not found' };
  });

  ipcMain.handle('get-ancestry-chain', async (event, runId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getAncestryChain(runId);
  });

  ipcMain.handle('can-unlock-training-run', async (event, runId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return { canUnlock: false, error: 'Database not ready' };
    return databaseManager.canUnlockTrainingRun(runId);
  });

  ipcMain.handle('get-training-descendants', async (event, runId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getDescendants(runId);
  });

  ipcMain.handle('watch-output-dir', async (event, outputDir) => {
    const success = startTomlWatcher(outputDir);
    return { success, outputDir };
  });

  ipcMain.handle('stop-toml-watcher', async () => {
    stopTomlWatcher();
    return { success: true };
  });

  ipcMain.handle('get-watched-dirs', async () => {
    return getWatchedDirs();
  });

  ipcMain.handle('get-last-toml', async () => {
    return getLastDetectedToml();
  });

  ipcMain.handle('process-toml', async (event, tomlPath) => {
    if (!fs.existsSync(tomlPath)) {
      return { success: false, error: 'File not found' };
    }
    try {
      await handleTomlDetected(tomlPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerTrainingHandlers };
