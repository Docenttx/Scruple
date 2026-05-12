// Workflow JSON validator (Pivot polish — workflow-validator).
//
// Sanity-checks a workflow_api_json before it gets shipped to Modal.
// Catches the common failure modes early so the user gets a useful
// error instead of a generic 500 from ComfyUI.
//
// Validations performed:
//   1. Structural — JSON is an object of nodes keyed by id
//   2. Each node has class_type + inputs
//   3. Cross-references (e.g. inputs that reference other nodes) point
//      at existing ids
//   4. Required output node (SaveImage / PreviewImage / Scruple terminal)
//   5. Model-file references map to entries that exist on the Modal
//      Volume (when a volume listing is provided)
//
// Returns either { ok: true } or { ok: false, issues: [...] } with
// each issue tagged with severity + node id for UI display.

interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Node id, if relevant. */
  nodeId?: string;
  /** Node class_type, if relevant. */
  nodeClass?: string;
  /** Specific input field, if relevant. */
  inputName?: string;
  message: string;
}

export interface ValidationOptions {
  /** Optional set of filenames known to exist on the volume.
   *  Format: "checkpoints/file.safetensors" matching the Volume layout.
   *  When omitted, model-file existence checks are skipped. */
  availableFiles?: Set<string>;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Quick summary counts. */
  summary: {
    nodeCount: number;
    referencedModels: string[];
    errorCount: number;
    warningCount: number;
  };
}

// Mapping of node class_type → (input field, model subdir) so we know
// which inputs are filenames + where they'd live on the Volume.
const MODEL_INPUT_FIELDS: Array<{ classType: string; field: string; subdir: string }> = [
  { classType: 'CheckpointLoaderSimple', field: 'ckpt_name', subdir: 'checkpoints' },
  { classType: 'CheckpointLoader', field: 'ckpt_name', subdir: 'checkpoints' },
  { classType: 'UNETLoader', field: 'unet_name', subdir: 'diffusion_models' },
  { classType: 'LoraLoader', field: 'lora_name', subdir: 'loras' },
  { classType: 'LoraLoaderModelOnly', field: 'lora_name', subdir: 'loras' },
  { classType: 'VAELoader', field: 'vae_name', subdir: 'vae' },
  { classType: 'CLIPLoader', field: 'clip_name', subdir: 'text_encoders' },
  { classType: 'DualCLIPLoader', field: 'clip_name1', subdir: 'text_encoders' },
  { classType: 'ControlNetLoader', field: 'control_net_name', subdir: 'controlnet' },
];

const OUTPUT_NODE_TYPES = new Set([
  'SaveImage',
  'PreviewImage',
  'ScrupleStudioTerminal',
  'ScrupleOutputCapture',
  'VHS_VideoCombine',  // video output
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
]);

export function validateWorkflow(
  workflowApiJson: unknown,
  opts: ValidationOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. Structural
  if (!workflowApiJson || typeof workflowApiJson !== 'object' || Array.isArray(workflowApiJson)) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: 'Workflow must be a JSON object' }],
      summary: { nodeCount: 0, referencedModels: [], errorCount: 1, warningCount: 0 },
    };
  }

  const nodes = workflowApiJson as Record<string, ComfyNode>;
  const nodeIds = Object.keys(nodes);

  if (nodeIds.length === 0) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: 'Workflow has no nodes' }],
      summary: { nodeCount: 0, referencedModels: [], errorCount: 1, warningCount: 0 },
    };
  }

  // 2. Each node has class_type + inputs
  for (const [id, n] of Object.entries(nodes)) {
    if (!n || typeof n !== 'object') {
      issues.push({ severity: 'error', nodeId: id, message: 'Node is not an object' });
      continue;
    }
    if (!n.class_type || typeof n.class_type !== 'string') {
      issues.push({ severity: 'error', nodeId: id, message: 'Missing class_type' });
    }
    if (n.inputs !== undefined && (typeof n.inputs !== 'object' || Array.isArray(n.inputs))) {
      issues.push({ severity: 'error', nodeId: id, nodeClass: n.class_type, message: 'inputs must be an object' });
    }
  }

  // 3. Cross-references — values like [nodeId, outputIndex] must point at
  //    a real node.
  for (const [id, n] of Object.entries(nodes)) {
    if (!n.inputs) continue;
    for (const [field, val] of Object.entries(n.inputs)) {
      if (Array.isArray(val) && val.length >= 2 && typeof val[0] === 'string') {
        const refId = val[0];
        if (!nodes[refId]) {
          issues.push({
            severity: 'error',
            nodeId: id,
            nodeClass: n.class_type,
            inputName: field,
            message: `references node id "${refId}" which doesn't exist`,
          });
        }
      }
    }
  }

  // 4. Output node check
  const hasOutput = Object.values(nodes).some(n => n.class_type && OUTPUT_NODE_TYPES.has(n.class_type));
  if (!hasOutput) {
    issues.push({
      severity: 'warning',
      message:
        'No output node detected (SaveImage / PreviewImage / video output). The run may complete but produce no captured image.',
    });
  }

  // 5. Model-file references — only when we have a known-available set
  const referencedModels: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    if (!n.class_type || !n.inputs) continue;
    const spec = MODEL_INPUT_FIELDS.find(m => m.classType === n.class_type);
    if (!spec) continue;
    const fileVal = n.inputs[spec.field];
    if (typeof fileVal !== 'string' || fileVal.length === 0) continue;
    const fullPath = `${spec.subdir}/${fileVal}`;
    referencedModels.push(fullPath);
    if (opts.availableFiles && !opts.availableFiles.has(fullPath)) {
      issues.push({
        severity: 'error',
        nodeId: id,
        nodeClass: n.class_type,
        inputName: spec.field,
        message: `Model file not in your library: ${fullPath}. Add it via Settings → Model Library.`,
      });
    }
  }

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;

  return {
    ok: errorCount === 0,
    issues,
    summary: {
      nodeCount: nodeIds.length,
      referencedModels,
      errorCount,
      warningCount,
    },
  };
}
