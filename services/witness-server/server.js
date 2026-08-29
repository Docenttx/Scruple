/**
 * server.js - SCRUPLE Witness Server V1 (Oracle)
 *
 * SQLite-backed tamper-proof witness server.
 * Deployed at /opt/scruple-witness/server.js on Oracle VM (129.80.132.5).
 * Runs on port 5799 as a systemd service.
 *
 * Endpoints:
 *   GET  /health
 *   POST /api/witness
 *   GET  /api/witness/:projectId
 *   POST /api/lock/:projectId
 *   POST /api/verify
 *   GET  /api/tsd/balance/:installationId
 *   POST /api/tsd/fund
 *   POST /api/tsd/pay
 *   POST /api/tsd/verify
 *   POST /api/clone-project
 *   GET  /api/stripe-config
 *   POST /api/create-payment-intent
 *   POST /api/confirm-and-execute
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const url = require('url');
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const Stripe = require('stripe');
const { issueAsset } = require('./testnet-locker');
const arweaveTreasury = require('./arweave-treasury');
const { pinJSON } = require('./ipfs-pinner');

// ─── Stripe configuration ─────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

if (!STRIPE_SECRET_KEY) {
  console.warn('[STRIPE] WARNING: STRIPE_SECRET_KEY not set — payment endpoints will fail');
}

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// Fee schedule in cents. Mirrors lib/pricing/actions.ts in scruple-web —
// change both together. Non-custodial: one charge per action.
const STRIPE_FEES = {
  'checkpoint':        500,   // $5.00
  'finalize':          1000,  // $10.00  (C2PA sign)
  'chain-lock-basic':  10000, // $100.00
  'chain-lock-pinned': 15000  // $150.00
};

// Configuration
const PORT = process.env.PORT || 5799;
// The HMAC secret that seals every witness leaf.
//
// This previously fell back to the literal string
// 'dev-secret-replace-in-production' when the environment variable was
// unset — silently, with no warning, unlike STRIPE_SECRET_KEY twenty
// lines above which at least says something. A leaf sealed with a
// constant published in this file is forgeable by anyone who has read
// it, and nothing downstream could tell the difference: the seal
// verifies perfectly, against a key everybody has.
//
// Fail closed. A witness that cannot seal is a witness that must not
// start. The dev convenience is preserved behind an explicit opt-in, so
// running without a real secret is now a thing you decide rather than a
// thing you drift into.
const SECRET = (() => {
  const s = process.env.SCRUPLE_WITNESS_SECRET;
  if (s && s.length >= 32) return s;
  if (s && s.length < 32) {
    console.error('[witness] FATAL: SCRUPLE_WITNESS_SECRET is shorter than 32 characters.');
    process.exit(1);
  }
  if (process.env.SCRUPLE_WITNESS_ALLOW_DEV_SECRET === '1') {
    console.warn('[witness] WARNING: running with the DEV secret. Every leaf sealed');
    console.warn('[witness] by this process is forgeable. Never in production.');
    return 'dev-secret-replace-in-production';
  }
  console.error('[witness] FATAL: SCRUPLE_WITNESS_SECRET is not set.');
  console.error('[witness] Refusing to start rather than sealing leaves with a');
  console.error('[witness] published constant. Set the variable, or set');
  console.error('[witness] SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 to accept a');
  console.error('[witness] forgeable seal deliberately.');
  process.exit(1);
})();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'witness.db');

// TSD token TTL: 5 minutes
const TSD_TOKEN_TTL_MS = 5 * 60 * 1000;

// Auto-fund amount for new beta installations
const BETA_AUTO_FUND = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Database setup
// ─────────────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS witnesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    witness_id TEXT UNIQUE NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT,
    run_sequence INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    visual_hash TEXT,
    client_timestamp TEXT,
    server_timestamp TEXT NOT NULL,
    signature TEXT NOT NULL,
    cloned_from TEXT
  );

  CREATE TABLE IF NOT EXISTS locked_projects (
    project_id TEXT PRIMARY KEY,
    merkle_root TEXT NOT NULL,
    witnessed_count INTEGER NOT NULL,
    server_signature TEXT NOT NULL,
    locked_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pre_scr_id TEXT UNIQUE NOT NULL,
    project_name TEXT NOT NULL,
    installation_id TEXT,
    cloned_from TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tsd_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tsd_auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    installation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    amount INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_witnesses_project ON witnesses(project_id);
  CREATE INDEX IF NOT EXISTS idx_tsd_tokens_token ON tsd_auth_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_tsd_ledger_install ON tsd_ledger(installation_id);
`);

// Run schema migrations for existing DBs
(function runMigrations() {
  try {
    const cols = db.prepare("PRAGMA table_info(witnesses)").all().map(c => c.name);
    if (!cols.includes('cloned_from')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN cloned_from TEXT");
      console.log('[DB] Migrated: witnesses.cloned_from');
    }
  } catch (e) {
    console.log('[DB] Migration warning: ' + e.message);
  }
  try {
    const cols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
    if (!cols.includes('cloned_from')) {
      db.exec("ALTER TABLE projects ADD COLUMN cloned_from TEXT");
      console.log('[DB] Migrated: projects.cloned_from');
    }
  } catch (e) {
    console.log('[DB] Migration warning: ' + e.message);
  }
  // v2.2 (canvas v2 WO-8) — bind the user's pinned manifest of custom-node
  // packs into the leaf preimage. Pre-2.2 rows leave it NULL → leaf_scheme
  // stays 'v2'. When the field is provided, leaf_scheme = 'v2.2'.
  try {
    const cols = db.prepare("PRAGMA table_info(witnesses)").all().map(c => c.name);
    if (!cols.includes('machine_manifest_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN machine_manifest_hash TEXT");
      console.log('[DB] Migrated: witnesses.machine_manifest_hash (v2.2)');
    }
    if (!cols.includes('leaf_scheme')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_scheme TEXT");
      console.log('[DB] Migrated: witnesses.leaf_scheme');
    }
    if (!cols.includes('leaf_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_hash TEXT");
      console.log('[DB] Migrated: witnesses.leaf_hash');
    }
    if (!cols.includes('input_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN input_hash TEXT");
      console.log('[DB] Migrated: witnesses.input_hash');
    }
    if (!cols.includes('workflow_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN workflow_hash TEXT");
      console.log('[DB] Migrated: witnesses.workflow_hash');
    }
    if (!cols.includes('prev_record_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN prev_record_hash TEXT");
      console.log('[DB] Migrated: witnesses.prev_record_hash');
    }
    if (!cols.includes('model_fingerprints_hash')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN model_fingerprints_hash TEXT");
      console.log('[DB] Migrated: witnesses.model_fingerprints_hash');
    }
    // H-1 — asymmetric leaf signature. The HMAC `signature` column stays
    // as the transport seal; these carry the evidence.
    if (!cols.includes('leaf_signature')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_signature TEXT");
      console.log('[DB] Migrated: witnesses.leaf_signature');
    }
    if (!cols.includes('leaf_signer_key_id')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_signer_key_id TEXT");
      console.log('[DB] Migrated: witnesses.leaf_signer_key_id');
    }
    if (!cols.includes('leaf_signature_alg')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_signature_alg TEXT");
      console.log('[DB] Migrated: witnesses.leaf_signature_alg');
    }
    // A surrogate-signed leaf must be distinguishable at rest, not only
    // at the moment of signing.
    if (!cols.includes('leaf_signer_surrogate')) {
      db.exec("ALTER TABLE witnesses ADD COLUMN leaf_signer_surrogate INTEGER");
      console.log('[DB] Migrated: witnesses.leaf_signer_surrogate');
    }
  } catch (e) {
    console.log('[DB] Migration warning (v2.2): ' + e.message);
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const leafSigner = require('./leaf_signer');

// The HMAC. H-2 demotes this to a TRANSPORT SEAL between the application
// tier and this service — it is no longer an evidence claim. Evidence is
// the ECDSA signature from leaf_signer, which a third party can verify
// without Scruple. See docs/canon/L2_FLOOR.md.
function sign(data) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('hex');
}

function generateWitnessId() {
  return 'wit_' + crypto.randomBytes(8).toString('hex');
}

// v2 leaf scheme: the Merkled leaf is sha256 of the canonical record, not
// the bare output content_hash. The record commits to inputs, workflow,
// order, and time too — so the RVN-anchored Merkle root binds the WHOLE
// provenance package, which is the premise outsiders rely on when they
// verify an asset by ID.
//
// Canonicalization: fixed field order. Stable across versions, easy for a
// third-party verifier to reproduce.
// v2 canonical — pre-WO-8. Does NOT include machine_manifest_hash.
// Audit replays must use this form for any witness with leaf_scheme='v2'.
function canonicalRecord(rec) {
  // Order is part of the protocol. Do NOT reorder these fields.
  const ordered = {
    run_sequence:     rec.run_sequence,
    output_hash:      rec.output_hash || '',
    input_hash:       rec.input_hash || '',
    workflow_hash:    rec.workflow_hash || '',
    model_fingerprints_hash: rec.model_fingerprints_hash || '',
    server_timestamp: rec.server_timestamp,
    prev_record_hash: rec.prev_record_hash || '',
  };
  return JSON.stringify(ordered);
}

// v2.2 canonical — adds machine_manifest_hash slot between
// model_fingerprints_hash and server_timestamp. Used only when the
// witness call supplied a non-empty machine_manifest_hash; leaf_scheme
// recorded as 'v2.2' so audit picks the matching form.
function canonicalRecordV22(rec) {
  const ordered = {
    run_sequence:     rec.run_sequence,
    output_hash:      rec.output_hash || '',
    input_hash:       rec.input_hash || '',
    workflow_hash:    rec.workflow_hash || '',
    model_fingerprints_hash: rec.model_fingerprints_hash || '',
    machine_manifest_hash:   rec.machine_manifest_hash || '',
    server_timestamp: rec.server_timestamp,
    prev_record_hash: rec.prev_record_hash || '',
  };
  return JSON.stringify(ordered);
}

function recordHash(rec, scheme) {
  const fn = scheme === 'v2.2' ? canonicalRecordV22 : canonicalRecord;
  return crypto.createHash('sha256').update(fn(rec)).digest('hex');
}

/**
 * Permanence anchoring for chain locks.
 *   - basic : Arweave token record only (no IPFS pin)
 *   - pinned: IPFS pin of the proof record (CID) + Arweave token record
 *             that embeds that CID.
 * Both steps are non-fatal — the RVN mint is the primary anchor; IPFS and
 * Arweave failures are surfaced as *Error fields so the caller can retry.
 * Matches the Electron Studio flow (lock-executor-blockchain always posts
 * the Arweave record; performPermanentLock adds the IPFS pin).
 */
