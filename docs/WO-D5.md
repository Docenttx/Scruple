# WO-D5 — the canon UI, on the shared implementation

_2026-09-09. Gate: `bash scripts/d5-gate.sh` (needs the scratch app on `:3902`)._

## What was built

| file | what it is |
|---|---|
| `/data/scruple-web/app/theme/canon-source/*.css` | the canon's two stylesheets, **byte-identical** to `app-legacy/renderer/styles/` — checked both ways by stage 0 of the gate. |
| `/data/scruple-web/scripts/port-canon-css.mjs` | the port. Scopes the rules, lifts the tokens to `:root`, hoists the keyframes, and **records the canon's defects rather than repairing them**. |
| `/data/scruple-web/app/theme/canon.css` | 2,999 generated lines. Not maintained — derived, and `--check` proves it. |
| `/data/scruple-web/tailwind.config.ts` | the palette now **reads** the tokens. Zero canon hex literals remain. |
| `/data/scruple-web/lib/v2/deployment.ts` | which regions apply to a deployment; web's compute comes from `lib/apps/registry.ts`, not a second list. |
| `/data/scruple-web/app/api/v2/capabilities/route.ts` | `?profile=desktop\|web`, beside the existing `?host=&mime=`. |
| `/data/scruple-web/app/studio/page.tsx` | one route. Fetches the real endpoint; refuses rather than guessing. |
| `/data/scruple-web/components/studio/*` | the shell, the regions, and `HostFacts` — the client half that asks the bridge. |
| `app/ipc-profile.js` | `scruple:profile` — what this machine has, measured at call time. |
| `app/main-modular.js` | announces `x-scruple-profile: desktop` on every request the window makes. |
| `scenarios/dashboard-shape.json` | 31 assertions, 5 mutations. |
| `scripts/d5-gate.sh` | the gate and its five controls. |

## The port is a script, and that is the whole claim

`docs/DESIGN.md`: *"The canon design is ported **into** the shared theme once.
After that there is one implementation and nothing to diverge."*

"Ported once" decays the moment someone edits the copy. So the theme is
**generated** from the canon's own bytes and `port-canon-css.mjs --check`
regenerates and diffs — a hand edit to `canon.css` fails a test. The palette
went further: `tailwind.config.ts` used to hold its own hex copies of the same
21 colours, which is exactly the drift the WO exists to end. It now emits

    'accent-primary': 'rgb(var(--accent-primary-rgb) / <alpha-value>)'

so a Tailwind utility and a canon rule saying `var(--accent-primary)` are the
same value **by construction**. The channel form is what keeps the 35 existing
opacity modifiers (`bg-scruple-accent/10`) working against a variable.

Three transformations, and only three:

1. **Scoped.** `.scruple-canon.workspace` and `.scruple-canon.wallet`. The two
   sheets collide — `.status-indicator`, `.btn-icon`, `.form-group` and
   `.help-text` are each defined in both — and load order decided the winner.
2. **Tokens lifted** to a real `:root`, unscoped, because they are the shared
   theme's vocabulary now.
3. **Keyframes prefixed and deduped**, because `@keyframes` has one global
   namespace whatever the rules around it say.

No value changed. No rule was dropped. Four canon defects came across **as
defects**, recorded in the generated header — see `docs/FINDINGS.md` D5-1..D5-4.

## Capability, not code

    GET /api/v2/capabilities?host=blender&mime=image/png   → which modalities apply
    GET /api/v2/capabilities?profile=desktop               → which REGIONS apply

Same endpoint, because it is the same question at two scales and it was built
on the sentence that justifies both: *"applicability is not secret, and a client
should be able to render its UI before the user has signed in."*

The dashboard is one component tree. What differs is the answer it is handed:

| | desktop | web |
|---|---|---|
| drawn | local-apps · capture-gate · vault · model-store | cloud-compute · machine-tiers · billing |
| both | projects · attestation | projects · attestation |
| compute | ComfyUI, Kohya, Blender — all `local`, all `source: host` | ComfyUI/Modal, Kohya/RunPod, Fusion/local — from `APPS` |

### Absent, not empty

The WO's control. An inapplicable region has **no node and no occurrence** —
not a hidden div, not a greyed card. `applicableRegions()` filters and the
renderer maps over what is left, so the code to draw it in a disabled state
does not exist rather than being guarded by a flag.

Measured three ways: `dom-absent` (count 0 in the real window),
`dom-unmentioned` (0 occurrences in the whole serialised document — the only
form that catches a region drawn and hidden), and `grep -c` over the served
bytes in the gate script, both directions.

`test/v2/deployment-shape.test.ts` adds **the control for the control**: it
renders a dashboard that *does* draw every region, hidden and empty the way a
careless implementation would, and requires the same check to catch it. A test
that only ever asserts absence passes just as well when its predicate is broken.

### Who knows what

The server knows the **shape** of a deployment. It does not know whether
ComfyUI is on your laptop. So every compute entry carries `source`, and the
four desktop regions are filled by `HostFacts`, which asks the preload bridge
and renders one of three states — `measured`, `unavailable`, `refused` — and
never a plausible default. The scenario's strongest assertion is that the
model-store region contains **the model root this run created minutes ago**: a
path the server could not know and a static mock could not invent.

## Proving it with no screen

`⚑ Screenshots come back blank under llvmpipe.` So the design is measured by
asking the layout engine what it computed:

    .sidebar                 background-color  rgb(17, 24, 39)   ← --bg-secondary #111827
    .sidebar                 width             220px             ← --sidebar-width
    .section-header h3       letter-spacing    1px               ← the canon's ALL-CAPS headers
    .scruple-canon.workspace background-color  rgb(10, 15, 28)   ← --bg-primary #0a0f1c

`getComputedStyle` is the browser's own answer after the cascade and after
every `var()` resolved, so a green here means the value travelled
`main.css` → `canon-source` → `canon.css` → `:root` → `var()` → Chromium. No
pixel was read.

## The sweep

    profile-lie          caught   15 red exactly
    no-profile-header    caught   15 red exactly
    fake-bridge          caught    3 red exactly
    no-bridge            caught    5 red exactly
    assert-expectation   caught    1 red exactly

`profile-lie` and `no-profile-header` land on the same 15 by different routes,
and that is not redundancy: one says the shape follows the announcement, the
other says the **default is web** and not desktop. A build that hard-coded the
desktop shape passes the first and fails the second.

`fake-bridge` is the honest measure of what a DOM assertion is worth. Every
region assertion stays **green** — the shape comes from the server, and a lying
preload cannot change what the server rendered. What the stub cannot do is know
the main pid or this run's model root. Same shape as WO-D2's `store-exists` and
WO-D4's port ledger: a claim is worth what the unfakeable part of it is worth.

## What this does not do

- **The existing pages were not migrated.** `/`, `/settings`, `/canvas` and the
  rest still use their Tailwind clone of the design. They now draw it from the
  canon tokens — one palette, not two — but their layouts are still their own.
  The canon layouts are in the theme, scoped and unused outside `/studio`.
- **The wallet layout is ported and unmounted.** 107 rules of it are in the
  shared theme. Nothing renders them, because `docs/DESIGN.md` holds the
  wallet's 21 key-handling files for a security review before revival, and a
  dashboard region for an unreviewed wallet is exactly the "drawing chrome for
  a thing you cannot have" this WO argues against.
- **`/studio` is not the app.** It is the dashboard shell that renders from
  capabilities. Project rows, iteration grids and the lock buttons are the
  existing components' business and are not wired into it yet.
