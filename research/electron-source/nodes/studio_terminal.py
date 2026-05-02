"""
studio_terminal.py - Scruple Studio Terminal

INTEGRATED PROVENANCE CAPTURE
- Polls Electron Studio for active project (REQUIRED)
- Captures all telemetry inputs from input_capture nodes
- Computes leaf_hash (SHA-256 of image bytes)
- Atomic JSON handoff to Studio

STUDIO IS REQUIRED - Node fails if Studio not connected.

Copyright (c) 2025. All Rights Reserved.
Patent Pending - Provisional Application Filed
"""

import os
import json
import hashlib
import threading
import uuid
import urllib.request
import urllib.error
import numpy as np
from datetime import datetime
from pathlib import Path

# Try PIL for image saving
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("[SCRUPLE] WARNING: PIL not found. Image saving disabled.")

# Try to get ComfyUI paths
try:
    import folder_paths
    COMFYUI_ROOT = Path(folder_paths.base_path)
    OUTPUT_DIR = Path(folder_paths.get_output_directory())
except:
    COMFYUI_ROOT = Path(".")
    OUTPUT_DIR = Path("./output")

# Session file (written by Electron Studio)
SESSION_FILE = COMFYUI_ROOT / "scruple_session.txt"

# Global counter file
COUNTER_FILE = OUTPUT_DIR / "scruple_counters.json"

# Manifest version
MANIFEST_VERSION = "3.0"

# Studio API settings
STUDIO_HOST = "127.0.0.1"
STUDIO_PORT_START = 5742
STUDIO_TIMEOUT = 2.0

# Thread lock for counter file access
_counter_lock = threading.Lock()


