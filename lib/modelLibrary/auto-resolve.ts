// Workflow-aware auto-resolve.
//
// Given a workflow_api_json the user is about to run, figure out which
// model files it needs that AREN'T yet on the Modal Volume, and split
// those into "we know how to fetch this" (catalog match by filename)
// vs "you'll have to paste a URL".
//
// The Workspace surfaces this as a banner with a "Resolve missing
// models" button when an outstanding workflow has resolvable refs.

import { validateWorkflow, type ValidationResult } from '@/lib/provenance/validate';
import { findByFilename, type CatalogModel } from './catalog';
import type { VolumeListing } from './modal-admin';

export interface AutoResolveResult {
  workflow: ValidationResult;
  missing: string[];               // full paths e.g. "loras/Body FIX FLUX.safetensors"
  resolvable: CatalogModel[];      // catalog entries we can auto-fetch
  unknown: string[];               // missing files with no catalog match
}

export function autoResolveWorkflow(
  workflowApiJson: Record<string, unknown>,
  listing: VolumeListing,
): AutoResolveResult {
  // Flatten listing → set of full paths
  const available = new Set<string>();
  for (const items of Object.values(listing.by_category)) {
    for (const it of items) available.add(it.path);
  }

  const result = validateWorkflow(workflowApiJson, { availableFiles: available });

  const missing = result.summary.referencedModels.filter(p => !available.has(p));
  const resolvable: CatalogModel[] = [];
  const unknown: string[] = [];
  for (const fullPath of missing) {
    const filename = fullPath.split('/').pop() ?? fullPath;
    const cat = findByFilename(filename);
    if (cat) resolvable.push(cat);
    else unknown.push(fullPath);
  }
  return { workflow: result, missing, resolvable, unknown };
}
