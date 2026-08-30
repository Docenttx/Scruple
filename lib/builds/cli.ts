#!/usr/bin/env node
// Operator CLI for the published-builds registry (WO-15).
//
//   node --import tsx lib/builds/cli.ts keygen
//   node --import tsx lib/builds/cli.ts publish --component scruple-capture \
//        --version 0.1.0 --measure-src services/scruple-capture/src
//   node --import tsx lib/builds/cli.ts publish --measurement sha256:... ...
//   node --import tsx lib/builds/cli.ts list
//   node --import tsx lib/builds/cli.ts status <measurement> [--at ISO8601]
//   node --import tsx lib/builds/cli.ts withdraw <measurement> --reason "..."
//   node --import tsx lib/builds/cli.ts supersede <measurement> --by <measurement>
//   node --import tsx lib/builds/cli.ts reinstate <measurement> --reason "..."
//   node --import tsx lib/builds/cli.ts verify [--public-key <hex>]
//
// THERE IS NO HTTP PUBLISH ROUTE, and that is a decision rather than an
// omission. Publication would have to be authorised by something, and the
// only thing that legitimately authorises it is possession of the registry
// signing key — which a route would then have to be handed over the wire,
// or hold ambiently for any caller carrying a tenant scope. A tenant must
// never be able to publish a build; no /v2 scope is the right credential
// for this. So the write path is local and key-bearing, and
// app/api/v2/builds/** is read-only.
//
// `--measure-src` imports services/scruple-capture/src/build-measurement.ts
// DYNAMICALLY. lib/ must not take a static dependency on the component it
// measures — the server holds the BDK and the component by §4.1 never
// does, and that boundary is worth keeping visible in the import graph.

import path from 'node:path';
import { runMigrations } from '@/lib/db/migrate';
import {
  buildRegistryStatus,
  listBuilds,
  publishBuild,
  reinstateBuild,
  supersedeBuild,
  withdrawBuild,
  buildEvents,
  verifyLifecycleSignature,
  verifyPublicationSignature,
} from './registry';
import { generateSeedHex, registryPublicKey } from './signing';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function measureSource(dir: string): Promise<string> {
  const abs = path.resolve(process.cwd(), dir);
  const mod = (await import(path.join(abs, 'build-measurement'))) as {
    buildMeasurement: (root?: string) => string;
  };
  return mod.buildMeasurement(abs);
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];

  if (cmd === 'keygen') {
    const seed = generateSeedHex();
    process.stdout.write(
      `SCRUPLE_BUILD_REGISTRY_KEY_HEX=${seed}\n\n` +
        '# Ed25519 seed. It never enters the database — that is what makes a registry row\n' +
        '# something only a key-holder can create, rather than something anyone with a\n' +
        '# write handle on the DB can INSERT.\n',
    );
    return 0;
  }

  runMigrations(false);

  switch (cmd) {
    case 'publish': {
      const src = flag(argv, 'measure-src');
      const measurement = src ? await measureSource(src) : flag(argv, 'measurement');
      const component = flag(argv, 'component');
      const version = flag(argv, 'version');
      if (!measurement || !component || !version) {
        process.stderr.write('publish needs --component, --version and one of --measurement / --measure-src\n');
        return 2;
      }
      const entry = publishBuild({
        measurement,
        componentName: component,
        version,
        measurementKind: src ? 'source-tree' : (flag(argv, 'kind') as 'image-digest' | undefined) ?? 'source-tree',
        notes: flag(argv, 'notes') ?? null,
      });
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
      return 0;
    }

    case 'measure': {
      const src = flag(argv, 'measure-src') ?? argv[3];
      if (!src) {
        process.stderr.write('measure needs a source directory\n');
        return 2;
      }
      process.stdout.write((await measureSource(src)) + '\n');
      return 0;
    }

    case 'list': {
      process.stdout.write(
        JSON.stringify(
          {
            signing_key: registryPublicKey(),
            builds: listBuilds(flag(argv, 'component')).map((b) => ({
              ...b,
              status: buildRegistryStatus(b.measurement).status,
            })),
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    case 'status': {
      const m = argv[3];
      if (!m) {
        process.stderr.write('status needs a measurement\n');
        return 2;
      }
      process.stdout.write(JSON.stringify(buildRegistryStatus(m, flag(argv, 'at')), null, 2) + '\n');
      return 0;
    }

    case 'withdraw':
    case 'reinstate': {
      const m = argv[3];
      const reason = flag(argv, 'reason');
      if (!m || !reason) {
        process.stderr.write(`${cmd} needs a measurement and --reason\n`);
        return 2;
      }
      const fn = cmd === 'withdraw' ? withdrawBuild : reinstateBuild;
      process.stdout.write(
        JSON.stringify(fn(m, reason, { effectiveAt: flag(argv, 'at') }), null, 2) + '\n',
      );
      return 0;
    }

    case 'supersede': {
      const m = argv[3];
      const by = flag(argv, 'by');
      if (!m || !by) {
        process.stderr.write('supersede needs a measurement and --by <measurement>\n');
        return 2;
      }
      process.stdout.write(
        JSON.stringify(
          supersedeBuild(m, by, { reason: flag(argv, 'reason'), effectiveAt: flag(argv, 'at') }),
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    // Re-checks every signature in the registry against a public key. The
    // point is that this can be run by someone who does NOT hold the
    // private key, on a database they do not trust, which is the only
    // reason the entries are signed rather than merely stored.
    case 'verify': {
      const pub = flag(argv, 'public-key') ?? registryPublicKey()?.publicKeyHex;
      if (!pub) {
        process.stderr.write('verify needs --public-key <hex> (or a configured signing key)\n');
        return 2;
      }
      let bad = 0;
      for (const b of listBuilds()) {
        const ok = verifyPublicationSignature(b, pub);
        if (!ok) bad++;
        process.stdout.write(`${ok ? 'ok  ' : 'BAD '} publication ${b.measurement} ${b.component_name} ${b.version}\n`);
        for (const e of buildEvents(b.measurement)) {
          const eok = verifyLifecycleSignature(e, pub);
          if (!eok) bad++;
          process.stdout.write(`${eok ? 'ok  ' : 'BAD '}   ${e.event} @ ${e.effective_at}\n`);
        }
      }
      return bad === 0 ? 0 : 1;
    }

    default:
      process.stderr.write(
        'usage: keygen | measure | publish | list | status | withdraw | supersede | reinstate | verify\n',
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
