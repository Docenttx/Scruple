// Probe 4 — write into the output volume a file that produces no leaf.
//
// This is one half of §2's two-surface finding turned into a test, and the
// half a network gate structurally cannot see: a tenant with a shell writes a
// file and reads it back without ever calling /view.
//
// ---------------------------------------------------------------------------
// THREE DIRECTORIES, NOT ONE. §10 C-8, AND IT IS THE POINT OF THIS PROBE.
// ---------------------------------------------------------------------------
//
// §2 obligation 3 said "the output volume" and C-8 corrected it to `output/`,
// `temp/` AND `input/`, because `PreviewImage` (nodes.py:1684-1690) is a
// `SaveImage` subclass whose `output_dir` is `folder_paths.get_temp_directory()`
// — it writes FULL IMAGES to `temp/`, not `output/`.
//
// So a probe that watched only `output/` would hand a clean pass to a
// deployment that leaks every preview. That is not a hypothetical: it is
// precisely the shape of the finding that produced C-8, and a conformance
// suite whose job is to catch it must fail when any ONE of the three is
// unwatched. Hence: the attack succeeds if ANY directory swallows a write.
//
// A DIRECTORY THAT IS NOT MOUNTED IS NOT A PASS EITHER. `temp: null` means the
// operator did not mount it, which means the tenant's `PreviewImage` output
// lands somewhere this deployment cannot see. That is recorded as an
// unwatched directory, not skipped.
//
// ---------------------------------------------------------------------------
// AND "THERE IS NO FILESYSTEM SURFACE HERE" IS A THIRD THING AGAIN
// ---------------------------------------------------------------------------
//
// `volumes: null` says this integration has no filesystem surface at all —
// canvas is the live example, because the Modal volume is not mountable into
// scruple-web. There is nothing to write into and nothing to watch, and the
// tenant has no shell on the other side either.
//
// That is NOT a pass. Nothing was gated; the question was never asked. It is
// also not a failure, because a surface that does not exist cannot leak. So
// the probe returns `not-attempted`, the runner records `inconclusive`, and
// the grader has to get coverage for that egress path from somewhere else —
// which is WO-5's DEFECT-2 arriving exactly where it was predicted: nothing in
// the hook/surface/placement model can say that the surfaces an integration
// HAS cover every path the host HAS.

import crypto from 'node:crypto';
import path from 'node:path';

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

interface DirOutcome {
  dir: string;
  abs: string | null;
  wrote: boolean;
  leaf: boolean;
  contentHash: string | null;
  /** The C-8 volume type the covering leaf declared, or null when it declared
   *  none. `'unspecified'` is what the pre-C-8 singular config emits. */
  declaredType: string | null;
  /** True when a leaf named a DIFFERENT volume than the one written to. */
  misattributed: boolean;
}

/**
 * §10 C-8 rides on `capture.egress` as `file:<volume type>:<path>`. Read the
 * type back out — carefully, because the path may itself contain colons.
 */
function volumeTypeOf(egress: string): string | null {
  const m = /^file:([a-z]+):/.exec(egress);
  return m ? m[1] : null;
}