async function anchorPermanence(opts) {
  const pinned = opts.tier === 'pinned';
  const result = { ipfsCid: null, ipfsError: null, arweaveTxId: null, arweaveError: null };

  if (pinned) {
    try {
      const record = {
        type: 'scruple-proof-record',
        version: '2.0',
        scr_id: opts.scrId,
        pre_scr_id: opts.preScrId || null,
        merkle_root: opts.merkleRoot,
        rvn_txid: opts.rvnTxId || null,
        witness_signature: opts.witnessSignature || null,
        witnessed_count: opts.witnessedCount || 0,
        locked_at: opts.lockedAt,
        installation_id: opts.installationId || null,
        project_name: opts.projectName || null,
      };
      const pin = await pinJSON(record, 'SCRUPLE_' + opts.scrId);
      result.ipfsCid = pin.cid;
      console.log('[ANCHOR] IPFS pinned ' + opts.scrId + ' → ' + pin.cid);
    } catch (e) {
      result.ipfsError = e && e.message ? e.message : String(e);
      console.error('[ANCHOR] IPFS pin failed for ' + opts.scrId + ': ' + result.ipfsError);
    }
  }

  try {
    result.arweaveTxId = await arweaveTreasury.postTokenRecord({
      scr_id: opts.scrId,
      pre_scr_id: opts.preScrId || null,
      installation_id: opts.installationId || null,
      project_name: opts.projectName || null,
      merkle_root: opts.merkleRoot,
      rvn_txid: opts.rvnTxId || null,
      witness_signature: opts.witnessSignature || null,
      witnessed_count: opts.witnessedCount || 0,
      locked_at: opts.lockedAt,
      ipfs_cid: result.ipfsCid,
    });
    console.log('[ANCHOR] Arweave record posted for ' + opts.scrId + ' → ' + result.arweaveTxId);
  } catch (e) {
    result.arweaveError = e && e.message ? e.message : String(e);
    console.error('[ANCHOR] Arweave post failed for ' + opts.scrId + ': ' + result.arweaveError);
  }

  return result;
}

