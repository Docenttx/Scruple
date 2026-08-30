// MIME is DECLARED, NEVER GUESSED.
//
// CANON_SKELETON.md §5 property 1, H-4 §3 ("declared from the writing node's
// type, never guessed"), and lib/capture/surface.ts on ObservedBytes.mime:
// "never from an extension, never from mimetypes.guess_type()". There is no
// content sniff, no magic-byte read and no extension lookup anywhere in this
// component, and there must not be one.
//
// WHAT "DECLARED" MEANS HERE, AND WHO DOES THE DECLARING. Three sources, and
// the leaf records which one spoke, because they are not equally strong:
//
//   'node'          the workflow's own writing node type said so. ComfyUI's
//                   SaveImage writes PNG because SaveImage writes PNG; that
//                   is a property of the node class, read from the graph the
//                   tenant submitted through the gate. Strongest.
//   'frame'         the WebSocket frame declared it in its own header —
//                   PREVIEW_IMAGE's 4-byte image-type field (1=JPEG, 2=PNG,
//                   server.py send_image) or PREVIEW_IMAGE_WITH_METADATA's
//                   metadata.image_type, which ComfyUI already writes as a
//                   mimetype string. The producer declared it in band.
//   'vendor-config' the vendor declared what their own output volume holds
//                   (SCRUPLE_CAPTURE_OUTPUT_VOLUME_MIME). An accountable
//                   party (§1) making a blanket statement, not an inference.
//
// And a fourth state that is not a source: UNDECLARED. Bytes appear in the
// output volume with no producing node — a tenant's shell write, §7 probe 4 —
// and no vendor declaration is configured. The component still hashes them
// and still spends a counter on them, because probe 4 requires a leaf; it
// does NOT invent a type for them. See leaf.ts for what that costs at ingest.
//
// The table below is a mapping from ComfyUI node CLASS to the type that class
// writes, read out of ComfyUI's own source. It is a declaration by the host
// software, transcribed. Where a class is genuinely polymorphic — SaveVideo
// and SaveWEBM take a container/codec argument — it is absent rather than
// approximated, and its outputs go out undeclared until the graph is read for
// the argument. Absent is honest; a default would be a guess wearing a table.

export type MimeSource = 'node' | 'frame' | 'vendor-config';

export interface DeclaredMime {
  mime: string;
  source: MimeSource;
  /** The node class, frame event or config key that declared it. */
  declaredBy: string;
}

/**
 * ComfyUI node class → the MIME that class writes.
 *
 * Sources, all in /data/reference/ui-inspire/ComfyUI:
 *   nodes.py SaveImage.save_images         → `_{counter:05}_.png`
 *   nodes.py PreviewImage(SaveImage)       → same writer, TEMP directory
 *   nodes.py SaveLatent                    → `_{counter:05}_.latent` (safetensors)
 *   comfy_extras/nodes_images.py           → SaveAnimatedWEBP / SaveAnimatedPNG
 *   comfy_extras/nodes_audio.py            → SaveAudio (flac) / MP3 / Opus
 *   comfy_extras/nodes_3d.py               → SaveGLB
 */
export const NODE_CLASS_MIME: Readonly<Record<string, string>> = Object.freeze({
  SaveImage: 'image/png',
  PreviewImage: 'image/png',
  SaveImageWebsocket: 'image/png',
  SaveAnimatedPNG: 'image/apng',
  SaveAnimatedWEBP: 'image/webp',
  SaveAudio: 'audio/flac',
  SaveAudioMP3: 'audio/mpeg',
  SaveAudioOpus: 'audio/opus',
  SaveGLB: 'model/gltf-binary',
  SaveSVGNode: 'image/svg+xml',
  SaveLatent: 'application/octet-stream',
  // ABSENT ON PURPOSE: SaveVideo and SaveWEBM take a format argument, so the
  // class does not determine the type. They stay undeclared rather than
  // getting a plausible default.
});

/** The two image-type codes in ComfyUI's PREVIEW_IMAGE frame header
 *  (server.py send_image: type_num 1 = JPEG, 2 = PNG). */
export const FRAME_IMAGE_TYPE_MIME: Readonly<Record<number, string>> = Object.freeze({
  1: 'image/jpeg',
  2: 'image/png',
});

export function mimeForNodeClass(classType: string): DeclaredMime | null {
  const m = NODE_CLASS_MIME[classType];
  return m ? { mime: m, source: 'node', declaredBy: classType } : null;
}

export function mimeForFrameImageType(typeNum: number): DeclaredMime | null {
  const m = FRAME_IMAGE_TYPE_MIME[typeNum];
  return m
    ? { mime: m, source: 'frame', declaredBy: `PREVIEW_IMAGE image_type=${typeNum}` }
    : null;
}

export function mimeFromVendorConfig(mime: string | null): DeclaredMime | null {
  return mime
    ? { mime, source: 'vendor-config', declaredBy: 'SCRUPLE_CAPTURE_OUTPUT_VOLUME_MIME' }
    : null;
}
