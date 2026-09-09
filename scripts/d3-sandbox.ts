// The sandbox a WO's gate runs against, provisioned by side effect.
//
// Three things have to exist on the scratch app before a capture surface can
// put a leaf anywhere, and none of them is something the surface may create
// for itself:
//
//   1. an API key carrying `witness:write` and `baseline:write`. The second
//      GRANTS `component:provision` (lib/v2/auth.ts V2_SCOPE_GRANTS), which is
//      the scope /api/v2/components/provision requires — the one route in the
//      estate that returns key material.
//   2. a BASELINE, whose ref is the tamper_surface_hash of the code being
//      measured. D-3: a leaf with no baseline_ref is not a weaker leaf, it is
//      not Scruple-witnessed at all. We compute it over the SURFACE — app/vault/
//      or app/comfy/, whichever is actually doing the measuring — not over the
//      whole repo, and not over a constant.
//   3. a one-time PROVISIONING TOKEN, minted through the estate's own
//      `issueProvisioningToken()` rather than by an INSERT here, because a
//      script that writes its own row is testing its own INSERT.
//
// Idempotent by re-running: keys and baselines are reused when the state file
// still matches the measured surface; a provisioning token is minted fresh
// every time, because it is single-use and short-TTL by design and a component
// that already sealed an identity never asks for one.
//
//   bash scripts/tsx.sh scripts/d3-sandbox.ts [--surface app/comfy] [--print-key]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { conn } from '@/lib/db/sqlite';
import { issueProvisioningToken } from '@/lib/ratchet/provisioning';

const REPO = path.resolve(__dirname, '..');
const APP = process.env.SCRUPLE_APP_URL ?? 'http://127.0.0.1:3902';

// WO-D4 made this take a SURFACE. There are two now — `app/vault` and
// `app/comfy` — and they must not share a baseline: the baseline_ref IS the
// tamper surface hash of the code doing the measuring, so one ref covering two
// surfaces would mean a change in either produced a drift attributed to both.
// One state file per surface, keyed by the surface's own path.
function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
const SURFACE_REL = argValue('--surface') ?? 'app/vault';
const SURFACE_SLUG = SURFACE_REL.replace(/[^a-zA-Z0-9]+/g, '-');
const STATE = path.join(REPO, '.run', 'sandbox', `${SURFACE_SLUG}.json`);

if (APP.includes(':5799') || APP.includes(':3001')) {
  throw new Error(`refusing to provision against ${APP} — that is production`);
}

export interface Sandbox {
  appUrl: string;
  userId: string;
  apiKey: string;
  keyId: string;
  /** The tamper_surface_hash the baseline was established over. */
  baselineRef: string;
  /** Which files went into it, so a drift is explainable rather than mysterious. */
  measuredFiles: string[];
}

/**
 * The tamper surface: every source file of the vault surface, hashed
 * individually with its path, in byte order.
 *
 * The same construction as `services/scruple-capture/src/build-measurement.ts`
 * and for the same reason — a byte moving across a file boundary must change
 * the value. It is deliberately NOT a call into that function: that one
 * measures the ComfyUI component's source, and measuring their code and
 * calling it our baseline would be a lie that happens to typecheck.
 */
export function tamperSurfaceHash(root: string): { hash: string; files: string[] } {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(ts|js|mjs|cjs|json)$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), 'utf8');
    h.update('\n');
  }
  return { hash: h.digest('hex'), files: files.map((f) => path.relative(REPO, f)) };
}

function mintKey(userId: string): { apiKey: string; keyId: string } {
  const apiKey = 'sk_d3_' + crypto.randomBytes(24).toString('base64url');
  const keyId = crypto.randomUUID();
  const db = conn();
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(userId, `${userId}@example.com`);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    keyId,
    userId,
    crypto.createHash('sha256').update(apiKey).digest('hex'),
    apiKey.slice(0, 12),
    // baseline:write grants component:provision. Both are needed and only one
    // is stored, which is exactly the deprecation V2_SCOPE_GRANTS documents.
    JSON.stringify(['witness:write', 'baseline:write', 'read']),
    `${SURFACE_REL} surface`,
  );
  return { apiKey, keyId };
}

