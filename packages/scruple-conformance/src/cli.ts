// scruple-conformance — the CLI a vendor runs INSIDE their tenant container.
//
//   npx scruple-conformance run    --config /etc/scruple/conformance.json --out ./submission
//   npx scruple-conformance verify --dir ./submission
//
// WHERE IT IS RUN IS THE WHOLE CLAIM. H-4 §7: "Run from inside the tenant
// container, where the adversary sits." Run this from CI, or from the vendor's
// laptop, or from the sidecar, and the four topology probes answer a question
// about the wrong position. `--simulate` exists for dry runs and stamps every
// result INADMISSIBLE, which is exactly what a Sonobuoy run that skipped tests
// is worth.
//
// Concretely, for a container deployment:
//
//   docker exec -it <workload-container> npx scruple-conformance run --config ...
//   kubectl exec -it <workload-pod> -- npx scruple-conformance run --config ...
//
// The config names the deployment (types.ts DeploymentUnderTest) plus the
// INTEGRATION.yaml metadata and a signing key. Nothing is discovered: a probe
// that had to find the upstream would be testing our port scanner, and a
// deployment that survived a failed scan would pass on our incompetence.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildBundle, signBundle, verifyBundle, writeBundle, type IntegrationMetadata } from './bundle';
import { grade, type GradeInput } from './grade';
import { httpLeafOracle } from './oracle';
import { renderProbeLog, runProbes } from './runner';
import type { DeploymentUnderTest, Probe, ProbeRun } from './types';
import { OsVantage, SimulatedVantage, type SimulatedPolicy } from './vantage';

export interface CliConfig {
  integration: IntegrationMetadata;
  deployment: DeploymentUnderTest;
  /** Bearer key for the leaf oracle — scruple-web, not the component. */
  oracleApiKey: string;
  reproduction: string;
  /** PEM ed25519 private key, or a path to one. */
  signingKeyPem?: string;
  signingKeyPath?: string;
  /** Dry-run only. Stamps the whole run inadmissible. */
  simulate?: SimulatedPolicy;
}

export interface RunOptions {
  probes: readonly Probe[];
  config: CliConfig;
  /** Graded paths. Optional: a probe-only run is legitimate and says so. */
  gradeInputs?: readonly GradeInput[];
  outDir: string;
}

export async function runConformance(opts: RunOptions): Promise<{ run: ProbeRun; outDir: string }> {
  const cfg = opts.config;
  const vantage = cfg.simulate ? new SimulatedVantage(cfg.simulate) : new OsVantage();

  const run = await runProbes(opts.probes, {
    vantage,
    deployment: cfg.deployment,
    leaves: httpLeafOracle({
      apiBaseUrl: cfg.deployment.apiBaseUrl,
      apiKey: cfg.oracleApiKey,
      componentId: cfg.deployment.componentId,
    }),
    log: (l) => process.stderr.write(`${l}\n`),
  });

  process.stderr.write(renderProbeLog(run));

  const g = grade(
    cfg.integration.version,
    (opts.gradeInputs ?? []).map((gi) => ({ ...gi, probes: run })),
  );

  let bundle = buildBundle({
    integration: { ...cfg.integration, probe_vantage: vantage.kind },
    run,
    grade: g,
    reproduction: cfg.reproduction,
  });

  const pem = cfg.signingKeyPem ?? (cfg.signingKeyPath ? fs.readFileSync(cfg.signingKeyPath, 'utf8') : null);
  if (pem) bundle = signBundle(bundle, crypto.createPrivateKey(pem));

  writeBundle(opts.outDir, bundle);
  return { run, outDir: opts.outDir };
}

/** The bot's half of the review, runnable by anyone against a submission dir. */
export function verifyDir(dir: string): { ok: boolean; report: string } {
  const manifestPath = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, report: `no MANIFEST.json in ${dir}` };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ReturnType<
    typeof buildBundle
  >['manifest'];
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'MANIFEST.json') continue;
    files[entry] = fs.readFileSync(path.join(dir, entry), 'utf8');
  }
  const result = verifyBundle({ files, manifest });
  const lines = [
    `submission: ${dir}`,
    `run: ${manifest.run_id}`,
    `probes: ${manifest.probes_passed} passed, ${manifest.probes_failed} failed, ${manifest.probes_inconclusive} inconclusive`,
    `admissible: ${manifest.admissible}`,
    `non-compliant paths: ${manifest.noncompliant_paths.join(', ') || '(none)'}`,
    ...result.failures.map((f) => `FAIL [${f.reason}] ${f.detail}`),
    result.ok ? 'MECHANICAL CHECKS PASSED' : 'MECHANICAL CHECKS FAILED',
    '',
    'The human half is deliberately not here: whether this vendor is a real',
    'counterparty and whether a signed Integration Agreement is on file are the',
    'questions no bot can answer, and cncf/k8s-conformance keeps them out of Prow',
    'for the same reason.',
  ];
  return { ok: result.ok && manifest.admissible, report: lines.join('\n') };
}
