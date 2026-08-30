// Which canvas-proxy routes carry artifact bytes — H-4 §10 C-7 and C-8,
// applied to canvas.
//
// WHAT WAS HERE BEFORE. The proxy gated exactly two routes:
//
//     isPromptPost = subPath === 'prompt'  || subPath === 'api/prompt'
//     isViewGet    = subPath === 'view'    || subPath === 'api/view'
//
// C-7 says that enumeration is a boundary presented as a list, and names
// four further ComfyUI routes that return retrievable artifact bytes and
// touch neither `output/` nor `/view`. `services/scruple-capture/src/
// surfaces/http-gate.ts` covers all four. Canvas must not ship a narrower
// gate than the component it is migrating onto, so the patterns below are
// the component's `BYTE_EGRESS`, VERBATIM — same order, same source
// strings, so that `test/v2/canvas-retrofit.test.ts` can read the
// component's array out of its own source and assert byte equality.
//
// WHY THEY ARE COPIED RATHER THAN IMPORTED, stated plainly rather than
// discovered by the next reader: `BYTE_EGRESS` and `CONTROL_PLANE` are
// module-private in http-gate.ts, and `services/scruple-capture/src/**` is
// not this work order's to change. The duplication is therefore a fork of
// five lines, and the drift test is the mitigation. If the component ever
// exports them, delete this array and import it; the test will say so the
// moment the two diverge.
//
// THE TRIPWIRE. An enumeration is a denylist wearing an allowlist's
// clothes. Any other 2xx response leaving with a non-control-plane content
// type is recorded as `unenumerated`, so the next ComfyUI release that
// adds a route surfaces as a log line rather than as a silence. It is not
// captured: ComfyUI serves its own frontend through this same proxy and
// every icon would otherwise become an iteration.

/** Routes known to return artifact bytes. Suffix-matched so the `/api/`
 *  prefix modern ComfyUI adds to both spellings is covered once. */
export const BYTE_EGRESS = [
  /^\/(api\/)?view$/,
  /^\/(api\/)?userdata\/.+$/,
  /^\/api\/assets\/[0-9a-fA-F-]{36}\/content$/,
  /^\/(api\/)?experiment\/models\/preview\/.+$/,
];

/** Content types that are control plane, not artifact. Everything else on a
 *  2xx is either captured (on an egress route) or tripped (anywhere else). */
export const CONTROL_PLANE = [
  'application/json',
  'text/html',
  'text/css',
  'text/plain',
  'text/javascript',
  'application/javascript',
  'application/manifest+json',
];

/**
 * C-8. `PreviewImage` (nodes.py:1684-1690) is a `SaveImage` subclass whose
 * output_dir is `folder_paths.get_temp_directory()`, so it writes full
 * images to `temp/`, not `output/`; `LoadImage` inputs live in `input/`.
 * ComfyUI's `GET /view` takes `?type=` naming which of the three to read
 * from, defaulting to `output`.
 *
 * Canvas has no filesystem watcher — the Modal container's volume is not
 * mounted into scruple-web, which is the structural difference between
 * canvas and the sidecar and is stated as such in CANVAS_BASELINE.md §3.
 * What canvas CAN do is refuse to gate only one of the three on the one
 * surface it has, which is what `viewDirectory()` is for: the directory is
 * read from the request, recorded on the capture row, and never used to
 * decide whether to capture.
 */
export const VIEW_DIRECTORIES = ['output', 'temp', 'input'] as const;
export type ViewDirectory = (typeof VIEW_DIRECTORIES)[number];

export function viewDirectory(search: URLSearchParams): ViewDirectory | null {
  const t = search.get('type');
  if (t === null) return 'output'; // ComfyUI's own default (server.py /view)
  return (VIEW_DIRECTORIES as readonly string[]).includes(t) ? (t as ViewDirectory) : null;
}

export type RouteKind = 'prompt' | 'upload' | 'byte-egress' | 'other';

/** Normalise the proxy's path param (`params.path.join('/')`, no leading
 *  slash) to the shape the component's patterns are written against. */
export function normalisePath(subPath: string): string {
  return subPath.startsWith('/') ? subPath : `/${subPath}`;
}

export function classifyRoute(method: string, subPath: string): RouteKind {
  const p = normalisePath(subPath);
  const m = method.toUpperCase();
  if (m === 'POST' && /^\/(api\/)?prompt$/.test(p)) return 'prompt';
  if (m === 'POST' && /^\/(api\/)?upload\/(image|mask)$/.test(p)) return 'upload';
  if (m === 'GET' && BYTE_EGRESS.some((r) => r.test(p))) return 'byte-egress';
  return 'other';
}

export function isControlPlane(contentType: string | null | undefined): boolean {
  const ct = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ct) return true;
  return CONTROL_PLANE.includes(ct);
}

export interface UnenumeratedEgress {
  path: string;
  contentType: string;
  at: string;
}

/**
 * Binary responses that left on a route nobody enumerated. In-memory and
 * per-process on purpose: this is a signal to an operator that the route
 * table has rotted against a new ComfyUI, not evidence about an artifact.
 * Evidence lives in `canvas_capture_log`.
 */
const tripped: UnenumeratedEgress[] = [];

export function tripwire(
  subPath: string,
  status: number,
  contentType: string | null | undefined,
  captured: boolean,
  log: (line: string) => void = (l) => console.warn(l),
): UnenumeratedEgress | null {
  if (captured || status !== 200) return null;
  if (isControlPlane(contentType)) return null;
  const p = normalisePath(subPath);
  if (BYTE_EGRESS.some((r) => r.test(p))) return null;
  const rec: UnenumeratedEgress = {
    path: p,
    contentType: String(contentType).split(';')[0].trim(),
    at: new Date().toISOString(),
  };
  tripped.push(rec);
  log(
    `[canvas/egress] UNENUMERATED BINARY EGRESS ${rec.path} (${rec.contentType}). Not ` +
      'captured — ComfyUI serves its own frontend through this proxy and every icon would ' +
      'otherwise become an iteration. If this is an artifact route it belongs in ' +
      'BYTE_EGRESS, in the component\'s http-gate.ts, and in H-4 §3.',
  );
  return rec;
}

export function unenumeratedEgress(): readonly UnenumeratedEgress[] {
  return tripped;
}

export function resetTripwire(): void {
  tripped.length = 0;
}
