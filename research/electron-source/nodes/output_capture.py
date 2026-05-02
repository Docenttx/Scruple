"""
output_capture.py - Output Capture Sensor

CAPTURES THE OUTPUT IMAGE
- Receives final IMAGE tensor from VAE Decode
- Passes raw tensor to Terminal for saving
- NO hashing here - Hub handles that

Copyright (c) 2025. All Rights Reserved.
Patent Pending - Provisional Application Filed
"""

from datetime import datetime


class ScrupleOutputCapture:
    """
    Output Capture - Raw image passthrough.
    
    Captures the final pixel tensor and passes it to the Terminal
    for coordinated export with the evidence manifest.
    """
    
    CATEGORY = "SCRUPLE"
    FUNCTION = "capture"
    OUTPUT_NODE = True
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
        }
    
    RETURN_TYPES = ("IMAGE", "*")
    RETURN_NAMES = ("images", "output_image")
    
    def capture(self, images):
        """
        Capture output image tensor.
        
        Returns:
            images: Original tensor unchanged (for Preview node)
            output_image: Dict with tensor for Terminal
        """
        timestamp = datetime.utcnow().isoformat() + "Z"
        
        # Package raw tensor for Terminal
        output_image = {
            "sensor": "output_capture",
            "timestamp": timestamp,
            "image_tensor": images,
            "image_shape": list(images.shape),
            "batch_size": images.shape[0],
        }
        
        print(f"[OUTPUT CAPTURE] Shape: {images.shape}")
        print(f"[OUTPUT CAPTURE] Batch: {images.shape[0]}")
        
        return (images, output_image)
    
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")