function generateTsdToken() {
  return 'TSD_AUTH_' + crypto.randomBytes(16).toString('hex');
}

function calculateMerkleRoot(hashes) {
  if (hashes.length === 0) return null;
  if (hashes.length === 1) return hashes[0];
  const nextLevel = [];
  for (let i = 0; i < hashes.length; i += 2) {
    if (i + 1 < hashes.length) {
      const combined = hashes[i] + hashes[i + 1];
      nextLevel.push(crypto.createHash('sha256').update(combined).digest('hex'));
    } else {
      nextLevel.push(hashes[i]);
    }
  }
  return calculateMerkleRoot(nextLevel);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Request handler
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    // Health check
    if (pathname === '/api/signer' && method === 'GET') {
      return handleSignerInfo(res);
    }
    if (pathname === '/api/signer/pubkey' && method === 'GET') {
      return handleSignerPubkey(res);
    }
    if (pathname === '/health' && method === 'GET') {
      return send(res, 200, { status: 'ok', version: '1.0', timestamp: new Date().toISOString() });
    }

    // ─── Witness endpoints ────────────────────────────────────────────────

    if (pathname === '/api/witness' && method === 'POST') {
      return handleWitness(req, res);
    }

    if (pathname.startsWith('/api/witness/') && method === 'GET') {
      const projectId = decodeURIComponent(pathname.split('/')[3]);
      return handleGetWitnesses(projectId, res);
    }

    if (pathname.startsWith('/api/lock/') && method === 'POST') {
      const projectId = decodeURIComponent(pathname.split('/')[3]);
      return handleLock(projectId, req, res);
    }

    if (pathname === '/api/verify' && method === 'POST') {
      return handleVerify(req, res);
    }

    // ─── TSD endpoints ────────────────────────────────────────────────────

    if (pathname.startsWith('/api/tsd/balance/') && method === 'GET') {
      const installationId = decodeURIComponent(pathname.split('/')[4]);
      return handleTsdBalance(installationId, res);
    }

    if (pathname === '/api/tsd/fund' && method === 'POST') {
      return handleTsdFund(req, res);
    }

    if (pathname === '/api/tsd/pay' && method === 'POST') {
      return handleTsdPay(req, res);
    }

    if (pathname === '/api/tsd/verify' && method === 'POST') {
      return handleTsdVerify(req, res);
    }

    // ─── Clone endpoint ───────────────────────────────────────────────────

    if (pathname === '/api/clone-project' && method === 'POST') {
      return handleCloneProject(req, res);
    }

    // ─── Fiat chain lock ──────────────────────────────────────────────────

    if (pathname === '/api/fiat-chain-lock' && method === 'POST') {
      return handleFiatChainLock(req, res);
    }

    // ─── Stripe endpoints ─────────────────────────────────────────────────

    if (pathname === '/api/stripe-config' && method === 'GET') {
      return handleStripeConfig(res);
    }

    if (pathname === '/api/create-payment-intent' && method === 'POST') {
      return handleCreatePaymentIntent(req, res);
    }

    if (pathname === '/api/confirm-and-execute' && method === 'POST') {
      return handleConfirmAndExecute(req, res);
    }

    // ─── Dev-only: confirm a Stripe test PaymentIntent ────────────────────
    // Drives the same flow Stripe Elements does in the browser, so CLI
    // tests don't need browser interaction. Localhost-only — same trust
    // boundary as the rest of the witness server (which scruple-web on
    // the same host is the only caller of in normal operation).
    if (pathname === '/api/admin/confirm-pi' && method === 'POST') {
      return handleAdminConfirmPi(req, res);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[SERVER] Unhandled error:', err.message);
    send(res, 500, { error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Witness handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleWitness(req, res) {
  const data = await readBody(req);
  const {
    project_id, project_name, run_sequence,
    content_hash, visual_hash, client_timestamp,
    // v2 fields (optional from older clients; required for full-package proof)
    input_hash, workflow_hash, model_fingerprints_hash,
    // v2.2 (canvas v2 WO-8) — pinned-manifest hash for the artist's
    // custom-node toolchain. Drives leaf_scheme: present → 'v2.2', else 'v2'.
    machine_manifest_hash,
  } = data;

  // Refuse the synthetic project ids a development harness generates.
  //
  // On 2026-08-29 a local integration test wrote 9 rows into THIS database
  // under project_id 'tenant:t1'. WITNESS_SERVER_URL defaults to
  // 127.0.0.1:5799, and the test pointed its own app at a throwaway SQLite
  // while forgetting the second database behind it. The rows were
  // chain-isolated and have been removed, with a backup taken first.
  //
  // NOTE ON THE SHAPE OF THIS CHECK. The first version refused any
  // non-numeric project id. That was wrong, and the production data said
  // so: this database legitimately holds 'puffjuly12-1783882341' (the L2
  // full-send demo), 'scruple-web-test-...', and an 'sw:<uuid>:<n>'
  // scheme. A numeric-only rule would have rejected all of them.
  //
  // So this refuses only the prefixes the /v2 canon surface generates,
  // which is precisely the traffic that should never reach a production
  // witness from a developer's machine. Set
  // SCRUPLE_WITNESS_ALLOW_SYNTHETIC_PROJECT=1 on a throwaway instance
  // where those ids are the point.
  const SYNTHETIC_PROJECT_PREFIXES = ['tenant:', 'baseline:'];
  if (
    process.env.SCRUPLE_WITNESS_ALLOW_SYNTHETIC_PROJECT !== '1' &&
    project_id !== undefined &&
    SYNTHETIC_PROJECT_PREFIXES.some((pre) => String(project_id).startsWith(pre))
  ) {
    return send(res, 400, {
      error: 'synthetic project_id refused',
      detail:
        'This project id prefix is generated by the /v2 canon surface and ' +
        'should not reach a production witness. A development harness is ' +
        'probably pointed at the wrong WITNESS_SERVER_URL. Set ' +
        'SCRUPLE_WITNESS_ALLOW_SYNTHETIC_PROJECT=1 if this is deliberate.',
      received: String(project_id).slice(0, 64),
      refused_prefixes: SYNTHETIC_PROJECT_PREFIXES,
    });
  }

  if (!project_id || !content_hash || run_sequence === undefined) {
    return send(res, 400, { error: 'Missing required fields' });
  }

  // Check if project is locked
  const locked = db.prepare('SELECT 1 FROM locked_projects WHERE project_id = ?').get(String(project_id));
  if (locked) {
    return send(res, 403, { error: 'Project is locked, no new iterations allowed' });
  }

  const witness_id = generateWitnessId();
  const server_timestamp = new Date().toISOString();

  // v2 leaf: chain prev_record_hash from this project's most recent witness
  // row (the row's leaf_hash, if any — v1 rows have NULL, chain starts at "").
  // Then build the canonical record and take its hash as the Merkled leaf.
  // The HMAC signs the leaf_hash, so the per-row seal covers the whole
  // record (output, inputs, workflow, sequence, time, prev) via the leaf.
  const prevRow = db.prepare(
    `SELECT leaf_hash FROM witnesses
      WHERE project_id = ?
      ORDER BY run_sequence DESC
      LIMIT 1`
  ).get(String(project_id));
  const prev_record_hash = (prevRow && prevRow.leaf_hash) ? prevRow.leaf_hash : '';

  const record = {
    run_sequence,
    output_hash:   content_hash,
    input_hash:    input_hash || '',
    workflow_hash: workflow_hash || '',
    model_fingerprints_hash: model_fingerprints_hash || '',
    machine_manifest_hash:   machine_manifest_hash || '',
    server_timestamp,
    prev_record_hash,
  };
  const leaf_scheme = machine_manifest_hash ? 'v2.2' : 'v2';
  const leaf_hash = recordHash(record, leaf_scheme);
  const signature = sign(leaf_hash);

  // H-1 — the evidence signature. Returns null when signing is disabled
  // or the KMS is unreachable; the leaf is still recorded, with its
  // signature fields null so anything reading it can tell that this leaf
  // is verifiable only by Scruple. Losing the event entirely would be
  // worse than recording one whose independent verifiability is pending.
  const leafSig = await leafSigner.signLeaf(leaf_hash);

  db.prepare(`
    INSERT OR IGNORE INTO witnesses
      (witness_id, project_id, project_name, run_sequence, content_hash,
       visual_hash, client_timestamp, server_timestamp, signature,
       input_hash, workflow_hash, prev_record_hash, leaf_hash, leaf_scheme,
       model_fingerprints_hash, machine_manifest_hash,
       leaf_signature, leaf_signer_key_id, leaf_signature_alg,
       leaf_signer_surrogate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    witness_id, String(project_id), project_name, run_sequence, content_hash,
    visual_hash, client_timestamp, server_timestamp, signature,
    input_hash || null, workflow_hash || null, prev_record_hash || null,
    leaf_hash, leaf_scheme,
    model_fingerprints_hash || null,
    machine_manifest_hash || null,
    leafSig ? leafSig.signature : null,
    leafSig ? leafSig.key_id : null,
    leafSig ? leafSig.alg : null,
    leafSig ? (leafSig.surrogate ? 1 : 0) : null,
  );

  // Log line is the audit trail: project identity, sequence, witness id,
  // leaf prefix, and presence-flags for the v2 bindings so an operator
  // sees at a glance whether each iteration carries its full record.
  const inMark = input_hash ? input_hash.slice(0, 8) : '∅';
  const wfMark = workflow_hash ? workflow_hash.slice(0, 8) : '∅';
  const mfMark = model_fingerprints_hash ? model_fingerprints_hash.slice(0, 8) : '∅';
  const mmMark = machine_manifest_hash ? machine_manifest_hash.slice(0, 8) : '∅';
  const prevMark = prev_record_hash ? prev_record_hash.slice(0, 8) : '∅';
  console.log(`[WITNESS] ${project_name || project_id} #${run_sequence} → ${witness_id} (${leaf_scheme} leaf ${leaf_hash.slice(0, 12)} · in=${inMark} · wf=${wfMark} · mf=${mfMark} · mm=${mmMark} · prev=${prevMark})`);

  send(res, 200, {
    witness_id, server_timestamp, signature,
    leaf_hash, prev_record_hash, leaf_scheme,
    // H-1 — the evidence signature, and an honest statement of what it
    // is worth. `independently_verifiable: false` means this leaf can be
    // checked by Scruple and nobody else, which anything presenting it
    // to a user must say rather than imply parity with a C2PA manifest.
    leaf_signature: leafSig ? leafSig.signature : null,
    leaf_signer_key_id: leafSig ? leafSig.key_id : null,
    leaf_signature_alg: leafSig ? leafSig.alg : null,
    signer_surrogate: leafSig ? Boolean(leafSig.surrogate) : false,
    independently_verifiable: Boolean(leafSig),
  });
}

// GET /api/signer — what is sealing leaves right now, and what that is
// worth. Unauthenticated: a verifier must be able to ask without a
// relationship to Scruple.
async function handleSignerInfo(res) {
  // Includes a live self-check: sign a probe and verify it against the
  // key we publish. A mismatch there makes every leaf unverifiable while
  // looking perfectly healthy, so it is worth the milliseconds.
  send(res, 200, { ...leafSigner.info(), self_check: await leafSigner.selfCheck() });
}

// GET /api/signer/pubkey — the verifying key.
//
// This is the endpoint that makes a Scruple leaf checkable without
// Scruple. Until H-1 there was no such endpoint, because there was no
// such possibility: an HMAC has no public half.
async function handleSignerPubkey(res) {
  const pem = await leafSigner.publicKeyPem();
  if (!pem) {
    send(res, 404, {
      error: 'no public key',
      detail: leafSigner.mode() === 'disabled'
        ? 'Leaf signing is disabled. Leaves carry an HMAC only and are verifiable by Scruple alone.'
        : 'Leaf signing is enabled but no public key URL is configured (SCRUPLE_WITNESS_KMS_PUBKEY_URL).',
      mode: leafSigner.mode(),
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
  res.end(pem);
}

function handleGetWitnesses(projectId, res) {
  const rows = db.prepare(`
    SELECT witness_id, run_sequence, content_hash, server_timestamp, signature
    FROM witnesses WHERE project_id = ?
    ORDER BY run_sequence ASC
  `).all(String(projectId));

  send(res, 200, { project_id: projectId, iterations: rows, count: rows.length });
}

async function handleLock(projectId, req, res) {
  // Optional canonical merkleRoot from the caller. scruple-web / desktop
  // compute a sorted-pair Merkle (lib/scruple/merkle.ts buildMerkle) that
  // their own verifier reproduces. When provided we anchor THAT root so the
  // minted scrId is verifiable client-side. When absent (legacy callers) we
  // fall back to the server's own calculateMerkleRoot — unchanged behavior.
  let bodyMerkleRoot = null;
  let tier = 'basic';
  try {
    const body = await readBody(req);
    if (body && typeof body.merkleRoot === 'string' && body.merkleRoot.length >= 32) {
      bodyMerkleRoot = body.merkleRoot;
    }
    if (body && (body.tier === 'pinned' || body.lockTier === 'pinned')) {
      tier = 'pinned';
    }
  } catch { /* no/invalid body — treat as legacy no-arg lock */ }

  const rows = db.prepare(`
    SELECT * FROM witnesses WHERE project_id = ?
    ORDER BY run_sequence ASC
  `).all(String(projectId));

  if (rows.length === 0) {
    return send(res, 400, { error: 'No witnessed iterations to lock' });
  }

  const hashes = rows.map(r => r.content_hash);
  const merkle_root = bodyMerkleRoot || calculateMerkleRoot(hashes);
  const locked_at = new Date().toISOString();

  const lockData = { project_id: projectId, merkle_root, witnessed_count: rows.length, locked_at };
  const server_signature = sign(lockData);

  db.prepare(`
    INSERT OR REPLACE INTO locked_projects (project_id, merkle_root, witnessed_count, server_signature, locked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(projectId), merkle_root, rows.length, server_signature, locked_at);

  console.log(`[WITNESS] Project ${projectId} LOCKED. Root: ${merkle_root.substring(0, 16)}...`);

  // Derive SCR-ID from merkle root (same shape as handleFiatChainLock) and
  // mint on RVN testnet. Mint failure does NOT fail the lock — we still
  // return the merkle + signature so callers can persist the local-disc
  // lock state and retry the mint separately if needed.
  const scrSuffix = crypto.createHash('sha256').update(merkle_root).digest('hex').substring(0, 8).toUpperCase();
  const scrId = 'SCR_' + scrSuffix;
  let proofTxId = null;
  let mintError = null;
  try {
    const mint = await issueAsset(scrId, null);
    proofTxId = mint.txid;
    console.log(`[WITNESS] ${scrId} minted on testnet → ${proofTxId}`);
  } catch (e) {
    mintError = e && e.message ? e.message : String(e);
    console.error(`[WITNESS] mint failed for ${scrId}: ${mintError}`);
  }

  // Permanence: Arweave token record (basic + pinned) + IPFS pin (pinned).
  const anchor = await anchorPermanence({
    tier,
    scrId,
    preScrId: null,
    merkleRoot: merkle_root,
    rvnTxId: proofTxId,
    witnessSignature: server_signature,
    witnessedCount: rows.length,
    lockedAt: locked_at,
    installationId: String(projectId),
    projectName: null,
  });

  send(res, 200, {
    project_id: projectId,
    iterations: rows.map(r => ({
      run_sequence: r.run_sequence,
      content_hash: r.content_hash,
      visual_hash: r.visual_hash,
      witnessed_at: r.server_timestamp,
      witnessed: true
    })),
    witnessed_count: rows.length,
    merkle_root,
    server_signature,
    locked_at,
    scrId,
    proofTxId,
    proofChain: proofTxId ? 'rvn-testnet' : null,
    mintError,
    lockTier: tier,
    ipfsCid: anchor.ipfsCid,
    ipfsError: anchor.ipfsError,
    arweaveTxId: anchor.arweaveTxId,
    arweaveError: anchor.arweaveError
  });
}

async function handleVerify(req, res) {
  const { project_id, local_chain } = await readBody(req);
  const serverChain = db.prepare(
    'SELECT * FROM witnesses WHERE project_id = ? ORDER BY run_sequence ASC'
  ).all(String(project_id));

  const mismatches = [];
  let valid = true;

  for (const local of (local_chain || [])) {
    const serverRecord = serverChain.find(s => s.run_sequence === local.run_sequence);
    if (!serverRecord) {
      mismatches.push({ run_sequence: local.run_sequence, issue: 'not_witnessed', local_hash: local.content_hash });
    } else if (serverRecord.content_hash !== local.content_hash) {
      valid = false;
      mismatches.push({ run_sequence: local.run_sequence, issue: 'hash_mismatch', local_hash: local.content_hash, server_hash: serverRecord.content_hash });
    }
  }

  send(res, 200, { valid, total_local: (local_chain || []).length, total_witnessed: serverChain.length, mismatches });
}

// ─────────────────────────────────────────────────────────────────────────────
// TSD handlers
// ─────────────────────────────────────────────────────────────────────────────

function getTsdLedger(installationId) {
  let row = db.prepare('SELECT * FROM tsd_ledger WHERE installation_id = ?').get(installationId);
  if (!row) {
    // Auto-fund new beta installation
    db.prepare(`
      INSERT INTO tsd_ledger (installation_id, balance, updated_at)
      VALUES (?, ?, ?)
    `).run(installationId, BETA_AUTO_FUND, new Date().toISOString());
    row = db.prepare('SELECT * FROM tsd_ledger WHERE installation_id = ?').get(installationId);
    console.log(`[TSD] Auto-funded new installation ${installationId} with ${BETA_AUTO_FUND} TSD`);
  }
  return row;
}

function handleTsdBalance(installationId, res) {
  const row = getTsdLedger(installationId);
  send(res, 200, { installationId, balance: row.balance });
}

async function handleTsdFund(req, res) {
  const { installationId, amount } = await readBody(req);
  if (!installationId || !amount || amount <= 0) {
    return send(res, 400, { error: 'installationId and positive amount required' });
  }

  getTsdLedger(installationId); // ensure row exists
  db.prepare(`
    UPDATE tsd_ledger SET balance = balance + ?, updated_at = ? WHERE installation_id = ?
  `).run(amount, new Date().toISOString(), installationId);

  const updated = db.prepare('SELECT balance FROM tsd_ledger WHERE installation_id = ?').get(installationId);
  console.log(`[TSD] Funded ${installationId} +${amount} → ${updated.balance}`);
  send(res, 200, { success: true, newBalance: updated.balance });
}

async function handleTsdPay(req, res) {
  const { installationId, action, amount } = await readBody(req);
  if (!installationId || !action || !amount || amount <= 0) {
    return send(res, 400, { error: 'installationId, action, and positive amount required' });
  }

  const ledger = getTsdLedger(installationId);
  if (ledger.balance < amount) {
    return send(res, 200, { success: false, error: 'Insufficient TSD balance' });
  }

  // Deduct balance
  db.prepare(`
    UPDATE tsd_ledger SET balance = balance - ?, updated_at = ? WHERE installation_id = ?
  `).run(amount, new Date().toISOString(), installationId);

  // Issue auth token
  const authToken = generateTsdToken();
  const expiresAt = new Date(Date.now() + TSD_TOKEN_TTL_MS).toISOString();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO tsd_auth_tokens (token, installation_id, action, amount, used, expires_at, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(authToken, installationId, action, amount, expiresAt, createdAt);

  const newBalance = db.prepare('SELECT balance FROM tsd_ledger WHERE installation_id = ?').get(installationId).balance;
  console.log(`[TSD] Paid ${amount} TSD for "${action}" — ${installationId} → balance ${newBalance}`);

  send(res, 200, { success: true, authToken, expiresAt, newBalance });
}

async function handleTsdVerify(req, res) {
  const { authToken, action } = await readBody(req);
  if (!authToken) {
    return send(res, 400, { error: 'authToken required' });
  }

  const tokenRow = db.prepare('SELECT * FROM tsd_auth_tokens WHERE token = ?').get(authToken);
  if (!tokenRow) {
    return send(res, 200, { valid: false, error: 'Token not found' });
  }
  if (tokenRow.used) {
    return send(res, 200, { valid: false, error: 'Token already used' });
  }
  if (new Date() > new Date(tokenRow.expires_at)) {
    return send(res, 200, { valid: false, error: 'Token expired' });
  }
  if (action && tokenRow.action !== action) {
    return send(res, 200, { valid: false, error: `Token action mismatch: expected "${tokenRow.action}", got "${action}"` });
  }

  // Consume token (one-time use)
  db.prepare('UPDATE tsd_auth_tokens SET used = 1 WHERE token = ?').run(authToken);

  console.log(`[TSD] Token verified and consumed: ${authToken.substring(0, 20)}... action="${tokenRow.action}"`);
  send(res, 200, { valid: true, action: tokenRow.action, installationId: tokenRow.installation_id });
}

// ─────────────────────────────────────────────────────────────────────────────
// Clone-project handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleCloneProject(req, res) {
  const { source_project_id, new_pre_scr_id, new_project_name, installation_id } = await readBody(req);

  if (!source_project_id || !new_pre_scr_id || !new_project_name) {
    return send(res, 400, { error: 'source_project_id, new_pre_scr_id, and new_project_name required' });
  }

  // Pull all witness records for source project
  const sourceWitnesses = db.prepare(`
    SELECT * FROM witnesses WHERE project_id = ?
    ORDER BY run_sequence ASC
  `).all(String(source_project_id));

  // Insert cloned witness copies under new_pre_scr_id
  const insertWitness = db.prepare(`
    INSERT OR IGNORE INTO witnesses
      (witness_id, project_id, project_name, run_sequence, content_hash, visual_hash, client_timestamp, server_timestamp, signature, cloned_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let clonedCount = 0;
  for (const w of sourceWitnesses) {
    const newWitnessId = generateWitnessId();
    insertWitness.run(
      newWitnessId,
      new_pre_scr_id,
      new_project_name,
      w.run_sequence,
      w.content_hash,
      w.visual_hash,
      w.client_timestamp,
      new Date().toISOString(),
      w.signature,
      String(source_project_id)
    );
    clonedCount++;
  }

  // Register new project in Oracle projects table
  try {
    db.prepare(`
      INSERT OR IGNORE INTO projects (pre_scr_id, project_name, installation_id, cloned_from, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(new_pre_scr_id, new_project_name, installation_id || null, String(source_project_id), new Date().toISOString());
  } catch (e) {
    console.log('[CLONE] Project registration warning: ' + e.message);
  }

  console.log(`[CLONE] ${source_project_id} → ${new_pre_scr_id} (${new_project_name}), ${clonedCount} witnesses cloned`);
  send(res, 200, { success: true, clonedCount, newPreScrId: new_pre_scr_id });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe payment handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleStripeConfig(res) {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return send(res, 503, { error: 'Stripe not configured on server' });
  }
  send(res, 200, {
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    actions: STRIPE_FEES,
  });
}

async function handleCreatePaymentIntent(req, res) {
  if (!stripe) {
    return send(res, 503, { error: 'Stripe not configured on server' });
  }

  const { action, installationId, projectId } = await readBody(req);

  if (!action || !installationId || !projectId) {
    return send(res, 400, { error: 'action, installationId, and projectId required' });
  }

  const amountCents = STRIPE_FEES[action];
  if (!amountCents) {
    return send(res, 400, { error: 'Unknown action: ' + action + '. Valid: ' + Object.keys(STRIPE_FEES).join(', ') });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        action,
        installationId: String(installationId),
        projectId: String(projectId),
        scruple_version: '3.0'
      },
      description: 'SCRUPLE Studio — ' + action + ' (Project ' + projectId + ')'
    });

    console.log('[STRIPE] PaymentIntent created: ' + paymentIntent.id + ' action=' + action + ' amount=$' + (amountCents / 100).toFixed(2));

    send(res, 200, {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountCents,
      currency: 'usd',
      action
    });
  } catch (err) {
    console.error('[STRIPE] PaymentIntent creation failed:', err.message);
    send(res, 500, { error: 'Failed to create payment intent: ' + err.message });
  }
}

// Localhost-only check: the remote socket must be loopback. Used to
// gate the dev confirm-pi endpoint. The witness binds 0.0.0.0 but is
// only reachable from the host (firewall keeps :5799 internal); we
// additionally enforce loopback here so the endpoint can't be reached
// even if a future deployment exposes the port.
function isLoopback(req) {
  const ra = req.socket?.remoteAddress ?? '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

async function handleAdminConfirmPi(req, res) {
  if (!isLoopback(req)) {
    return send(res, 404, { error: 'Not found' });
  }
  if (!stripe) {
    return send(res, 500, { error: 'Stripe not configured on witness server' });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: 'Invalid JSON' });
  }
  const paymentIntentId = body?.paymentIntentId;
  const paymentMethod = body?.paymentMethod || 'pm_card_visa';
  if (!paymentIntentId) {
    return send(res, 400, { error: 'paymentIntentId required' });
  }
  try {
    const pi = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
      // Stripe requires return_url whenever automatic_payment_methods may
      // include redirect-based methods (Klarna, iDEAL, …). For cards in
      // test mode the URL is never actually followed; we just need to
      // satisfy the validator. Localhost is fine.
      return_url: 'http://127.0.0.1:3001/api/stripe/return',
    });
    console.log(`[STRIPE] (dev-confirm) ${paymentIntentId} → status=${pi.status}`);
    return send(res, 200, {
      ok: true,
      paymentIntentId: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
    });
  } catch (err) {
    console.error(`[STRIPE] (dev-confirm) failed for ${paymentIntentId}: ${err.message}`);
    return send(res, 502, { error: err.message });
  }
}

async function handleConfirmAndExecute(req, res) {
  if (!stripe) {
    return send(res, 503, { error: 'Stripe not configured on server' });
  }

  const {
    paymentIntentId,
    action,
    projectId,
    lockTier,
    installationId,
    merkleRoot,
    preScrId
  } = await readBody(req);

  if (!paymentIntentId || !action || !projectId) {
    return send(res, 400, { error: 'paymentIntentId, action, and projectId required' });
  }

  // Verify payment with Stripe — must be succeeded
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    return send(res, 400, { error: 'Failed to retrieve payment intent: ' + err.message });
  }

  if (paymentIntent.status !== 'succeeded') {
    console.warn('[STRIPE] Payment not succeeded: ' + paymentIntentId + ' status=' + paymentIntent.status);
    return send(res, 402, { error: 'Payment not completed. Status: ' + paymentIntent.status });
  }

  // Verify metadata matches request (anti-tamper)
  if (paymentIntent.metadata.action !== action) {
    return send(res, 400, { error: 'Payment intent action mismatch' });
  }
  if (paymentIntent.metadata.projectId !== String(projectId)) {
    return send(res, 400, { error: 'Payment intent project mismatch' });
  }

  // Verify correct amount was paid
  const expectedCents = STRIPE_FEES[action];
  if (paymentIntent.amount !== expectedCents) {
    return send(res, 400, { error: 'Payment amount mismatch. Expected $' + (expectedCents / 100).toFixed(2) });
  }

  console.log('[STRIPE] Payment verified: ' + paymentIntentId + ' action=' + action + ' project=' + projectId);

  // Execute the appropriate lock action
  try {
    if (action === 'finalize' || action === 'checkpoint') {
      // Witness lock — countersign the lock event.
      //   finalize  → also persists to locked_projects (the project is sealed)
      //   checkpoint → snapshot only; signature returned so web can store it,
      //                no locked_projects row because the project remains open
      // `action` is included in the signed tuple so a checkpoint signature
      // cannot be replayed as a finalize signature.
      const projectIdStr = String(projectId);
      const rows = db.prepare(
        'SELECT * FROM witnesses WHERE project_id = ? ORDER BY run_sequence ASC'
      ).all(projectIdStr);

      if (rows.length === 0 && action === 'finalize') {
        // Allow finalize with no witnesses (local-only project)
        console.log('[STRIPE] Finalize with no witnesses for project ' + projectIdStr);
      }

      const locked_at = new Date().toISOString();
      const hashes = rows.map(r => r.content_hash);
      const root = rows.length > 0 ? calculateMerkleRoot(hashes) : null;
      const lockData = {
        project_id: projectIdStr,
        action,
        merkle_root: root,
        witnessed_count: rows.length,
        locked_at,
      };
      const server_signature = sign(lockData);

      if (action === 'finalize' && rows.length > 0) {
        db.prepare(`
          INSERT OR REPLACE INTO locked_projects (project_id, merkle_root, witnessed_count, server_signature, locked_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(projectIdStr, root, rows.length, server_signature, locked_at);

        console.log('[STRIPE] Project finalized on Oracle: ' + projectIdStr);
      } else if (action === 'checkpoint') {
        console.log('[STRIPE] Project checkpointed (signed, not finalized): ' + projectIdStr);
      }

      // Record Stripe payment in DB for audit trail
      db.prepare(`
        INSERT OR IGNORE INTO tsd_auth_tokens (token, installation_id, action, amount, used, expires_at, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        'STRIPE_' + paymentIntentId,
        String(installationId || ''),
        action,
        expectedCents,
        locked_at,
        locked_at
      );

      return send(res, 200, {
        success: true,
        action,
        projectId,
        paymentIntentId,
        lockedAt: locked_at,
        merkleRoot: root,
        witnessedCount: rows.length,
        serverSignature: server_signature,
        note: action + ' authorized and recorded by Oracle'
      });
    }

    if (action === 'chain-lock-basic' || action === 'chain-lock-pinned') {
      const tier = action === 'chain-lock-pinned' ? 'pinned' : 'basic';
      // SCR-ID derives from the canonical Merkle root ALONE — identical to
      // handleLock — so the custodial (Stripe) and non-custodial (wallet)
      // paths mint the same verifiable anchor for the same content, and a
      // third party can reproduce the SCR-ID from provenance data without
      // the paymentIntentId. Falls back to projectId only if no root passed.
      const rootSource = merkleRoot || preScrId || String(projectId);
      const scrSuffix = crypto.createHash('sha256').update(rootSource).digest('hex').substring(0, 8).toUpperCase();
      const scrId = 'SCR_' + scrSuffix;
      const locked_at = new Date().toISOString();

      // Real RVN testnet mint (same executor as handleLock). Mint failure
      // does NOT fail the lock — payment is already captured, so we record
      // the lock + surface mintError for a later retry.
      let proofTxId = null;
      let mintError = null;
      try {
        const mint = await issueAsset(scrId, null);
        proofTxId = mint.txid;
        console.log('[STRIPE] ' + scrId + ' minted on testnet → ' + proofTxId);
      } catch (e) {
        mintError = e && e.message ? e.message : String(e);
        console.error('[STRIPE] mint failed for ' + scrId + ': ' + mintError);
      }

      const server_signature = sign({ projectId, scrId, tier, paymentIntentId, proofTxId, locked_at });

      // Record lock in Oracle
      try {
        db.prepare(`
          INSERT OR REPLACE INTO locked_projects (project_id, merkle_root, witnessed_count, server_signature, locked_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          String(projectId),
          merkleRoot || 'stripe-payment-' + paymentIntentId,
          0,
          server_signature,
          locked_at
        );
      } catch (e) {
        console.log('[STRIPE] DB lock record warning: ' + e.message);
      }

      // Permanence: Arweave token record (basic + pinned) + IPFS pin (pinned).
      const anchor = await anchorPermanence({
        tier,
        scrId,
        preScrId: preScrId || null,
        merkleRoot: merkleRoot || null,
        rvnTxId: proofTxId,
        witnessSignature: server_signature,
        witnessedCount: 0,
        lockedAt: locked_at,
        installationId,
        projectName: null,
      });

      console.log('[STRIPE] Chain lock ' + tier + ' for project ' + projectId + ' → ' + scrId);

      return send(res, 200, {
        success: true,
        scrId,
        proofTxId,
        proofChain: proofTxId ? 'rvn-testnet' : null,
        mintError,
        merkleRoot: merkleRoot || null,
        ipfsCid: anchor.ipfsCid,
        ipfsError: anchor.ipfsError,
        arweaveTxId: anchor.arweaveTxId,
        arweaveError: anchor.arweaveError,
        lockTier: tier,
        paymentIntentId,
        note: proofTxId
          ? ('Payment verified. RVN asset ' + scrId + ' minted'
             + (anchor.ipfsCid ? ', IPFS ' + anchor.ipfsCid : '')
             + (anchor.arweaveTxId ? ', Arweave ' + anchor.arweaveTxId : '') + '.')
          : ('Payment verified. RVN mint failed (' + mintError + ') — lock recorded, retry available.')
      });
    }

    return send(res, 400, { error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[STRIPE] Execution failed after payment:', err.message);
    // Payment succeeded but execution failed — log for manual review
    console.error('[STRIPE] MANUAL REVIEW NEEDED: paymentIntentId=' + paymentIntentId + ' project=' + projectId);
    send(res, 500, { error: 'Payment succeeded but execution failed: ' + err.message + '. Contact support with ID: ' + paymentIntentId });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fiat chain lock handler (Beta: TSD-verified mock response)
// ─────────────────────────────────────────────────────────────────────────────

async function handleFiatChainLock(req, res) {
  const body = await readBody(req);
  const { project_id, project_name, pre_scr_id, merkle_root, lock_tier, auth_token, installation_id } = body;

  if (!project_id || !auth_token) {
    return send(res, 400, { error: 'project_id and auth_token required' });
  }

  // Verify TSD auth token — must be action 'chain-lock', unconsumed, unexpired
  const tokenRow = db.prepare('SELECT * FROM tsd_auth_tokens WHERE token = ?').get(auth_token);
  if (!tokenRow) {
    return send(res, 200, { success: false, error: 'Auth token not found' });
  }
  if (tokenRow.used) {
    return send(res, 200, { success: false, error: 'Auth token already used' });
  }
  if (new Date() > new Date(tokenRow.expires_at)) {
    return send(res, 200, { success: false, error: 'Auth token expired' });
  }
  if (tokenRow.action !== 'chain-lock') {
    return send(res, 200, { success: false, error: `Token action mismatch: expected "chain-lock", got "${tokenRow.action}"` });
  }

  // Consume the token
  db.prepare('UPDATE tsd_auth_tokens SET used = 1 WHERE token = ?').run(auth_token);

  // Generate a deterministic SCR ID from merkle root (or pre_scr_id fallback)
  const rootSource = merkle_root || pre_scr_id || project_id;
  const scrSuffix = require('crypto').createHash('sha256').update(rootSource).digest('hex').substring(0, 8).toUpperCase();
  const scrId = 'SCR_' + scrSuffix;

  // Record the lock in Oracle DB so verify endpoint reflects it
  try {
    db.prepare(`
      INSERT OR REPLACE INTO locked_projects (project_id, merkle_root, witnessed_count, server_signature, locked_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(project_id),
      merkle_root || 'pending',
      0,
      sign({ project_id, scrId, lock_tier, locked_at: new Date().toISOString() }),
      new Date().toISOString()
    );
  } catch (e) {
    console.log('[FIAT-LOCK] DB lock record warning: ' + e.message);
  }

  const tier = lock_tier || 'basic';
  console.log(`[FIAT-LOCK] ${tier} chain lock for ${project_name || project_id} → ${scrId} (installation: ${installation_id})`);

  // Real RVN testnet asset issuance via testnet-locker.
  // IPFS + Arweave still stubbed; will fold in next.
  let proofTxId = null;
  let mintError = null;
  try {
    const mint = await issueAsset(scrId, null);
    proofTxId = mint.txid;
    console.log(`[FIAT-LOCK] ${scrId} minted on testnet → ${proofTxId}`);
  } catch (e) {
    mintError = e && e.message ? e.message : String(e);
    console.error(`[FIAT-LOCK] mint failed for ${scrId}: ${mintError}`);
  }

  send(res, 200, {
    success:      true,
    scrId:        scrId,
    proofTxId:    proofTxId,
    proofChain:   'rvn-testnet',
    mintError:    mintError,
    merkleRoot:   merkle_root || null,
    ipfsCid:      null,           // pending — IPFS pinning to be wired
    ipfsError:    tier === 'pinned' ? 'IPFS pinning not yet implemented on Oracle' : null,
    arweaveTxId:  null,           // pending — Arweave anchoring to be wired
    arweaveError: 'Arweave anchoring not yet implemented on Oracle',
    lockTier:     tier,
    beta:         true,
    note:         proofTxId
      ? 'RVN testnet asset minted; IPFS+Arweave still stubbed.'
      : 'Mint failed — see mintError. IPFS+Arweave still stubbed.'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SCRUPLE WITNESS] Server running on port ${PORT}`);
  console.log(`[SCRUPLE WITNESS] DB: ${DB_PATH}`);
  console.log(`[SCRUPLE WITNESS] TSD auto-fund: ${BETA_AUTO_FUND} on first balance check`);
});

server.on('error', (err) => {
  console.error('[SERVER] Fatal:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM — closing');
  server.close(() => { db.close(); process.exit(0); });
});

process.on('SIGINT', () => {
  server.close(() => { db.close(); process.exit(0); });
});
