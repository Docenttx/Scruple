// POST /api/verify
//
// Accepts a lock-package manifest (JSON body or multipart upload) and
// recomputes the Merkle root. Returns:
//   {
//     valid: boolean,
//     computedRoot: string,
//     expectedRoot: string,
//     scrId: string,
//     leafCount: number,
//     mismatches?: string[]   // human-readable problems
//   }

import { NextRequest, NextResponse } from 'next/server';
import { computeRootFromLeaves } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import type { LockPackageManifest } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let manifest: LockPackageManifest;
  try {
    const body = await req.json();
    manifest = body as LockPackageManifest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (manifest?.version !== 1 || !Array.isArray(manifest.iterations)) {
    return NextResponse.json({ error: 'Not a Scruple lock package (v1)' }, { status: 400 });
  }

  const mismatches: string[] = [];

  // Verify ordering invariant
  for (let i = 0; i < manifest.iterations.length; i++) {
    if (manifest.iterations[i].runSequence !== i + 1) {
      mismatches.push(`run_sequence gap at index ${i} (expected ${i + 1}, got ${manifest.iterations[i].runSequence})`);
    }
  }

  // Recompute Merkle root from leaf hashes
  const leaves = manifest.iterations.map((it) => it.leafHash);
  const computedRoot = computeRootFromLeaves(leaves);
  if (!computedRoot) {
    return NextResponse.json({ error: 'Empty manifest' }, { status: 400 });
  }

  if (computedRoot !== manifest.merkleRoot) {
    mismatches.push(`Merkle root mismatch: computed=${computedRoot} expected=${manifest.merkleRoot}`);
  }

  const computedScr = deriveScrId(computedRoot, manifest.scrId.startsWith('SCRB_'));
  if (computedScr !== manifest.scrId) {
    mismatches.push(`SCR-ID mismatch: computed=${computedScr} expected=${manifest.scrId}`);
  }

  return NextResponse.json({
    valid: mismatches.length === 0,
    computedRoot,
    expectedRoot: manifest.merkleRoot,
    scrId: manifest.scrId,
    computedScrId: computedScr,
    leafCount: leaves.length,
    mismatches: mismatches.length > 0 ? mismatches : undefined,
  });
}
