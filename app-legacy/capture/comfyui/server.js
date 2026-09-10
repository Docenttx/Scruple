/**
 * server.js - Internal HTTP Server
 * 
 * Provides Control Plane for ComfyUI JS communication.
 * Auto-finds available port starting from 5742.
 * 
 * Endpoints:
 *   GET  /api/status    - Returns hub status, active project
 *   POST /api/interlock - Receives BUSY/IDLE signals
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const http = require('http');
const url = require('url');

class InternalServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.BASE_PORT = 5742;
    this.MAX_PORT_ATTEMPTS = 20;
    
    // State
    this.isInterlocked = false;
    this.activeProject = null;
    this.activeProjectOutputPath = null;  // Path for provenance files
    this.hubStatus = 'ready';
    this.bypassMode = false;  // If true, provenance capture is disabled
  }

  /**
   * Start server, auto-finding available port.
   */
  async start() {
    for (let attempt = 0; attempt < this.MAX_PORT_ATTEMPTS; attempt++) {
      const portToTry = this.BASE_PORT + attempt;
      
      try {
        await this.tryPort(portToTry);
        this.port = portToTry;
        console.log('[SERVER] Started on port: ' + this.port);
        return this.port;
      } catch (error) {
        if (error.code === 'EADDRINUSE') {
          console.log('[SERVER] Port ' + portToTry + ' in use, trying next...');
          continue;
        }
        throw error;
      }
    }

    throw new Error('Could not find available port after ' + this.MAX_PORT_ATTEMPTS + ' attempts');
  }

  /**
   * Try to start server on specific port.
   */
  tryPort(port) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        reject(error);
      });

      this.server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  /**
   * Handle incoming requests.
   */
  handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Route handling
    if (pathname === '/api/status' && req.method === 'GET') {
      this.handleStatus(req, res);
    } else if (pathname === '/api/capture-status' && req.method === 'GET') {
      this.handleCaptureStatus(req, res);
    } else if (pathname === '/api/interlock' && req.method === 'POST') {
      this.handleInterlock(req, res);
    } else if (pathname === '/api/health' && req.method === 'GET') {
      this.handleHealth(req, res);
    } else if (pathname === '/api/bypass' && req.method === 'POST') {
      this.handleBypass(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * GET /api/status - Return hub status for ComfyUI JS polling.
   */
  handleStatus(req, res) {
    const status = {
      hub_status: this.hubStatus,
      interlocked: this.isInterlocked,
      active_project: this.activeProject,
      port: this.port,
      timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  /**
   * GET /api/capture-status - Return capture status for Python Project Manager.
   * 
   * This is the primary endpoint that ComfyUI nodes poll to get:
   * - connected: Is Studio running?
   * - bypass: Should we skip provenance capture?
   * - project_name: Active project from Studio UI
   * - output_path: Where to write provenance files
   */
  handleCaptureStatus(req, res) {
    const status = {
      connected: true,
      bypass: this.bypassMode,
      project_name: this.activeProject || '',
      output_path: this.activeProjectOutputPath || '',
      timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  /**
   * POST /api/interlock - Receive BUSY/IDLE signals from ComfyUI.
   */
  handleInterlock(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        if (data.state === 'BUSY') {
          this.isInterlocked = true;
          console.log('[SERVER] Interlock: BUSY - UI frozen');
        } else if (data.state === 'IDLE') {
          this.isInterlocked = false;
          console.log('[SERVER] Interlock: IDLE - UI released');
        }

        // Emit event for main process
        if (this.onInterlockChange) {
          this.onInterlockChange(this.isInterlocked);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, interlocked: this.isInterlocked }));
        
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  /**
   * GET /api/health - Simple health check.
   */
  handleHealth(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: this.port }));
  }

  /**
   * POST /api/bypass - Enable/disable bypass mode.
   */
  handleBypass(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        this.bypassMode = !!data.enabled;
        
        console.log('[SERVER] Bypass mode: ' + (this.bypassMode ? 'ENABLED' : 'DISABLED'));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          bypass: this.bypassMode,
          message: 'Bypass mode ' + (this.bypassMode ? 'enabled' : 'disabled')
        }));
        
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  /**
   * Set active project and its output path.
   */
  setActiveProject(projectName, outputPath = null) {
    this.activeProject = projectName;
    this.activeProjectOutputPath = outputPath;
    
    // Clear bypass mode when a project is activated
    if (projectName) {
      this.bypassMode = false;
    }
  }

  /**
   * Set bypass mode.
   */
  setBypassMode(enabled) {
    this.bypassMode = enabled;
  }

  /**
   * Set hub status.
   */
  setHubStatus(status) {
    this.hubStatus = status;
  }

  /**
   * Set interlock change callback.
   */
  setInterlockCallback(callback) {
    this.onInterlockChange = callback;
  }

  /**
   * Get current port.
   */
  getPort() {
    return this.port;
  }

  /**
   * Stop server.
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[SERVER] Stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = { InternalServer };
