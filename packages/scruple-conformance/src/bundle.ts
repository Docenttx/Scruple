// The submission bundle. cncf/k8s-conformance's four files, adapted.
//
// WHAT THE K8S SUBMISSION IS (docs/canon/oss-study/sonobuoy-conformance.md
// §1.1): a single-commit PR under `vX.Y/$vendor/` containing exactly
//
//     PRODUCT.yaml     vendor metadata
//     README.md        reproduction steps, NO LINKS ALLOWED
//     e2e.log          the raw run log
//     junit_01.xml     the machine-readable results
//
// and the bot checks are mechanical: all required files present, all required
// tests present, all tests pass, one commit, no stray files.
//
// WHAT WE CHANGE, AND WHY EACH CHANGE EARNS ITSELF:
//
//   PRODUCT.yaml → INTEGRATION.yaml. Same required fields, plus the four
//     Scruple facts no K8s vendor has: standard version, declared placement,
//     enforcement mechanism, attestation provider. Those four are the input to
//     `assuranceForHost`, so the metadata file and the grade cannot disagree.
//
//   junit_01.xml → probes.json. JUnit's schema has no room for "the attack
//     succeeded" as distinct from "the test errored", and that distinction is
//     the entire semantics of this suite.
//
//   e2e.log → probes.log. Same job, same closing summary line.
//
//   + GRADE.md. The file K8s has no analogue for, and the one
//     STUDIO_P1-P8_GRADE.md argues hardest for: "the grade is a document the
//     vendor produces, and producing an unflattering one is normal." The K8s
//     loop can omit it because every K8s conformance claim is functional. Ours
//     cannot, because P1 and P3 are not (§5.2).
//
//   + MANIFEST.json, SIGNED. K8s does not sign, and does not need to: its
//     trust anchor is a GitHub PR from an identified CNCF member, and the
//     evidence is reproducible by anyone. Ours is a report about a boundary
//     nobody outside the vendor can see, so the least it can do is be
//     attributable — the signature says WHO produced this run, and binds the
//     five files together so one cannot be swapped after review.
//
// THE SIGNATURE IS NOT A SECURITY CLAIM ABOUT THE DEPLOYMENT. It is
// attribution plus integrity, which is exactly what §5.3 says the industry
// does for the parts it cannot verify: convert them into a signed
// representation with consequence, and make false claims discoverable rather
// than impossible.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalBytes, canonicalJson, type CanonicalValue } from './canonical';
import type { Grade } from './grade';
import { renderGradeMarkdown, renderGradeTable } from './render';
import { renderProbeLog } from './runner';
import type { ProbeRun } from './types';

export interface IntegrationMetadata {
  /** The eight PRODUCT.yaml fields, unchanged in name so the two are legible together. */
  vendor: string;
  name: string;
  version: string;
  website_url: string;
  documentation_url: string;
  contact_email_address: string;
  type: 'hosted platform' | 'distribution' | 'installer';
  description: string;
  /** The four Scruple additions. Inputs to assuranceForHost, not decoration. */
  standard_version: string;
  declared_placement: string;
  enforcement: string;
  attestation_provider: string;
  /** What the tenant's position actually was during the run. */
  probe_vantage: string;
}

export interface BundleInput {
  integration: IntegrationMetadata;
  run: ProbeRun;
  grade: Grade;
  /** Reproduction steps. NO LINKS — the K8s FAQ bans them because link rot
   *  defeats reproducibility, and that lesson is free to copy. */
  reproduction: string;
}

export interface SignedBundle {
  /** filename → contents. Written verbatim. */
  files: Record<string, string>;
  manifest: BundleManifest;
}

export interface BundleManifest extends Record<string, CanonicalValue> {
  schema: string;
  run_id: string;
  produced_at: string;
  standard_version: string;
  vendor: string;
  product: string;
  /** Every file, hashed. Sorted by name so the canonical form is stable. */
  files: Array<{ name: string; sha256: string; size_bytes: number }>;
  probes_passed: number;
  probes_failed: number;
  probes_inconclusive: number;
  /** False when any probe was inconclusive or failed. The bot checks this. */
  admissible: boolean;
  /** The grade's own bottom line, so a reader need not open GRADE.md to see it. */
  compliant_paths: string[];
  noncompliant_paths: string[];
  /** The commit the grade's evidence came from. */
  source_ref: string;
  /**
   * WHICH P2 RULE THIS GRADE WAS ISSUED UNDER.
   *
   * Beside `source_ref` for the same reason it is: a grade of a moving tree is
   * a grade of nothing, and a grade under an unnamed rule is an opinion about
   * a moving standard. A reviewer holding two submissions six months apart has
   * to be able to see that they were graded by different rules before they
   * compare the tables.
   */
  grade_profile: string;
  /** Lifecycle state per graded path. `sealed` is the only one that claims. */
  lifecycle: Array<{ path: string; state: string }>;
  signature: {
    alg: 'ed25519';
    /** SPKI, base64. The verifier needs no key distribution to check integrity;
     *  it needs the registry only to check WHO. */
    public_key: string;
    /** Over canonicalJson(manifest-without-signature). */
    sig: string;
  } | null;
}

