# Findings carried forward

_Things that are true about this build and are not visible from a green gate.
Each is written where the next work order will trip over it. WO-D7 folds these
into `docs/STATE.md`; they are kept separately until then so that "the gate
passed" and "here is what the gate does not cover" stay different sentences._

---

## D4-1 — the capture component claims an isolation this desktop does not have

`CaptureComponent.start` hard-codes `declaredPlacement: 'sidecar-gate'` with
`enforcement: 'isolated-namespace'`, and `resolvePlacement()` honours the pair
by comparing the enforcement **string** against the string the placement
requires. It has to: the SDK runs in containers it cannot introspect.

On this desktop the string is not true. The gate is a child of the Electron
main process — same user, same namespaces, same machine, and the measured party
has root on all of it. `app/comfy/namespace.ts` measures exactly that and the
gate records `isolation.enforcementPresent: false` on its own result, beside
the placement the component declares, so the gap is on the record rather than
in an argument.

**What it does NOT change.** The leaf's basis is `stale` and never `verified`,
so nothing downstream is currently reading this placement as a hardware claim.
**What needs a decision:** `declaredPlacement` should come from configuration
rather than a constant, so a desktop deployment can declare
`unattested-client` / `none` and earn it the way `app/vault/run.ts` already
does. That is a change to the SDK's contract affecting every deployment that
already claims `sidecar-gate`, so it was named here rather than taken in a WO
about fingerprints.

## D4-2 — bypassing the gate does not produce an unwitnessed artifact; it produces a blind one

Measured by the `bypass-the-gate` mutation. A generation sent straight at
ComfyUI leaves the HTTP gate with nothing to see — and the **output volume
watcher catches the file anyway and witnesses it**. H-4 §2's two-surface claim,
happening live.

The leaf that results is honest and thinner: the adapter recorded the
observation as `no-graph`, so there is no workflow hash, no correlation and no
model fingerprints on it. That distinction — a record that says it is blind
versus one that is silently thinner — is WO-D6's Level 1 versus Level 2,
arriving early and by accident.

## D4-3 — the fingerprint is a read of the store, not a hook in the loader

