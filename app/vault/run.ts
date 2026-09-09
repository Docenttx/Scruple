#!/usr/bin/env node
// The vault sidecar. Electron main spawns this; it is not a library the
// renderer can reach.
//
// WHY A SEPARATE PROCESS AND NOT A require() IN THE MAIN PROCESS
// ------------------------------------------------------------------
// docs/DESIGN.md already puts the capture gate here — "runs: the capture gate
// (sidecar)" — and the same three reasons apply to the vault:
//
//   1. The SDK is the server repo's TypeScript, run under its own tsx and its
//      own tsconfig. Electron's main process is a different runtime with a
//      different module resolver, and teaching it to load the SDK would mean
//      a build step in this repo — which is the version-skew discipline
//      docs/DESIGN.md refused when it said "Not bundled".
//   2. The IK is here. A sealed key in the process that also runs a
//      BrowserWindow is one preload bug away from the renderer.
//   3. It fails loudly and separately. A vault that could not provision exits
//      non-zero and Electron reports that, rather than taking the window down.
//
// WHAT IT DOES, IN ORDER
// ------------------------------------------------------------------
//   Identity   §4.4 — restore the sealed identity or redeem a one-time token.
//   Submitter  the SDK's ObservationSink. It owns MAC, ratchet, queue, drain.
//   VaultSurface.open/observe/close — the snapshot, emitting one observation
//              per ACCEPTED file.
//   the manifest — built from the surface's report, written to the store, and
//              then witnessed ITSELF, which is what carries every refusal onto
//              the record rather than into a log line.
//
// The result file is a CLAIM, exactly as app/scenario.js's is. Every assertion
// about it is made by scripts/desktop-run.mjs, in another process, against the
// bytes on disk and the rows in the witness.

import fs from 'node:fs';
import path from 'node:path';

import {
  assuranceForHost,
  buildMeasurement,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
  Identity,
  measureStorageConfinement,
  profileFor,
  QueueStore,
  Submitter,
  type HostCaptureProfile,
} from './sdk';
import { buildManifest } from './manifest';
import { VaultSurface } from './vaultSurface';

export interface VaultRequest {
  vaultDir: string;
  vaultId: string;
  ceilingBytes?: number;
  /** Where the sealed identity and the queue live. 0700. */
  stateDir: string;
  /** Where the manifest is written, content-addressed. NEVER inside the vault:
   *  the legacy vault wrote provenance.json into the directory it was
   *  measuring, so the act of recording the vault changed the vault. */
  storeDir: string;
  appUrl: string;
  apiKey: string;
  baselineRef: string;
  /** Single-use. Ignored when a sealed identity already exists. */
  provisioningToken: string | null;
  resultPath: string;
}

export interface VaultResult {
  ok: boolean;
  vaultId: string;
  vaultDir: string;
  startedAt: string;
  finishedAt?: string;
  sidecarPid: number;
  /** The assurance this configuration actually earned, from its placement and
   *  its enforcement — not from what it calls itself. */
  assurance: { placement: string; effective: string; profile: string; canClaim: boolean; reason: string } | null;
  componentId: string | null;
  buildMeasurement: string | null;
  manifest: { path: string; digest: string; bytes: number } | null;
  counts: Record<string, number> | null;
  /** One row per file, mirroring the manifest, so the driver can assert on an
   *  outcome without parsing the manifest twice. */
  entries: Array<{ path: string; outcome: string; contentHash: string | null; bytesCounted: number | null }>;
  /** What the Submitter MACed, in counter order. The durable record is the
   *  queue and the server; this is for the driver to correlate against. */
  emitted: Array<{ counter: number; contentHash: string; mimeDeclared: boolean }>;
  queueDepth: number | null;
  error: string | null;
}

const log = (l: string) => console.log(`[vault-run] ${l}`);