const BUNDLE_SCHEMA = 'scruple.dev/conformance/bundle/v1';

/** The five files a submission must contain. The bot's requirement #2. */
export const REQUIRED_FILES = [
  'INTEGRATION.yaml',
  'README.md',
  'probes.log',
  'probes.json',
  'GRADE.md',
] as const;

export function buildBundle(input: BundleInput): SignedBundle {
  const files: Record<string, string> = {
    'INTEGRATION.yaml': renderIntegrationYaml(input.integration),
    'README.md': renderReadme(input),
    'probes.log': renderProbeLog(input.run),
    'probes.json': JSON.stringify(input.run, null, 2) + '\n',
    'GRADE.md': renderGradeMarkdown(input.grade),
  };

  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    run_id: input.run.runId,
    produced_at: input.run.finishedAt,
    standard_version: input.integration.standard_version,
    vendor: input.integration.vendor,
    product: input.integration.name,
    files: Object.keys(files)
      .sort()
      .map((name) => ({
        name,
        sha256: crypto.createHash('sha256').update(files[name], 'utf8').digest('hex'),
        size_bytes: Buffer.byteLength(files[name], 'utf8'),
      })),
    probes_passed: input.run.summary.passed,
    probes_failed: input.run.summary.failed,
    probes_inconclusive: input.run.summary.inconclusive,
    admissible: input.run.admissible,
    compliant_paths: input.grade.paths.filter((p) => p.compliant).map((p) => p.path),
    noncompliant_paths: input.grade.paths.filter((p) => !p.compliant).map((p) => p.path),
    source_ref: input.grade.sourceRef,
    grade_profile: input.grade.profile,
    lifecycle: input.grade.paths.map((p) => ({ path: p.path, state: p.lifecycle })),
    signature: null,
  };

  return { files, manifest };
}

/** The bytes the signature covers: the manifest with `signature` removed. */
export function signingPreimage(manifest: BundleManifest): Buffer {
  const { signature: _drop, ...rest } = manifest;
  return canonicalBytes(rest as unknown as CanonicalValue);
}

export function signBundle(bundle: SignedBundle, privateKey: crypto.KeyObject): SignedBundle {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`signBundle: expected an ed25519 key, got ${privateKey.asymmetricKeyType}`);
  }
  const pub = crypto.createPublicKey(privateKey);
  const manifest: BundleManifest = { ...bundle.manifest, signature: null };
  const sig = crypto.sign(null, signingPreimage(manifest), privateKey);
  return {
    files: bundle.files,
    manifest: {
      ...manifest,
      signature: {
        alg: 'ed25519',
        public_key: pub.export({ type: 'spki', format: 'der' }).toString('base64'),
        sig: sig.toString('base64'),
      },
    },
  };
}

export type VerifyFailure =
  | 'no-signature'
  | 'bad-signature'
  | 'missing-file'
  | 'file-hash-mismatch'
  | 'stray-file';

export interface VerifyResult {
  ok: boolean;
  failures: Array<{ reason: VerifyFailure; detail: string }>;
}

/**
 * The bot's job, in one function. Mechanical checks only — the human half
 * (is this vendor a real counterparty, is the Integration Agreement signed)
 * is deliberately not here, exactly as `reviewing.md` keeps it out of Prow.
 */
