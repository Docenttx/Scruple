# WO-G1 — the Studio, running again, on Electron 38

_2026-09-10. Gate: `npm run g1` (14/14) · `npm run g1:scenario` (12/12) ·
`bash scripts/d1-gate.sh` (passed, three controls fired) · `npm run d3` (24/24)._

The app opens, the tab bar is the app's own, the sidebar lists projects and the
main window holds the tracked project. `app-legacy/` is the application now:
`package.json` `main` points at `app-legacy/main-modular.js`.

---

## What the hypothesis got wrong

WO-G1 said the port would be small and told me to test that first. The Electron
API surface half was right — `nodeIntegration: false`, `contextIsolation: true`,
zero uses of the removed `remote` module, `webviewTag` already on. Not one line
changed for an Electron API.

**It was the wrong thing to measure.** I measured the port and never asked whether
there was an app to port.

### `app-legacy/` was not the app

Its own `MANIFEST.md` says so, in a section headed *"Files in canonical structure
but MISSING from snapshot"*, ending **"The bundle will not run without them."** I
had read that file for its tab bar and not for its warning. Missing: all four
`capture/comfyui/` modules and all seven `capture/training/` modules — required at
the top of `main-modular.js`, so the process could not reach its first statement.

### The real tree

`/mnt/corpus/work/WindowsRigCorpus/WindowsRigCorpus/Scruple - Modular/Scruple Studio M/scruple-studio`
— 84 files, 2026-04-06, and the exact path the MANIFEST names as authoritative
(`D:\Scruple - Modular\Scruple Studio M\scruple-studio\`).

Evidence it is the newer tree and not merely a different one:

| Question | Answer |
|---|---|
| Does the snapshot have anything the rig lacks? | **No** — zero legacy-only files |
| Is the entry point the same? | **Byte-identical** `main-modular.js` |
| Where they differ (14 files), who is ahead? | The rig: stripe-payment and blockchain-finalize modal states the snapshot has never heard of |
| Is the tab bar affected? | **No** — identical, same lines, same line numbers |

⚑ **Search discipline.** The first two sweeps timed out (exit 124 and 143) and
printed nothing. A control file I knew existed — `render-main.js` — did not come
back, which is the only reason I knew the negative was worthless rather than
clean. The pruned sweep found the tree in 90 seconds.

---

## What the port actually required

### 1. A missing comma

`config/config-testnet.js` on the rig **does not parse** — no comma after
`paymentMode: 'fiat'`. The April rig state could not have started. One character.

### 2. A native dependency, two majors back

`better-sqlite3@9.4.3` will not compile against Electron 38's V8 headers:

```
v8-persistent-handle.h:274:19: error: expected identifier
  274 |     requires(std::is_base_of_v<T, S>)
```

A C++20 `requires` clause under a toolchain the v9 `binding.gyp` builds at C++17.
**Bumped to `better-sqlite3@13.0.3`**, and it removes the native build step
entirely rather than fixing it: v13 ships N-API prebuilds, `linux-arm64`,
`win32-x64` and `win32-arm64` among them. `electron-rebuild` has nothing to do.

⚑ **This is the finding G3 cares about: the travel laptop needs no build
toolchain.** The API surface `database.js` uses is `prepare`/`get`/`run`/`all`/
`exec`/`pragma`/`close` — stable across all four majors.

### 3. Three files in the wrong directory

`app-legacy/lock/lock-executor-{blockchain,fiat,server}.js`. The MANIFEST admits
it: *"placed here by inference."* The inference was wrong —
`lock/lock-chain-lock.js:37` does `require('./executors/lock-executor-' + name)`.
Every chain lock would have thrown. Real layout restored.

### 4. A sandboxed preload cannot require the file next to it

The app's bridge (53 channels) and the host seam (12) both wanted
`window.scruple`, and `exposeInMainWorld` throws on the second call. I split the
host half into `preload-host.js` and spread it in. It **loaded as nothing** — no
throw, no warning, just a `window.scruple` with no `ping` on it. A preload under
`contextIsolation: true` with `sandbox` at its default reaches `electron` and a
short allowlist of built-ins, and not a relative file beside it. The host surface
is inline, with that written above it. The alternative was `sandbox: false`,
which trades a real boundary for a tidier file.

---

## 🔴 The one that must be settled before G3

**The app pointed at a live witness.** `http://129.80.23.93:5799` in five places
— and `lock/executors/lock-executor-server.js:17` **hard-coded it with no env
override**, so setting `SCRUPLE_WITNESS_URL` moved four call sites and silently
left one aimed at the production audit log. Nobody reading the environment would
have caught it.

A test rig writing test locks into that log is not undoable. Not deleting
anything is the entire value of an audit log.

`config/witness-endpoint.js` is now the only resolver. Default: the CVM surrogate
at `127.0.0.1:8799` — software-backed, so a leaf it signs is `passthrough` or
`stale` and never `verified`, which is the point. A production endpoint **refuses
with a code** (`witness_endpoint_refused`) unless `SCRUPLE_ALLOW_PRODUCTION_WITNESS=1`.
No config-file key and no UI toggle: a value you can set by clicking is a value
you can set by accident. Control proven red, then green with the opt-in.

**This is a change to shipped behaviour and the founder should confirm it.** It
makes the safe thing the default and the real thing deliberate.

---

## Every difference from the legacy tab set, and why

The gate requires each one justified. A silent drift is what D5 was.

| Difference | Justification |
|---|---|
| **`Kohya_ss` absent** | Existing behaviour, preserved: `kohyaEnabled` is false unless a Kohya answers on 7860-7862. **Absent, not empty** — the gate asserts the string `data-view="kohya"` appears **zero** times in the document |
| **Only one Wallet tab** | Existing behaviour. `fiatEnabled` and `blockchainEnabled` are both derived from one `beta.paymentMode` (`renderer/api.js:121-122`) and are mutually exclusive **by construction**. Proven in both directions by booting twice |
| **`ComfyUI` absent when disabled** | Existing behaviour, and the gate's control: with `comfyUIEnabled: false` there is no tab node **and** no `.comfy-webview-container` |

🔴 **And one difference that is mine.** WO-G1 asked for a tab set of *exactly*
five — `ComfyUI · Kohya_ss · Workspace · Wallet(fiat) · Wallet(blockchain)`. **The
app has never drawn that and cannot.** Five is the set of tabs it *can* draw, not a
set it draws at once. I wrote that sentence and it was wrong; the gate asserts the
app's real behaviour. The alternative was to change the app until it matched my
sentence, which is the D5 mistake with the polarity reversed.

### Changes to the app's own code — the complete list

1. `config/config-testnet.js` — one comma. Without it nothing runs.
2. `lock/executors/` — restored layout. Without it every chain lock throws.
3. `wallet/ravencoin/wallet.js`, `wallet-testnet.js` — four `require('../../…')`
   corrected to `'./…`. Dead fallback paths inside `try`/`catch`, pre-existing in
   both snapshots, unreachable while the primary require succeeds. Fixed because a
   fallback that cannot load is a landmine for the day the primary path fails.
4. `preload.js` — 12 host channels added. No app channel shadowed; asserted.
5. `main-modular.js` — six edits, all additive: the host-seam require, a
   navigation recorder, `registerHostIpc()`, `announceProfile()`, the
   `--probe=`/`--scenario=` driver hook, and `will-quit` reaping.
6. Five witness call sites routed through `config/witness-endpoint.js`.

**Nothing in `renderer/` was edited.** The interface is the spec.

---

## Two defects found and deliberately NOT fixed

Recording them rather than fixing them, because both change behaviour a person may
be relying on, and G1's remit is to make the app run.

**1. The View menu and startup disagree about the wallet.** `beta.paymentMode` is
what the renderer reads at startup (`renderer/api.js:117-122`). `beta.rvnMode` is
what the View menu reads and writes (`main-modular.js:374-386`). They mean the
same thing and nothing keeps them in step, so **switching the wallet from the menu
and restarting can put the tab back**. The G1 gate seeds both, which is how it
surfaced. → a `FINDINGS-WIN.md` candidate for G3.

**2. `wallet/wallets-index.js` requires `./rvn/*`, a directory that does not
exist.** Nothing requires the file, so nothing fails. Dead code with wrong paths.

---

## What is proven, and what is not

**Proven.** The app boots on Electron 38.8.6 (Chromium 140, Node 22.22.0) and
renders its own interface: 11,559 characters of it, sidebar at the canon
`rgb(17, 24, 39)`, the project directory and the tracked-project section both
present, no `[data-region]` node anywhere. `ping` round-trips through the main
process; `vault-capture` passes 24/24 unchanged on the new shell.

**Not proven, and not claimed.** Nobody has clicked anything. Every result here
comes from a scripted boot, **which is exactly how D5's missing tabs survived
seven work orders.** The tab bar is asserted to exist and to contain the right
set; whether the app is *usable* is WO-G3's question and only a person can answer
it. Checkpoint, lock and mint have not been exercised — that is G2.

The witness default is now the surrogate, so any lock performed before G2 lands
produces a `passthrough` leaf. That is honest and it is also useless as a receipt.
**A green G1 is "the app runs", not "the app witnesses".**
