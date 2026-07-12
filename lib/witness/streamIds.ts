// ID generation for the audit log's typed identifiers.
//
// Format: <prefix>_<8 lowercase hex chars>
// Prefixes: TEN (tenants), PRN (principals), DLG (delegations),
//           STR (streams), CKP (checkpoints), ANC (anchor_epochs).
//
// The 8-hex suffix is the first 8 characters of sha256 over
// (namespace || salt || Date.now()) — collision-resistant enough for
// bookkeeping IDs (2^32 space per prefix; billions of streams / tenants
// tolerable). Checkpoint and anchor IDs use content-derived hashes
// instead (see below) so they're deterministic across replays.

import { createHash, randomBytes } from 'node:crypto';

function short(namespace: string): string {
  const salt = randomBytes(16).toString('hex');
  return createHash('sha256')
    .update(namespace + salt + Date.now().toString())
    .digest('hex')
    .slice(0, 8);
}

export function newTenantId(): string {
  return `TEN_${short('tenant')}`;
}

export function newPrincipalId(): string {
  return `PRN_${short('principal')}`;
}

export function newDelegationId(): string {
  return `DLG_${short('delegation')}`;
}

export function newStreamId(): string {
  return `STR_${short('stream')}`;
}

/** Content-derived: first 8 hex of sha256(merkle_root_bytes). */
export function checkpointIdFromMerkleRootHex(merkleRootHex: string): string {
  if (merkleRootHex.length !== 64) {
    throw new Error(`merkle_root must be 64 hex chars, got ${merkleRootHex.length}`);
  }
  const bytes = Buffer.from(merkleRootHex, 'hex');
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `CKP_${hex.slice(0, 8)}`;
}

/** Content-derived: first 8 hex of sha256(super_root_bytes). */
export function anchorIdFromSuperRootHex(superRootHex: string): string {
  if (superRootHex.length !== 64) {
    throw new Error(`super_root must be 64 hex chars, got ${superRootHex.length}`);
  }
  const bytes = Buffer.from(superRootHex, 'hex');
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `ANC_${hex.slice(0, 8)}`;
}
