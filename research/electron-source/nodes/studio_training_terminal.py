"""
studio_training_terminal.py - Scruple Training Terminal

UNIVERSAL TRAINING PROVENANCE CAPTURE
- Polls Electron Studio for active project (REQUIRED)
- Works with ANY training workflow (Flux, Kohya, Simpletuner, etc.)
- Recursively crawls the node graph starting from the output
- Heuristically identifies Datasets, Models, and Hyperparameters
- Computes Merkle roots for dataset folders
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
from datetime import datetime
from pathlib import Path

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
COUNTER_FILE = OUTPUT_DIR / "scruple_training_counters.json"

# Manifest version
MANIFEST_VERSION = "3.0"

# Studio API settings
STUDIO_HOST = "127.0.0.1"
STUDIO_PORT_START = 5742
STUDIO_TIMEOUT = 2.0

# Thread lock for counter file access
_counter_lock = threading.Lock()


class ScrupleTrainingTerminal:
    """
    Scruple Training Terminal - Universal Training Provenance Capture.
    
    REQUIRES Electron Studio to be running with an active project.
    Parses ANY training graph by walking backwards from the output file path.
    """
    
    CATEGORY = "SCRUPLE"
    FUNCTION = "capture"
    OUTPUT_NODE = True
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_path_1": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "lora_path_2": ("STRING", {"forceInput": True}),
                "lora_path_3": ("STRING", {"forceInput": True}),
                "lora_path_4": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
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
            print(f"[SCRUPLE TRAINING] Poll error: {e}")
        
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
            print(f"[SCRUPLE TRAINING] Session read error: {e}")
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
    # HASHING UTILITIES
    # =========================================================================
    
    def _hash_file(self, file_path):
        """Compute SHA-256 hash of a file."""
        try:
            with open(file_path, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()
        except Exception as e:
            print(f"[SCRUPLE TRAINING] Hash error for {file_path}: {e}")
            return None
    
    def _hash_pair(self, left, right):
        """Hash two hashes together using Merkle tree convention."""
        combined = left + right if left < right else right + left
        return hashlib.sha256(combined.encode()).hexdigest()
    
    def _compute_merkle_root(self, hashes):
        """Build Merkle tree from list of hashes, return root."""
        if not hashes:
            return None
        if len(hashes) == 1:
            return hashes[0]
        
        current_level = list(hashes)
        
        while len(current_level) > 1:
            if len(current_level) % 2 == 1:
                current_level.append(current_level[-1])
            
            next_level = []
            for i in range(0, len(current_level), 2):
                next_level.append(self._hash_pair(current_level[i], current_level[i + 1]))
            
            current_level = next_level
        
        return current_level[0]
    
    def _compute_folder_merkle(self, folder_path):
        """Compute Merkle root for all files in a dataset folder."""
        try:
            folder = Path(folder_path)
        except:
            return {"merkle_root": None, "file_count": 0, "image_count": 0, "caption_count": 0}
        
        if not folder.exists() or not folder.is_dir():
            return {"merkle_root": None, "file_count": 0, "image_count": 0, "caption_count": 0}
        
        image_exts = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}
        caption_exts = {'.txt', '.caption'}
        valid_exts = image_exts | caption_exts
        
        files = []
        for f in sorted(folder.iterdir()):
            if f.is_file() and f.suffix.lower() in valid_exts:
                files.append(f)
        
        if not files:
            return {"merkle_root": None, "file_count": 0, "image_count": 0, "caption_count": 0}
        
        hashes = []
        image_count = 0
        caption_count = 0
        
        for f in files:
            file_hash = self._hash_file(f)
            if file_hash:
                hashes.append(file_hash)
                if f.suffix.lower() in caption_exts:
                    caption_count += 1
                else:
                    image_count += 1
        
        return {
            "merkle_root": self._compute_merkle_root(hashes),
            "file_count": len(files),
            "image_count": image_count,
            "caption_count": caption_count
        }

    # =========================================================================
    # GRAPH WALKING
    # =========================================================================

    def _find_upstream_nodes(self, prompt, start_node_id, visited=None):
        """Recursively find ALL nodes connected upstream from the start node."""
        if visited is None:
            visited = set()
        
        start_node_id = str(start_node_id)
        
        if start_node_id in visited:
            return []
        
        visited.add(start_node_id)
        found_nodes = []
        
        node_data = prompt.get(start_node_id)
        if not node_data:
            return []

        found_nodes.append({
            "id": start_node_id,
            "class_type": node_data.get("class_type", "Unknown"),
            "inputs": node_data.get("inputs", {})
        })
        
        for key, value in node_data.get("inputs", {}).items():
            if isinstance(value, list) and len(value) == 2:
                parent_id = str(value[0])
                if parent_id not in visited:
                    found_nodes.extend(self._find_upstream_nodes(prompt, parent_id, visited))
                    
        return found_nodes

    def _find_source_node_for_input(self, prompt, my_node_id, input_name):
        """Find which node is connected to a specific input slot of THIS node."""
        my_data = prompt.get(str(my_node_id))
        if not my_data:
            return None
        
        connection = my_data.get("inputs", {}).get(input_name)
        if isinstance(connection, list) and len(connection) == 2:
            return str(connection[0])
        return None

    # =========================================================================
    # HEURISTIC EXTRACTION
    # =========================================================================

    def _find_path_in_settings(self, settings):
        """Find any value that looks like a directory path."""
        for k, v in settings.items():
            if isinstance(v, str) and ("path" in k.lower() or "dir" in k.lower()):
                try:
                    if os.path.isdir(v):
                        return v
                except:
                    pass
        return None

    def _parse_workflow_heuristically(self, node_list):
        """
        Analyze a list of nodes and categorize them based on naming heuristics.
        
        Returns dict with: datasets, models, params, unknowns
        """
        categorized = {
            "datasets": [],
            "models": [],
            "params": {},
            "unknowns": []
        }
        
        for node in node_list:
            cls = node["class_type"]
            cls_lower = cls.lower()
            
            # Extract primitive settings (skip node references)
            settings = {}
            for k, v in node["inputs"].items():
                if not isinstance(v, list):
                    settings[k] = v
            
            # --- HEURISTIC 1: DATASETS ---
            if "dataset" in cls_lower:
                ds_path = self._find_path_in_settings(settings)
                ds_entry = {
                    "node": cls,
                    "settings": settings
                }
                if ds_path:
                    merkle = self._compute_folder_merkle(ds_path)
                    ds_entry.update({
                        "path": ds_path,
                        "merkle_root": merkle["merkle_root"],
                        "image_count": merkle["image_count"],
                        "caption_count": merkle["caption_count"]
                    })
                categorized["datasets"].append(ds_entry)
                continue

            # --- HEURISTIC 2: MODELS ---
            if any(kw in cls_lower for kw in ["checkpoint", "loader", "modelselect"]):
                model_name = (
                    settings.get("ckpt_name") or 
                    settings.get("model_name") or 
                    settings.get("unet_name") or
                    settings.get("transformer") or
                    settings.get("vae") or
                    settings.get("clip_l") or
                    settings.get("t5")
                )
                categorized["models"].append({
                    "node": cls,
                    "name": model_name,
                    "settings": settings
                })
                continue

            # --- HEURISTIC 3: TRAINING PARAMS ---
            if any(kw in cls_lower for kw in ["optimizer", "train", "config", "init", "lora"]):
                categorized["params"][cls] = settings
                continue
                
            # --- DEFAULT ---
            if settings:
                categorized["unknowns"].append({
                    "node": cls,
                    "settings": settings
                })

        return categorized
    
    # =========================================================================
    # TELEMETRY DISPLAY
    # =========================================================================
    
    def _build_telemetry_log(self, provenance, status_icon):
        """Build telemetry log string for display."""
        lines = []
        lines.append(f"=== SCRUPLE TRAINING {status_icon} ===")
        lines.append(f"Project: {provenance.get('project_name', 'Unknown')}")
        lines.append(f"Run: #{provenance.get('run_sequence', 0)}")
        lines.append(f"Time: {provenance.get('timestamp', '')[:19]}")
        lines.append("")
        
        # Outputs
        outputs = provenance.get("outputs", [])
        if outputs:
            lines.append(f">>> OUTPUTS ({len(outputs)})")
            for out in outputs:
                lines.append(f"  {Path(out['path']).name}")
                if out.get('sha256'):
                    lines.append(f"    SHA: {out['sha256'][:24]}...")
            lines.append("")

        # Datasets
        ingredients = provenance.get("ingredients", {})
        datasets = ingredients.get("datasets", [])
        if datasets:
            lines.append(f">>> DATASETS ({len(datasets)})")
            for ds in datasets:
                if ds.get('path'):
                    lines.append(f"  {ds['path']}")
                    if ds.get('merkle_root'):
                        lines.append(f"    Merkle: {ds['merkle_root'][:24]}...")
                    lines.append(f"    Images: {ds.get('image_count', 0)}, Captions: {ds.get('caption_count', 0)}")
            lines.append("")
        
        # Models
        models = ingredients.get("base_models", [])
        if models:
            lines.append(f">>> BASE MODELS ({len(models)})")
            for m in models:
                if m.get('name'):
                    lines.append(f"  {m['name']}")
        
        return "\n".join(lines)
    
    # =========================================================================
    # MAIN CAPTURE FUNCTION
    # =========================================================================
    
    def capture(self, prompt=None, unique_id=None, **kwargs):
        """
        Capture provenance for this training run.
        
        REQUIRES Studio to be connected with an active project.
        """
        
        # =====================================================================
        # 1. POLL STUDIO (REQUIRED)
        # =====================================================================
        print("\n[SCRUPLE TRAINING] === Checking Studio Connection ===")
        
        status = self._poll_studio()
        
        if not status or not status.get("connected"):
            error_msg = "ERROR: Scruple Studio not running!"
            print(f"[SCRUPLE TRAINING] {error_msg}")
            print("[SCRUPLE TRAINING] Please start Studio and activate a project.")
            raise Exception(error_msg)
        
        if status.get("bypass"):
            print("[SCRUPLE TRAINING] Bypass mode - skipping capture")
            return {"ui": {"status": ["BYPASS"]}}
        
        self.project_name = status.get("project_name", "").strip()
        self.output_path = status.get("output_path", "").strip()
        
        if not self.project_name:
            error_msg = "ERROR: No active project in Studio!"
            print(f"[SCRUPLE TRAINING] {error_msg}")
            print("[SCRUPLE TRAINING] Please activate a project in Studio.")
            raise Exception(error_msg)
        
        print(f"[SCRUPLE TRAINING] Connected (port {self.studio_port})")
        print(f"[SCRUPLE TRAINING] Project: {self.project_name}")
        
        # =====================================================================
        # 2. READ SESSION ID
        # =====================================================================
        self.session_id = self._read_session_id()
        session_icon = "OK" if self.session_id else "NO SESSION"
        
        timestamp = datetime.utcnow()
        timestamp_str = timestamp.strftime("%Y%m%d_%H%M%S")
        timestamp_iso = timestamp.isoformat() + "Z"
        
        # =====================================================================
        # 3. GET SEQUENCE NUMBER
        # =====================================================================
        run_sequence = self._get_next_sequence(self.project_name)
        print(f"[SCRUPLE TRAINING] Run: #{run_sequence}")
        
        # =====================================================================
        # 4. CRAWL UPSTREAM GRAPH
        # =====================================================================
        print("[SCRUPLE TRAINING] Crawling workflow graph...")
        
        saver_node_id = self._find_source_node_for_input(prompt, unique_id, "lora_path_1")
        
        graph_data = {"datasets": [], "models": [], "params": {}, "unknowns": []}
        nodes_analyzed = 0
        
        if saver_node_id:
            all_upstream_nodes = self._find_upstream_nodes(prompt, saver_node_id)
            nodes_analyzed = len(all_upstream_nodes)
            graph_data = self._parse_workflow_heuristically(all_upstream_nodes)
            print(f"[SCRUPLE TRAINING] Analyzed {nodes_analyzed} nodes")
            print(f"[SCRUPLE TRAINING] Found {len(graph_data['datasets'])} dataset(s)")
        else:
            print("[SCRUPLE TRAINING] Warning: Could not trace upstream graph")
        
        # =====================================================================
        # 5. PREPARE OUTPUT PATHS
        # =====================================================================
        output_dir = Path(self.output_path) if self.output_path else (OUTPUT_DIR / "training_provenance")
        project_dir = output_dir / self.project_name
        project_dir.mkdir(parents=True, exist_ok=True)
        
        base_filename = f"{self.project_name}_training{run_sequence}_{timestamp_str}"
        temp_json_path = project_dir / f"temp_{uuid.uuid4().hex}.json"
        final_json_path = project_dir / f"{base_filename}.training.provenance.json"
        
        # =====================================================================
        # 6. HASH OUTPUT FILES
        # =====================================================================
        print("[SCRUPLE TRAINING] Hashing output files...")
        
        outputs = []
        for i in range(1, 5):
            lora_path = kwargs.get(f"lora_path_{i}")
            if lora_path and isinstance(lora_path, str) and lora_path.strip():
                lora_path = lora_path.strip()
                if os.path.exists(lora_path):
                    file_hash = self._hash_file(lora_path)
                    if file_hash:
                        outputs.append({
                            "path": lora_path,
                            "filename": Path(lora_path).name,
                            "sha256": file_hash
                        })
                        print(f"[SCRUPLE TRAINING] Hashed: {Path(lora_path).name}")
        
        if not outputs:
            error_msg = "ERROR: No valid output files found!"
            print(f"[SCRUPLE TRAINING] {error_msg}")
            raise Exception(error_msg)
        
        print(f"[SCRUPLE TRAINING] Processed {len(outputs)} output(s)")
        
        # =====================================================================
        # 7. BUILD PROVENANCE PAYLOAD
        # =====================================================================
        provenance = {
            "version": MANIFEST_VERSION,
            "type": "lora_training",
            "session_id": self.session_id,
            "project_name": self.project_name,
            "run_sequence": run_sequence,
            "timestamp": timestamp_iso,
            "nodes_analyzed": nodes_analyzed,
            "ingredients": {
                "datasets": graph_data.get("datasets", []),
                "base_models": graph_data.get("models", [])
            },
            "recipe": {
                "training_params": graph_data.get("params", {}),
                "other_nodes": graph_data.get("unknowns", [])
            },
            "outputs": outputs
        }
        
        # =====================================================================
        # 8. ATOMIC HANDOFF
        # =====================================================================
        try:
            with open(temp_json_path, 'w', encoding='utf-8') as f:
                json.dump(provenance, f, indent=2, sort_keys=False)
            
            temp_json_path.replace(final_json_path)
            print(f"[SCRUPLE TRAINING] Handoff: {final_json_path.name}")
            
        except Exception as e:
            raise Exception(f"Handoff failed: {e}")
        
        # =====================================================================
        # 9. BUILD TELEMETRY LOG FOR DISPLAY
        # =====================================================================
        telemetry_log = self._build_telemetry_log(provenance, session_icon)
        
        status_msg = f"CAPTURED: {base_filename}"
        print(f"[SCRUPLE TRAINING] {status_msg}")
        print(f"[SCRUPLE TRAINING] =====================================\n")
        
        return {
            "ui": {
                "telemetry_log": [telemetry_log],
                "project_name": [self.project_name],
                "run_sequence": [run_sequence],
                "dataset_count": [len(graph_data.get('datasets', []))],
                "output_count": [len(outputs)],
                "studio_connected": [True],
            }
        }
    
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """Always re-execute to check Studio status."""
        return float("nan")


# =============================================================================
# NODE REGISTRATION
# =============================================================================

NODE_CLASS_MAPPINGS = {
    "ScrupleTrainingTerminal": ScrupleTrainingTerminal,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScrupleTrainingTerminal": "SCRUPLE Training Terminal",
}
