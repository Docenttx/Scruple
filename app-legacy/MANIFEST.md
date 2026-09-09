# SCRUPLE Studio — Snapshot Bundle

**Source:** `/mnt/project/` snapshot, dated 2026-05-12 05:26–05:27
**Generated:** 2026-05-12

> ⚠️ **Staleness warning:** Per the standing project rule, `/mnt/project/` is the
> last project-knowledge snapshot, NOT necessarily what's on your dev machine
> right now. Verify against `D:\Scruple - Modular\Scruple Studio M\scruple-studio\`
> before treating this as authoritative.

---

## Included (51 files)

### Root
- `context.js`, `database.js`, `index-final.html`, `main-modular.js`, `preload.js`, `package.json`

### `config/`
- `config-testnet.js`

### `ipc/`
- `ipc-barrel.js`, `ipc-lock-handlers.js`, `ipc-project-handlers.js`,
  `ipc-settings-handlers.js`, `ipc-training-handlers.js`, `ipc-wallet-handlers.js`

### `lock/`
- `lock-barrel.js`, `lock-chain-lock.js`, `lock-local-lock.js`,
  `lock-package-builder.js`, `merkle.js`
- **Newer (not in `scruple-studio-structure.txt`, placed here by inference):**
  `lock-executor-blockchain.js`, `lock-executor-fiat.js`, `lock-executor-server.js`

### `renderer/`
- `api.js`, `bundle-final.js`, `handlers.js`, `render-main.js`,
  `render-wallet.js`, `render-wallet-testnet.js`, `render-workspace.js`, `state.js`

### `renderer/styles/`
- `main.css`, `wallet.css`

### `server/`
- `witness-index.js`, `witness-client.js`
- **Newer (placed here by inference):** `tsd-client.js`

### `wallet/`
- `wallets-index.js`

### `wallet/ipfs/`
- `ipfs-config.js`, `ipfs-index.js`, `ipfs-pinner.js`, `ipfs-uploader.js`

### `wallet/ravencoin/`
- `asset-encoder.js`, `asset-encoder-testnet.js`, `assets.js`,
  `electrumx-client.js`, `electrumx-client-testnet.js`,
  `native-issuer.js`, `native-issuer-testnet.js`,
  `price.js`, `rvn-index.js`,
  `wallet.js`, `wallet-testnet.js`,
  `wallets-integration-native.js`, `wallets-integration-native-testnet.js`

---

## Files in canonical structure but MISSING from snapshot

These need to come from your dev machine. The bundle will not run without them:

### `capture/comfyui/` — all 4 files missing
- `leaf-handler.js`
- `server.js`
- `session.js`
- `watcher.js`

### `capture/training/` — all 7 files missing
- `hash-worker.js`
- `training-barrel.js`
- `training-capture-handler.js`
- `training-completion-handler.js`
- `training-hasher.js`
- `training-output-watcher.js`
- `training-toml-watcher.js`

### `server/`
- `mock-server.js` (may have been deprecated by `tsd-client.js`)

### `wallet/arweave/`
- `arweave-index.js`
- `test-arweave.js`

### `wallet/ipfs/`
- `test-ipfs.js`

---

## Placement decisions to verify

Three files from the snapshot are not in `scruple-studio-structure.txt`. I placed
them where their names suggest they belong — confirm before relying on this:

| File | Placed at | Rationale |
|---|---|---|
| `lock-executor-blockchain.js` | `lock/` | Lock executor, paired with the other lock modules |
| `lock-executor-fiat.js` | `lock/` | Lock executor (fiat path for Stripe integration) |
| `lock-executor-server.js` | `lock/` | Lock executor (server-side execution path) |
| `tsd-client.js` | `server/` | Server-witness adjacent (replaces mock-server.js per memory notes) |

---

## Excluded from this bundle

- `.bak` files (`render-main_js.bak`, `render-wallet_js.bak`, `render-wallet-testnet_js.bak`, `lock-executor-fiat_js.bak`)
- Documentation/handoff files (`HANDOFF-*.md`, `CHAT*-INSTRUCTIONS-*.md`, `PLAN-*.md`, `NOTE-*.md`, `WORKORDER-*.md`, `DESIGN-*.md`, `IMPLEMENTATION-*.md`, `SERVER-*.md`)
- Directory-structure docs (`Scruple_Studio_Directory_Structure.docx`, `scruple-studio-structure.txt`, `TOML_and_Config_file_pivot.docx`)
- Oracle server files (see `oracle-server/` zip)
- ComfyUI custom node Python files (see `comfyui-nodes/` zip)
