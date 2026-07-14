# Coverage per modality — Article 50(2) requirement mapping

Direct citation of the underlying evidence for every asserted mark.

## Format

Each row: `modality × marking layer × implementation status × evidence pointer`.
"Evidence pointer" is a file path or URL that a reviewer can inspect
without ambiguity.

## Image

| Marking layer | Implementation | Status | Evidence |
|---|---|---|---|
| 1.1.1 C2PA v2.x | Full support across png, jpeg, webp, svg+xml, tiff, x-adobe-dng, heic, heif, avif via c2pa-python 0.89 wrapper | Shipped | `github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/docs/c2pa-conformance-evidence/2026-07-14/Generate.output.image.*/` (9 folders, each with a signed sample + JSON manifest) |
| 1.1.2 Imperceptible watermark | DCT spread-spectrum + Reed-Solomon ECC in mid-frequency Y-channel coefficients; 128-bit payload with tier-scoped body; applied at publication time via `/api/lock/local` to a derivative alongside the preserved master | Shipped | `services/watermark/image_dct.py` (encoder); `services/watermark/payload.py` (wire format); `scripts/smoke-watermark.mjs` (8 assertions including JPEG q=75 + 75% resize survival); `scripts/smoke-watermark-e2e.mjs` (5-step end-to-end); `../03-marking-implementation/marking-technical-spec.md` §Layer 2 |
| 1.1.3 Witness leaf | Per-iteration hash + Merkle chain + ledger anchor | Shipped | `docs/architecture/SCRUPLE_STANDARD_v1.md` §6; `lib/witness/canonicalLeafV24.ts` (normative); `_bundle_report.json` for iterations 1–15 |

## Video

| Marking layer | Implementation | Status | Evidence |
|---|---|---|---|
| 1.1.1 C2PA v2.x | Full support: mp4, quicktime (mov), x-msvideo (avi) via c2pa-python; BMFF hash assertion included | Shipped | `Generate.output.video.mp4/`, `Generate.output.video.quicktime/`, `Validate.output.video.x-msvideo/` |
| 1.1.3 Witness leaf | Same as image (all 11 systems use identical witness path) | Shipped | Same as image |
| 1.1.2 Imperceptible watermark | Per-frame image watermark with GOP-level payload rotation, async post-processor; extends the image-modality reference implementation shipped for the image row above | Roadmap Q4 2026 | `../05-governance/interoperability-roadmap.md` §Q4 |

## Audio

| Marking layer | Implementation | Status | Evidence |
|---|---|---|---|
| 1.1.1 C2PA v2.x | Full support: wav, flac, mpeg (MP3), mp4 (AAC) via c2pa-python | Shipped | `Generate.output.audio.wav/`, `.flac/`, `.mpeg/`, `.mp4/` |
| 1.1.3 Witness leaf | Same | Shipped | Same as image |
| 1.1.2 Imperceptible watermark | Frequency-domain spread-spectrum via FFT; SynthID Audio evaluation for base-model-side embedding continues in parallel (ElevenLabs precedent) | Roadmap Q4 2026 | `../05-governance/interoperability-roadmap.md` §Q4 |

## Text

Scruple does NOT currently generate free-form text as an output. The Code's
Sub-measure 1.1.2 requirement for text > 200 tokens does not apply.

If we ship a text generation surface (e.g. a chat/completion product), we
will:
- Add it to the scope inventory as a new row.
- Ship Sub-measure 1.1.2 via Google SynthID-Text (open-sourced Oct 2024).
- Update this coverage matrix accordingly.

## ML model (pytorch)

| Marking layer | Implementation | Status | Evidence |
|---|---|---|---|
| 1.1.1 C2PA v2.x mlModel | Sidecar manifest bound to LoRA output hash; wrapper limit for embedded mlModel manifest pending c2pa-python feature flag | Partial (sidecar shipped; embedded pending upstream) | `Raw.input.application.x-pytorch/` shows raw sample; `NOT_SUPPORTED.txt` documents the wrapper gap |
| 1.1.3 Witness leaf | Per-training-run leaf with model_hash + header_hash + training_input_hash + workflow_hash | Shipped | `lib/kohya/witness.ts` + witness server training_runs table |
| 1.1.2 Imperceptible watermark | Not applicable to model weights (would be watermarked at derivative content generation time) | N/A | Note only |

## Documents (PDF)

Validate-only. Scruple does not generate PDFs currently.

| Marking layer | Implementation | Status | Evidence |
|---|---|---|---|
| 1.1.1 C2PA v2.x validate | c2pa-python 0.89 wrapper does not currently expose PDF signing (c2pa-rs `pdf` feature not compiled into Python wheel) | Partial (read wrapper pending) | `Raw.input.application.pdf/` shows raw sample; `NOT_SUPPORTED.txt` documents the wrapper gap |
| Roadmap | Track c2pa-python releases; once pdf feature exposed, wire into the same universal signer wrapper | Roadmap | Cover letter §6 |

## Overall summary

- Raster image outputs carry all three Section 1 layers (1.1.1 + 1.1.2 + 1.1.3).
- Video, audio, and mlModel outputs carry two layers (1.1.1 + 1.1.3), each
  satisfying Section 1's multi-layered requirement. Video and audio 1.1.2
  extension is on the Q4 2026 roadmap.
- Every gap is disclosed against the specific technical reason and mapped
  to a roadmap milestone.
- Every claim has a file-level evidence pointer for a reviewer to inspect.