export const probeOutputVolume: Probe = {
  id: 'P-04',
  spec: 'H-4 §7 probe 4 (§2 obligation 3 as amended by §10 C-8)',
  title: 'write into a watched volume a file that produces no leaf',
  attempt: 'write distinct bytes into output/, temp/ and input/ from the tenant position',
  requirement:
    'every one of the three directories must produce a leaf covering those exact bytes ' +
    'within the drain window — the attack SUCCEEDS when nothing happens',
  evidenceFor: ['P1', 'P2'],
  topological: false,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const vols = ctx.deployment.volumes;
    if (!vols) {
      return {
        outcome: 'not-attempted',
        detail:
          'This integration declares no filesystem surface, so there is no volume to write ' +
          'into and no watcher to evade. Nothing was gated and nothing leaked — the question ' +
          'was not asked. Coverage of the host\'s disk-path egress, if it has any, has to be ' +
          'established on the surfaces this integration does have.',
        evidence: { surface_present: false, directories_declared: 0 },
      };
    }
    const targets: Array<{ name: string; dir: string | null }> = [
      { name: 'output', dir: vols.output },
      { name: 'temp', dir: vols.temp },
      { name: 'input', dir: vols.input },
    ];

    const outcomes: DirOutcome[] = [];

    for (const t of targets) {
      if (!t.dir) {
        outcomes.push({
          dir: t.name,
          abs: null,
          wrote: false,
          leaf: false,
          contentHash: null,
          declaredType: null,
          misattributed: false,
        });
        continue;
      }
      // Distinct bytes per directory: a single blob would let one leaf answer
      // for three writes, which is the exact confusion this probe exists to
      // rule out.
      const bytes = Buffer.from(
        `scruple-conformance P-04 ${t.name} ${crypto.randomUUID()}`,
        'utf8',
      );
      const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const abs = path.join(t.dir, `scruple-probe-04-${t.name}.bin`);
      const wrote = await ctx.vantage.writeFile(abs, bytes);
      if (!wrote) {
        outcomes.push({
          dir: t.name,
          abs,
          wrote: false,
          leaf: false,
          contentHash,
          declaredType: null,
          misattributed: false,
        });
        continue;
      }
      const found = await ctx.leaves.leafFor(contentHash, ctx.deployment.drainWindowMs);
      // IT MUST BE A FILESYSTEM-WATCH LEAF. A tenant with a shell reads the
      // file without ever calling /view, so a leaf produced by the network
      // gate for identical bytes says nothing about whether that read was
      // covered. Accepting any leaf would let one artifact's hash answer for
      // another path's silence.
      const byWatcher = found.found && found.surfaces.includes('filesystem-watch');

      // ---------------------------------------------------------------------
      // §10 C-8's SECOND HALF: not "is there a leaf" but "does the leaf say
      // which of the three directories these bytes landed in".
      //
      // AN ABSENT DECLARATION AND A WRONG ONE ARE NOT THE SAME FINDING, and
      // collapsing them is the mistake mime.ts already refuses. A deployment on
      // the pre-C-8 singular config emits `file:unspecified:…`: the write IS
      // witnessed, and the record cannot distinguish a PreviewImage in `temp/`
      // from a SaveImage in `output/`. That is reported as an unrecorded type,
      // not as an uncaptured write — the probe writes DISTINCT bytes per
      // directory, so its own attribution never depended on the tag.
      //
      // A leaf that names the WRONG volume is different in kind. It is a false
      // statement about where bytes came from, and a verifier who trusted it
      // would conclude `temp/` is watched on the strength of an `output/`
      // write. That counts as unwitnessed for the directory it lied about.
      // ---------------------------------------------------------------------
      const types = found.egresses.map(volumeTypeOf).filter((x): x is string => x !== null);
      const declaredType = types.length ? types[0] : null;
      const misattributed =
        byWatcher && declaredType !== null && declaredType !== 'unspecified' && declaredType !== t.name;
      outcomes.push({
        dir: t.name,
        abs,
        wrote: true,
        leaf: byWatcher && !misattributed,
        contentHash,
        declaredType,
        misattributed,
      });
    }

    const written = outcomes.filter((o) => o.wrote);
    const unwitnessed = written.filter((o) => !o.leaf);
    const unmounted = outcomes.filter((o) => o.abs === null);
    const unwritable = outcomes.filter((o) => o.abs !== null && !o.wrote);

    const typedOk = written.filter((o) => o.declaredType !== null && o.declaredType === o.dir);
    const untyped = written.filter(
      (o) => o.leaf && (o.declaredType === null || o.declaredType === 'unspecified'),
    );
    const misattributed = written.filter((o) => o.misattributed);

    const evidence = {
      surface_present: true,
      c8_volume_type_recorded: `${typedOk.length}/${written.length}`,
      volume_types_declared:
        written.map((o) => `${o.dir}→${o.declaredType ?? 'none'}`).join(',') || 'none',
      volume_type_misattributed: misattributed.map((o) => o.dir).join(',') || 'none',
      drain_window_ms: ctx.deployment.drainWindowMs,
      directories_declared: outcomes.length,
      directories_mounted: outcomes.length - unmounted.length,
      directories_written: written.length,
      directories_witnessed: written.length - unwitnessed.length,
      unwatched: unwitnessed.map((o) => o.dir).join(',') || 'none',
      unmounted: unmounted.map((o) => o.dir).join(',') || 'none',
      not_writable_from_tenant: unwritable.map((o) => o.dir).join(',') || 'none',
      oracle: ctx.leaves.describe,
    };

    if (unmounted.length > 0) {
      return {
        outcome: 'succeeded',
        detail:
          `${unmounted.map((o) => o.dir).join(' and ')} not mounted into the component. §10 C-8: ` +
          'PreviewImage is a SaveImage subclass writing full images to temp/, and LoadImage ' +
          'inputs live in input/. A directory nobody mounted is a directory nobody watches, ' +
          'and every artifact that lands there is retrievable with no leaf.',
        evidence,
      };
    }

    if (written.length === 0) {
      return {
        outcome: 'blocked',
        detail:
          'None of the three directories was writable from the tenant position. A read-only ' +
          'mount is a stronger posture than a watched one and this probe has nothing to catch ' +
          '— but note that §2 obligation 3 does not require read-only, because hash-on-close ' +
          'is tamper-EVIDENT by design (§6).',
        evidence,
      };
    }

    if (unwitnessed.length > 0) {
      const lying = unwitnessed.filter((o) => o.misattributed);
      return {
        outcome: 'succeeded',
        detail:
          `Wrote to ${written.length} of 3 directories; ${unwitnessed.length} produced no usable ` +
          `leaf within ${ctx.deployment.drainWindowMs} ms ` +
          `(${unwitnessed.map((o) => o.dir).join(', ')}). Those bytes are retrievable and ` +
          'unwitnessed.' +
          (lying.length
            ? ` ${lying.length} of them DID produce a leaf, naming the wrong volume ` +
              `(${lying.map((o) => `${o.dir} recorded as ${o.declaredType}`).join('; ')}). A leaf ` +
              'that misattributes the directory is worse than no leaf: a verifier reading it ' +
              'concludes a volume is watched on the strength of a write to a different one.'
            : ''),
        evidence,
      };
    }

    return {
      outcome: 'blocked',
      detail:
        `All ${written.length} writes produced a leaf covering the exact bytes within ` +
        `${ctx.deployment.drainWindowMs} ms.` +
        (untyped.length
          ? ` ${untyped.length} of those leaves do not record WHICH volume the bytes landed in ` +
            `(${untyped.map((o) => o.dir).join(', ')}). The writes are witnessed; the record ` +
            'cannot tell a PreviewImage in temp/ from a SaveImage in output/, which is the ' +
            'distinction §10 C-8 exists to make. That is a pre-C-8 singular `outputVolume` ' +
            'configuration — declare the three roots with their types.'
          : ''),
      evidence,
    };
  },
};
