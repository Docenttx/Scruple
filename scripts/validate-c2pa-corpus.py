#!/usr/bin/env python3
"""Validate a corpus of C2PA-signed assets against the C2PA trust list.

For each asset in the input directory, this script:
  - Reads the C2PA manifest via c2pa-python (currently 0.89)
  - Verifies internal integrity: claim signature valid, hash-URI matches,
    BMFF hash valid for video/audio, ingredient hashes match
  - Verifies signer trust via c2pa-python's Settings API (SDK-defaulted
    verified trust list). Timestamp authority (TSA) trust is reported
    as informational — untrusted TSA is a configuration hint, not a
    failure of the manifest.
  - Emits one JSON per sample plus a summary manifest.

Usage:
  python3 scripts/validate-c2pa-corpus.py --input <corpus-dir> --output <report-dir>

Rationale: Reviewer 2026-07-16 asked us to demonstrate our validator
ingests third-party C2PA content and reports validation results against
the C2PA CA + TSA trust list. This script is that demonstration.

Two-mode output because trust configuration is orthogonal to internal
integrity:
  - "integrity" mode: verify_trust=false. Answers "is the manifest
    internally consistent?" (signature valid, hashes match)
  - "trust" mode: verify_trust=true. Answers "is the signer / TSA on the
    trust list?" (trusted vs untrusted)
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import c2pa

MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic',
    '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.wav': 'audio/wav', '.flac': 'audio/flac', '.pdf': 'application/pdf',
}


def _validate_one(sample: Path, mime: str, trust_mode: bool) -> Dict[str, Any]:
    """Run one validation pass in the requested mode. Returns a compact
    per-sample dict."""
    try:
        c2pa.load_settings(
            json.dumps({'verify': {
                'verify_trust': trust_mode,
                'verify_after_sign': trust_mode,
            }}),
            'json',
        )
    except Exception:
        pass

    data = sample.read_bytes()
    reader = c2pa.Reader(mime, io.BytesIO(data))
    state = str(reader.get_validation_state())
    vr = reader.get_validation_results() or {}
    mj = json.loads(reader.json())
    reader.close()

    active = mj.get('active_manifest')
    m = mj.get('manifests', {}).get(active, {}) if active else {}
    sig = m.get('signature_info', {})
    cg = (m.get('claim_generator_info') or [{}])[0]
    ingredients = m.get('ingredients') or []
    actions_ass = [a for a in m.get('assertions', []) if a.get('label') == 'c2pa.actions.v2']
    actions = actions_ass[0].get('data', {}).get('actions', []) if actions_ass else []

    active_vr = vr.get('activeManifest', {})

    def _msgs(items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        return [{'code': i.get('code', ''), 'explanation': i.get('explanation', '')} for i in items]

    return {
        'validation_state': state,
        'success_count': len(active_vr.get('success', [])),
        'informational_count': len(active_vr.get('informational', [])),
        'failure_count': len(active_vr.get('failure', [])),
        'failures': _msgs(active_vr.get('failure', [])),
        'informational': _msgs(active_vr.get('informational', [])),
        'signature': {
            'issuer': sig.get('issuer'),
            'time': sig.get('time'),
            'alg': sig.get('alg'),
            'cert_serial_number': sig.get('cert_serial_number'),
        },
        'claim_generator': cg.get('name'),
        'claim_generator_version': cg.get('version'),
        'ingredient_count': len(ingredients),
        'ingredient_relationships': [i.get('relationship') for i in ingredients],
        'action_chain': [
            {
                'action': a.get('action'),
                'digitalSourceType': a.get('digitalSourceType'),
                'softwareAgent': a.get('softwareAgent'),
            }
            for a in actions
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Corpus directory (files to validate)')
    ap.add_argument('--output', required=True, help='Report output directory')
    args = ap.parse_args()

    corpus = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    summary: List[Dict[str, Any]] = []
    for sample in sorted(corpus.iterdir()):
        if not sample.is_file():
            continue
        mime = MIME_BY_EXT.get(sample.suffix.lower())
        if not mime:
            print(f'  ? {sample.name}: unknown MIME, skipping')
            continue

        integrity = _validate_one(sample, mime, trust_mode=False)
        trust = _validate_one(sample, mime, trust_mode=True)

        entry = {
            'sample': sample.name,
            'mime': mime,
            'bytes': sample.stat().st_size,
            'integrity_check': integrity,
            'trust_check': trust,
        }
        summary.append(entry)
        (out / f'{sample.stem}.validation.json').write_text(json.dumps(entry, indent=2))

        state_i = integrity['validation_state']
        state_t = trust['validation_state']
        marker = '✓' if state_i == 'Valid' else '✗'
        print(
            f'  {marker} {sample.name:32s} '
            f'integrity={state_i:7s} trust={state_t:9s} '
            f'issuer={(integrity["signature"]["issuer"] or "(none)")[:35]}'
        )

    (out / '_summary.json').write_text(json.dumps(summary, indent=2))
    n_valid = sum(1 for e in summary if e['integrity_check']['validation_state'] == 'Valid')
    n_total = len(summary)
    print()
    print(f'  {n_valid}/{n_total} samples pass internal integrity check')
    print(f'  Report → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
