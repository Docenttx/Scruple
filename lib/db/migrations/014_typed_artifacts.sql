-- Migration 014: typed outputs + input-artifact manifest.
--
-- Generalizes capture beyond single-image txt2img so the same provenance
-- machinery covers img2img, upscaling, txt2vid, img2video, and LoRA
-- training. Each iteration is still ONE witnessed output leaf
-- (leaf_hash = output_hash), but:
--
--   output_kind          what the output IS — 'image' | 'video' | 'checkpoint'
--   output_content_type  mime/type, e.g. image/png, video/mp4,
--                        application/octet-stream (safetensors)
--   output_bytes         output size in bytes (videos/checkpoints are large)
--   input_artifacts      JSON array of the hashed+stored INPUTS that fed this
--                        run. Each entry:
--                          { kind, hash, filename, content_type, bytes,
--                            storage_pointer }
--                        kind ∈ init_image | control_image | source_image
--                              | training_image | base_checkpoint | other
--                        For LoRA training the whole image SET lands here as
--                        many training_image entries; the output checkpoint
--                        is the single leaf. input_hash binds these hashes.
--
-- Backward compatible: existing rows default to output_kind='image' and
-- input_artifacts='[]'; nothing about the txt2img path changes.

ALTER TABLE iterations ADD COLUMN output_kind          TEXT NOT NULL DEFAULT 'image';
ALTER TABLE iterations ADD COLUMN output_content_type  TEXT;
ALTER TABLE iterations ADD COLUMN output_bytes         INTEGER;
ALTER TABLE iterations ADD COLUMN input_artifacts      TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_iterations_output_kind ON iterations(output_kind);
