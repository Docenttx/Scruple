// Provenance extractor (Pivot clone-5).
//
// Walks a ComfyUI workflow_api_json (the shape returned by
// app.graphToPrompt().output) and pulls out the high-level fields a
// human cares about. The full JSON is still the canonical record on
// `iterations.metadata`; this is for the sidebar's Provenance Terminal
// display — one tidy line per meaningful node.
//
// Cap at 10 rows to keep the sidebar readable.

const MAX_ROWS = 10;

export interface ProvenanceRow {
  /** Sidebar category label, e.g. "Model", "Lora 1", "Prompt (positive)". */
  category: string;
  /** Compact value, e.g. "v1-5-pruned-emaonly". */
  value: string;
  /** Whether this is recorded in the chain (always true today; opt-out is future). */
  checked: boolean;
  /** Optional tooltip (full path, full prompt text, etc.). */
  detail?: string;
}

interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

/**
 * Extract a stable ordered list of provenance rows from a workflow.
 * Pure function — no I/O, no DB, no network. Safe to call in any
 * render context.
 */
export function extractProvenance(workflowApiJson: unknown): ProvenanceRow[] {
  if (!workflowApiJson || typeof workflowApiJson !== 'object') return [];
  const nodes = Object.values(workflowApiJson as Record<string, ComfyNode>).filter(
    (n): n is ComfyNode => !!n && typeof n === 'object',
  );

  const rows: ProvenanceRow[] = [];

  // Model — CheckpointLoaderSimple, CheckpointLoader, UNETLoader
  for (const n of nodes) {
    if (
      n.class_type === 'CheckpointLoaderSimple' ||
      n.class_type === 'CheckpointLoader' ||
      n.class_type === 'UNETLoader'
    ) {
      const name = stringy(n.inputs?.ckpt_name) ?? stringy(n.inputs?.unet_name);
      if (name) {
        rows.push({
          category: 'Model',
          value: stripExt(name),
          checked: true,
          detail: name,
        });
        break; // typically one base model per workflow
      }
    }
  }

  // Loras — each LoraLoader becomes a row
  let loraIndex = 0;
  for (const n of nodes) {
    if (n.class_type === 'LoraLoader' || n.class_type === 'LoraLoaderModelOnly') {
      const name = stringy(n.inputs?.lora_name);
      if (name) {
        loraIndex += 1;
        const strength =
          n.inputs?.strength_model ?? n.inputs?.strength_clip ?? n.inputs?.strength ?? '?';
        rows.push({
          category: `Lora ${loraIndex}`,
          value: `${stripExt(name)} @ ${strength}`,
          checked: true,
          detail: name,
        });
      }
    }
  }

  // VAE — separate node only (CheckpointLoaderSimple bundles its VAE)
  for (const n of nodes) {
    if (n.class_type === 'VAELoader') {
      const name = stringy(n.inputs?.vae_name);
      if (name) {
        rows.push({ category: 'VAE', value: stripExt(name), checked: true, detail: name });
        break;
      }
    }
  }

  // Prompts — first two CLIPTextEncode nodes (positive, negative)
  const prompts = nodes
    .filter(n => n.class_type === 'CLIPTextEncode' || n.class_type === 'CLIPTextEncodeSDXL')
    .map(n => stringy(n.inputs?.text))
    .filter((t): t is string => !!t && t.length > 0);
  if (prompts[0]) {
    rows.push({
      category: 'Prompt (+)',
      value: trim(prompts[0], 36),
      checked: true,
      detail: prompts[0],
    });
  }
  if (prompts[1]) {
    rows.push({
      category: 'Prompt (−)',
      value: trim(prompts[1], 36),
      checked: true,
      detail: prompts[1],
    });
  }

  // Sampler — KSampler / KSamplerAdvanced
  for (const n of nodes) {
    if (n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced') {
      const sampler = stringy(n.inputs?.sampler_name) ?? '?';
      const scheduler = stringy(n.inputs?.scheduler);
      rows.push({
        category: 'Sampler',
        value: scheduler ? `${sampler} / ${scheduler}` : sampler,
        checked: true,
      });
      const steps = n.inputs?.steps;
      if (typeof steps === 'number') {
        rows.push({ category: 'Steps', value: String(steps), checked: true });
      }
      const cfg = n.inputs?.cfg;
      if (typeof cfg === 'number') {
        rows.push({ category: 'CFG', value: String(cfg), checked: true });
      }
      const seed = n.inputs?.seed;
      if (typeof seed === 'number' || typeof seed === 'string') {
        rows.push({ category: 'Seed', value: String(seed), checked: true });
      }
      break;
    }
  }

  // Dimensions — EmptyLatentImage / EmptySD3LatentImage
  for (const n of nodes) {
    if (
      n.class_type === 'EmptyLatentImage' ||
      n.class_type === 'EmptySD3LatentImage'
    ) {
      const w = n.inputs?.width;
      const h = n.inputs?.height;
      if (typeof w === 'number' && typeof h === 'number') {
        rows.push({ category: 'Dimensions', value: `${w}×${h}`, checked: true });
        break;
      }
    }
  }

  // ControlNets — each ControlNetLoader becomes a row
  let cnIndex = 0;
  for (const n of nodes) {
    if (n.class_type === 'ControlNetLoader') {
      const name = stringy(n.inputs?.control_net_name);
      if (name) {
        cnIndex += 1;
        rows.push({
          category: cnIndex === 1 ? 'ControlNet' : `ControlNet ${cnIndex}`,
          value: stripExt(name),
          checked: true,
          detail: name,
        });
      }
    }
  }

  return rows.slice(0, MAX_ROWS);
}

// ── helpers ────────────────────────────────────────────────────────────────

function stringy(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function stripExt(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
