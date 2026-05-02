"""
input_capture.py - Input Capture Sensor (was: Scruple Tap)

SMART TELEMETRY SENSOR
- Accepts any data type
- Passes through unchanged
- Extracts ACTUAL VALUES from ComfyUI native types:
  - CONDITIONING → raw prompt text
  - ModelPatcher → model filename
  - LATENT → dimensions (width × height)
  - CLIP → encoder model name
- Captures DNA, not just metadata

Copyright (c) 2025. All Rights Reserved.
Patent Pending - Provisional Application Filed
"""

import hashlib
from datetime import datetime


class ScrupleTap:
    """
    Input Capture - Smart pass-through sensor.
    
    Captures actual values from ComfyUI's native types,
    not just metadata. Extracts the "DNA" of the creative process.
    """
    
    CATEGORY = "SCRUPLE"
    FUNCTION = "capture"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_data": ("*",),
                "tap_label": ("STRING", {"default": "input"}),
            },
            "optional": {
                "diagnostic_mode": ("BOOLEAN", {"default": False}),
            },
        }
    
    RETURN_TYPES = ("*", "*")
    RETURN_NAMES = ("passthrough", "telemetry")
    
    def capture(self, input_data, tap_label, diagnostic_mode=False):
        """
        Capture and pass through.
        
        Returns:
            passthrough: Original data unchanged
            telemetry: Extracted DNA dict for terminal
        """
        timestamp = datetime.utcnow().isoformat() + "Z"
        
        # Build telemetry packet
        telemetry = {
            "sensor": "input_capture",
            "label": tap_label,
            "timestamp": timestamp,
            "data_type": type(input_data).__name__,
        }
        
        # Add full diagnostic dump if enabled
        if diagnostic_mode:
            telemetry["_diagnostic"] = self._full_diagnostic(input_data)
        
        # Extract actual values based on type
        self._extract_dna(input_data, telemetry)
        
        # Log what we captured
        preview = telemetry.get("preview") or telemetry.get("value") or telemetry.get("model_name") or telemetry.get("dimensions") or telemetry["data_type"]
        print(f"[INPUT CAPTURE] {tap_label}: {str(preview)[:60]}")
        
        return (input_data, telemetry)
    
    def _full_diagnostic(self, data):
        """Generate full diagnostic dump of data structure."""
        diag = {
            "type": type(data).__name__,
            "module": type(data).__module__,
        }
        
        try:
            # For lists/tuples - show structure
            if isinstance(data, (list, tuple)):
                diag["length"] = len(data)
                diag["structure"] = []
                for i, item in enumerate(data[:3]):  # First 3 items
                    item_diag = {
                        "index": i,
                        "type": type(item).__name__,
                    }
                    if isinstance(item, (list, tuple)):
                        item_diag["sub_length"] = len(item)
                        item_diag["sub_types"] = [type(x).__name__ for x in item[:5]]
                        # Check for dict metadata
                        for j, sub in enumerate(item):
                            if isinstance(sub, dict):
                                item_diag[f"dict_at_{j}"] = {
                                    "keys": list(sub.keys()),
                                    "value_types": {k: type(v).__name__ for k, v in list(sub.items())[:10]}
                                }
                    elif isinstance(item, dict):
                        item_diag["keys"] = list(item.keys())
                    elif hasattr(item, 'shape'):
                        item_diag["shape"] = str(item.shape)
                    diag["structure"].append(item_diag)
            
            # For dicts - show all keys and value types
            elif isinstance(data, dict):
                diag["keys"] = list(data.keys())
                diag["value_types"] = {k: type(v).__name__ for k, v in data.items()}
                # Check for nested structures
                for k, v in data.items():
                    if hasattr(v, 'shape'):
                        diag[f"{k}_shape"] = str(v.shape)
            
            # For objects - show attributes
            else:
                diag["attributes"] = [a for a in dir(data) if not a.startswith('_')][:20]
                # Try to get common attributes
                for attr in ['shape', 'dtype', 'device', 'model_config', 'model_options']:
                    if hasattr(data, attr):
                        val = getattr(data, attr)
                        if isinstance(val, dict):
                            diag[attr] = list(val.keys())
                        else:
                            diag[attr] = str(val)[:100]
        
        except Exception as e:
            diag["error"] = str(e)
        
        return diag
    
    def _extract_dna(self, data, telemetry):
        """
        Extract actual values from ComfyUI native types.
        This is the "smart witness" that drills into complex objects.
        """
        
        # =================================================================
        # CONDITIONING - Extract raw prompt text
        # Format: [(tensor, {"pooled_output": ..., ...}), ...]
        # Some nodes attach "raw_text" or "text" to metadata
        # =================================================================
        if isinstance(data, list) and len(data) > 0:
            first = data[0]
            
            # Check for CONDITIONING format: list of tuples
            if isinstance(first, (list, tuple)) and len(first) >= 2:
                # 1. Primary: Look for text in metadata dict
                if isinstance(first[1], dict):
                    metadata = first[1]
                    # Try multiple possible keys where text might be stored
                    raw_text = (
                        metadata.get("raw_text") or 
                        metadata.get("text") or 
                        metadata.get("prompt") or
                        metadata.get("original_text") or
                        metadata.get("caption")
                    )
                    if raw_text:
                        telemetry["preview"] = raw_text[:200]
                        telemetry["prompt_length"] = len(raw_text)
                        telemetry["hash"] = hashlib.sha256(raw_text.encode()).hexdigest()[:16]
                        return
                    
                    # Also check for any string values in metadata
                    for key, val in metadata.items():
                        if isinstance(val, str) and len(val) > 10 and key not in ["pooled_output"]:
                            telemetry["preview"] = val[:200]
                            telemetry["found_in"] = key
                            telemetry["hash"] = hashlib.sha256(val.encode()).hexdigest()[:16]
                            return
                
                # 2. Fallback: Record mathematical footprint if no text found
                if hasattr(first[0], 'shape'):
                    telemetry["encoding_shape"] = str(first[0].shape)
                    telemetry["conditioning_count"] = len(data)
                    telemetry["preview"] = f"[ENCODED - tap STRING wire for text]"
                    telemetry["note"] = "Place capture BEFORE CLIPTextEncode to get raw text"
                    try:
                        tensor_bytes = first[0].cpu().numpy().tobytes()
                        telemetry["hash"] = hashlib.sha256(tensor_bytes).hexdigest()[:16]
                    except:
                        pass
                    return
            
            # Plain list - just record length and sample
            telemetry["length"] = len(data)
            if len(data) > 0 and isinstance(data[0], str):
                telemetry["preview"] = data[0][:100]
            return
        
        # =================================================================
        # ModelPatcher - Extract model filename/identity
        # =================================================================
        type_name = type(data).__name__
        
        if type_name == "ModelPatcher":
            model_name = self._extract_model_name(data)
            telemetry["model_name"] = model_name
            telemetry["hash"] = hashlib.sha256(model_name.encode()).hexdigest()[:16]
            telemetry["preview"] = model_name
            return
        
        # =================================================================
        # CLIP - Extract encoder model name
        # =================================================================
        if "CLIP" in type_name or type_name == "CLIP":
            clip_name = self._extract_clip_name(data)
            telemetry["clip_name"] = clip_name
            telemetry["hash"] = hashlib.sha256(clip_name.encode()).hexdigest()[:16]
            telemetry["preview"] = clip_name
            return
        
        # =================================================================
        # LATENT - Extract dimensions (dict with "samples" tensor)
        # Latent space is 1/8 of pixel space
        # =================================================================
        if isinstance(data, dict) and "samples" in data:
            samples = data["samples"]
            if hasattr(samples, 'shape'):
                shape = list(samples.shape)  # [Batch, Channels, Height, Width]
                if len(shape) >= 4:
                    width = shape[3] * 8
                    height = shape[2] * 8
                    telemetry["width"] = width
                    telemetry["height"] = height
                    telemetry["dimensions"] = f"{width}x{height}"
                    telemetry["batch_size"] = shape[0]
                    telemetry["latent_shape"] = str(shape)
                    telemetry["preview"] = f"{width}x{height}"
            return
        
        # =================================================================
        # VAE - Extract VAE model info
        # =================================================================
        if type_name == "VAE" or "VAE" in type_name:
            vae_name = self._extract_vae_name(data)
            telemetry["vae_name"] = vae_name
            telemetry["preview"] = vae_name
            return
        
        # =================================================================
        # Tensor (generic) - Shape and partial hash
        # =================================================================
        if hasattr(data, 'shape'):
            telemetry["shape"] = str(data.shape)
            telemetry["dtype"] = str(data.dtype) if hasattr(data, 'dtype') else "unknown"
            try:
                tensor_bytes = data.cpu().numpy().tobytes()[:1024]  # First 1KB
                telemetry["hash"] = hashlib.sha256(tensor_bytes).hexdigest()[:16]
            except:
                pass
            telemetry["preview"] = f"Tensor{data.shape}"
            return
        
        # =================================================================
        # String - Direct capture
        # =================================================================
        if isinstance(data, str):
            telemetry["preview"] = data[:200] + "..." if len(data) > 200 else data
            telemetry["value"] = data
            telemetry["hash"] = hashlib.sha256(data.encode()).hexdigest()[:16]
            return
        
        # =================================================================
        # Numbers - Direct capture
        # =================================================================
        if isinstance(data, (int, float)):
            telemetry["value"] = data
            telemetry["preview"] = str(data)
            return
        
        # =================================================================
        # Dict (generic) - Capture keys and common values
        # =================================================================
        if isinstance(data, dict):
            telemetry["keys"] = list(data.keys())[:10]
            # Try to extract common fields
            for key in ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"]:
                if key in data:
                    telemetry[key] = data[key]
            telemetry["preview"] = f"dict({len(data)} keys)"
            return
        
        # =================================================================
        # Fallback - Just record what we can
        # =================================================================
        telemetry["preview"] = f"<{type_name}>"
    
    def _extract_model_name(self, model_patcher):
        """Extract model filename from ModelPatcher."""
        # Try various attributes where model name might be stored
        try:
            # Check for model_options
            if hasattr(model_patcher, 'model_options'):
                opts = model_patcher.model_options
                if isinstance(opts, dict):
                    if 'model_path' in opts:
                        return opts['model_path'].split('/')[-1].split('\\')[-1]
            
            # Check for load_device or model attribute
            if hasattr(model_patcher, 'model'):
                model = model_patcher.model
                if hasattr(model, 'model_config'):
                    config = model.model_config
                    if hasattr(config, 'unet_config'):
                        return str(config.unet_config.get('model_type', 'Unknown'))
            
            # Check for filename in object representation
            obj_str = str(model_patcher)
            if 'safetensors' in obj_str.lower() or 'ckpt' in obj_str.lower():
                # Try to extract filename
                import re
                match = re.search(r'[\w\-\.]+\.(safetensors|ckpt)', obj_str, re.IGNORECASE)
                if match:
                    return match.group(0)
            
            # Last resort - use object id for uniqueness
            return f"ModelPatcher_{id(model_patcher) % 10000}"
            
        except Exception as e:
            return f"ModelPatcher_error_{str(e)[:20]}"
    
    def _extract_clip_name(self, clip):
        """Extract CLIP encoder model name."""
        try:
            # Check for various CLIP attributes
            if hasattr(clip, 'clip_name'):
                return clip.clip_name
            
            if hasattr(clip, 'cond_stage_model'):
                model = clip.cond_stage_model
                if hasattr(model, '__class__'):
                    return model.__class__.__name__
            
            # Check for tokenizer info
            if hasattr(clip, 'tokenizer'):
                tok = clip.tokenizer
                if hasattr(tok, 'name_or_path'):
                    return tok.name_or_path.split('/')[-1]
            
            # Use class name as fallback
            return type(clip).__name__
            
        except Exception as e:
            return f"CLIP_error_{str(e)[:20]}"
    
    def _extract_vae_name(self, vae):
        """Extract VAE model name."""
        try:
            if hasattr(vae, 'vae_name'):
                return vae.vae_name
            
            if hasattr(vae, 'first_stage_model'):
                return type(vae.first_stage_model).__name__
            
            return type(vae).__name__
            
        except Exception as e:
            return f"VAE_error_{str(e)[:20]}"
    
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")
