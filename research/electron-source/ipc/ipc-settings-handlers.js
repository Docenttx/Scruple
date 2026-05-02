/**
 * ipc/settings-handlers.js - Setup and Configuration IPC Handlers
 *
 * Registers: get-state, setup-comfyui-path, browse-folder, browse-file, setup-paths
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require('electron');
const ctx = require('../context');

function registerSettingsHandlers(initialize) {
  // 'initialize' is passed in because setup handlers need to call it

  // Get initial state
  ipcMain.handle('get-state', async () => {
    console.log('[MAIN] get-state handler called');
    const configManager = ctx.get('configManager');
    const config = configManager ? configManager.load() : {};
    const hasAnyPath = config.comfyUIPath || config.trainingOutputDir;
    console.log('[MAIN] get-state returning, needsSetup:', !hasAnyPath);
    return {
      needsSetup: !hasAnyPath,
      sessionId: ctx.get('sessionManager')?.getSessionId(),
      port: ctx.get('internalServer')?.getPort(),
      config,
      paymentMode: config.beta?.paymentMode || 'fiat'
    };
  });

  // First-run setup
  ipcMain.handle('setup-comfyui-path', async (event, comfyUIPath) => {
    // Validate path
    if (!fs.existsSync(comfyUIPath)) {
      return { success: false, error: 'Path does not exist' };
    }

    // Check it looks like ComfyUI
    const hasOutput = fs.existsSync(path.join(comfyUIPath, 'output'));
    const hasModels = fs.existsSync(path.join(comfyUIPath, 'models'));

    if (!hasOutput && !hasModels) {
      return {
        success: false,
        error: 'This does not appear to be a ComfyUI installation (missing output/ or models/ folder)'
      };
    }

    // Save config
    ctx.get('configManager').set('comfyUIPath', comfyUIPath);
    ctx.get('configManager').save();

    // Initialize everything
    const result = await initialize();

    return {
      success: !result.needsSetup,
      ...result
    };
  });

  // Browse for folder
  ipcMain.handle('browse-folder', async () => {
    const result = await dialog.showOpenDialog(ctx.get('mainWindow'), {
      properties: ['openDirectory'],
      title: 'Select Folder'
    });

    if (result.canceled) {
      return { canceled: true };
    }

    return {
      canceled: false,
      path: result.filePaths[0]
    };
  });

  // Browse for file (e.g., safetensors model)
  ipcMain.handle('browse-file', async (event, fileType) => {
    const filters = [];
    if (fileType === 'safetensors') {
      filters.push({ name: 'Safetensors Models', extensions: ['safetensors'] });
    }
    filters.push({ name: 'All Files', extensions: ['*'] });

    const result = await dialog.showOpenDialog(ctx.get('mainWindow'), {
      properties: ['openFile'],
      title: 'Select File',
      filters
    });

    if (result.canceled) {
      return { canceled: true };
    }

    return {
      canceled: false,
      path: result.filePaths[0]
    };
  });

  // Combined setup handler for all paths
  ipcMain.handle('setup-paths', async (event, paths) => {
    console.log('[MAIN] setup-paths handler called with:', paths);
    const { comfyUIPath, trainingOutputDir, trainingImagesDir, defaultBaseModel } = paths;
    const configManager = ctx.get('configManager');

    // Validate ComfyUI path if provided
    if (comfyUIPath) {
      console.log('[MAIN] Validating ComfyUI path:', comfyUIPath);
      if (!fs.existsSync(comfyUIPath)) {
        return { success: false, error: 'ComfyUI path does not exist' };
      }

      // Check for output/models directly or in ComfyUI subfolder
      let actualComfyPath = comfyUIPath;
      let hasOutput = fs.existsSync(path.join(comfyUIPath, 'output'));
      let hasModels = fs.existsSync(path.join(comfyUIPath, 'models'));

      // If not found, check for ComfyUI subfolder (portable installs)
      if (!hasOutput && !hasModels) {
        const subfolderPath = path.join(comfyUIPath, 'ComfyUI');
        if (fs.existsSync(subfolderPath)) {
          hasOutput = fs.existsSync(path.join(subfolderPath, 'output'));
          hasModels = fs.existsSync(path.join(subfolderPath, 'models'));
          if (hasOutput || hasModels) {
            actualComfyPath = subfolderPath;
            console.log('[MAIN] Found ComfyUI in subfolder:', actualComfyPath);
          }
        }
      }

      if (!hasOutput && !hasModels) {
        return {
          success: false,
          error: 'ComfyUI folder missing output/ or models/ folder'
        };
      }
      configManager.set('comfyUIPath', actualComfyPath);
    }

    // Validate and save training output dir
    if (trainingOutputDir) {
      console.log('[MAIN] Validating training output dir:', trainingOutputDir);
      if (!fs.existsSync(trainingOutputDir)) {
        // Create it
        try {
          fs.mkdirSync(trainingOutputDir, { recursive: true });
        } catch (e) {
          return { success: false, error: 'Cannot create training output folder: ' + e.message };
        }
      }
      configManager.set('trainingOutputDir', trainingOutputDir);
    }

    // Validate and save training images dir
    if (trainingImagesDir) {
      console.log('[MAIN] Validating training images dir:', trainingImagesDir);
      if (!fs.existsSync(trainingImagesDir)) {
        try {
          fs.mkdirSync(trainingImagesDir, { recursive: true });
        } catch (e) {
          return { success: false, error: 'Cannot create training images folder: ' + e.message };
        }
      }
      configManager.set('trainingImagesDir', trainingImagesDir);
    }

    // Validate base models folder if provided
    if (defaultBaseModel) {
      console.log('[MAIN] Validating base models folder:', defaultBaseModel);
      if (!fs.existsSync(defaultBaseModel)) {
        return { success: false, error: 'Base models folder does not exist' };
      }
      configManager.set('baseModelsDir', defaultBaseModel);
    }

    console.log('[MAIN] Saving config and initializing...');
    configManager.save();

    // Initialize everything
    const result = await initialize();
    console.log('[MAIN] Initialize result:', result);

    return {
      success: !result.needsSetup,
      ...result
    };
  });
}

module.exports = { registerSettingsHandlers };