class ScrupleStudioTerminal:
    """
    Scruple Studio Terminal - Integrated Provenance Capture.
    
    REQUIRES Electron Studio to be running with an active project.
    Polls Studio API, captures telemetry, exports with atomic handoff.
    """
    
    CATEGORY = "SCRUPLE"
    FUNCTION = "capture"
    OUTPUT_NODE = True
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "in_1": ("*", {"forceInput": True}),
                "in_2": ("*", {"forceInput": True}),
                "in_3": ("*", {"forceInput": True}),
                "in_4": ("*", {"forceInput": True}),
                "in_5": ("*", {"forceInput": True}),
                "in_6": ("*", {"forceInput": True}),
                "in_7": ("*", {"forceInput": True}),
                "in_8": ("*", {"forceInput": True}),
                "in_9": ("*", {"forceInput": True}),
                "in_10": ("*", {"forceInput": True}),
                "in_11": ("*", {"forceInput": True}),
                "in_12": ("*", {"forceInput": True}),
                "in_13": ("*", {"forceInput": True}),
                "in_14": ("*", {"forceInput": True}),
                "in_15": ("*", {"forceInput": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }
    
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    
    def __init__(self):
        self.session_id = None
        self.studio_port = None
        self.project_name = None
        self.output_path = None
    
    # =========================================================================
    # STUDIO CONNECTION
    # =========================================================================
    
    def _find_studio_port(self):
        """Find which port Studio is running on."""
        for port in range(STUDIO_PORT_START, STUDIO_PORT_START + 10):
            try:
                url = f"http://{STUDIO_HOST}:{port}/api/health"
                req = urllib.request.Request(url, method='GET')
                with urllib.request.urlopen(req, timeout=1.0) as response:
                    if response.status == 200:
                        return port
            except:
                continue
        return None
    
    def _poll_studio(self):
        """
        Poll Electron Studio for capture status.
        
        Returns:
            dict or None: Status from Studio
        """
        if not self.studio_port:
            self.studio_port = self._find_studio_port()
        
        if not self.studio_port:
            return None
        
        try:
            url = f"http://{STUDIO_HOST}:{self.studio_port}/api/capture-status"
            req = urllib.request.Request(url, method='GET')
            req.add_header('Accept', 'application/json')
            
            with urllib.request.urlopen(req, timeout=STUDIO_TIMEOUT) as response:
                if response.status == 200:
                    return json.loads(response.read().decode('utf-8'))
                    
        except urllib.error.URLError:
            self.studio_port = None
        except Exception as e:
            print(f"[SCRUPLE STUDIO] Poll error: {e}")
        
        return None
    
    # =========================================================================
    # SESSION ID
    # =========================================================================
    
    def _read_session_id(self):
        """Read session ID from scruple_session.txt."""
        try:
            if SESSION_FILE.exists():
                return SESSION_FILE.read_text(encoding='utf-8').strip()
        except Exception as e:
            print(f"[SCRUPLE STUDIO] Session read error: {e}")
        return None
    
    # =========================================================================
    # COUNTER MANAGEMENT
    # =========================================================================
    
    def _get_next_sequence(self, project_name):
        """Get next run sequence number atomically."""
        with _counter_lock:
            counters = {}
            
            if COUNTER_FILE.exists():
                try:
                    with open(COUNTER_FILE, 'r', encoding='utf-8') as f:
                        counters = json.load(f)
                except:
                    pass
            
            current = counters.get(project_name, 0)
            next_seq = current + 1
            counters[project_name] = next_seq
            
            COUNTER_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(COUNTER_FILE, 'w', encoding='utf-8') as f:
                json.dump(counters, f, indent=2)
            
            return next_seq
    
    # =========================================================================
    # IMAGE HANDLING
    # =========================================================================
    
    def _save_image(self, image_tensor, path):
        """Save image tensor to PNG file."""
        if not HAS_PIL:
            return False
        
        try:
            if hasattr(image_tensor, 'cpu'):
                image_tensor = image_tensor.cpu().numpy()
            
            if isinstance(image_tensor, np.ndarray):
                if image_tensor.ndim == 4:
                    image_tensor = image_tensor[0]
                
                if image_tensor.dtype == np.float32 or image_tensor.dtype == np.float64:
                    image_tensor = (image_tensor * 255).astype(np.uint8)
                
                if image_tensor.ndim == 3 and image_tensor.shape[2] in [3, 4]:
                    img = Image.fromarray(image_tensor)
                    img.save(path, 'PNG')
                    return True
            
            return False
        except Exception as e:
            print(f"[SCRUPLE STUDIO] Image save error: {e}")
            return False
    
    def _hash_image_file(self, image_path):
        """Compute SHA-256 hash of image file."""
        try:
            with open(image_path, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()
        except Exception as e:
            print(f"[SCRUPLE STUDIO] Hash error: {e}")
            return None
    
    # =========================================================================
    # METADATA EXTRACTION
    # =========================================================================
    
    def _extract_all_settings(self, prompt):
        """
        Extract ALL primitive settings from ALL nodes in the workflow.
        
        Returns list of tuples: (node_class.input_name, value, is_long_string)
        Sorted with long strings (prompts) first, then alphabetical.
        """
        if not prompt:
            return []
        
        settings = []
        
        for node_id, node_data in prompt.items():
            if not isinstance(node_data, dict):
                continue
            
            class_type = node_data.get("class_type", f"Node_{node_id}")
            node_inputs = node_data.get("inputs", {})
            
            for input_name, value in node_inputs.items():
                # Skip references to other nodes (lists like ["node_id", 0])
                if isinstance(value, list):
                    continue
                
                # Only capture primitives
                if isinstance(value, (str, int, float, bool)):
                    key = f"{class_type}.{input_name}"
                    is_long_string = isinstance(value, str) and len(value) > 50
                    settings.append((key, value, is_long_string))
        
        # Partition: long strings first, then rest alphabetically
        long_strings = [(k, v) for k, v, is_long in settings if is_long]
        config_items = [(k, v) for k, v, is_long in settings if not is_long]
        
        # Sort each group alphabetically by key
        long_strings.sort(key=lambda x: x[0])
        config_items.sort(key=lambda x: x[0])
        
        return long_strings + config_items
    
    # =========================================================================
    # TELEMETRY DISPLAY
    # =========================================================================
    
    def _build_telemetry_log(self, provenance, status_icon):
        """Build telemetry log string for display."""
        lines = []
        lines.append(f"=== SCRUPLE STUDIO {status_icon} ===")
        lines.append(f"Project: {provenance.get('project_name', 'Unknown')}")
        lines.append(f"Run: #{provenance.get('run_sequence', 0)}")
        lines.append(f"Time: {provenance.get('timestamp', '')[:19]}")
        lines.append("")
        lines.append(f"LEAF: {provenance.get('leaf_hash', '')[:24]}...")
        lines.append("")
        
        # Settings (unified list from _extract_all_settings)
        settings = provenance.get("metadata", {}).get("settings", [])
        
        if settings:
            lines.append(">>> SETTINGS")
            for key, value in settings:
                # Truncate long values for display
                val_str = str(value)
                if len(val_str) > 60:
                    val_str = val_str[:57] + "..."
                lines.append(f"  {key} = {val_str}")
        
        return "\n".join(lines)
    
    # =========================================================================
    # MAIN CAPTURE FUNCTION
    # =========================================================================
    
    def capture(self, prompt=None, extra_pnginfo=None, **kwargs):
        """
        Capture provenance for this generation.
        
        REQUIRES Studio to be connected with an active project.
        """
        
        # =====================================================================
        # 1. POLL STUDIO (REQUIRED)
        # =====================================================================
        print("\n[SCRUPLE STUDIO] === Checking Studio Connection ===")
        
        status = self._poll_studio()
        
        if not status or not status.get("connected"):
            error_msg = "ERROR: Scruple Studio not running!"
            print(f"[SCRUPLE STUDIO] {error_msg}")
            print("[SCRUPLE STUDIO] Please start Studio and activate a project.")
            raise Exception(error_msg)
        
        if status.get("bypass"):
            print("[SCRUPLE STUDIO] Bypass mode - skipping capture")
            return ("BYPASS", "")
        
        self.project_name = status.get("project_name", "").strip()
        self.output_path = status.get("output_path", "").strip()
        
        if not self.project_name:
            error_msg = "ERROR: No active project in Studio!"
            print(f"[SCRUPLE STUDIO] {error_msg}")
            print("[SCRUPLE STUDIO] Please activate a project in Studio.")
            raise Exception(error_msg)
        
        print(f"[SCRUPLE STUDIO] ðŸ”— Connected (port {self.studio_port})")
        print(f"[SCRUPLE STUDIO] Project: {self.project_name}")
        
        # =====================================================================
        # 2. READ SESSION ID
        # =====================================================================
        self.session_id = self._read_session_id()
        session_icon = "ðŸ”—" if self.session_id else "âš ï¸"
        
        timestamp = datetime.utcnow()
        timestamp_str = timestamp.strftime("%Y%m%d_%H%M%S")
        timestamp_iso = timestamp.isoformat() + "Z"
        
        # =====================================================================
        # 3. GET SEQUENCE NUMBER
        # =====================================================================
        run_sequence = self._get_next_sequence(self.project_name)
        print(f"[SCRUPLE STUDIO] Run: #{run_sequence}")
        
        # =====================================================================
        # 4. FIND IMAGE TENSOR
        # =====================================================================
        image_tensor = None
        image_shape = None
        
        for key, value in kwargs.items():
            if value is None:
                continue
            
            if isinstance(value, dict) and "image_tensor" in value:
                image_tensor = value.get("image_tensor")
                image_shape = value.get("image_shape")
                print(f"[SCRUPLE STUDIO] Found image in {key}")
                break
        
        if image_tensor is None:
            error_msg = "ERROR: No image tensor found!"
            print(f"[SCRUPLE STUDIO] {error_msg}")
            raise Exception(error_msg)
        
        # =====================================================================
        # 5. PREPARE OUTPUT PATHS
        # =====================================================================
        output_dir = Path(self.output_path) if self.output_path else (OUTPUT_DIR / "terminal_provenance")
        project_dir = output_dir / self.project_name
        project_dir.mkdir(parents=True, exist_ok=True)
        
        base_filename = f"{self.project_name}_run{run_sequence}_{timestamp_str}"
        png_path = project_dir / f"{base_filename}.png"
        temp_json_path = project_dir / f"temp_{uuid.uuid4().hex}.json"
        final_json_path = project_dir / f"{base_filename}.provenance.json"
        
        # =====================================================================
        # 6. SAVE IMAGE
        # =====================================================================
        if not self._save_image(image_tensor, png_path):
            raise Exception("Failed to save image!")
        
        print(f"[SCRUPLE STUDIO] Saved: {png_path.name}")
        
        # =====================================================================
        # 7. COMPUTE LEAF HASH
        # =====================================================================
        leaf_hash = self._hash_image_file(png_path)
        
        if not leaf_hash:
            raise Exception("Failed to hash image!")
        
        print(f"[SCRUPLE STUDIO] Leaf: {leaf_hash[:16]}...")
        
        # =====================================================================
        # 8. EXTRACT ALL SETTINGS FROM WORKFLOW
        # =====================================================================
        settings = self._extract_all_settings(prompt)
        metadata = {
            "settings": settings,
        }
        
        print(f"[SCRUPLE STUDIO] Extracted {len(settings)} settings from workflow")
        
        # =====================================================================
        # 9. BUILD PROVENANCE PAYLOAD
        # =====================================================================
        provenance = {
            "version": MANIFEST_VERSION,
            "session_id": self.session_id,
            "project_name": self.project_name,
            "run_sequence": run_sequence,
            "timestamp": timestamp_iso,
            "image_path": str(png_path),
            "image_filename": png_path.name,
            "leaf_hash": leaf_hash,
            "metadata": metadata,
            "image_shape": image_shape,
        }
        
        # =====================================================================
        # 10. ATOMIC HANDOFF
        # =====================================================================
        try:
            with open(temp_json_path, 'w', encoding='utf-8') as f:
                json.dump(provenance, f, indent=2, sort_keys=True)
            
            temp_json_path.replace(final_json_path)
            print(f"[SCRUPLE STUDIO] Handoff: {final_json_path.name}")
            
        except Exception as e:
            raise Exception(f"Handoff failed: {e}")
        
        # =====================================================================
        # 11. BUILD TELEMETRY LOG FOR DISPLAY
        # =====================================================================
        telemetry_log = self._build_telemetry_log(provenance, session_icon)
        
        status_msg = f"CAPTURED: {base_filename}"
        print(f"[SCRUPLE STUDIO] {status_msg}")
        print(f"[SCRUPLE STUDIO] =====================================\n")
        
        return {
            "ui": {
                "telemetry_log": [telemetry_log],
                "project_name": [self.project_name],
                "run_sequence": [run_sequence],
                "leaf_hash": [leaf_hash[:16] + "..."],
                "studio_connected": [True],
            }
        }
    
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """Always re-execute to check Studio status."""
        return float("nan")
