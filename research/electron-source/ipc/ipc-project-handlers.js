/**
 * ipc-project-handlers.js - Project CRUD IPC Handlers
 *
 * Registers: get-projects, get-project, get-iterations, read-image,
 *            create-project, archive-project, activate-project, deactivate-project
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const ctx = require('../context');
const { startTomlWatcher, unwatchDir } = require('../capture/training/training-barrel');

function registerProjectHandlers(notifyWebviewProjectChange) {

  ipcMain.handle('get-projects', async () => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getAllProjects();
  });

  ipcMain.handle('get-project', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return null;
    return databaseManager.getProjectWithIterations(projectId);
  });

  ipcMain.handle('get-iterations', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return [];
    return databaseManager.getIterations(projectId);
  });

  ipcMain.handle('read-image', async (event, projectName, imageFilename) => {
    const configManager = ctx.get('configManager');
    if (!configManager) return null;
    try {
      const terminalPath = configManager.getTerminalProvenancePath();
      if (!terminalPath || !projectName || !imageFilename) return null;
      const imagePath = path.join(terminalPath, projectName, imageFilename);
      if (!fs.existsSync(imagePath)) return null;
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = path.extname(imageFilename).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      return 'data:' + mimeType + ';base64,' + base64;
    } catch (error) {
      console.error('Read image error: ' + error.message);
      return null;
    }
  });

  ipcMain.handle('create-project', async (event, name, type = 'txt2img') => {
    const databaseManager = ctx.get('databaseManager');
    const configManager = ctx.get('configManager');
    if (!databaseManager) return { success: false, error: 'Database not ready' };
    try {
      const project = databaseManager.createProject(name, type);
      let vaultPath = null;
      if (type === 'training') {
        const config = configManager.load();
        vaultPath = path.join(config.trainingOutputDir, name);
        if (!fs.existsSync(vaultPath)) {
          fs.mkdirSync(vaultPath, { recursive: true });
          console.log('[PROJECT] Created training project folder: ' + vaultPath);
        }
        databaseManager.updateProject(project.id, { vault_path: vaultPath });
        startTomlWatcher(vaultPath);
        console.log('[PROJECT] TOML watcher started for new training vault: ' + vaultPath);
      }
      return {
        success: true,
        project: databaseManager.getProject(project.id),
        vaultPath,
        isTraining: type === 'training'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('archive-project', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) return { success: false, error: 'Database not ready' };
    try {
      const project = databaseManager.archiveProject(projectId);
      console.log('[PROJECT] Archived project: ' + project.name);
      return { success: true, project };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('activate-project', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    const configManager = ctx.get('configManager');
    const internalServer = ctx.get('internalServer');
    if (!databaseManager) return { success: false, error: 'Database not ready' };
    try {
      const previousProject = databaseManager.getActiveProject();
      if (previousProject && previousProject.type === 'training' && previousProject.vault_path) {
        unwatchDir(previousProject.vault_path);
        console.log('[PROJECT] TOML watcher removed for previous training vault: ' + previousProject.vault_path);
      }
      databaseManager.setActiveProject(projectId);
      const project = databaseManager.getProject(projectId);
      if (internalServer && project) {
        const outputPath = configManager.getTerminalProvenancePath() || '';
        internalServer.setActiveProject(project.name, outputPath);
        console.log('[PROJECT] Internal server synced: ' + project.name);
      }
      if (project && project.type === 'training' && project.vault_path) {
        if (fs.existsSync(project.vault_path)) {
          startTomlWatcher(project.vault_path);
          console.log('[PROJECT] TOML watcher added for training vault: ' + project.vault_path);
        }
      }
      notifyWebviewProjectChange(project ? project.name : '');
      return { success: true, project };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('deactivate-project', async (event) => {
    const databaseManager = ctx.get('databaseManager');
    const internalServer = ctx.get('internalServer');
    if (!databaseManager) return { success: false, error: 'Database not ready' };
    try {
      const activeProject = databaseManager.getActiveProject();
      if (activeProject && activeProject.type === 'training' && activeProject.vault_path) {
        unwatchDir(activeProject.vault_path);
        console.log('[PROJECT] TOML watcher removed for training vault: ' + activeProject.vault_path);
      }
      databaseManager.clearActiveProject();
      if (internalServer) {
        internalServer.setActiveProject('', '');
        console.log('[PROJECT] Internal server cleared active project');
      }
      notifyWebviewProjectChange('');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerProjectHandlers };
