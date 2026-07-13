// Trust-labeler — WO-B2 (2026-07-13).
//
// Matches each pack in a container_machine_manifest against a
// ComfyOrg trust list snapshot. Labels are:
//
//   trusted    — pack appears in the trust list AND (either no commit
//                pinning available OR the stored commit_sha matches the
//                list's latest known commit)
//   listed     — pack appears in the list but the stored commit differs
//                from latest; still safer than "unknown" but stale
//   unknown    — pack does NOT appear on the list at all
//
// "unknown" is not a rejection — it just means the pack isn't ComfyOrg-
// blessed. Human authorship isn't gated on trust-list membership; the
// label helps the viewer distinguish "official pack" from "someone's
// experimental fork" without needing to eyeball the repo URL.

import { fetchTrustList, _toPackKeyForTesting, type TrustEntry } from './comfyorg';

export type TrustLabel = 'trusted' | 'listed' | 'unknown';

export interface CustomNodeEntry {
  pack: string;
  commit_sha: string | null;
  contents_hash?: string;
}

export interface LabeledCustomNode extends CustomNodeEntry {
  trust: TrustLabel;
  trust_repository?: string;
  trust_tags?: string[];
}

/**
 * Label each pack in the manifest against the given trust-list entries.
 * Deterministic + synchronous; the async part is the fetcher, kept
 * separate so callers can cache / short-circuit as they see fit.
 */
export function labelManifest(
  packs: CustomNodeEntry[],
  trust: TrustEntry[],
): LabeledCustomNode[] {
  const byKey = new Map<string, TrustEntry>();
  for (const entry of trust) byKey.set(entry.packName, entry);

  return packs.map((pack) => {
    const key = _toPackKeyForTesting(pack.pack);
    const t = byKey.get(key);
    if (!t) return { ...pack, trust: 'unknown' as TrustLabel };
    if (t.latestCommitSha && pack.commit_sha && t.latestCommitSha !== pack.commit_sha) {
      return {
        ...pack,
        trust: 'listed' as TrustLabel,
        trust_repository: t.repository ?? undefined,
        trust_tags: t.tags,
      };
    }
    return {
      ...pack,
      trust: 'trusted' as TrustLabel,
      trust_repository: t.repository ?? undefined,
      trust_tags: t.tags,
    };
  });
}

export interface LabelSummary {
  total: number;
  trusted: number;
  listed: number;
  unknown: number;
}

export function summarizeLabels(labeled: LabeledCustomNode[]): LabelSummary {
  const s: LabelSummary = { total: labeled.length, trusted: 0, listed: 0, unknown: 0 };
  for (const p of labeled) s[p.trust]++;
  return s;
}

/** One-shot convenience: fetch the current trust list and label a manifest. */
export async function labelManifestFromLive(
  packs: CustomNodeEntry[],
): Promise<LabeledCustomNode[]> {
  const trust = await fetchTrustList();
  return labelManifest(packs, trust);
}
