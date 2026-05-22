-- Migration 015: async run-job fields on generation_jobs.
--
-- The CC dev pipeline's async path (executeRunAsync) spawns a workflow on
-- Modal and returns immediately; /api/runs/status polls and ingests when
-- the run completes. Long workflows (LoRA training) can't finish inside the
-- synchronous request window, so we persist everything needed to ingest the
-- result on a later poll:
--
--   run_inputs    JSON RunInputSpec[] — re-resolved to bytes for the
--                 input-artifact manifest when the run completes.
--   run_output_kind  expected output kind (image|video|checkpoint).
--   run_prompt    denormalized label for the iteration row.
--   run_workflow  the workflow_api_json (kept for re-spawn on preemption).
--
-- All nullable — existing /api/generate rows don't set them.

ALTER TABLE generation_jobs ADD COLUMN run_inputs       TEXT;
ALTER TABLE generation_jobs ADD COLUMN run_output_kind  TEXT;
ALTER TABLE generation_jobs ADD COLUMN run_prompt       TEXT;
ALTER TABLE generation_jobs ADD COLUMN run_workflow     TEXT;