export async function runVault(req: VaultRequest): Promise<VaultResult> {
  const result: VaultResult = {
    ok: false,
    vaultId: req.vaultId,
    vaultDir: req.vaultDir,
    startedAt: new Date().toISOString(),
    sidecarPid: process.pid,
    assurance: null,
    componentId: null,
    buildMeasurement: null,
    manifest: null,
    counts: null,
    entries: [],
    emitted: [],
    queueDepth: null,
    error: null,
  };

  const write = () => {
    result.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(req.resultPath), { recursive: true });
    fs.writeFileSync(req.resultPath, JSON.stringify(result, null, 2));
  };

  if (req.appUrl.includes(':5799') || req.appUrl.includes(':3001')) {
    result.error = `refusing to submit to ${req.appUrl} — that is production`;
    write();
    return result;
  }

  fs.mkdirSync(req.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(req.storeDir, { recursive: true });

  // The declared posture, and what it actually earns. `unattested-client` with
  // `none` resolves to itself, which is the honest answer for a directory on
  // the user's own machine measured by code the user can edit.
  const hostProfile: HostCaptureProfile = {
    host: 'comfyui',
    hooks: ['artifact.produced', 'document.save'],
    surfaces: ['filesystem-watch'],
    fidelity: 'as-written',
    declaredPlacement: 'unattested-client',
    enforcement: 'none',
    attestation: 'none',
  };
  const assurance = assuranceForHost(hostProfile);
  const profile = profileFor(assurance.resolution.effective);
  result.assurance = {
    placement: hostProfile.declaredPlacement,
    effective: assurance.resolution.effective,
    profile,
    canClaim: assurance.canClaim,
    reason: assurance.reason,
  };
  log(`assurance: ${assurance.reason}`);

  // The build measurement is over THIS surface's source — app/vault/ — and not
  // over services/scruple-capture/src, which is what buildMeasurement()
  // defaults to. Measuring somebody else's code and calling it ours would
  // typecheck and would be a lie.
  const measurement = buildMeasurement(__dirname);

  let identity: Identity;
  try {
    identity = await Identity.open({
      stateDir: req.stateDir,
      apiBaseUrl: req.appUrl,
      apiKey: req.apiKey,
      provisioningToken: req.provisioningToken,
      // Identity.open reads exactly these four. The cast is narrow and
      // deliberate: constructing a whole CaptureConfig would mean inventing an
      // upstream URL and a listen port for a component that proxies nothing.
    } as unknown as Parameters<typeof Identity.open>[0]);
  } catch (e) {
    result.error = `provisioning failed: ${String(e)}`;
    write();
    return result;
  }
  result.componentId = identity.componentId;
  result.buildMeasurement = identity.buildMeasurement;

  const queue = new QueueStore(path.join(req.stateDir, 'queue.jsonl'));
  const submitter = new Submitter({
    identity,
    queue,
    apiBaseUrl: req.appUrl,
    apiKey: req.apiKey,
    baselineRef: req.baselineRef,
    profile,
    enforcement: assurance.resolution.enforcement,
    // No authority is enrolled for this desktop. null, never a plausible
    // string — an authority nobody enrolled is the cooperating liar the field
    // exists to exclude.
    witnessAuthority: null,
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    // Re-measured per emission. On a desktop the vault and the state directory
    // are normally the same device, which is a genuinely degraded confinement
    // and is recorded as one rather than tidied away.
    confinementFor: () =>
      measureStorageConfinement({
        stateDir: req.stateDir,
        volumes: [req.vaultDir],
        minReservableBytes: 64 * 1024 * 1024,
      }),
    // No upstreamFor: a vault has no upstream process to interrogate. The leaf
    // then says `not_queried`, which stays distinguishable from an enumeration
    // that failed.
    log,
  });

  const surface = new VaultSurface({
    vaultDir: req.vaultDir,
    vaultId: req.vaultId,
    ...(req.ceilingBytes ? { ceilingBytes: req.ceilingBytes } : {}),
    log,
  });

  try {
    await surface.open({ sink: submitter, placement: assurance.placement, config: { vaultDir: req.vaultDir } });
    await surface.observe();
    const report = surface.report!;

    // ── THE UNIT. Built from the report, written outside the vault, and
    //    witnessed, so every refusal above is on the record and not in a log.
    const built = buildManifest(report);
    const manifestPath = path.join(req.storeDir, `${built.digest}.vault-manifest.json`);
    fs.writeFileSync(manifestPath, built.bytes);

    await submitter.emit({
      hook: 'document.save',
      surface: 'filesystem-watch',
      correlationId: req.vaultId,
      bytes: {
        fidelity: 'as-written',
        contentHash: built.digest,
        sizeBytes: built.bytes.length,
        // Declared by us, because we wrote this file and we know what it is.
        // That is what "declared" means; it is not a guess about somebody
        // else's bytes.
        mime: 'application/json',
      },
      evidence: {
        kind: 'document_save',
        egress: `vault:manifest:${path.basename(manifestPath)}`,
        mime_source: 'vault-manifest-writer',
        correlation_method: 'vault-snapshot',
        vault_id: req.vaultId,
        vault_path: report.vaultDir,
        // Enters workflow_hash, so the summary is bound to the leaf beyond the
        // manifest's own content hash. Integers and strings only — a float in
        // a preimage is a MAC that fails unreproducibly (§10 C-1).
        graph: {
          vault_manifest: built.manifest.manifest_version,
          canonicalization_profile: built.manifest.canonicalization_profile,
          vault_id: req.vaultId,
          ceiling_bytes: report.ceilingBytes,
          declared_by: report.declaredBy,
          counts: built.manifest.counts,
          declaration_content_hash: built.manifest.declaration.content_hash,
        },
      },
      observedAt: new Date().toISOString(),
    });

    result.manifest = { path: manifestPath, digest: built.digest, bytes: built.bytes.length };
    result.counts = built.manifest.counts;
    result.entries = report.entries.map((e) => ({
      path: e.path,
      outcome: e.outcome,
      contentHash: e.contentHash.value,
      bytesCounted: e.bytesCounted.value,
    }));

    await surface.close();
    // One more drain, so a witness that came back between the first emission
    // and now still gets everything before this process exits.
    await submitter.drain().catch(() => undefined);
    result.emitted = submitter.emitted.map((e) => ({
      counter: e.counter, contentHash: e.contentHash, mimeDeclared: e.mimeDeclared,
    }));
    result.queueDepth = queue.loadAll().length;
    result.ok = result.error === null;
  } catch (e) {
    result.error = String((e as Error).stack ?? e);
  } finally {
    identity.destroy();
  }

  write();
  return result;
}

async function main(): Promise<void> {
  const reqPath = process.argv[2];
  if (!reqPath) {
    console.error('usage: run.ts <request.json>');
    process.exit(2);
  }
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as VaultRequest;
  const r = await runVault(req);
  if (!r.ok) {
    console.error(`[vault-run] FAILED: ${r.error}`);
    process.exit(1);
  }
  log(`ok — manifest ${r.manifest?.digest} · ${JSON.stringify(r.counts)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[vault-run] FATAL: ${String((e as Error).stack ?? e)}`);
    process.exit(1);
  });
}