export function verifyBundle(bundle: SignedBundle): VerifyResult {
  const failures: VerifyResult['failures'] = [];

  for (const required of REQUIRED_FILES) {
    if (!(required in bundle.files)) {
      failures.push({ reason: 'missing-file', detail: `${required} is not in the submission` });
    }
  }
  for (const name of Object.keys(bundle.files)) {
    if (!REQUIRED_FILES.includes(name as (typeof REQUIRED_FILES)[number])) {
      failures.push({
        reason: 'stray-file',
        detail: `${name} is not one of the ${REQUIRED_FILES.length} required files`,
      });
    }
  }
  for (const entry of bundle.manifest.files) {
    const content = bundle.files[entry.name];
    if (content === undefined) {
      failures.push({ reason: 'missing-file', detail: `${entry.name} is in the manifest and not in the bundle` });
      continue;
    }
    const actual = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    if (actual !== entry.sha256) {
      failures.push({
        reason: 'file-hash-mismatch',
        detail: `${entry.name}: manifest says ${entry.sha256.slice(0, 12)}, content hashes to ${actual.slice(0, 12)}`,
      });
    }
  }

  const sig = bundle.manifest.signature;
  if (!sig) {
    failures.push({ reason: 'no-signature', detail: 'the manifest is unsigned' });
  } else {
    const pub = crypto.createPublicKey({
      key: Buffer.from(sig.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = crypto.verify(
      null,
      signingPreimage(bundle.manifest),
      pub,
      Buffer.from(sig.sig, 'base64'),
    );
    if (!ok) failures.push({ reason: 'bad-signature', detail: 'ed25519 verification failed' });
  }

  return { ok: failures.length === 0, failures };
}

export function writeBundle(dir: string, bundle: SignedBundle): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(bundle.files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  fs.writeFileSync(
    path.join(dir, 'MANIFEST.json'),
    JSON.stringify(bundle.manifest, null, 2) + '\n',
    'utf8',
  );
}

function yamlString(v: string): string {
  return /^[A-Za-z0-9 ._\/:-]+$/.test(v) && !/^\s|\s$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

export function renderIntegrationYaml(m: IntegrationMetadata): string {
  const lines = [
    '# The PRODUCT.yaml analogue. The first eight fields are cncf/k8s-conformance\'s,',
    '# name for name, so a reviewer who has read one can read this. The last five are',
    '# the inputs to lib/capture/surface.ts#assuranceForHost — this file and GRADE.md',
    '# cannot disagree about placement, because the grade is computed from these.',
    '',
  ];
  for (const [k, v] of Object.entries(m)) lines.push(`${k}: ${yamlString(String(v))}`);
  return lines.join('\n') + '\n';
}

function renderReadme(input: BundleInput): string {
  return [
    `# Scruple conformance — ${input.integration.name} ${input.integration.version}`,
    '',
    'NO LINKS IN THIS FILE. cncf/k8s-conformance\'s FAQ bans them from submission',
    'READMEs because a reviewer must be able to replicate the run from the file in',
    'front of them, and link rot defeats reproducibility. The same rule applies here.',
    '',
    '## Reproduction',
    '',
    input.reproduction.trimEnd(),
    '',
    '## What was run',
    '',
    `${input.run.results.length} probes, from a ${input.integration.probe_vantage} vantage.`,
    'Each probe is an attack made from the tenant position. A conformant deployment',
    'blocks all of them. The run summary is the last line of probes.log.',
    '',
    '```',
    input.run.summary.line,
    '```',
    '',
    '## Grade',
    '',
    renderGradeTable(input.grade).trimEnd(),
    '',
    '## Reproducibility is the enforcement mechanism',
    '',
    'Everything in probes.log is re-runnable by any third party against the live',
    'integration. A failure to reproduce is the trigger for review, on the same shape',
    'CNCF uses: a cure window, then the mark comes off. Nothing here is an audit and',
    'nothing here is an endorsement of the vendor\'s overall security posture.',
    '',
  ].join('\n');
}

export { canonicalJson };

/**
 * Re-hash a bundle's files into its manifest WITHOUT re-signing.
 *
 * This is the attack `verifyBundle` has to catch and it deserves to be
 * exercised rather than described: an adversary who swaps GRADE.md for a
 * flattering one and then fixes up the manifest's hashes so nothing looks torn.
 * The signature covers the manifest, so the repair is what gets caught. Test
 * helper — never call it from a publishing path.
 */
export function buildBundle_forTest_rehash(bundle: SignedBundle): SignedBundle {
  return {
    files: bundle.files,
    manifest: {
      ...bundle.manifest,
      files: Object.keys(bundle.files)
        .sort()
        .map((name) => ({
          name,
          sha256: crypto.createHash('sha256').update(bundle.files[name], 'utf8').digest('hex'),
          size_bytes: Buffer.byteLength(bundle.files[name], 'utf8'),
        })),
    },
  };
}
