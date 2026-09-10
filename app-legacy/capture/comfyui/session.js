/**
 * session.js - Session Manager V3
 * 
 * Manages session ID for ghost ingest prevention.
 * Writes scruple_session.txt to ComfyUI root.
 * 
 * Simple UUID string - Python reads it, Electron validates it.
 * If Electron restarts (new UUID), old provenance files are ignored.
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class SessionManager {
  constructor(comfyUIPath) {
    this.comfyUIPath = comfyUIPath;
    this.sessionFilePath = path.join(comfyUIPath, 'scruple_session.txt');
    this.sessionId = null;
  }

  /**
   * Create a new session and write to file.
   * Called on Electron startup.
   * 
   * Python Terminal node will read this file and include
   * the session_id in every .provenance.json it writes.
   */
  createSession() {
    this.sessionId = uuidv4();
    
    try {
      fs.writeFileSync(this.sessionFilePath, this.sessionId, 'utf8');
      console.log('[SESSION] Created session: ' + this.sessionId);
      console.log('[SESSION] Written to: ' + this.sessionFilePath);
    } catch (error) {
      console.error('[SESSION] Failed to write session file:', error);
      throw error;
    }

    return this.sessionId;
  }

  /**
   * Get current session ID.
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Validate a session ID from incoming provenance data.
   * Returns true only if it matches current session.
   * 
   * This prevents "ghost ingest" - if Electron crashes and restarts,
   * old provenance files from the previous session are ignored.
   */
  validateSession(incomingSessionId) {
    if (!this.sessionId) {
      console.warn('[SESSION] No active session to validate against');
      return false;
    }

    if (incomingSessionId !== this.sessionId) {
      console.warn('[SESSION] Session mismatch - ignoring stale file');
      console.warn('[SESSION]   Expected: ' + this.sessionId);
      console.warn('[SESSION]   Received: ' + incomingSessionId);
      return false;
    }

    return true;
  }

  /**
   * Cleanup session file on exit.
   */
  cleanup() {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
        console.log('[SESSION] Cleaned up session file');
      }
    } catch (error) {
      console.warn('[SESSION] Failed to cleanup session file:', error);
    }
  }
}

module.exports = { SessionManager };
