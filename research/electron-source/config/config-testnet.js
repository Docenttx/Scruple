/**
 * config-testnet.js - Configuration Manager
 * 
 * Manages application configuration.
 * Stores in Scruple Home folder.
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Default Scruple Home location (Windows)
const DEFAULT_SCRUPLE_HOME = 'C:\\Scruple';

class ConfigManager {
  constructor() {
    this.config = null;
    this.configPath = null;
    this.scrupleHome = null;
    this.initialize();
  }

  /**
   * Initialize config paths.
   */
  initialize() {
    // Determine Scruple Home
    this.scrupleHome = process.env.SCRUPLE_HOME || DEFAULT_SCRUPLE_HOME;
    
    // Config file path
    this.configPath = path.join(this.scrupleHome, 'config', 'scruple_studio.json');

    // Ensure directories exist
    const configDir = path.dirname(this.configPath);
    fs.mkdirSync(configDir, { recursive: true });

    // Create other required directories
    const dirs = ['database', 'workspace', 'vault'];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(this.scrupleHome, dir), { recursive: true });
    }
  }

  /**
   * Load configuration from file.
   */
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(content);
        console.log('[CONFIG] Loaded from: ' + this.configPath);
      } else {
        console.log('[CONFIG] No config file, using defaults');
        this.config = this.getDefaults();
      }
    } catch (error) {
      console.error('[CONFIG] Failed to load config:', error);
      this.config = this.getDefaults();
    }

    // Always ensure scrupleHome is set
    this.config.scrupleHome = this.scrupleHome;

    // Ensure rvn.network defaults exist for older config files
    if (!this.config.rvn) {
      this.config.rvn = this.getDefaults().rvn;
    }
    if (!this.config.rvn.network) {
      this.config.rvn.network = 'rvn';
    }

    // Ensure beta block exists for older config files
    if (!this.config.beta) {
      this.config.beta = this.getDefaults().beta;
    }
    // Ensure paymentMode exists for older config files
    if (!this.config.beta.paymentMode) {
      this.config.beta.paymentMode = 'fiat';
    }

    return this.config;
  }

  /**
   * Save configuration to file.
   */
  save() {
    try {
      const content = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, content, 'utf8');
      console.log('[CONFIG] Saved to: ' + this.configPath);
      return true;
    } catch (error) {
      console.error('[CONFIG] Failed to save config:', error);
      return false;
    }
  }

  /**
   * Get a config value.
   */
  get(key) {
    if (!this.config) {
      this.load();
    }
    return this.config[key];
  }

  /**
   * Set a config value.
   */
  set(key, value) {
    if (!this.config) {
      this.load();
    }
    this.config[key] = value;
  }

  /**
   * Get default configuration.
   */
  getDefaults() {
    return {
      version: '3.0',
      comfyUIPath: null,       // User must set during first-run
      scrupleHome: this.scrupleHome,
      port: 5742,              // Base port for internal server
      theme: 'dark',
      debugMode: false,
      
      // Tab visibility defaults
      comfyUIEnabled: true,
      kohyaEnabled: false,
      testnetEnabled: true,
      mainnetEnabled: false,
      rvn: {
        network: 'rvn',              // 'rvn' (mainnet) or 'rvn-test' (testnet)
        rpcUrl: 'https://rpc.ting.finance/rpc',
        rpcUser: 'rpcuser',
        rpcPassword: ''
      },
      
      // Arweave settings — testnet points to arlocal on Oracle VM
      arweave: {
        gateway: 'http://129.80.23.93:1984',
        turboUrl: null
      },
      
      // IPFS settings — testnet points to kubo on Oracle VM
      ipfs: {
        gateway: 'http://129.80.23.93:8080/ipfs/',
        pinningService: 'local',
        localApiUrl: 'http://129.80.23.93:5001'
      },

      // Beta configuration
      beta: {
        rvnMode: 'auto',  // 'auto' (Oracle server executes) | 'user' (local ElectrumX mint)
        paymentMode: 'fiat'  // 'fiat' (Stripe/TSD) | 'blockchain' (local RVN wallet)
        prefundedWallet: {
          address: 'mpSmBZpodJy8cwfiJ1V5uoau9iUBemcXzF',
          wif: ''  // export from Oracle: raven-cli -testnet dumpprivkey mpSmBZpodJy8cwfiJ1V5uoau9iUBemcXzF
        }
      }
    };
  }

  /**
   * Get Scruple Home path.
   */
  getScrupleHome() {
    return this.scrupleHome;
  }

  /**
   * Get path to database file.
   */
  getDatabasePath() {
    return path.join(this.scrupleHome, 'database', 'scruple.db');
  }

  /**
   * Get path to workspace folder.
   */
  getWorkspacePath() {
    return path.join(this.scrupleHome, 'workspace');
  }

  /**
   * Get path to vault folder.
   */
  getVaultPath() {
    return path.join(this.scrupleHome, 'vault');
  }

  /**
   * Get path to terminal provenance folder (in ComfyUI output).
   */
  getTerminalProvenancePath() {
    if (!this.config || !this.config.comfyUIPath) {
      return null;
    }
    return path.join(this.config.comfyUIPath, 'output', 'terminal_provenance');
  }

  /**
   * Get path to session file (in ComfyUI root).
   */
  getSessionFilePath() {
    if (!this.config || !this.config.comfyUIPath) {
      return null;
    }
    return path.join(this.config.comfyUIPath, 'scruple_session.txt');
  }

  /**
   * Validate configuration.
   */
  validate() {
    const errors = [];

    if (!this.config.comfyUIPath) {
      errors.push('ComfyUI path not set');
    } else if (!fs.existsSync(this.config.comfyUIPath)) {
      errors.push('ComfyUI path does not exist: ' + this.config.comfyUIPath);
    }

    if (!fs.existsSync(this.scrupleHome)) {
      errors.push('Scruple Home does not exist: ' + this.scrupleHome);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
  /**
   * Get the active RVN network.
   * @returns {'rvn'|'rvn-test'} Network identifier
   */
  getNetwork() {
    if (!this.config) this.load();
    return (this.config.rvn && this.config.rvn.network) || 'rvn';
  }

  /**
   * Set the active RVN network and persist immediately.
   * Requires app restart to take effect.
   * @param {'rvn'|'rvn-test'} network
   * @returns {boolean} True if saved successfully
   */
  setNetwork(network) {
    if (network !== 'rvn' && network !== 'rvn-test') {
      throw new Error('Invalid network. Use "rvn" or "rvn-test".');
    }
    if (!this.config) this.load();
    if (!this.config.rvn) this.config.rvn = {};
    this.config.rvn.network = network;
    console.log('[CONFIG] Network set to:', network);
    return this.save();
  }

  /**
   * Get or generate a persistent installation ID.
   * Generated once on first run, stored in config, never changes.
   * @returns {string} Installation ID in format SCRI_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   */
  getInstallationId() {
    if (!this.config) this.load();
    if (this.config.installationId) return this.config.installationId;
    const id = 'SCRI_' + crypto.randomBytes(16).toString('hex').toUpperCase();
    this.config.installationId = id;
    this.save();
    console.log('[CONFIG] Installation ID generated: ' + id);
    return id;
  }

}

module.exports = { ConfigManager };
