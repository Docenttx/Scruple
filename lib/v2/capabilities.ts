// Which output modalities apply to a given host and media type.
//
// Canon decision D-7. Today every shell hides buttons by hand and gets it
// wrong in its own way: the CAD trio inherited Fusion's assumptions
// wholesale and sends a `.f3d` extension for every host, ToonBoom borrows
// the CAD witness endpoint for animation frames, and four integrations
// send `application/octet-stream` unconditionally, which silently gates
// the server's image-only watermarker shut.
//
// Applicability becomes a server fact with one place to correct it. A
// client renders from the answer instead of encoding its own beliefs.
//
// The important asymmetry: `reason` is populated whether a modality is
// available or not, because the unavailable ones get SHOWN to a user.
// "Not available" with no explanation reads as a bug; "CAD assemblies
// have no pixel or audio data to embed a watermark into" reads as an
// answer.

export type Modality = 'c2pa' | 'watermark' | 'chain' | 'local';

export type HostId =
  | 'blender' | 'fusion360' | 'inventor' | 'solidworks' | 'meshroom'
  | 'toonboom' | 'photoshop' | 'illustrator' | 'indesign'
  | 'comfyui' | 'kohya';

export interface Capability {
  modality: Modality;
  available: boolean;
  reason: string;
  price_cents?: number;
}

/**
 * MIME types the C2PA Generator Product asserts in its Intake Form.
 * Kept narrow on purpose: claiming a MIME we have not exercised
 * end-to-end is exactly what the 2026-07-16 conformance round had to
 * walk back.
 */
const C2PA_SIGNABLE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif',
  'image/heic', 'image/heif', 'image/gif', 'image/jxl', 'image/svg+xml',
  'image/x-adobe-dng', 'image/vnd.adobe.photoshop',
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4',
]);

/**
 * §9.2 is defined as a frequency-domain transform on pixels or audio
 * samples. A container without either has nothing to embed into. This is
 * narrower than C2PA_SIGNABLE by design: SVG is signable (it is a file
 * with bytes) but not watermarkable (it is vector instructions, not a
 * sampled grid).
 */
function isWatermarkable(mime: string): boolean {
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

/**
 * Parametric CAD. Not a rendering of a model — the model itself. There
 * is no pixel buffer and no audio sample, and the GPSA's claim-generation
 * MIME list excludes these entirely.
 *
 * This is a real architectural boundary, not a corner cut, and it stops
 * being true the moment a CAD tool witnesses a raster byproduct — a
 * thumbnail, a drawing-sheet export. None currently does. Whether one
 * should is a product decision.
 */
const CAD_MIMES = new Set([
  'application/vnd.autodesk.fusion360', 'model/step', 'model/iges',
  'application/vnd.autodesk.inventor.part',
  'application/vnd.autodesk.inventor.assembly',
  'application/vnd.solidworks.part',
  'application/vnd.solidworks.assembly',
  'application/vnd.solidworks.drawing',
  'model/stl', 'model/obj', 'model/gltf+json', 'model/gltf-binary',
]);

function isCad(mime: string): boolean {
  return CAD_MIMES.has(mime) || mime.startsWith('model/');
}

export function capabilitiesFor(host: HostId, mime: string): Capability[] {
  const m = mime.toLowerCase().split(';')[0].trim();
  const cad = isCad(m);

  const c2pa: Capability = C2PA_SIGNABLE.has(m)
    ? { modality: 'c2pa', available: true, reason: 'Signed as a C2PA content credential, verifiable by any C2PA tool.' }
    : {
        modality: 'c2pa',
        available: false,
        reason: cad
          ? 'C2PA has no manifest format for parametric CAD files. Export a rendering or a drawing sheet to attach a credential.'
          : `Scruple is not asserted as a C2PA Generator Product for ${m}.`,
      };

  const watermark: Capability = isWatermarkable(m)
    ? { modality: 'watermark', available: true, reason: 'An imperceptible mark carrying a signing timestamp, recoverable from the pixels or audio alone.' }
    : {
        modality: 'watermark',
        available: false,
        reason: cad
          ? 'A watermark is embedded in pixel or audio data. A parametric CAD file has neither.'
          : m === 'image/svg+xml'
            ? 'SVG is vector instructions rather than a sampled grid, so there is no frequency domain to embed a mark in.'
            : `No watermark embedder exists for ${m}.`,
      };

  // Chain lock anchors a leaf hash. It applies to anything that can be
  // hashed, which is everything — the media type is irrelevant to it.
  const chain: Capability = {
    modality: 'chain',
    available: true,
    reason: 'The leaf hash is inscribed on a public ledger, findable without Scruple.',
  };

  // §9.4 — "Every Scruple event produces a local lock; the other
  // modalities are attached alongside it, not instead of it." It is
  // reported here for completeness, but it is never optional and asking
  // for it is a no-op.
  const local: Capability = {
    modality: 'local',
    available: true,
    reason: 'Always applied. Finalizes the leaf and issues a portable receipt.',
  };

  return [c2pa, watermark, chain, local];
}

export function isModalityAvailable(host: HostId, mime: string, modality: Modality): Capability {
  const found = capabilitiesFor(host, mime).find((c) => c.modality === modality);
  return found ?? { modality, available: false, reason: `Unknown modality "${modality}".` };
}
