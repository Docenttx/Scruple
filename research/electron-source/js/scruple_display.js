/**
 * scruple_display.js - Studio Terminal Display
 * 
 * FORENSIC EVIDENCE EXPORT STATUS
 * - Shows Studio connection and project name
 * - Shows authentication status (🔒/⚠️/✗)
 * - Displays scrolling telemetry log
 * 
 * Status Indicators:
 * - Green (🔒): Studio connected, authenticated
 * - Yellow (⚠️): No session key, .sig skipped
 * - Red (✗): Error or Studio not connected
 * 
 * Copyright (c) 2025. All Rights Reserved.
 * Patent Pending - Provisional Application Filed
 */

import { app } from "../../scripts/app.js";

// Studio polling state - can be set by injection from Studio
window.scrupleProjectName = window.scrupleProjectName || "";
window.scrupleStudioConnected = window.scrupleStudioConnected || false;

// Poll Studio as fallback (slower since injection handles immediate updates)
async function pollStudio() {
    for (let port = 5742; port < 5752; port++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/capture-status`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            if (response.ok) {
                const data = await response.json();
                window.scrupleStudioConnected = data.connected || false;
                window.scrupleProjectName = data.project_name || "";
                return;
            }
        } catch (e) {
            // Try next port
        }
    }
    window.scrupleStudioConnected = false;
    window.scrupleProjectName = "";
}

// Poll less frequently - injection handles immediate updates
setInterval(pollStudio, 5000);
pollStudio();

app.registerExtension({
    name: "Scruple.StudioTerminal",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ScrupleStudioTerminal") return;
        
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onExecuted = nodeType.prototype.onExecuted;
        
        nodeType.prototype.onNodeCreated = function() {
            if (onNodeCreated) {
                onNodeCreated.apply(this, arguments);
            }
            
            // State
            this.telemetryLog = "Waiting for data...";
            this.authenticated = false;
            this.hasError = false;
            this.projectName = "";
            this.studioConnected = false;
            this.size = [420, 420];  // Taller for 15+ inputs
            
            // Start refresh interval to update from polling/injection
            const self = this;
            setInterval(() => {
                // Update display from window vars (set by injection or polling)
                if (window.scrupleProjectName || window.scrupleStudioConnected) {
                    self.setDirtyCanvas(true, true);
                }
            }, 1000);
        };
        
        // Update display when data arrives
        nodeType.prototype.onExecuted = function(output) {
            if (onExecuted) {
                onExecuted.apply(this, arguments);
            }
            
            if (output) {
                // Get telemetry log
                if (output.telemetry_log) {
                    if (Array.isArray(output.telemetry_log)) {
                        this.telemetryLog = output.telemetry_log[0];
                    } else {
                        this.telemetryLog = output.telemetry_log;
                    }
                }
                
                // Get project name
                if (output.project_name) {
                    if (Array.isArray(output.project_name)) {
                        this.projectName = output.project_name[0];
                    } else {
                        this.projectName = output.project_name;
                    }
                }
                
                // Get studio connection status
                if (output.studio_connected) {
                    if (Array.isArray(output.studio_connected)) {
                        this.studioConnected = output.studio_connected[0];
                    } else {
                        this.studioConnected = output.studio_connected;
                    }
                }
                
                // Authenticated if studio connected
                this.authenticated = this.studioConnected;
                
                // Check for errors
                this.hasError = this.telemetryLog && 
                    (this.telemetryLog.includes("ERROR:") || 
                     this.telemetryLog.includes("PARTIAL:"));
            }
            
            this.setDirtyCanvas(true, true);
            app.graph.setDirtyCanvas(true, true);
        };
        
        // Custom drawing
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function(ctx) {
            if (onDrawForeground) {
                onDrawForeground.apply(this, arguments);
            }
            
            // Use injected/polled window data if node hasn't been executed yet
            const displayProjectName = this.projectName || window.scrupleProjectName || "";
            const displayConnected = this.studioConnected || window.scrupleStudioConnected || false;
            const displayAuth = displayConnected && displayProjectName;
            
            // Display area - no widget, starts right below title
            const leftMargin = 100;  // Space for inputs on left
            const rightMargin = 10;
            const topMargin = 30;    // Just below title
            const bottomMargin = 10;
            
            const x = leftMargin;
            const y = topMargin;
            const width = this.size[0] - leftMargin - rightMargin;
            const height = this.size[1] - topMargin - bottomMargin;
            
            // Background
            ctx.fillStyle = "#0d1117";
            ctx.fillRect(x, y, width, height);
            
            // Border
            ctx.strokeStyle = "#30363d";
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, width, height);
            
            // Header bar - 40px for 2 lines (project name + auth status)
            ctx.fillStyle = "#161b22";
            ctx.fillRect(x, y, width, 40);
            
            // Line 1: Project name
            ctx.font = "bold 10px monospace";
            if (displayProjectName) {
                ctx.fillStyle = "#3fb950";  // Green
                ctx.fillText("🔗 " + displayProjectName, x + 8, y + 14);
            } else if (displayConnected) {
                ctx.fillStyle = "#d29922";  // Yellow
                ctx.fillText("⚠️ NO ACTIVE PROJECT", x + 8, y + 14);
            } else {
                ctx.fillStyle = "#f85149";  // Red
                ctx.fillText("❌ STUDIO NOT CONNECTED", x + 8, y + 14);
            }
            
            // Line 2: Auth status
            ctx.font = "bold 10px monospace";
            if (displayAuth && displayProjectName) {
                ctx.fillStyle = "#3fb950";  // Green
                ctx.fillText("🔒 AUTHENTICATED", x + 8, y + 30);
            } else if (this.hasError) {
                ctx.fillStyle = "#f85149";  // Red
                ctx.fillText("✗ ERROR", x + 8, y + 30);
            } else if (this.telemetryLog && this.telemetryLog !== "Waiting for data...") {
                ctx.fillStyle = "#d29922";  // Yellow
                ctx.fillText("⚠️ UNAUTHENTICATED", x + 8, y + 30);
            } else {
                ctx.fillStyle = "#8b949e";  // Gray
                ctx.fillText("📡 TELEMETRY", x + 8, y + 30);
            }
            
            // Status indicator dot
            ctx.beginPath();
            ctx.arc(x + width - 12, y + 20, 5, 0, Math.PI * 2);
            if (displayAuth && displayProjectName) {
                ctx.fillStyle = "#3fb950";  // Green
            } else if (this.hasError) {
                ctx.fillStyle = "#f85149";  // Red
            } else if (displayConnected) {
                ctx.fillStyle = "#d29922";  // Yellow
            } else {
                ctx.fillStyle = "#484f58";  // Gray
            }
            ctx.fill();
            
            // Log content
            ctx.fillStyle = "#c9d1d9";
            ctx.font = "9px monospace";
            
            const logY = y + 48;
            const lineHeight = 11;
            const maxLines = Math.floor((height - 48) / lineHeight);
            
            if (this.telemetryLog) {
                const lines = this.telemetryLog.split("\n");
                const visibleLines = lines.slice(-maxLines);
                
                for (let i = 0; i < visibleLines.length; i++) {
                    const line = visibleLines[i];
                    const lineY = logY + (i * lineHeight);
                    
                    // Color coding
                    if (line.startsWith("===") || line.startsWith(">>>")) {
                        ctx.fillStyle = "#58a6ff";  // Blue headers
                    } else if (line.includes("SEED:")) {
                        ctx.fillStyle = "#f0883e";  // Orange seeds
                    } else if (line.includes("EXPORT:") && line.includes("EXPORTED")) {
                        ctx.fillStyle = "#3fb950";  // Green success
                    } else if (line.includes("ERROR") || line.includes("PARTIAL")) {
                        ctx.fillStyle = "#f85149";  // Red errors
                    } else if (line.includes("AUTHENTICATED")) {
                        ctx.fillStyle = "#3fb950";  // Green auth
                    } else if (line.includes("UNAUTHENTICATED")) {
                        ctx.fillStyle = "#d29922";  // Yellow unauth
                    } else if (line.startsWith("  ") && !line.startsWith("    ")) {
                        ctx.fillStyle = "#c9d1d9";  // White content
                    } else {
                        ctx.fillStyle = "#8b949e";  // Gray default
                    }
                    
                    // Truncate long lines
                    const maxChars = Math.floor(width / 6);
                    const displayLine = line.length > maxChars ? 
                        line.substring(0, maxChars - 3) + "..." : line;
                    ctx.fillText(displayLine, x + 5, lineY);
                }
            }
        };
    }
});
