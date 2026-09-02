// The formats Scruple can actually sign — the TypeScript half of one table.
//
// The Python half is services/c2pa-signer/formats.py and it is the
// EMITTING source: it is what the evidence-bundle builder enumerates and
// what the Conformance Intake Form mirrors. This file must agree with it
// entry for entry, and test/v2/c2pa-reachable.test.ts parses formats.py
// and fails when they drift — the same idiom
// services/c2pa-signer/tests/test_assertion_contract.py uses for
// assertion labels, and for the same reason: a copy that is only checked
// against another copy stays consistent while both are wrong.
//
// Before 2026-09-02 there were four hand-maintained copies of this fact
// and no two agreed. What each one got wrong is written up in
// formats.py's docstring; the short version is that three of them
// advertised formats the library refuses and the fourth hid three it
// signs.
//
// Every `generate: true` row was signed through c2pa-python 0.36.0 on
// 2026-09-02 against the fixture in
// docs/c2pa-conformance-evidence/2026-07-14/Raw.input.<mime>/ and read
// back to validation_state=Valid. 18 of 18.

import path from 'path';

export interface C2paFormat {
  mime: string;
  /** Lower-case, dot-prefixed. First entry is canonical for this MIME. */
  extensions: readonly string[];
  /** We PRODUCE signed manifests in this format. */
  generate: boolean;
  /** We INGEST manifests as ingredients in this format. */
  validate: boolean;
}

export interface C2paUnsupportedFormat {
  mime: string;
  extensions: readonly string[];
  /** Named, because "unsupported" with no reason reads as our bug. */
  reason: string;
}

export const C2PA_FORMATS: readonly C2paFormat[] = [
  { mime: 'image/jpeg',        extensions: ['.jpg', '.jpeg'], generate: true,  validate: true },
  { mime: 'image/png',         extensions: ['.png'],          generate: true,  validate: true },
  { mime: 'image/svg+xml',     extensions: ['.svg'],          generate: true,  validate: true },
  { mime: 'image/x-adobe-dng', extensions: ['.dng'],          generate: true,  validate: true },
  { mime: 'image/tiff',        extensions: ['.tiff', '.tif'], generate: true,  validate: true },
  { mime: 'image/webp',        extensions: ['.webp'],         generate: true,  validate: true },
  { mime: 'image/heic',        extensions: ['.heic'],         generate: true,  validate: true },
  { mime: 'image/heif',        extensions: ['.heif'],         generate: true,  validate: true },
  { mime: 'image/avif',        extensions: ['.avif'],         generate: true,  validate: true },
  { mime: 'video/mp4',         extensions: ['.mp4'],          generate: true,  validate: true },
  { mime: 'video/quicktime',   extensions: ['.mov'],          generate: true,  validate: true },
  { mime: 'audio/flac',        extensions: ['.flac'],         generate: true,  validate: true },
  { mime: 'audio/mpeg',        extensions: ['.mp3'],          generate: true,  validate: true },
  { mime: 'audio/wav',         extensions: ['.wav'],          generate: true,  validate: true },
  { mime: 'audio/mp4',         extensions: ['.m4a'],          generate: true,  validate: true },
  { mime: 'image/gif',         extensions: ['.gif'],          generate: true,  validate: true },
  { mime: 'image/jxl',         extensions: ['.jxl'],          generate: true,  validate: true },
  { mime: 'video/x-msvideo',   extensions: ['.avi'],          generate: true,  validate: true },
  { mime: 'application/pdf',   extensions: ['.pdf'],          generate: false, validate: true },
] as const;

/**
 * The must-NOT-fire half. A MIME here is refused BEFORE the signer
 * subprocess is spawned, so the caller gets 415 + a reason instead of a
 * 500 out of c2pa-rs.
 */
export const C2PA_UNSUPPORTED: readonly C2paUnsupportedFormat[] = [
  {
    mime: 'video/webm',
    extensions: ['.webm'],
    reason:
      'c2pa-rs 0.36.0 has no WebM handler — the Builder answers "Builder does ' +
      'not support video/webm". Transcode to MP4 (video/mp4) or MOV ' +
      '(video/quicktime), both of which sign.',
  },
  {
    mime: 'image/vnd.adobe.photoshop',
    extensions: ['.psd'],
    reason:
      'c2pa-rs 0.36.0 has no PSD handler. Export a PNG, TIFF or JPEG and sign that.',
  },
  {
    mime: 'application/x-pytorch',
    extensions: ['.pt', '.pth'],
    reason:
      'c2pa-rs 0.36.0 has no embedded-manifest handler for model checkpoints. ' +
      'A checkpoint is bound by an EXTERNAL (sidecar) manifest instead — see ' +
      'scripts/puffjuly12/12-emit-lora-sidecar.py.',
  },
  {
    mime: 'application/octet-stream',
    extensions: [],
    reason:
      'application/octet-stream is not a format, it is the absence of one. ' +
      'Declare the real MIME.',
  },
] as const;

export const C2PA_GENERATE_MIMES: readonly string[] = C2PA_FORMATS.filter(
  (f) => f.generate,
).map((f) => f.mime);

export const C2PA_VALIDATE_MIMES: readonly string[] = C2PA_FORMATS.filter(
  (f) => f.validate,
).map((f) => f.mime);

/** Set form, for capabilitiesFor() and anything else asking a membership question. */
export const C2PA_SIGNABLE_MIMES: ReadonlySet<string> = new Set(C2PA_GENERATE_MIMES);

const UNSUPPORTED_BY_MIME: ReadonlyMap<string, string> = new Map(
  C2PA_UNSUPPORTED.map((u) => [u.mime, u.reason]),
);

const EXTENSION_TO_MIME: ReadonlyMap<string, string> = new Map([
  ...C2PA_FORMATS.flatMap((f) => f.extensions.map((e) => [e, f.mime] as [string, string])),
  ...C2PA_UNSUPPORTED.flatMap((u) => u.extensions.map((e) => [e, u.mime] as [string, string])),
]);

/**
 * Extension → MIME.
 *
 * An unsupported extension resolves to its TRUE MIME rather than being
 * hidden behind octet-stream: `.webm` is `video/webm` and always was,
 * and pretending otherwise is what turned a txt2vid WebM into a 500
 * instead of an answer. The refusal happens in `signRefusalReason`,
 * where it can name the reason.
 *
 * An extension we have never heard of falls back to
 * `application/octet-stream`, which is itself an unsupported entry, so
 * it too refuses by name.
 */
export function mimeFromPath(p: string): string {
  return EXTENSION_TO_MIME.get(path.extname(p).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * `null` when the MIME can be signed; otherwise a reason fit to hand
 * back to the caller verbatim.
 */
export function signRefusalReason(mime: string): string | null {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (C2PA_SIGNABLE_MIMES.has(m)) return null;
  const known = UNSUPPORTED_BY_MIME.get(m);
  if (known) return `${m} cannot be signed: ${known}`;
  return (
    `${m} is not a format Scruple is asserted as a C2PA Generator Product ` +
    `for. Signable: ${C2PA_GENERATE_MIMES.join(', ')}.`
  );
}
