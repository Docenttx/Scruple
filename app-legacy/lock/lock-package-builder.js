/**
 * lock/package-builder.js - Scruple Package Construction
 *
 * Builds the .scruple vault package (provenance.json, report.html, images).
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../context');

async function buildScruplePackage(project, merkleRoot, scrId) {
  const config = ctx.get('configManager').load();
  const vaultPath = path.join(config.scrupleHome, 'vault', project.name + '_locked');
  
  // Create vault directory
  fs.mkdirSync(vaultPath, { recursive: true });

  // Build provenance.json
  const provenance = {
    version: '3.0',
    scr_id: scrId,
    project: {
      name: project.name,
      created_at: project.created_at,
      locked_at: new Date().toISOString(),
      iteration_count: project.iterations ? project.iterations.length : 0
    },
    merkle_root: merkleRoot,
    iterations: project.iterations || []
  };

  // Inject clone lineage if present (Part 3 — Clone Flow)
  if (project.cloned_from) {
    provenance.cloned_from = project.cloned_from;
    provenance.clone_note = 'Finalized copy created from checkpointed project';
  }
  if (project.pre_scr_id) {
    provenance.pre_scr_id = project.pre_scr_id;
  }

  // Write provenance.json
  const provenanceJson = JSON.stringify(provenance, null, 2);
  const provenancePath = path.join(vaultPath, 'provenance.json');
  fs.writeFileSync(provenancePath, provenanceJson);

  // Hash provenance.json
  const provenanceHash = crypto.createHash('sha256').update(provenanceJson).digest('hex');

  // Build report.html
  const reportHtml = generateReportHtml(provenance);
  const reportPath = path.join(vaultPath, 'report.html');
  fs.writeFileSync(reportPath, reportHtml);

  // Copy images from terminal_provenance
  const imagesPath = path.join(vaultPath, 'images');
  fs.mkdirSync(imagesPath, { recursive: true });

  const terminalPath = ctx.get('configManager').getTerminalProvenancePath();
  const projectSourcePath = path.join(terminalPath, project.name);
  
  if (fs.existsSync(projectSourcePath)) {
    const files = fs.readdirSync(projectSourcePath);
    for (const file of files) {
      if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')) {
        const srcPath = path.join(projectSourcePath, file);
        const destPath = path.join(imagesPath, file);
        fs.copyFileSync(srcPath, destPath);
      }
    }
    _log('Copied ' + files.filter(f => f.match(/\.(png|jpg|jpeg)$/i)).length + ' images to vault');
  }

  return {
    vaultPath,
    provenancePath,
    provenanceHash
  };
}

function generateReportHtml(provenance) {
  const cloneSection = provenance.cloned_from ? `
  <div class="section">
    <h2>Clone Lineage</h2>
    <p>Cloned from: <code>${provenance.cloned_from}</code></p>
    <p>${provenance.clone_note || ''}</p>
  </div>` : '';

  return '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <title>SCRUPLE Provenance Report - ' + provenance.scr_id + '</title>\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; \n           max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }\n    .header { background: #1a237e; color: white; padding: 20px; border-radius: 8px; }\n    .scr-id { font-size: 24px; font-family: monospace; }\n    .section { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }\n    .hash { font-family: monospace; font-size: 12px; word-break: break-all; }\n  </style>\n</head>\n<body>\n  <div class="header">\n    <div class="scr-id">' + provenance.scr_id + '</div>\n    <div>SCRUPLE Provenance Certificate</div>\n  </div>\n  \n  <div class="section">\n    <h2>Project: ' + provenance.project.name + '</h2>\n    <p>Created: ' + provenance.project.created_at + '</p>\n    <p>Locked: ' + provenance.project.locked_at + '</p>\n    <p>Iterations: ' + provenance.project.iteration_count + '</p>\n  </div>\n  \n  <div class="section">\n    <h2>Merkle Root</h2>\n    <p class="hash">' + provenance.merkle_root + '</p>\n  </div>\n  ' + cloneSection + '\n  <div class="section">\n    <h2>Verification</h2>\n    <p>To verify this package:</p>\n    <ol>\n      <li>Hash each image file (SHA-256)</li>\n      <li>Build Merkle tree from hashes</li>\n      <li>Compare root to value above</li>\n      <li>Derive SCR ID: SCR_ + first 6 chars of root</li>\n      <li>Lookup on Ravencoin blockchain</li>\n    </ol>\n  </div>\n</body>\n</html>';
}

async function hashFile(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function _log(message, level) {
  level = level || 'info';
  const timestamp = new Date().toISOString();
  console.log('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  const mw = ctx.get('mainWindow');
  if (mw && mw.webContents) {
    mw.webContents.send('log', { timestamp, level, message });
  }
}

module.exports = { buildScruplePackage, generateReportHtml, hashFile };
