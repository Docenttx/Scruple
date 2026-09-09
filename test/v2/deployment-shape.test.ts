// One route, two shapes, and the absences are absences.
//
// WO-D5's gate: "the same route renders a desktop-shaped dashboard when
// capabilities report local apps and a web-shaped one when they report
// Modal/RunPod." Its control: "a region that does not apply must be ABSENT, not
// merely empty — a dashboard that always draws everything cannot pass."
//
// The end-to-end version of this runs in a real Electron window against the
// real served route (scruple-desktop/scenarios/dashboard-shape.json). These are
// the same claims made where they can be made in milliseconds, plus the one
// thing the end-to-end run cannot do: prove that the absence check would
// actually catch a dashboard that drew everything.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  deploymentCapabilities,
  applicableRegions,
  REGION_IDS,
  type RegionId,
} from '../../lib/v2/deployment';
import { APPS } from '../../lib/apps/registry';
import StudioDashboard from '../../components/studio/StudioDashboard';
import { RENDERERS, Section } from '../../components/studio/regions';

const DESKTOP_ONLY: RegionId[] = ['local-apps', 'capture-gate', 'vault', 'model-store'];
const WEB_ONLY: RegionId[] = ['cloud-compute', 'machine-tiers', 'billing'];
const BOTH: RegionId[] = ['projects', 'attestation'];

const render = (profile: 'desktop' | 'web') =>
  renderToStaticMarkup(createElement(StudioDashboard, { caps: deploymentCapabilities(profile) }));

describe('what each deployment reports', () => {
  test('desktop reports the things that require being on the machine', () => {
    const caps = deploymentCapabilities('desktop');
    for (const r of DESKTOP_ONLY) {
      assert.equal(caps.regions.find((x) => x.region === r)!.applies, true, `${r} should apply on desktop`);
    }
    for (const r of WEB_ONLY) {
      assert.equal(caps.regions.find((x) => x.region === r)!.applies, false, `${r} should not apply on desktop`);
    }
    assert.deepEqual(
      caps.compute.map((c) => c.backend),
      ['local', 'local', 'local'],
      'a desktop deployment spawns nothing on anyone else’s hardware',
    );
  });

  test('web reports Modal and RunPod — from the app registry, not a second list', () => {
    const caps = deploymentCapabilities('web');
    assert.deepEqual(caps.compute.map((c) => c.id), APPS.map((a) => a.id));
    assert.deepEqual(caps.compute.map((c) => c.backend), APPS.map((a) => a.backend));
    assert.ok(caps.compute.some((c) => c.backend === 'modal'));
    assert.ok(caps.compute.some((c) => c.backend === 'runpod'));
    for (const r of WEB_ONLY) {
      assert.equal(caps.regions.find((x) => x.region === r)!.applies, true);
    }
  });

  test('a region that does not apply still carries a reason — the API is complete even where the UI is silent', () => {
    for (const profile of ['desktop', 'web'] as const) {
      for (const r of deploymentCapabilities(profile).regions) {
        assert.ok(r.reason.length > 30, `${profile}/${r.region}: "${r.reason}" reads as a bug, not an answer`);
      }
    }
  });

  test('`verified` is never representable on the desktop profile', () => {
    // 🔴 The standing rail, and it is structural: the type refuses it, the
    // resolver refuses it, and migration 053 refuses it at the database.
    const caps = deploymentCapabilities('desktop');
    assert.equal(caps.capture_profile, 'desktop');
    assert.equal(caps.attestation.verified_representable, false);
  });

  test('every region has a renderer — adding one to the enum cannot silently draw nothing', () => {
    for (const id of REGION_IDS) assert.equal(typeof RENDERERS[id], 'function', `${id} has no renderer`);
  });
});

describe('absent, not empty', () => {
  test('the desktop dashboard does not contain the cloud regions in any form', () => {
    const html = render('desktop');
    for (const r of DESKTOP_ONLY) assert.ok(html.includes(`data-region="${r}"`), `${r} should be drawn`);
    for (const r of WEB_ONLY) {
      // Not "no node" — no OCCURRENCE. A hidden div, a commented-out block and
      // an empty section all fail this and all pass a querySelector check.
      assert.equal(html.split(r).length - 1, 0, `"${r}" appears in the desktop dashboard`);
    }
  });

  test('the web dashboard does not contain the local regions in any form', () => {
    const html = render('web');
    for (const r of WEB_ONLY) assert.ok(html.includes(`data-region="${r}"`), `${r} should be drawn`);
    for (const r of DESKTOP_ONLY) {
      assert.equal(html.split(r).length - 1, 0, `"${r}" appears in the web dashboard`);
    }
  });

  test('both shapes draw the regions they share, from the same components', () => {
    for (const html of [render('desktop'), render('web')]) {
      for (const r of BOTH) assert.ok(html.includes(`data-region="${r}"`), `${r} is shared and must be drawn`);
    }
  });

  test('the shape is the only difference: neither render hard-codes the other’s profile', () => {
    assert.ok(render('desktop').includes('data-profile="desktop"'));
    assert.ok(render('web').includes('data-profile="web"'));
  });

  // ⚑ THE CONTROL FOR THE CONTROL. Every assertion above is a claim that a
  // string does not occur, and a test that only ever asserts absence passes
  // just as well when the predicate is broken as when the code is right. So
  // here is a dashboard that DOES draw everything — each inapplicable region
  // rendered the way a careless implementation would render it, hidden and
  // empty — and the same check must catch it.
  test('the absence check catches a dashboard that draws every region and hides the rest', () => {
    const caps = deploymentCapabilities('desktop');
    const alwaysDraws = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...caps.regions.map((r) =>
          r.applies
            ? RENDERERS[r.region](caps)
            : createElement(
                'div',
                { key: r.region, hidden: true, style: { display: 'none' } },
                createElement(Section, { region: r.region, title: r.region, children: null }),
              ),
        ),
      ),
    );

    const missed = WEB_ONLY.filter((r) => alwaysDraws.split(r).length - 1 === 0);
    assert.deepEqual(
      missed,
      [],
      'the always-draws dashboard slipped past the same check the real one is held to — the check is worthless',
    );
    // And the querySelector-shaped check alone would NOT have caught it, which
    // is exactly why the assertions above look for occurrences.
    assert.ok(
      alwaysDraws.includes('data-region="cloud-compute"'),
      'the always-draws fixture is not actually drawing the region it is meant to draw',
    );
  });

  test('applicableRegions never returns a region that does not apply', () => {
    for (const profile of ['desktop', 'web'] as const) {
      const caps = deploymentCapabilities(profile);
      assert.ok(applicableRegions(caps).every((r) => r.applies));
      assert.ok(applicableRegions(caps).length < caps.regions.length, 'both shapes should exclude something');
    }
  });
});
