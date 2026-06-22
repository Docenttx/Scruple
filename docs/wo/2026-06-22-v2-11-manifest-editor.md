# WO-11 · Manifest editor UI + workflow validity pre-check

**Scope:** When "Custom Machine" is enabled, surface an editor where the user can add/remove/pin custom node packs. Also: at /prompt time inside the proxy, pre-check workflow's `class_type`s against the user's machine manifest and 409 if a node is missing.

**Reference:** `docs/architecture/canvas-v2.md` build plan steps 16, 17.

## Files

- `components/settings/ManifestEditor.tsx` — NEW; list current packs, search/add node repos, pin specific commits/tags, save → POST `/api/machines` → triggers WO-7 build
- `lib/canvas/nodeRegistry.ts` — small in-app cache of known popular packs (display name + repo + latest tag) — seed list, expand later
- `app/canvas-proxy/[sessionId]/[...path]/route.ts` (WO-4) — extend the POST `/prompt` interceptor:
  - parse `workflow.prompt` → collect all `class_type` values
  - read `machines.manifest_json` for the active machine
  - load a manifest-derived class_type catalog (cached per manifest_hash) — sourced from a sidecar `node_index_<manifest_hash>.json` written at build time by the build worker
  - if any class_type ∉ catalog → respond 409 `{ error: 'missing_node_type', node: <class>, suggest_rebuild: true }`
  - canvas iframe receives 409 → can show "Your machine doesn't have node X. [Rebuild Machine with X added]"
- `scripts/machine-build-worker.mjs` (WO-7) — after build, introspect ComfyUI's `/object_info` once in a tiny ping run, capture the class_type names, write `node_index_<manifest_hash>.json` to a Modal volume (or scruple-web fs)

## Verify

- Toggle Custom Machine ON → editor renders with default packs prefilled
- Add new pack (e.g. ComfyUI-WAS-Suite) + save → new machine row queued for build → user is charged
- After build: try a workflow with WAS nodes → succeeds
- Try a workflow with a missing node → proxy 409s before Modal sees it; canvas surfaces the prompt

## Out of scope

- Auto-rebuild on 409 (user-driven only)
- Node search across all of GitHub (curated list only at v1)
