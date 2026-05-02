# Scruple × Stooges — Definitive Build Specification
_2026-04-08T16:01:52.644Z_



# Scruple Studio × Stooges: Definitive Build Specification

---

## Executive Summary

- **Scruple Studio is Electron middleware** that instruments ComfyUI via injected Python nodes, a local Express server, a FileWatcher, and an IPC-bridged renderer — capturing every AI generation into a chained, Merkle-treed, witness-attested provenance record.
- **Stooges doesn't need 80% of this machinery.** Because Stooges *is* the generation orchestrator (not a sidecar to one), the entire FileWatcher/InternalServer/ComfyUI-node layer is irrelevant. Stooges captures provenance inline, at the moment of generation.
- **The reusable core is small and pure:** the SHA-256 hash-chain algorithm, the binary Merkle tree construction, the witness server REST protocol, the Oracle lock/mint endpoints, and the Stripe payment flow. These are portable TypeScript functions and HTTP calls.
- **The human approval gate that Stooges already requires IS the provenance boundary.** The moment a user clicks "Generate this image," inputs are sealed. The moment DALL-E returns bytes, outputs are sealed. Provenance capture is architecturally free.
- **Recommended path: direct API-route integration** — no Electron, no bridge, no middleware. A `lib/provenance/` module in the Stooges Next.js codebase that implements hashing, Merkle computation, and witness/lock calls. Phase 1 is ~5 files, ~800 lines of TypeScript.

---

## 1. What Scruple Studio Actually Is

Scruple Studio is a **three-process Electron desktop application** functioning as a provenance sidecar to ComfyUI:

### Process Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MAIN PROCESS (Node.js)  —  main-modular.js                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ FileWatcher   │  │InternalServer│  │ SessionManager    │ │
│  │ monitors      │  │ Express HTTP │  │ writes            │ │
│  │ output/       │  │ on dynamic   │  │ scruple_session   │ │
│  │ terminal_     │  │ port         │  │ .txt into ComfyUI │ │
│  │ provenance/   │  │              │  │ dir               │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────┘ │
│         │                  │                                 │
│         ▼                  ▼                                 │
│  ┌─────────────────────────────────────┐                    │
│  │       handleNewLeaf()               │                    │
│  │  hash → chain → merkle → witness    │                    │
│  │  → SQLite → IPC emit               │                    │
│  └─────────────────────────────────────┘                    │
│         │                                                    │
│  ┌──────┴──────────────────────────────┐                    │
│  │  context.js  (shared singleton bag) │                    │
│  │  Holds: db, merkle, witness, wallet │                    │
│  └─────────────────────────────────────┘                    │
│         │                                                    │
│  ┌──────┴──────────────────────────────┐                    │
│  │  DatabaseManager (better-sqlite3)   │                    │
│  │  ~/.scruple/database/scruple.db     │                    │
│  │  Tables: projects, iterations,      │                    │
│  │  merkle_nodes, training_runs,       │                    │
│  │  checkpoints, files_registry        │                    │
│  └─────────────────────────────────────┘                    │
├─────────────────────────────────────────────────────────────┤
│  PRELOAD  —  preload.js                                      │
│  contextBridge.exposeInMainWorld('scruple', { ... })        │
│  Context isolation: ON  │  nodeIntegration: OFF              │
│  ~53 methods + 20 event channels                             │
├─────────────────────────────────────────────────────────────┤
│  RENDERER  —  index-final.html                               │
│  Pure UI. Zero filesystem/DB/network access.                 │
│  All operations via window.scruple.* only.                   │
└─────────────────────────────────────────────────────────────┘

        ▲ POST (JSON leaf data)
        │
┌───────┴─────────────────────────────────┐
│  COMFYUI CUSTOM NODES (Python)          │
│  ComfyUI-Scruple/                       │
│                                          │
│  ScrupleTap          → capture inputs    │
│  ScrupleOutputCapture → capture outputs  │
│  ScrupleStudioTerminal → POST to server  │
│  ScrupleTrainingTerminal → training POST │
│                                          │
│  These are PASSIVE SENSORS.              │
│  They hash and POST. They don't modify   │
│  the generation.                         │
└──────────────────────────────────────────┘

        ▲ REST calls (HTTPS)
        │
