#!/usr/bin/env python3
"""Scruple watermark — subprocess entry point.

Reads a JSON job spec from stdin, embeds or decodes a watermark,
writes result to disk or emits decoded payload to stdout.

Job spec (embed):
    {
      "action": "embed",
      "input_path": "/path/to/master.png",
      "output_path": "/path/to/watermarked.png",
      "output_format": "PNG",
      "payload_hex": "5c14a38e30ff00000000000000000000"
    }
Result:
    { "ok": true, "output_path": "...", "bytes": 12345 }

Job spec (decode):
    {
      "action": "decode",
      "input_path": "/path/to/image.png"
    }
Result:
    { "ok": true, "decoded": { ...payload dict... } }
    or
    { "ok": true, "decoded": null }   # no valid watermark
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

from watermark.image_dct import embed_image, decode_image  # noqa: E402
from watermark.payload import payload_from_hex  # noqa: E402


def main() -> int:
    try:
        raw = sys.stdin.read()
        job = json.loads(raw)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'bad job JSON: {e}'}))
        return 1

    action = job.get('action')
    if action == 'embed':
        try:
            src = Path(job['input_path']).resolve()
            dst = Path(job['output_path']).resolve()
            payload = payload_from_hex(job['payload_hex'])
            output_format = job.get('output_format', 'PNG')
            wm_bytes = embed_image(
                src.read_bytes(),
                payload,
                output_format=output_format,
            )
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(wm_bytes)
            print(json.dumps({
                'ok': True,
                'output_path': str(dst),
                'bytes': len(wm_bytes),
            }))
            return 0
        except Exception as e:
            print(json.dumps({
                'ok': False,
                'error': str(e),
                'trace': traceback.format_exc().splitlines()[-4:],
            }))
            return 1

    if action == 'decode':
        try:
            src = Path(job['input_path']).resolve()
            decoded = decode_image(src.read_bytes())
            print(json.dumps({'ok': True, 'decoded': decoded}))
            return 0
        except Exception as e:
            print(json.dumps({
                'ok': False,
                'error': str(e),
                'trace': traceback.format_exc().splitlines()[-4:],
            }))
            return 1

    print(json.dumps({'ok': False, 'error': f'unknown action: {action!r}'}))
    return 1


if __name__ == '__main__':
    sys.exit(main())