`app/comfy/modelSink.ts` hashes the model files when the **artifact** is
observed, which is after ComfyUI loaded the weights rather than during. A swap
performed between the load and the read would be recorded as the post-swap
bytes. The interval is recorded (`readStartedAt` / `readFinishedAt` on the
gate's own result) and deliberately kept **out** of the manifest, because a
timestamp in the manifest would make `model_fingerprints_hash` unrecomputable
by anyone holding the weights.

Closing it needs the host to report what it opened — a Level-2 adapter, which
is WO-D6's registration.

## D4-4 — the gate is an ingress gate, and ComfyUI's outbound network is not on it

Logged by the component itself at startup as an advisory, repeated here because
it is easy to read a green gate as coverage. `comfy_api_nodes/` ships ~25 node
packs that open sessions to external services from inside the ComfyUI process.
Those bytes leave through neither surface. A desktop deployment cannot deny
egress from a container it does not have.

## D4-5 — a renderer-side stub can fake the whole port ledger

Measured by the `fake-bridge` mutation: every ledger assertion stays green
under it. Claiming "one listener, the right pid, loopback only" costs a stub in
the page nothing. The ledger's worth is that it is a reading of
`/proc/net/tcp` **that a real main process took**, and what establishes that is
`reached-main` plus the artifact, the leaf and the fingerprint — never the
ledger on its own. Same shape as WO-D2's finding about `store-exists`.

## D4-6 — Blender is not in this app

Stated because the design names it and nothing here touches it. WO-D4 launches
ComfyUI. Blender is the next series, and the Level-1 hook it will use is the
one this WO put in the path.

# WO-D5

## D5-1 — the canon stylesheet does not parse

`main.css` has two syntax defects, found by pointing a real CSS parser at it
for the first time:

- **line 916** — a stray `}` at depth 0, sitting between two conflicting
  `.console-logs` rules.
- **line 2176** — the file ends in a lone `/`, half of a comment opener that
  was cut off.

Every browser recovers silently from both (the CSS error-recovery rules say:
discard, resynchronise, carry on), which is why it shipped and why nobody saw
it. postcss does not recover, and that is the useful part: a design being
carried into a shared theme should be read by something that tells the truth
about it. `port-canon-css.mjs` drops each one exactly as a browser drops it and
**records it in the generated header** rather than repairing the source copy,
which stays byte-identical to the original so the cross-repo checksum in
`scripts/d5-gate.sh` keeps meaning something.

## D5-2 — the 21st token is referenced and never declared

`docs/DESIGN.md` says 21 tokens. The canon **declares 20**. The 21st is
`--accent-hover`, referenced by exactly one rule:

    .activate-btn        { background: var(--accent-primary); color: var(--bg-primary); }
    .activate-btn:hover  { background: var(--accent-hover); }

Nothing declares it, so on hover the property is invalid at computed-value time
and the background falls back to the initial value — transparent. The primary
action button goes from cyan to invisible, dark text on a dark panel, the
moment a pointer touches it.

**Carried across unrepaired**, and `test/v2/canon-theme.test.ts` fails if the
shared theme ever declares it. Declaring a value would be inventing a design
decision and calling it a port. The point of one implementation is that the
defect is now visible in one place instead of invisible in two.

## D5-3 — wallet.css declares no tokens at all

It reads 15 names that nothing anywhere declares, through
`var(--name, #fallback)` — so the **fallback** is what every wallet panel has
always rendered. Four of those names carry more than one fallback at different
sites:

    --border-color    #333, #444, #3a3a3a
    --text-muted      #888, #666
    --text-secondary  #aaa, #ccc
    --code-bg         #2a2a2a, #1a1a1a

A name with two values is not a token, it is two literals wearing one name.
They are therefore **not** hoisted into `:root`: hoisting would have to pick a
winner and would silently restyle the loser. They stay exactly as written, and
`tailwind.config.ts` keeps its wallet colours as literals for the same reason,
with the defect list in `canon.css` as the explanation.

One name resolves differently from how it reads: `var(--accent-primary, #4a9eff)`.
`--accent-primary` **is** declared, by main.css, as `#00d9ff` — and both sheets
were loaded into one document, so the `#4a9eff` fallback never fired in the
desktop either. The port preserves that. The wallet's "own" blue was dead code.

## D5-4 — the two sheets collide, and load order decided the winner

`.status-indicator`, `.btn-icon`, `.form-group` and `.help-text` are each
defined in **both** main.css and wallet.css with different values. Both were
loaded globally into one document, so wallet.css won every one of them by
loading second. Scoping the port under `.scruple-canon.workspace` and
`.scruple-canon.wallet` keeps both copies and makes which one applies a
property of the markup instead of a property of an import statement.

`@keyframes` could not be handled that way — it has one global namespace
whatever the rules around it say — so those are prefixed (`canon-spin`) and
deduped. Every duplicate happened to be byte-identical; the port **throws**
rather than picking a winner if one ever is not.

## D5-5 — a test-runner convenience moved a tamper-surface hash

Rendering a component inside `node --test` needed the automatic JSX runtime,
and the quickest route was a flag in `package.json`'s `test:v2` script. That
turned `canvas-retrofit.test.ts` red: **`package.json` is on canvas's tracked
tamper surface**, and its baseline hash means "a file on canvas's capture path
changed".

The mechanism worked exactly as designed and the fix was to stop touching the
file, not to re-record the baseline: the three studio components import `React`
explicitly instead. Worth recording because the temptation in the moment is to
re-record — the failure message even tells you the command — and re-recording
would have signed off a change to the capture path that never happened.

## D5-6 — a rendered dashboard cannot tell you the bridge is real

Measured by the `fake-bridge` mutation: **every** region assertion stays green
under it. The shape of the dashboard comes from the server, so a preload that
answers in the renderer and never reaches main cannot change a single region.
Three assertions move, and all three are about values a stub cannot invent: the
main process's pid, and this run's model root appearing inside the region.

The same lesson as WO-D2's `store-exists` and WO-D4's port ledger, arriving in
a third place: an observable is worth what its unfakeable half is worth.

## D5-7 — `verified` is unrepresentable on this web deployment too

Expected on desktop: unreachable by construction, three ways.
`verifiedIsRepresentable()` also requires an enforcement that is not `'none'`,
and this deployment has no placement enforcement configured — so the web shape
reports `unrepresentable` as well. The two shapes agree by arithmetic rather
than by coincidence, which is why the assertion that reads it stays green under
both shape mutations and is deliberately not in either declared red set.
