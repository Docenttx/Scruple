"""
SCRUPLE Backbone - Digital Twin Telemetry Sensors
Passive data capture for AI provenance

Copyright (c) 2025. All Rights Reserved.
Patent Pending - Provisional Application Filed
"""

from .nodes.input_capture import ScrupleTap
from .nodes.output_capture import ScrupleOutputCapture
from .nodes.studio_terminal import ScrupleStudioTerminal
from .nodes.studio_training_terminal import ScrupleTrainingTerminal

NODE_CLASS_MAPPINGS = {
    "ScrupleTap": ScrupleTap,
    "ScrupleOutputCapture": ScrupleOutputCapture,
    "ScrupleStudioTerminal": ScrupleStudioTerminal,
    "ScrupleTrainingTerminal": ScrupleTrainingTerminal,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScrupleTap": "📍 Input Capture",
    "ScrupleOutputCapture": "📷 Output Capture", 
    "ScrupleStudioTerminal": "📤 Studio Terminal",
    "ScrupleTrainingTerminal": "🎓 Training Terminal",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("[SCRUPLE] Studio & Training Terminals loaded")