async function establishBaseline(apiKey: string, tsh: string): Promise<string> {
  const res = await fetch(`${APP}/api/v2/baseline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      host: 'comfyui',
      integration_version: `scruple-desktop-studio/${SURFACE_SLUG}@3.1.0-dev`,
      tamper_surface_hash: tsh,
    }),
  });
  // v2Ok wraps some routes in `data` and returns others bare; read both rather
  // than assuming, because assuming produced a "baseline refused (201)".
  const text = await res.text();
  let body: { data?: { baseline_ref?: string }; baseline_ref?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`baseline response was not JSON (${res.status}): ${JSON.stringify(text.slice(0, 400))}`);
  }
  const ref = body.data?.baseline_ref ?? body.baseline_ref;
  if (!res.ok || !ref) {
    throw new Error(`baseline refused (${res.status}): ${text.slice(0, 400)}`);
  }
  return ref;
}

export function readSandbox(): Sandbox {
  if (!fs.existsSync(STATE)) {
    throw new Error(`no sandbox state at ${STATE}; run: bash scripts/tsx.sh scripts/d3-sandbox.ts --surface ${SURFACE_REL}`);
  }
  return JSON.parse(fs.readFileSync(STATE, 'utf8')) as Sandbox;
}

/** Mint a fresh single-use token for a component about to provision. */
export function mintProvisioningToken(userId: string, label: string): string {
  return issueProvisioningToken({ tenantId: userId, label }).token;
}

async function main(): Promise<void> {
  const surface = tamperSurfaceHash(path.join(REPO, SURFACE_REL));
  fs.mkdirSync(path.dirname(STATE), { recursive: true });

  let sb: Sandbox | null = null;
  if (fs.existsSync(STATE)) {
    const prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) as Sandbox;
    if (prev.baselineRef === surface.hash && prev.appUrl === APP) sb = prev;
    else
      console.log(
        `[d3-sandbox] tamper surface moved (${prev.baselineRef.slice(0, 12)} \u2192 ` +
          `${surface.hash.slice(0, 12)}); re-baselining`,
      );
  }

  if (!sb) {
    // ⚑ `baselines.baseline_hash` IS GLOBALLY UNIQUE, not unique per tenant.
    // Two tenants cannot establish a baseline over the same tamper surface,
    // and the second gets a 500 with an empty body — which is how this was
    // found. So an existing baseline for this exact surface is ADOPTED, and
    // its tenant is the tenant we mint a key for. Re-running this script after
    // losing the state file must not strand the surface with no baseline it
    // is allowed to claim.
    const owner = conn()
      .prepare(`SELECT tenant_id FROM baselines WHERE baseline_hash = ?`)
      .get(surface.hash) as { tenant_id: string } | undefined;

    if (owner) {
      const { apiKey, keyId } = mintKey(owner.tenant_id);
      console.log(`[d3-sandbox] adopting existing baseline for tenant ${owner.tenant_id}`);
      sb = {
        appUrl: APP, userId: owner.tenant_id, apiKey, keyId,
        baselineRef: surface.hash, measuredFiles: surface.files,
      };
    } else {
      const userId = `${SURFACE_SLUG}-` + crypto.randomBytes(3).toString('hex');
      const { apiKey, keyId } = mintKey(userId);
      const baselineRef = await establishBaseline(apiKey, surface.hash);
      sb = { appUrl: APP, userId, apiKey, keyId, baselineRef, measuredFiles: surface.files };
    }
    fs.writeFileSync(STATE, JSON.stringify(sb, null, 2), { mode: 0o600 });
  }

  if (process.argv.includes('--print-key')) {
    process.stdout.write(sb.apiKey + '\n');
    return;
  }
  if (process.argv.includes('--mint-token')) {
    // Single-use and short-TTL by design, so it is minted per run and never
    // cached. A component that already sealed an identity ignores it.
    process.stdout.write(mintProvisioningToken(sb.userId, `${SURFACE_REL} run`) + '\n');
    return;
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(sb) + '\n');
    return;
  }
  console.log(`[d3-sandbox] app          ${sb.appUrl}`);
  console.log(`[d3-sandbox] tenant       ${sb.userId}`);
  console.log(`[d3-sandbox] baseline_ref ${sb.baselineRef}`);
  console.log(`[d3-sandbox] measured     ${sb.measuredFiles.length} files under ${SURFACE_REL}/`);
  console.log(`[d3-sandbox] state        ${STATE}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[d3-sandbox] FAILED: ${String(e)}`);
    process.exit(1);
  });
}