┌───────┴─────────────────────────────────┐
│  ORACLE WITNESS SERVER                   │
│  129.80.23.93:5799                       │
│                                          │
│  /api/witness    — record iteration hash │
│  /api/lock       — finalize chain lock   │
│  /api/testnet-lock — mint RVN asset      │
│  /api/stripe/*   — payment processing    │
│  /api/verify     — proof verification    │
│                                          │
│  Independent third-party timestamp.      │
│  User cannot forge witness records.      │
└──────────────────────────────────────────┘
```

### Why This Architecture Exists

ComfyUI is a third-party tool Scruple cannot modify. Therefore Scruple must:
1. **Inject telemetry sensors** (Python custom nodes) into ComfyUI's workflow
2. **Run a local HTTP server** for those nodes to POST to
3. **Watch the filesystem** for output files
4. **Coordinate via session files** (`scruple_session.txt`)

This entire instrumentation layer is unnecessary when the application *is* the generation orchestrator — which is Stooges' situation.

---

## 2. The `window.scruple.*` IPC Surface

Complete enumeration of every method exposed through the preload bridge:

### State & Setup (5 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `getState()` | none | `{ initialized, comfyuiPath, activeProject, ... }` | Full app state snapshot |
| `setupComfyUIPath(path)` | `string` | `{ success }` | First-run ComfyUI directory config |
| `setupPaths(paths)` | `{ comfyui, output, ... }` | `{ success }` | Multi-path configuration |
| `browseFolder()` | none | `string \| null` | OS native folder picker dialog |
| `browseFile(fileType)` | `string` | `string \| null` | OS native file picker dialog |

### Project Operations (8 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `createProject(name, type)` | `string, 'txt2img' \| 'training'` | `{ id, name, ... }` | Create provenance container |
| `getProjects()` | none | `Project[]` | List all projects |
| `getProject(id)` | `number` | `Project` | Single project with all fields |
| `getIterations(projectId)` | `number` | `Iteration[]` | All iterations for project |
| `readImage(projectName, file)` | `string, string` | `base64 string` | Read image from project folder |
| `activateProject(id)` | `number` | `{ success }` | Set as active capture target |
| `deactivateProject()` | none | `{ success }` | Clear active project |
| `archiveProject(id)` | `number` | `{ success }` | Soft delete |

### Lock Operations (4 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `localDiscLock(projectId, authToken)` | `number, string` | `{ scrId, merkleRoot, packageHash }` | Tier 1: Seal Merkle root locally |
| `singleChainLock(projectId, password)` | `number, string` | `{ rvnTxid, arweaveTxid }` | Tier 2: Blockchain anchor |
| `persistentChainLock(projectId)` | `number` | `{ arweaveUri, ipfsCid }` | Tier 3: Permanent storage |
| `checkpointProject(projectId, authToken)` | `number, string` | `{ checkpointHash }` | Mid-project snapshot |

### Stripe Payment (3 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `stripeGetConfig()` | none | `{ publishableKey }` | Get Stripe public key |
| `stripeCreatePaymentIntent(action, projectId)` | `string, number` | `{ clientSecret, intentId }` | Create payment intent |
| `stripeConfirmAndExecute(intentId, action, projectId, opts)` | `string, string, number, object` | `{ success, result }` | Pay and execute lock |

### Training Runs (6 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `getTrainingRuns(projectId)` | `number` | `TrainingRun[]` | List training runs for project |
| `getAllTrainingRuns()` | none | `TrainingRun[]` | All training runs |
| `getTrainingRun(trainingId)` | `number` | `TrainingRun` | Single training run |
| `lockTrainingRun(id, lockType, password)` | `number, string, string` | `{ success }` | Lock individual training run |
| `detectKohyaPort()` | none | `{ port } \| null` | Find Kohya_ss instance |
| `getCaptureStatus()` | none | `{ capturing, target, ... }` | Pipeline status |

### Witness System (1 method)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `getWitnessStatus()` | none | `{ initialized, online, serverUrl }` | Witness server health |

### Interlock (1 method)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `setInterlock(busy)` | `boolean` | `{ success }` | Prevent concurrent lock operations |

### RVN Wallet (15 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `rvnWalletStatus()` | none | `{ exists, unlocked, address }` | Wallet state |
| `rvnWalletCreate(password)` | `string` | `{ address, mnemonic }` | Generate new wallet |
| `rvnWalletImport(mnemonic, password)` | `string, string` | `{ address }` | Import from seed |
| `rvnWalletUnlock(password)` | `string` | `{ success }` | Decrypt wallet |
| `rvnWalletLock()` | none | `{ success }` | Re-encrypt wallet |
| `rvnWalletDelete(confirmation)` | `string` | `{ success }` | Destroy wallet |
| `rvnWalletVerifyPassword(password)` | `string` | `boolean` | Check password |
| `rvnGetBalance()` | none | `{ confirmed, unconfirmed }` | RVN balance |
| `rvnGetAddress()` | none | `string` | Receive address |
| `rvnGetFeeQuote()` | none | `{ fee }` | Current fee estimate |
| `rvnGetCosts()` | none | `{ localLock, chainLock, ... }` | Operation cost table |
| `rvnGetPrice()` | none | `{ usd }` | RVN/USD price |
| `rvnCheckAssetExists(assetName)` | `string` | `boolean` | Check asset name availability |
| `rvnGetAssetData(assetName)` | `string` | `{ ipfsHash, ... }` | Asset metadata |
| `rvnVerifyProof(scrId, merkleRoot)` | `string, string` | `{ verified, txid }` | On-chain proof verification |

### IPFS Config (3 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `ipfsGetConfig()` | none | `{ host, port, protocol }` | Current settings |
| `ipfsSaveConfig(config)` | `object` | `{ success }` | Update settings |
| `ipfsTestConnection()` | none | `{ online, peerId }` | Ping IPFS node |

### Arweave Wallet (5 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `arweaveImportKey()` | none (opens file dialog) | `{ address }` | Import JWK keyfile |
| `arweaveGetStatus()` | none | `{ connected, address }` | Wallet status |
| `arweaveDisconnect()` | none | `{ success }` | Remove wallet |
| `arweaveGetBalance()` | none | `{ ar, winston }` | AR balance |
| `arweaveMintTestAr()` | none | `{ success }` | Testnet faucet |

### Preflight & Utility (3 methods)

| Method | Parameters | Returns | Purpose |
|--------|-----------|---------|---------|
| `preflightTraining(projectId)` | `number` | `{ valid, errors[] }` | Validate training inputs |
| `openExternal(url)` | `string` | `void` | Open URL in system browser (direct `shell.openExternal`, no IPC) |
| `openFolder(folderPath)` | `string` | `{ success }` | Open folder in file manager |

### Event System (2 methods, 20 valid channels)

| Method | Purpose |
|--------|---------|
| `on(channel, callback)` | Subscribe to IPC events |
| `off(channel, callback)` | Unsubscribe |

**Valid channels:** `initialized`, `needs-setup`, `leaf-added`, `leaf-error`, `watcher-error`, `interlock-changed`, `project-changed`, `tab-settings-changed`, `log`, `training-added`, `training-complete`, `training-error`, `checkpoint-added`, `witness-status`, `preflight-progress`, `preflight-complete`, `kohya-connected`, `kohya-disconnected`, `toml-detected`, `training-run-created`

**Grand Total: ~53 methods + 20 event channels.**

---

## 3. The Manifest Format

The `ScrupleStudioTerminal` Python node (`studio_terminal.py`) produces a JSON leaf file written to `output/terminal_provenance/`. This is also what gets POSTed to the InternalServer. The structure:

### Leaf File (per-generation event)

```json
{
  "version": "1.0",
  "type": "txt2img",
  "timestamp": "2024-01-15T14:32:01.123Z",
  "session_id": "scruple_session_abc123",
  "sequence": 7,

  "inputs": {
    "prompt": "a sunset over mountains, oil painting style",
    "negative_prompt": "blurry, low quality",
    "seed": 42,
    "cfg_scale": 7.5,
    "steps": 20,
    "sampler": "euler_ancestral",
    "scheduler": "normal",
    "width": 512,
    "height": 512,
    "model": {
      "name": "sd_xl_base_1.0.safetensors",
      "hash": "a1b2c3d4e5f6..."
    },
    "loras": [
      {
        "name": "detail_enhancer.safetensors",
        "hash": "f6e5d4c3b2a1...",
        "strength": 0.8
      }
    ]
  },

  "outputs": {
    "images": [
      {
        "filename": "ComfyUI_00042_.png",
        "hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      }
    ]
  },

  "input_hash": "sha256:<hash of canonical JSON of inputs>",
  "output_hash": "sha256:<hash of image bytes>",
  "content_hash": "sha256:<hash of input_hash + output_hash>",
  "previous_hash": "sha256:<leaf_hash of sequence 6>",
  "leaf_hash": "sha256:<hash of previous_hash + content_hash + timestamp>"
}
```

### Lock Package (per-project, generated at Tier 1)

```json
{
  "version": "1.0",
  "scr_id": "SCR-xxxxxxxx",
  "project": {
    "id": 1,
    "name": "Mountain Sunset Series",
    "type": "txt2img",
    "created_at": "2024-01-15T10:00:00Z",
    "locked_at": "2024-01-15T16:00:00Z"
  },
  "provenance": {
    "iteration_count": 42,
    "merkle_root": "sha256:abcdef...",
    "chain": [
      {
        "sequence": 1,
        "leaf_hash": "sha256:...",
        "input_hash": "sha256:...",
        "output_hash": "sha256:...",
        "previous_hash": null,
        "timestamp": "...",
        "witness_id": "wit_...",
        "witness_timestamp": "...",
        "control_index": 0.73
      },
      {
        "sequence": 2,
        "leaf_hash": "sha256:...",
        "input_hash": "sha256:...",
        "output_hash": "sha256:...",
        "previous_hash": "sha256:<leaf_hash of seq 1>",
        "timestamp": "...",
        "witness_id": "wit_...",
        "witness_timestamp": "...",
        "control_index": 0.65
      }
    ],
    "merkle_tree": {
      "levels": [
        [{ "position": 0, "hash": "..." }, { "position": 1, "hash": "..." }],
        [{ "position": 0, "hash": "...", "left": "...", "right": "..." }]
      ]
    }
  },
  "witness": {
    "server": "129.80.23.93:5799",
    "session_records": ["wit_001", "wit_002", "..."],
    "final_signature": "..."
  },
  "package_hash": "sha256:<hash of entire package minus this field>"
}
```

### Hash Construction Rules

```
input_hash  = SHA-256(canonical_json(inputs))
output_hash = SHA-256(raw_image_bytes)
content_hash = SHA-256(input_hash + output_hash)
leaf_hash   = SHA-256(previous_hash + content_hash + timestamp)
                      ↑ null/"0" for first iteration

merkle_parent = SHA-256(left_child_hash + right_child_hash)
merkle_root   = top-level single hash after tree construction

package_hash  = SHA-256(entire_package_json_without_package_hash_field)
```

The **chaining** (`previous_hash` → `leaf_hash`) means every leaf depends on all prior leaves. You cannot insert, delete, or reorder without breaking the chain. The Merkle tree then provides O(log n) verification of any individual leaf.

---

## 4. The Lock Tier Progression

### Tier 0: Unlocked — Active Capture

| Property | Value |
|----------|-------|
| **Status** | `'unlocked'`, `is_active = 1` |
| **What's happening** | FileWatcher running, iterations accumulating, Merkle tree growing incrementally, witness server receiving real-time hashes |
| **DB state** | `iterations` rows growing, `merkle_nodes` being rebuilt, `projects.merkle_root` updated after each leaf |
| **Prerequisites** | Project created, ComfyUI path configured, active project set |
| **Reversible?** | N/A — this is the working state |
| **External calls** | `witnessIteration()` → Oracle on each leaf |

### Tier 1: Local Disc Lock (`localDiscLock`)

| Property | Value |
|----------|-------|
| **Status** | `'locked'` |
| **What it does** | 1. Finalizes Merkle tree, computes definitive `merkle_root`. 2. Generates `scr_id` (Scruple Content Record ID). 3. Builds the Scruple Package JSON (all iterations, Merkle tree, witness records). 4. Computes `package_hash` over entire package. 5. Writes package to local filesystem. 6. Sets `status = 'locked'`. |
| **Prerequisites** | Project unlocked. ≥1 iteration. Valid `authToken` (Stripe payment or TSD credit). |
| **DB fields populated** | `merkle_root`, `scr_id`, `pre_scr_id`, `package_hash`, `status`, `locked_at` |
| **External calls** | Oracle payment verification (Stripe or TSD) |
| **Reversible?** | **NO.** This is the point of no return. No more iterations can be added. |

### Tier 2: Single Chain Lock (`singleChainLock`)

| Property | Value |
|----------|-------|
| **Status** | `'chain_locked'` |
| **What it does** | 1. Takes locally-locked project (`scr_id` + `merkle_root` must exist). 2. POSTs to Oracle `/api/testnet-lock`. 3. Oracle mints Ravencoin unique asset with SCR-ID as name and Merkle root in IPFS metadata. 4. May also upload package to Arweave. 5. Stores `rvn_txid` and optional `arweave_txid`. |
| **Prerequisites** | Must be local-locked (Tier 1 complete). Requires wallet password OR Oracle server-side execution. Payment required. |
| **DB fields populated** | `rvn_txid`, `arweave_txid` |
| **External calls** | Oracle `/api/testnet-lock` → Ravencoin network mint |
| **Reversible?** | **NO.** Blockchain transaction is permanent. |

### Tier 3: Persistent Chain Lock (`persistentChainLock`)

| Property | Value |
|----------|-------|
| **Status** | `'persistent_locked'` |
| **What it does** | 1. Uploads full provenance package to permanent decentralized storage. 2. Arweave upload (permanent, paid by AR). 3. IPFS pin (content-addressed). 4. Records `arweave_uri` and `ipfs_cid` on project. |
| **Prerequisites** | Must be chain-locked (Tier 2 complete). IPFS node configured. Arweave wallet funded. Payment required. |
| **DB fields populated** | `arweave_uri`, `ipfs_cid` |
| **External calls** | Arweave upload, IPFS pin |
| **Reversible?** | **NO.** Arweave is permanent by design. |

### Special: Checkpoint (`checkpointProject`)

| Property | Value |
|----------|-------|
| **Status** | Remains `'unlocked'` |
| **What it does** | Computes a snapshot Merkle root over current iterations. Witnesses the checkpoint. Records it in `checkpoints` table. **Does NOT stop capture.** |
| **Prerequisites** | Active project with iterations. Auth token. |
| **Use case** | "Prove what existed at this point in time, but keep working" |
| **Reversible?** | Project continues. Checkpoint is permanent record. |

### Special: Training Run Lock (`lockTrainingRun`)

| Property | Value |
|----------|-------|
| **What it does** | Locks an individual LoRA training run independently of the parent project. Captures dataset Merkle, base model hash, training params hash, output model hash. |
| **Prerequisites** | Completed training run with all hash fields populated. |
| **Separate from project lock tier** | Yes — parallel track for training provenance. |

### Progression Enforcement

```
Unlocked ──► Local Lock ──► Chain Lock ──► Persistent Lock
              (Tier 1)       (Tier 2)       (Tier 3)
                 │               │               │
           Seal Merkle     Mint RVN asset   Upload to
           + SCR-ID        with root in     Arweave +
           + Package       metadata         IPFS
                 │               │               │
           scr_id ✓        rvn_txid ✓       arweave_uri ✓
           merkle_root ✓                    ipfs_cid ✓
```

Each tier **checks for the output of the previous tier.** `singleChainLock` checks `project.scr_id` and `project.merkle_root` exist. `persistentChainLock` checks `project.rvn_txid` exists. The code enforces strict ordering.

---

## 5. Top 3 Integration Options for Stooges

### Option A: Direct API-Route Integration — "Provenance is a library, not a service"

**One sentence:** Port the hash-chain, Merkle tree, and witness/lock protocol into a TypeScript library that Stooges API routes call inline during image generation.

**Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│  Stooges Next.js Application                            │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  /api/bits/[bitId]/generate-image                  │ │
│  │                                                     │ │
│  │  1. Receive approved prompt from human gate         │ │
│  │  2. input_hash = hash(prompt + model + params)      │ │
│  │  3. Call DALL-E / Leonardo API                      │ │
│  │  4. output_hash = hash(image_bytes)                 │ │
│  │  5. leaf_hash = hash(prev + content + timestamp)    │ │
│  │  6. witnessIteration() → Oracle                     │ │
│  │  7. Store provenance in Stooges DB                  │ │
│  │  8. Upload image to GDrive                          │ │
│  │  9. Return { image, provenance } to client          │ │
│  └──────────────┬─────────────────────────────────────┘ │
│                  │                                        │
│  ┌──────────────▼─────────────────────────────────────┐ │
│  │  lib/provenance/                                    │ │
│  │                                                     │ │
│  │  hasher.ts      — SHA-256 chain computation         │ │
│  │  merkle.ts      — Binary Merkle tree                │ │
│  │  witness.ts     — Oracle witness REST client        │ │
│  │  lock.ts        — Oracle lock REST client           │ │
│  │  package.ts     — Scruple Package builder           │ │
│  └─────────────────────────────────────────────────────┘ │
│                  │                                        │
│  ┌──────────────▼─────────────────────────────────────┐ │
│  │  Stooges Database (Postgres via Prisma/Drizzle)    │ │
│  │                                                     │ │
│  │  image_provenance table                             │ │
│  │  (session_id, sequence, input_hash, output_hash,    │ │
│  │   leaf_hash, previous_hash, witness_id, ...)        │ │
│  └─────────────────────────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS
                ┌───────────▼───────────┐
                │  Oracle Witness Server │
                │  129.80.23.93:5799     │
                │                        │
                │  /api/witness           │
                │  /api/lock              │
                │  /api/testnet-lock      │
                │  /api/stripe/*          │
                └────────────────────────┘
```

**What gets reused from Scruple:**
- Hash algorithm (SHA-256 chain: `previous_hash + content_hash + timestamp`) — direct port from `handleNewLeaf()` in `main-modular.js`
- Merkle tree algorithm — direct port from `MerkleManager` in `merkle.js`
- Witness protocol — direct port from `witness-client.js` (simple REST POSTs)
- Lock protocol — direct port from `lock-barrel.js` (REST POSTs to Oracle)
- Stripe flow — direct port from `stripe-client.js`
- Package format — same JSON structure, built in TypeScript

**What gets rebuilt:**
- Storage layer (Postgres instead of SQLite, Prisma/Drizzle instead of better-sqlite3)
- No FileWatcher, no InternalServer, no session files
- No IPC bridge (it's a web app)
- No wallet management UI (Oracle handles chain operations server-side)
- UI components in React (Stooges stack) instead of vanilla JS DOM manipulation

**Build sequence:**
1. `lib/provenance/hasher.ts` — pure hash functions (day 1)
2. `lib/provenance/merkle.ts` — Merkle tree (day 1)
3. `lib/provenance/witness.ts` — Oracle client (day 2)
4. DB migration: `image_provenance` table (day 2)
5. `/api/bits/[bitId]/generate-image` — inline capture (day 3)
6. `/api/bits/[bitId]/lock` — lock operations (day 4)
7. UI: provenance badge on generated images (day 5)

**Recommended: YES — this is the recommended option.**

---

### Option B: Sidecar Microservice — "Provenance as a service"

**One sentence:** Run a standalone Node.js provenance service (extracted from Scruple's main process) that Stooges API routes call via HTTP, keeping provenance logic completely decoupled.

**Architecture:**
```
┌──────────────────────┐        ┌──────────────────────────┐
│  Stooges Next.js     │  HTTP  │  Provenance Service      │
│                      │◄──────►│  (Node.js, port 5800)    │
│  /api/generate-image │        │                          │
│  calls provenance    │        │  POST /leaf              │
│  service after each  │        │  POST /lock              │
│  generation          │        │  GET  /tree/:projectId   │
│                      │        │  GET  /verify/:scrId     │
│                      │        │                          │
│                      │        │  SQLite (own DB)         │
│                      │        │  + Oracle witness calls  │
└──────────────────────┘        └──────────────────────────┘
```

**What gets reused:** Most of `main-modular.js`, `database.js`, `merkle.js`, `witness-client.js`, `lock-barrel.js` — with Electron IPC stripped out and Express routes added.

**What gets rebuilt:** Express API wrapper around existing logic. Deployment config. Health checks. Auth between Stooges and the sidecar.

**Build sequence:**
1. Strip Electron from `main-modular.js`, expose as Express routes (days 1-3)
2. Add auth middleware (API key between Stooges ↔ sidecar) (day 3)
3. Stooges API routes call sidecar after each generation (day 4)
4. Deploy both services (day 5)

**Recommended: NO.** This adds operational complexity (two services to deploy, monitor, and keep in sync) without meaningful benefit. The provenance logic is ~400 lines of pure functions. Running a separate service for that is over-engineering. The only scenario where this makes sense is if multiple applications need provenance (not just Stooges) — which is not the current requirement.

---

### Option C: Client-Side Provenance — "The browser computes, the server stores"

**One sentence:** Run hash computation and Merkle tree building in the browser (via Web Crypto API), with the server only storing results and calling the witness server.

**Architecture:**
```
┌─────────────────────────────────────────────────┐
│  Browser (Stooges React Client)                  │
│                                                  │
│  1. User approves image generation               │
│  2. Browser computes input_hash via SubtleCrypto │
│  3. Server generates image, returns bytes        │
│  4. Browser computes output_hash                 │
│  5. Browser computes leaf_hash (chain link)      │
│  6. Browser sends all hashes to server           │
│  7. Server stores + witnesses                    │
└───────────────────────┬─────────────────────────┘
                        │
              ┌─────────▼──────────┐
              │  Stooges API       │
              │  /api/store-leaf   │
              │  /api/lock         │
              │  Calls Oracle      │
              └────────────────────┘
```

**What gets reused:** Same algorithms, ported to browser-compatible TypeScript using `crypto.subtle` instead of Node's `crypto`.

**What gets rebuilt:** All hash functions using Web Crypto API (async). Client-side Merkle tree. Client-server sync protocol.

**Recommended: NO.** This is architecturally elegant but practically wrong. The browser doesn't have the image bytes before the server processes them (DALL-E returns to the server). You'd have to transfer full image bytes to the client just for hashing, then back. More critically: **client-side provenance is forgeable.** A modified client could submit fake hashes. The whole point of provenance is that the system computing it is trusted. Server-side computation with independent witness attestation is the only architecture that provides real guarantees.

---

## 6. Recommended Option — Full Build Spec (Option A: Direct API-Route Integration)

### The Human Approval Gate

The human approval gate is the natural provenance boundary. Here's the exact design:

```
┌─────────────────────────────────────────────────────────┐
│                    STOOGES UI                             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Council Discussion Panel                          │ │
│  │                                                     │ │
│  │  Larry: "For this scene, I'd suggest a warm        │ │
│  │  sunset palette with dramatic clouds..."            │ │
│  │                                                     │ │
│  │  Curly: "I think we should include mountain         │ │
│  │  silhouettes in the foreground..."                  │ │
│  │                                                     │ │
│  │  Moe (Conductor): "Based on the discussion,        │ │
│  │  I recommend generating with this prompt:"          │ │
│  │                                                     │ │
│  │  ┌──────────────────────────────────────────────┐  │ │
│  │  │  "A dramatic sunset over mountain silhouettes │  │ │
│  │  │   with warm orange and purple tones, oil      │  │ │
│  │  │   painting style, dramatic cloud formations"  │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                     │ │
│  │  Model: DALL-E 3                                    │ │
│  │  Size: 1024x1024                                    │ │
│  │  Quality: HD                                        │ │
│  │                                                     │ │
│  │  ┌─────────────────┐  ┌───────────────────────┐   │ │
│  │  │  ✓ APPROVE &    │  │  ✗ REJECT / MODIFY    │   │ │
│  │  │    GENERATE     │  │                        │   │ │
│  │  └────────┬────────┘  └───────────────────────┘   │ │
│  │           │                                        │ │
│  │     ══════╪════════════════════════════════════    │ │
│  │     PROVENANCE BOUNDARY — inputs sealed here       │ │
│  │     ══════╪════════════════════════════════════    │ │
│  │           │                                        │ │
│  │           ▼                                        │ │
│  │  ┌──────────────────────────────────────────────┐ │ │
│  │  │  🔒 Generating with provenance capture...    │ │ │
│  │  │  ████████████░░░░░░░░  45%                   │ │ │
│  │  │                                               │ │ │
│  │  │  ✓ Input hash sealed                          │ │ │
│  │  │  ⟳ Waiting for DALL-E response...             │ │ │
│  │  │  ○ Output hash pending                        │ │ │
│  │  │  ○ Witness attestation pending                │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  │                                                    │ │
│  │  After generation:                                 │ │
│  │  ┌──────────────────────────────────────────────┐ │ │
│  │  │  [Generated Image]              Provenance:  │ │ │
│  │  │  ┌──────────────┐              SCR #7        │ │ │
│  │  │  │              │              Chain: ✓      │ │ │
│  │  │  │   🖼️ Image   │              Witness: ✓    │ │ │
│  │  │  │              │              Leaf: a3f2... │ │ │
│  │  │  └──────────────┘                            │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**The key insight:** The "Approve & Generate" button is NOT just a UX gate — it is a cryptographic event. The instant it's clicked:
1. The prompt text, model selection, and all parameters are frozen
2. `input_hash` is computed from these frozen values
3. The generation API call proceeds
4. When DALL-E returns, `output_hash` is computed from the raw bytes
5. These two hashes, plus the previous leaf's hash, produce the `leaf_hash`

The human cannot change the prompt after clicking approve. The AI cannot change what it received. The output is what the API returned. The chain links it to everything before.

---

### The Generation Capture Flow

```typescript
// /api/bits/[bitId]/generate-image.ts

import { computeInputHash, computeOutputHash, computeLeafHash } from '@/lib/provenance/hasher';
import { addLeafToTree } from '@/lib/provenance/merkle';
import { witnessIteration } from '@/lib/provenance/witness';

export async function POST(req: Request, { params }: { params: { bitId: string } }) {
  const { prompt, model, size, quality, style, sessionId } = await req.json();
  const bitId = params.bitId;

  // ─── STEP 1: Get previous hash for chain linkage ───
  const prevIteration = await db.imageProvenance.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
  });
  const previousHash = prevIteration?.leafHash ?? '0'.repeat(64);
  const sequence = (prevIteration?.sequence ?? 0) + 1;

  // ─── STEP 2: Seal inputs ───
  const timestamp = new Date().toISOString();
  const inputParams = {
    prompt,
    model,          // "dall-e-3"
    size,           // "1024x1024"
    quality,        // "hd"
    style,          // "natural"
  };
  const inputHash = computeInputHash(inputParams);

  // ─── STEP 3: Generate image ───
  const imageResponse = await openai.images.generate({
    model,
    prompt,
    size,
    quality,
    n: 1,
    response_format: 'b64_json',
  });
  const imageBytes = Buffer.from(imageResponse.data[0].b64_json!, 'base64');

  // ─── STEP 4: Seal output ───
  const outputHash = computeOutputHash(imageBytes);

  // ─── STEP 5: Compute leaf hash (chain link) ───
  const leafHash = computeLeafHash(inputHash, outputHash, previousHash, timestamp);

  // ─── STEP 6: Witness with Oracle ───
  let witnessRecord = null;
  try {
    witnessRecord = await witnessIteration({
      projectId: sessionId,
      name: `${bitId}-gen-${sequence}`,
      sequence,
      contentHash: leafHash,
      visualHash: outputHash,
      timestamp,
    });
  } catch (e) {
    // Witness failure is non-fatal — local record still valid
    console.error('Witness server unavailable:', e);
  }

  // ─── STEP 7: Store provenance record ───
  const provenance = await db.imageProvenance.create({
    data: {
      sessionId,
      bitId,
      sequence,
      inputHash,
      outputHash,
      leafHash,
      previousHash,
      timestamp,
      witnessId: witnessRecord?.witnessId ?? null,
      witnessTimestamp: witnessRecord?.timestamp ?? null,
      controlIndex: computeControlIndex(inputParams),
      promptText: prompt,
      modelName: model,
      generationParams: inputParams,
    },
  });

  // ─── STEP 8: Update Merkle tree ───
  await addLeafToTree(sessionId, leafHash);

  // ─── STEP 9: Upload to GDrive ───
  const gdriveFileId = await uploadToGDrive(bitId, imageBytes, sequence);

  // ─── STEP 10: Return to client ───
  return Response.json({
    imageUrl: `data:image/png;base64,${imageResponse.data[0].b64_json}`,
    gdriveFileId,
    provenance: {
      sequence,
      leafHash,
      inputHash,
      outputHash,
      witnessed: !!witnessRecord,
      witnessId: witnessRecord?.witnessId,
    },
  });
}
```

---

### The Stooges Workspace View

Based on `render-workspace.js` as reference — adapted from Electron DOM manipulation to React:

```tsx
// components/provenance/ProvenancePanel.tsx

export function ProvenancePanel({ sessionId }: { sessionId: string }) {
  const { data: iterations } = useQuery(['iterations', sessionId],
    () => fetch(`/api/provenance/${sessionId}/iterations`).then(r => r.json())
  );
  const { data: session } = useQuery(['session', sessionId],
    () => fetch(`/api/provenance/${sessionId}`).then(r => r.json())
  );

  return (
    <div className="provenance-panel">
      {/* ─── Session Header ─── */}
      <div className="session-header">
        <h3>{session?.name}</h3>
        <StatusBadge status={session?.status} />
        <span className="iteration-count">
          {iterations?.length ?? 0} generations captured
        </span>
        {session?.merkleRoot && (
          <span className="merkle-root" title={session.merkleRoot}>
            Root: {session.merkleRoot.slice(0, 12)}...
          </span>
        )}
      </div>

      {/* ─── Hash Chain Visualization ─── */}
      <div className="chain-view">
        {iterations?.map((iter, i) => (
          <div key={iter.id} className="chain-link">
            <div className="sequence">#{iter.sequence}</div>
            <div className="thumbnail">
              <img src={iter.thumbnailUrl} alt={`Generation ${iter.sequence}`} />
            </div>
            <div className="hashes">
              <HashLine label="Input" hash={iter.inputHash} />
              <HashLine label="Output" hash={iter.outputHash} />
              <HashLine label="Leaf" hash={iter.leafHash} />
            </div>
            <div className="witness-status">
              {iter.witnessId ? (
                <span className="witnessed">✓ Witnessed</span>
              ) : (
                <span className="unwitnessed">○ Local only</span>
              )}
            </div>
            {i < iterations.length - 1 && (
              <div className="chain-arrow">
                ↓ previous_hash links to next
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ─── Lock Controls ─── */}
      {session?.status === 'unlocked' && iterations?.length > 0 && (
        <div className="lock-controls">
          <button onClick={() => handleLocalLock(sessionId)}>
            🔒 Local Lock (Seal Provenance)
          </button>
        </div>
      )}
      {session?.status === 'locked' && (
        <div className="lock-controls">
          <button onClick={() => handleChainLock(sessionId)}>
            ⛓️ Chain Lock (Anchor to Blockchain)
          </button>
          