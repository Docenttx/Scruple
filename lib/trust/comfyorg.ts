// ComfyOrg trusted-set fetcher — WO-B2 (2026-07-13).
//
// The trust label is a runtime UI concern — it is NOT folded into the
// signed leaf preimage. Rationale: the trust list can change over time
// (packs added / removed / audited); folding it would invalidate
// historical leaves any time ComfyOrg updates the manifest. Instead we
// render "trusted|unknown" badges at receipt-view time by matching the
// stored container_machine_manifest against a currently-fetched trust
// list. Unknown means "not on the list right now"; it never means
// "definitely bad".
//
// Endpoint is configurable via SCRUPLE_TRUST_LIST_URL because ComfyOrg's
// production API surface + schema is still evolving. The default URL
// is the Comfy Registry public endpoint (comfyregistry.com); the shape
// this module accepts is documented on the TrustListResponse type below
// so vendors mirroring the list can conform.
//
// See:
//   memory/project_node_hashing_gap_and_workflow_provenance_plan_2026_07_13.md
//   §"Trusted-set comparison"

const DEFAULT_TRUST_LIST_URL =
  process.env.SCRUPLE_TRUST_LIST_URL || 'https://api.comfy.org/nodes';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Shape the fetcher expects (either from ComfyOrg's API directly if the
 * schema aligns, or from a vendor mirror). Only the fields we consume
 * are required — extra fields are ignored.
 *
 *   { nodes: [
 *       { id: "comfyui-easy-use",
 *         repository: "https://github.com/yolain/ComfyUI-Easy-Use",
 *         latest_version: { commit: "..." } }
 *   ] }
 */
export interface TrustListResponse {
  nodes: Array<{
    id?: string;
    /** GitHub URL, "owner/name", or bare name. Any of these forms are matched. */
    repository?: string;
    /** Optional latest-known-good commit SHA. When absent, any commit of
     *  the pack is treated as "trusted" — pack listing alone counts. */
    latest_version?: { commit?: string };
    /** Optional publisher / verification tags — surfaced verbatim in the
     *  badge tooltip so viewers can distinguish "verified publisher" from
     *  "listed pack, not audited". */
    tags?: string[];
  }>;
}

export interface TrustEntry {
  packName: string;         // normalized lowercase-kebab
  repository: string | null;
  latestCommitSha: string | null;
  tags: string[];
}

let _cache: { at: number; entries: TrustEntry[] } | null = null;
let _inflight: Promise<TrustEntry[]> | null = null;

/**
 * Normalize whatever the trust list gave us (URL / owner-slash-name / name)
 * to a lowercase-kebab pack key we can compare against
 * container_machine_manifest.custom_nodes[].pack.
 */
function toPackKey(input: string | undefined | null): string {
  if (!input) return '';
  let s = input.trim();
  // Extract "owner/name" from a github URL.
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  if (m) s = m[2];
  // "owner/name" → "name"
  if (s.includes('/')) s = s.split('/').pop() ?? '';
  // Lowercase, collapse to kebab.
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function fetchInner(url: string, timeoutMs = 5000): Promise<TrustEntry[]> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'scruple-web/trust-fetcher/0.1' },
    });
    if (!res.ok) throw new Error(`trust list HTTP ${res.status}`);
    const body = (await res.json()) as TrustListResponse;
    if (!body || !Array.isArray(body.nodes)) return [];
    return body.nodes.map((n) => ({
      packName: toPackKey(n.repository ?? n.id ?? ''),
      repository: n.repository ?? null,
      latestCommitSha: n.latest_version?.commit ?? null,
      tags: Array.isArray(n.tags) ? n.tags : [],
    })).filter((e) => e.packName.length > 0);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch the trusted-node list. In-process cached for {@link CACHE_TTL_MS}.
 * Returns an empty array on network / parse failure — trust labeling is
 * best-effort and should never crash the receipt page.
 */
export async function fetchTrustList(
  url: string = DEFAULT_TRUST_LIST_URL,
): Promise<TrustEntry[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.entries;
  if (_inflight) return _inflight;
  _inflight = fetchInner(url)
    .then((entries) => {
      _cache = { at: now, entries };
      return entries;
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[trust] fetch failed:', e instanceof Error ? e.message : e);
      return _cache?.entries ?? [];
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/** For tests / dev — bypass the network entirely. */
export function _setTrustListForTesting(entries: TrustEntry[]): void {
  _cache = { at: Date.now(), entries };
}

export { toPackKey as _toPackKeyForTesting };
