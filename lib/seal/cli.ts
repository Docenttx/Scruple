#!/usr/bin/env node
// Operator CLI for the integration lifecycle (WO-22).
//
//   node --import tsx lib/seal/cli.ts register <deployment-id> --tenant <t> [--label "..."]
//   node --import tsx lib/seal/cli.ts bind <component-id> --deployment <d>
//   node --import tsx lib/seal/cli.ts verifying <deployment-id> [--reason "..."]
//   node --import tsx lib/seal/cli.ts seal <deployment-id> --manifest <file.json> [--notes "..."]
//   node --import tsx lib/seal/cli.ts change <deployment-id> --manifest <file.json>
//   node --import tsx lib/seal/cli.ts status <deployment-id> [--at ISO8601]
//   node --import tsx lib/seal/cli.ts verify <deployment-id> [--public-key <hex>]
//
// THERE IS NO HTTP WRITE ROUTE, for WO-15's reason and one more of this
// work order's own.
//
//   WO-15's: approval "would have to be authorised by something, and the
//   only thing that legitimately authorises it is possession of the
//   signing key" — which a route would have to be handed over the wire or
//   hold ambiently for any caller carrying a tenant scope.
//
//   This one's: A DEPLOYMENT MOVING ITS OWN LIFECYCLE STATE IS A VENDOR
//   GRADING THEIR OWN EXAM. `sealed` is the state that lets a deployment
//   claim the standard, and no tenant credential is the right credential
//   for granting it to yourself. Exposing `verifying` but not `sealed`
//   would be a half-measure with an extra route to defend, so nothing is
//   exposed and app/api/v2/seal/** is read-only.
//
// The manifest file is `{"entries":[{class,id,source,sha256}, ...]}` —
// see lib/seal/measure.ts for what belongs in it and why it is a DECLARED
// list rather than a directory walk. `--measure-root` hashes `content`
// entries from disk relative to that root.

import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '@/lib/db/migrate';
import { registryPublicKey } from '@/lib/builds/signing';
import { normaliseManifest, type ManifestEntry, type PipelineManifest } from './measure';
import {
  applySeal,
  bindComponent,
  declareManifestChange,
  enterVerification,
  issueSeal,
  lifecycleEvents,
  listSeals,
  registerDeployment,
  sealStatus,
  verifyLifecycleSignature,
  verifySealMeasurement,
  verifySealSignature,
} from './registry';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadManifest(file: string): PipelineManifest {
  const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')) as {
    entries?: ManifestEntry[];
  };
  return normaliseManifest(raw.entries ?? []);
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];
  runMigrations();

  switch (cmd) {
    case 'register': {
      const id = argv[3];
      const tenant = flag(argv, 'tenant');
      if (!id || !tenant) {
        process.stderr.write('usage: register <deployment-id> --tenant <tenant>\n');
        return 2;
      }
      const d = registerDeployment({
        deploymentId: id,
        tenantId: tenant,
        label: flag(argv, 'label') ?? null,
      });
      process.stdout.write(`registered ${d.deployment_id} — integrating\n`);
      return 0;
    }

    case 'bind': {
      const componentId = argv[3];
      const deployment = flag(argv, 'deployment');
      if (!componentId || !deployment) {
        process.stderr.write('usage: bind <component-id> --deployment <deployment-id>\n');
        return 2;
      }
      bindComponent(componentId, deployment);
      process.stdout.write(`${componentId} -> ${deployment}\n`);
      return 0;
    }

    case 'verifying': {
      const id = argv[3];
      if (!id) return 2;
      const e = enterVerification(id, flag(argv, 'reason'));
      process.stdout.write(`${id} verifying @ ${e.effective_at}\n`);
      return 0;
    }

    case 'seal': {
      const id = argv[3];
      const file = flag(argv, 'manifest');
      if (!id || !file) {
        process.stderr.write('usage: seal <deployment-id> --manifest <file.json>\n');
        return 2;
      }
      const seal = issueSeal({
        deploymentId: id,
        manifest: loadManifest(file),
        notes: flag(argv, 'notes') ?? null,
      });
      applySeal(id, seal.seal_ref, { reason: flag(argv, 'reason') });
      process.stdout.write(
        `sealed ${id}\n  seal_ref    ${seal.seal_ref}\n  measurement ${seal.pipeline_measurement}\n`,
      );
      return 0;
    }

    case 'change': {
      const id = argv[3];
      const file = flag(argv, 'manifest');
      if (!id || !file) {
        process.stderr.write('usage: change <deployment-id> --manifest <file.json>\n');
        return 2;
      }
      const { verdict, event } = declareManifestChange({
        deploymentId: id,
        proposed: loadManifest(file),
      });
      process.stdout.write(`${verdict.class}\n`);
      for (const r of verdict.reasons) process.stdout.write(`  - ${r}\n`);
      process.stdout.write(
        event
          ? `recorded ${event.event} @ ${event.effective_at}\n`
          : 'nothing inside the boundary moved; no event recorded\n',
      );
      return 0;
    }

    case 'status': {
      const id = argv[3];
      if (!id) return 2;
      const st = sealStatus(id, flag(argv, 'at'));
      process.stdout.write(JSON.stringify({ ...st, events: st.events.length }, null, 2) + '\n');
      return st.claims_standard ? 0 : 1;
    }

    case 'verify': {
      const id = argv[3];
      const pub = flag(argv, 'public-key') ?? registryPublicKey()?.publicKeyHex;
      if (!id || !pub) {
        process.stderr.write('verify needs a deployment id and a --public-key (or a local key)\n');
        return 2;
      }
      let bad = 0;
      for (const s of listSeals(id)) {
        const sigOk = verifySealSignature(s, pub);
        const measOk = verifySealMeasurement(s);
        if (!sigOk || !measOk) bad++;
        process.stdout.write(
          `${sigOk ? 'sig ok ' : 'SIG BAD'} ${measOk ? 'measurement ok ' : 'MEASUREMENT BAD'}  ${s.seal_ref}\n`,
        );
      }
      for (const e of lifecycleEvents(id)) {
        const ok = verifyLifecycleSignature(e, pub);
        if (!ok) bad++;
        process.stdout.write(`${ok ? 'ok  ' : 'BAD '}   ${e.event} @ ${e.effective_at}\n`);
      }
      return bad === 0 ? 0 : 1;
    }

    default:
      process.stderr.write(
        'usage: register | bind | verifying | seal | change | status | verify\n',
      );
      return 2;
  }
}

if (require.main === module) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(String(err?.message ?? err) + '\n');
      process.exit(1);
    },
  );
}

export { main };
