// Correlating observed bytes back to the prompt that produced them (§3, row 4).
//
// The gate sees a workflow go in and bytes come out; nothing in the bytes says
// which workflow they belong to. ComfyUI's own WS stream is what closes that:
// `executing` carries {prompt_id, node} and `execution_success` carries
// {prompt_id}, so the gate knows which prompt is live when a file lands or a
// frame goes past.
//
// THIS IS A HEURISTIC AND IT IS LABELLED AS ONE ON EVERY LEAF IT TOUCHES.
// ComfyUI executes one prompt at a time per worker, so "the prompt that was
// executing when this file closed" is right in the ordinary case and wrong
// under a concurrent second worker sharing the volume. `correlation` on the
// observation records HOW the link was made — 'ws-executing', 'filename-prefix'
// or 'none' — so a verifier is never told a guess was a fact. lib/canvas/witness.ts
// pairs /view with "the most recent pending row" and has the same exposure;
// stating it is the difference.

import { hashRunInputs, hashGraphOrTraining } from '../../../lib/leaf/hashes';
import { mimeForNodeClass, NODE_CLASS_MIME, type DeclaredMime } from './mime';

export type CorrelationMethod = 'ws-executing' | 'filename-prefix' | 'none';

export interface PendingPrompt {
  promptId: string;
  workflowHash: string | null;
  /** null when the graph references input artifacts whose bytes the gate
   *  never saw — see inputHashFor(). Never a hash of `[]` in that case. */
  inputHash: string | null;
  /** class_type → filename_prefix, for the writing nodes in this graph. */
  writers: Array<{ nodeId: string; classType: string; filenamePrefix: string | null }>;
  /** The graph itself, so the submission can carry it and the route can
   *  recompute workflow_hash with lib/leaf/hashes.ts rather than trusting
   *  ours. Held for the TTL only — this is a gate, not a workflow store. */
  graph: Record<string, unknown> | null;
  openedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface GraphNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class Correlator {
  private pending = new Map<string, PendingPrompt>();
  private executing: string | null = null;
  /** Input artifact bytes the gate actually saw, by the name ComfyUI will
   *  know them under. Populated from POST /upload/image and /upload/mask. */
  private inputHashes = new Map<string, string>();

  constructor(private readonly ttlMs: number) {}

  /** Tee of POST /upload/image — the only moment the gate holds input bytes. */
  recordInputBytes(name: string, sha256: string): void {
    this.inputHashes.set(name, sha256);
  }

  /**
   * Tee of POST /prompt (§3, row 1). Opens the pending record keyed by the
   * prompt_id ComfyUI returned.
   */
  openPrompt(promptId: string, graph: unknown): PendingPrompt {
    this.sweep();
    const writers = writingNodesOf(graph);
    const rec: PendingPrompt = {
      promptId,
      // The graph is hashed with lib/leaf/hashes.ts — the same function
      // /api/v2/witness and lib/iterations/ingest.ts use. Two implementations
      // of a preimage are two preimages.
      workflowHash: hashGraphOrTraining(graph, undefined),
      inputHash: this.inputHashFor(graph),
      writers,
      graph: isRecord(graph) ? graph : null,
      openedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.pending.set(promptId, rec);
    return rec;
  }

  /** WS `executing` — {prompt_id, node}. */
  noteExecuting(promptId: string | null): void {
    if (!promptId) {
      // node === null with a prompt_id is ComfyUI's end-of-prompt marker; a
      // null prompt_id is the idle message and must not clear a live prompt.
      return;
    }
    this.executing = promptId;
    const p = this.pending.get(promptId);
    if (p && p.startedAt === null) p.startedAt = Date.now();
  }

  /** WS `execution_success` — {prompt_id}. */
  noteExecutionSuccess(promptId: string | null): void {
    if (!promptId) return;
    const p = this.pending.get(promptId);
    if (p) p.finishedAt = Date.now();
    if (this.executing === promptId) {
      // Deliberately NOT cleared. A SaveImage node's file can close after
      // execution_success has gone past — the write completes on the worker
      // thread while the message is already in flight — and clearing here
      // would drop the correlation for exactly the files that matter most.
      // The TTL sweep is what ends it.
    }
  }

  get currentPromptId(): string | null {
    return this.executing;
  }

  get(promptId: string): PendingPrompt | undefined {
    return this.pending.get(promptId);
  }

  /**
   * Which prompt a file that just closed in the output volume belongs to,
   * and how confidently.
   *
   * Filename first: ComfyUI writes `{filename_prefix}_{counter:05}_.ext`
   * (folder_paths.get_save_image_path), so a basename that starts with a
   * writer's declared prefix is a real link and not a timing guess. Falls
   * back to whatever is executing.
   */
  attribute(basename: string): {
    prompt: PendingPrompt | null;
    method: CorrelationMethod;
    mime: DeclaredMime | null;
  } {
    for (const p of this.pending.values()) {
      for (const w of p.writers) {
        const prefix = w.filenamePrefix ? lastSegment(w.filenamePrefix) : null;
        if (prefix && basename.startsWith(prefix)) {
          return { prompt: p, method: 'filename-prefix', mime: mimeForNodeClass(w.classType) };
        }
      }
    }
    const live = this.executing ? this.pending.get(this.executing) ?? null : null;
    if (!live) return { prompt: null, method: 'none', mime: null };
    // Only declare a type when the graph leaves no ambiguity about which
    // class wrote it. Two writing classes of different types in one graph and
    // a timing-based link is not a declaration, it is a coin toss.
    const classes = new Set(live.writers.map((w) => w.classType));
    const mime = classes.size === 1 ? mimeForNodeClass([...classes][0]) : null;
    return { prompt: live, method: 'ws-executing', mime };
  }

  /** For WS frames: the live prompt, which the frame arrived inside. */
  attributeFrame(): { prompt: PendingPrompt | null; method: CorrelationMethod } {
    const live = this.executing ? this.pending.get(this.executing) ?? null : null;
    return live ? { prompt: live, method: 'ws-executing' } : { prompt: null, method: 'none' };
  }

  /**
   * input_hash, or null.
   *
   * hashRunInputs's preimage is {provider, prompt, spec, inputs} in that key
   * order — lifted from lib/iterations/ingest.ts so a canvas leaf and a
   * component leaf over the same inputs hash identically. provider/prompt/spec
   * are null here for the same reason /api/v2/witness passes null: this
   * surface is zero-content (P6) and never receives them.
   *
   * NULL RATHER THAN THE HASH OF `[]` when the graph references an input
   * artifact whose bytes never came through the gate. hashModelFingerprints
   * makes the same choice for the same reason: `[]` asserts "we enumerated
   * the inputs and there were none", and asserting that about a workflow
   * whose LoadImage points at a file the tenant put there by hand is a false
   * statement in a signed record.
   */
  private inputHashFor(graph: unknown): string | null {
    const referenced = referencedInputNames(graph);
    const inputs: Array<{ kind: string; hash: string }> = [];
    for (const name of referenced) {
      const h = this.inputHashes.get(name);
      if (!h) return null;
      inputs.push({ kind: 'image', hash: h });
    }
    inputs.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return hashRunInputs({ provider: null, prompt: null, spec: null, inputs });
  }

  sweep(now = Date.now()): void {
    for (const [id, p] of this.pending) {
      if (now - p.openedAt > this.ttlMs) this.pending.delete(id);
    }
  }
}

function lastSegment(prefix: string): string {
  const parts = prefix.split('/');
  return parts[parts.length - 1] ?? prefix;
}

// ── WRITERS AND LOADERS ARE TABLES, NOT PREFIXES ────────────────────────
//
// WO-27. Both halves of the correlator used to gate on a NAME SHAPE:
// `/^(Save|Preview)/` for a writer, `/^Load(Image|ImageMask|Audio|Video)/`
// for a loader. That is an enumeration used as a boundary with none of an
// enumeration's honesty — a class that does not match is not "unknown", it
// is silently NOT A WRITER, and the graph then has zero writers, loses
// filename-prefix attribution and falls back to a timing guess.
//
// It excluded an installed node. `VHS_VideoCombine` is VideoHelperSuite's
// output node and the standard AnimateDiff/img2vid/vid2vid writer;
// `VHS_LoadVideo` / `VHS_LoadVideoPath` are its loaders. BOTH Modal images
// install the pack (modal/scruple_runner.py:123-129, modal/canvas_app.py:
// 89-93) and `lib/compute/machines.ts` advertises `VHS` on every machine in
// the catalogue. So the shape test excluded, from the component that is
// supposed to see everything, a node the product ships.
//
// The tables below are DATA and the shape tests are kept as a FALLBACK
// beneath them, in that order, because the two answer different questions.
// The table says "this class is a writer, and we know because we installed
// it." The shape says "this class is probably a writer, and we have never
// heard of it." Neither is allowed to be the only rule: a table alone would
// re-break every vendor custom node, and a shape alone is what shipped.
//
// A THIRD TABLE ALREADY EXISTED AND DISAGREED. `lib/provenance/validate.ts`
// OUTPUT_NODE_TYPES lists `VHS_VideoCombine` and has since it was written,
// so the estate has held both answers at once. This is now the one the
// capture path reads; the validator's copy is a lint, not a leaf.

/**
 * Classes that write retrievable bytes, named rather than matched.
 *
 * Every key of NODE_CLASS_MIME is a writer by construction (it exists to
 * say what that class writes) and is folded in below rather than restated,
 * so adding a MIME cannot leave the two tables disagreeing.
 */
export const EXTRA_WRITING_NODE_CLASSES: ReadonlySet<string> = new Set([
  // VideoHelperSuite — installed in both Modal images.
  'VHS_VideoCombine',
  // ComfyUI core video writers. Polymorphic in container/codec, so mime.ts
  // deliberately declares no MIME for them; being a writer and having a
  // declarable type are separate facts and this table only asserts the first.
  'SaveVideo',
  'SaveWEBM',
  // Scruple's own terminals, which validate.ts already counted as outputs.
  'ScrupleStudioTerminal',
  'ScrupleOutputCapture',
]);

/**
 * Classes that read an input artifact by NAME — the ones whose bytes must
 * have come through the gate for `input_hash` to be assertable.
 *
 * VHS_LoadVideoPath / VHS_LoadImagesPath take a filesystem PATH rather than
 * an uploaded name. They are listed anyway and on purpose: a path the gate
 * never saw is exactly the case that must make input_hash null rather than
 * the hash of `[]`.
 */
export const EXTRA_INPUT_LOADER_CLASSES: ReadonlySet<string> = new Set([
  'VHS_LoadVideo',
  'VHS_LoadVideoPath',
  'VHS_LoadImages',
  'VHS_LoadImagesPath',
  'VHS_LoadAudio',
  'VHS_LoadAudioUpload',
]);

/** Input keys on a loader node that name an artifact. `video`/`video_path`
 *  and `directory` are VHS's; the rest are core ComfyUI's. */
export const INPUT_NAME_KEYS: readonly string[] = [
  'image', 'mask', 'audio', 'video', 'file', 'video_path', 'directory',
];

/** Is this class a writer? Table first, then the name shape. */
export function isWritingNodeClass(classType: string): boolean {
  if (EXTRA_WRITING_NODE_CLASSES.has(classType)) return true;
  if (Object.prototype.hasOwnProperty.call(NODE_CLASS_MIME, classType)) return true;
  return /^(Save|Preview)/.test(classType);
}

/** Is this class an input loader? Table first, then the name shape. */
export function isInputLoaderClass(classType: string): boolean {
  if (EXTRA_INPUT_LOADER_CLASSES.has(classType)) return true;
  return /^Load(Image|ImageMask|Audio|Video)/.test(classType);
}

/**
 * The nodes in a prompt graph that write retrievable bytes.
 *
 * Recognised by class name against the writer table (which folds in every
 * NODE_CLASS_MIME key) plus the `Save`/`Preview` shape, because a vendor's
 * custom_nodes directory can hold writers this component has never heard of.
 * An unrecognised writer yields an entry with no declared MIME rather than
 * no entry at all — the correlation is still worth having, and the missing
 * type shows up as undeclared instead of as a silently absent file.
 */
export function writingNodesOf(graph: unknown): PendingPrompt['writers'] {
  const out: PendingPrompt['writers'] = [];
  if (!isRecord(graph)) return out;
  // ComfyUI accepts either the bare node map or {prompt: {...}}.
  const nodes = isRecord(graph.prompt) ? graph.prompt : graph;
  for (const [nodeId, raw] of Object.entries(nodes)) {
    if (!isRecord(raw)) continue;
    const n = raw as GraphNode;
    const classType = typeof n.class_type === 'string' ? n.class_type : null;
    if (!classType) continue;
    if (!isWritingNodeClass(classType)) continue;
    const fp = n.inputs && typeof n.inputs.filename_prefix === 'string' ? n.inputs.filename_prefix : null;
    out.push({ nodeId, classType, filenamePrefix: fp });
  }
  return out;
}

/** Input artifact names a graph refers to — loader-family `image`/`mask`/
 *  `video`/... inputs that are plain strings rather than [nodeId, slot]
 *  wiring tuples. */
export function referencedInputNames(graph: unknown): string[] {
  const names = new Set<string>();
  if (!isRecord(graph)) return [];
  const nodes = isRecord(graph.prompt) ? graph.prompt : graph;
  for (const raw of Object.values(nodes)) {
    if (!isRecord(raw)) continue;
    const n = raw as GraphNode;
    const cls = typeof n.class_type === 'string' ? n.class_type : '';
    if (!isInputLoaderClass(cls)) continue;
    for (const key of INPUT_NAME_KEYS) {
      const v = n.inputs?.[key];
      if (typeof v === 'string' && v.length > 0) names.add(v);
    }
  }
  return [...names].sort();
}
