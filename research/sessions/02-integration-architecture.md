# Scruple Integration — Final Output (Updated with Complete Codebase)
_2026-04-08T06:04:33.943Z_



# Scruple Studio × Stooges Integration — Final Synthesis

_Revised 2026-04-08 incorporating complete codebase analysis (29/29 files)_

---

## What Changed: New Findings from Round 5

The previous synthesis (Rounds 1–4) was built on **17 of 29 files** and constructed an architecture that does not exist. Round 5 analyzed the remaining 12 files — the Python ComfyUI nodes, the Electron renderer layer, the state system, and the handler infrastructure — and revealed that every structural assumption in the prior document was wrong.

### Three False Assumptions Corrected

**1. "Scruple is an npm library with a programmatic SDK"** → **FALSE**

The previous synthesis described `packages/core/`, `packages/api/`, and `packages/ui/` as importable npm packages exposing `createScruple()`, `configureScruple()`, and `witnessScruple()`. None of these function signatures appear anywhere in the 29-file codebase. The actual system is an **Electron desktop application** with:

- A **main process** that runs an Express server on localhost (ports 5742–5751), manages a local SQLite database, performs filesystem operations, and handles blockchain/Oracle interactions
- A **renderer process** that calls main-process functions via Electron's `contextBridge` IPC (`window.scruple.getState()`, `window.scruple.getProjects()`, etc.)
- **ComfyUI Python plugin nodes** that communicate with the Express server via HTTP REST over localhost
- An **Oracle cloud service** that handles blockchain anchoring (Ravencoin, IPFS, Arweave) and fiat payment processing (Stripe/TSD tokens)

There is no importable JavaScript library. `window.scruple.*` is an Electron preload injection, not an SDK.

**2. "The XState `ScrupleMachine` manages a four-state lifecycle"** → **FALSE**

The actual state management is a hand-rolled reactive store in `state.js` — 40 lines of vanilla JavaScript with `set`/`get`/`subscribe` and `requestAnimationFrame` batching. The project lifecycle is a **six-tier lock progression**, not four states:

```
unlocked → checkpointed → local_locked → chain_locked → persistent_locked → permanent_locked
```

`checkpointed` is non-terminal (work can continue), which is architecturally significant: provenance snapshots don't have to be final.

**3. "The `CustodyLink` type modification is the key integration point"** → **MISLEADING**

The production system does not use `CustodyLink` objects. Provenance data is captured as **manifest JSON files** written by `studio_terminal.py`, containing:

- Full ComfyUI node graph extraction (every primitive value from every node)
- Telemetry packets from up to 15 upstream `ScrupleTap` sensor nodes
- SHA-256 leaf hash of the output image
- Merkle root computed over all iterations in a project
- Manifest version (`"3.0"`)

The `CustodyLink` type may exist in an unreferenced npm package, but the running application operates on a fundamentally different, richer data model. The dual-evidence modification proposed in Round 2 is directionally correct (input/output hash pairs are necessary for chain verification) but addresses the wrong data structure.

### New Capabilities Discovered

| Capability | Location | Significance |
|---|---|---|
| Multi-tool provenance | `api.js` `setupPaths()` | Accepts ComfyUI, Kohya, training images, base models paths — not ComfyUI-only |
| Training dataset Merkle trees | `studio_training_terminal.py` | Hashes every file in a training dataset folder, computes Merkle root |
| Upstream graph walking | `studio_training_terminal.py` | Recursively discovers all nodes connected upstream from output |
| Heuristic node classification | `studio_training_terminal.py` | Auto-categorizes discovered nodes as datasets, models, or hyperparameters |
| Dual payment system | `state.js`, `api.js` | Fiat (TSD tokens via Stripe/Oracle) and blockchain (direct RVN wallet) |
| Preflight verification | `render-workspace.js` | Validates provenance chain integrity before locking |
| Kohya_ss integration | `state.js` | Separate connection detection and port tracking for Kohya training tool |
| Lineage tree for training runs | `render-workspace.js` | ROOT/VERSION/BRANCH lineage types with parent-child relationships |

---

## Updated Integration Architecture: Top 3 Options (Revised)

The previous synthesis's three options (Provenance Layer, Scruple Workspace, Direct Scruple) are all invalidated. They assumed an importable SDK that does not exist. Here are the three viable options based on the actual architecture.

---

### Option A: Protocol Extraction — Web-Native Reimplementation

**RECOMMENDED FOR STOOGES**

**One sentence:** Extract Scruple's data formats, hashing algorithms, and manifest schema from the Python/JS source, then reimplement the capture pipeline in browser-compatible JavaScript, using the Oracle service for blockchain anchoring.

**What the user sees:** A fully browser-native Stooges experience. No desktop software required. Users generate images via DALL-E/Leonardo, review them, and approve with provenance automatically captured. Locking and anchoring happen through the Oracle's fiat/TSD payment path. A provenance panel shows iteration history, Merkle roots, and verification status.

**Architecture:**

```
┌─────────────────────────────────────────────────────┐
│  Stooges Web Application (Browser)                  │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Generation    │  │ Manifest     │  │ Provenance │ │
│  │ Adapters      │→ │ Builder      │→ │ Store      │ │
│  │ (DALL-E,      │  │ (schema from │  │ (IndexedDB │ │
│  │  Leonardo)    │  │  terminal.py)│  │  + API)    │ │
│  └──────────────┘  └──────────────┘  └─────┬──────┘ │
│                                             │        │
│  ┌──────────────┐  ┌──────────────┐         │        │
│  │ Hash Engine   │  │ Merkle Tree  │         │        │
│  │ (Web Crypto   │  │ (ported from │         │        │
│  │  SHA-256)     │  │  Python)     │         │        │
│  └──────────────┘  └──────────────┘         │        │
│                                             │        │
│  ┌──────────────────────────────────────────┘        │
│  │ Lock Manager (six-tier progression)               │
│  │  unlocked → checkpointed → local_locked →         │
│  │  chain_locked → persistent_locked → permanent     │
│  └───────────────────────┬───────────────────────────┘
│                          │                            │
└──────────────────────────┼────────────────────────────┘
                           │ HTTPS
                    ┌──────▼──────┐
                    │ Scruple     │
                    │ Oracle      │
                    │ (RVN, IPFS, │
                    │  Arweave,   │
                    │  Stripe)    │
                    └─────────────┘
```

**What we reimplement from Scruple's source:**

| Scruple Component | Source File | Stooges Equivalent |
|---|---|---|
| DNA extraction from inputs | `input_capture.py` lines 60–80 | `GenerationAdapter.captureInputs()` — records prompt, model, seed, parameters as typed telemetry |
| Manifest assembly | `studio_terminal.py._extract_all_settings()` | `ManifestBuilder.build()` — assembles all inputs + output hash into manifest JSON |
| Image hashing | `studio_terminal.py._hash_image_file()` | `hashArtifact()` — Web Crypto API `crypto.subtle.digest('SHA-256', ...)` |
| Merkle tree computation | `studio_training_terminal.py._compute_folder_merkle()` | `computeMerkleRoot()` — same algorithm in JS |
| Project lifecycle | `api.js` project CRUD via `window.scruple.*` | Stooges backend API with equivalent endpoints |
| Six-tier lock progression | `render-workspace.js` status labels | State machine in Stooges (Zustand or XState) |
| Iteration/training run storage | Electron main process SQLite | Stooges backend database (Postgres) |
| Preflight verification | `renderPreflightPanel()` | Chain integrity validator before lock operations |

**Manifest schema (extracted from Python source):**

```typescript
interface GenerationManifest {
  version: "3.0";
  session_id: string;
  project_id: string;
  run_sequence: number;
  timestamp: string;
  
  // From generation adapter (equivalent to input_capture.py DNA extraction)
  inputs: {
    prompt: { value: string; hash: string };
    negative_prompt?: { value: string; hash: string };
    model: { name: string; hash: string };
    seed: number;
    steps: number;
    cfg_scale: number;
    sampler: string;
    dimensions: { width: number; height: number };
    [key: string]: unknown; // Extensible for API-specific parameters
  };
  
  // All generation parameters as flat key-value (mirrors _extract_all_settings)
  all_settings: Record<string, string | number | boolean>;
  
  // Output
  artifact: {
    filename: string;
    leaf_hash: string;    // SHA-256 of image bytes
    format: string;       // "png", "webp", etc.
    size_bytes: number;
  };
  
  // Telemetry from adapter (equivalent to ScrupleTap captures)
  telemetry: TelemetryPacket[];
  
  // Computed after all iterations in project
  merkle_root?: string;
}

interface TelemetryPacket {
  source: string;         // "dalle-3", "leonardo-phoenix", etc.
  label: string;          // Human-readable description
  data_hash: string;      // SHA-256 of the captured data
  raw_data: unknown;      // The actual captured value
  captured_at: string;    // ISO timestamp
}

interface Project {
  id: string;
  name: string;
  type: "txt2img" | "training";
  status: LockStatus;
  iteration_count: number;
  merkle_root: string | null;
  scr_id: string | null;
  created_at: string;
  locked_at: string | null;
}

type LockStatus = 
  | "unlocked" 
  | "checkpointed" 
  | "local_locked" 
  | "chain_locked" 
  | "persistent_locked" 
  | "permanent_locked";
```

**Critical risk:** The Oracle likely validates that submissions originate from authenticated Scruple Studio sessions. We need an API agreement with Scruple to allow third-party manifest submission, or we build our own anchoring infrastructure. This is the single highest-risk dependency in the entire integration.

**Mitigation path:** For the first milestone, provenance is local-only (`unlocked` through `local_locked`). No Oracle dependency. Blockchain anchoring (`chain_locked` and beyond) is Phase 2, contingent on Oracle API access negotiation.

**Pros:**
- Only option that works for web users
- No desktop software requirement
- Full control over UX
- Provenance data is schema-compatible with Scruple's format (future interop possible)
- Checkpoint-based locking means provenance accumulates without forcing premature finalization

**Cons:**
- Largest build effort — reimplementing ~60% of Scruple's capture pipeline
- Oracle API access is not guaranteed; may need to build alternative anchoring
- Must maintain schema compatibility as Scruple evolves (manifest version changes)
- No direct reuse of Scruple code (everything is reimplemented, not imported)

---

### Option B: Sidecar Integration — Scruple Studio Runs Alongside Stooges

**One sentence:** Stooges detects a running Scruple Studio instance on the user's machine and communicates with it using the same HTTP protocol the ComfyUI nodes use.

**What the user sees:** Stooges runs in the browser. Users who want provenance also install and run Scruple Studio on their desktop. Stooges detects Studio's presence, pushes generation manifests to it via localhost HTTP, and reads project/iteration data back. Studio handles all storage, Merkle computation, and blockchain anchoring.

**Architecture:**

```
┌────────────────────────┐         ┌────────────────────────┐
│ Stooges (Browser)      │         │ Scruple Studio         │
│                        │  HTTP   │ (Electron Desktop)     │
│  Generation UI         │────────►│                        │
│  DALL-E/Leonardo calls │  :5742  │  Express Server        │
│  Manifest assembly     │◄────────│  SQLite DB             │
│  Provenance display    │         │  Oracle/Blockchain     │
│                        │         │  Lock management       │
└────────────────────────┘         └────────────────────────┘
```

Stooges acts as another "node" in Studio's capture ecosystem, identical in protocol to `studio_terminal.py`:

```typescript
// Stooges sidecar client — mirrors studio_terminal.py protocol

class StudioSidecar {
  private port: number | null = null;
  
  async findStudio(): Promise<boolean> {
    // Mirror _find_studio_port() — scan 5742-5751
    for (let port = 5742; port < 5752; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
          this.port = port;
          return true;
        }
      } catch { continue; }
    }
    return false;
  }
  
  async getCaptureStatus(): Promise<CaptureStatus> {
    // Mirror _poll_studio()
    const res = await fetch(
      `http://127.0.0.1:${this.port}/api/capture-status`
    );
    return res.json();
  }
  
  async submitManifest(manifest: GenerationManifest): Promise<void> {
    // Mirror studio_terminal's atomic JSON handoff
    await fetch(`http://127.0.0.1:${this.port}/api/submit-manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest)
    });
  }
}
```

**CORS constraint:** Browsers block `fetch()` to `127.0.0.1:5742` from a different origin unless Studio's Express server sets `Access-Control-Allow-Origin` headers. Scruple Studio almost certainly does not set these headers today, since its only HTTP clients are Python's `urllib` (no CORS) and its own Electron webview (same-origin). **This requires a Scruple code change or a local proxy.**

**Pros:**
- Reuses all of Scruple's infrastructure — storage, Merkle computation, lock management, Oracle integration, blockchain anchoring
- No need to reimplement capture pipeline
- Provenance data is identical to what Scruple produces natively
- Lowest reimplementation effort

**Cons:**
- Desktop-only. Web-only users get no provenance.
- Requires users to install and run Scruple Studio
- CORS requires either a Scruple patch or a local browser extension/proxy
- Version coupling — Stooges breaks when Scruple updates their API
- Two-process UX is awkward ("make sure Studio is running before generating")
- Studio's manifest submission endpoint may not exist yet (it receives data from filesystem watches, not necessarily HTTP POST)

---

### Option C: Hybrid — Web-Native with Optional Desktop Enrichment

**One sentence:** Build Option A's web-native system as the baseline, but also implement Option B's sidecar detection so that users with Scruple Studio installed get richer provenance capabilities (blockchain anchoring, persistent storage) without additional effort.

**Architecture:**

```
┌─────────────────────────────────────────────────────────┐
│  Stooges Web Application                                │
│                                                          │
│  ┌─────────────────────────────────┐                     │
│  │ Generation + Manifest Pipeline  │ (Always active)     │
│  │ Web Crypto hashing              │                     │
│  │ Merkle tree computation         │                     │
│  │ Local provenance (→local_locked)│                     │
│  └──────────────┬──────────────────┘                     │
│                 │                                         │
│  ┌──────────────▼──────────────────┐                     │
│  │ Lock Manager                    │                     │
│  │                                 │                     │
│  │ unlocked ──► checkpointed ──►   │                     │
│  │ local_locked ──► ???            │                     │
│  │                                 │                     │
│  │  ┌──────────┐  ┌────────────┐  │                     │
│  │  │ Path 1:  │  │ Path 2:    │  │                     │
│  │  │ Oracle   │  │ Sidecar    │  │                     │
│  │  │ Direct   │  │ to Studio  │  │                     │
│  │  │ (if API  │  │ (if local  │  │                     │
│  │  │ access)  │  │ detected)  │  │                     │
│  │  └──────────┘  └────────────┘  │                     │
│  └─────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

On startup, Stooges checks for Studio presence (port scan). If found, it offers enhanced anchoring through Studio. If not, it operates with local provenance only (or Oracle direct, if that API access is secured).

**Pros:**
- Works for all users (web and desktop)
- Desktop users get full Scruple ecosystem benefits
- Graceful degradation — provenance quality scales with infrastructure available
- Doesn't block on Oracle API negotiation

**Cons:**
- Most complex to build (both paths)
- Two code paths for anchoring means two sets of bugs
- Must maintain compatibility with both Oracle API and Studio HTTP protocol

---

### Option Comparison Matrix

| Factor | A: Web-Native | B: Sidecar | C: Hybrid |
|---|---|---|---|
| Works in browser | ✅ | ❌ | ✅ |
| No desktop install | ✅ | ❌ | ✅ (degraded) |
| Blockchain anchoring | Requires Oracle API | ✅ via Studio | Both paths |
| Build effort | High | Low-Medium | Highest |
| Schema compatibility | Must maintain | Automatic | Must maintain |
| Oracle dependency | Yes (for chain_locked+) | No | Optional |
| CORS issues | N/A | Yes | Partial |
| Stooges UX control | Full | Partial | Full |
| Risk | Oracle access | CORS + install friction | Complexity |

**Recommendation: Option A for Phase 1, evolving to Option C.**

Build the web-native pipeline first. This establishes the manifest schema, hashing, Merkle computation, and local provenance (`unlocked` through `local_locked`). Simultaneously negotiate Oracle API access. Once Oracle access is secured, enable `chain_locked` and beyond. If Oracle access is denied, implement sidecar detection as a fallback for desktop users who want anchoring.

---

## Python-JS Bridge: How ComfyUI Nodes Actually Work

This section documents the actual communication protocol discovered in Round 5, replacing the council's incorrect description of an npm SDK.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ ComfyUI Process                                             │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐ │
│  │ ScrupleTap   │──►│ ScrupleTap   │──►│ ScrupleStudio   │ │
│  │ (input_      │   │ (input_      │   │ Terminal        │ │
│  │  capture.py) │   │  capture.py) │   │ (studio_        │ │
│  │              │   │              │   │  terminal.py)   │ │
│  │ Captures:    │   │ Captures:    │   │                 │ │
│  │ • prompt     │   │ • model name │   │ Receives up to  │ │
│  │ • seed       │   │ • latent     │   │ 15 telemetry    │ │
│  │ • CFG scale  │   │   dimensions │   │ inputs          │ │
│  └──────────────┘   └──────────────┘   │                 │ │
│                                         │ Also receives:  │ │
│  ┌──────────────┐                      │ • IMAGE tensor  │ │
│  │ ScrupleOutput│─────────────────────►│ • MASK (opt.)   │ │
│  │ Capture      │                      │                 │ │
│  │ (output_     │                      │ Performs:        │ │
│  │  capture.py) │                      │ • Hash image    │ │
│  │              │                      │ • Read session  │ │
│  │ Captures raw │                      │ • Poll Studio   │ │
│  │ IMAGE tensor │                      │ • Extract all   │ │
│  └──────────────┘                      │   node settings │ │
│                                         │ • Build manifest│ │
│                                         │ • Write JSON    │ │
│                                         │ • POST to Studio│ │
│                                         └────────┬────────┘ │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
                          HTTP POST (localhost)     │
                          + filesystem              │
                          (scruple_session.txt)     │
                                                   │
┌──────────────────────────────────────────────────▼──────────┐
│ Scruple Studio (Electron)                                   │
│                                                              │
│  Express Server (:5742-5751)                                │
│  ├── GET  /api/health           → liveness check            │
│  ├── GET  /api/capture-status   → active project + state    │
│  └── POST /api/submit-manifest  → receive generation data   │
│                                    (inferred, not confirmed) │
│                                                              │
│  Main Process                                                │
│  ├── SQLite database (projects, iterations, training runs)  │
│  ├── Merkle tree computation                                │
│  ├── Filesystem management (images, manifests)              │
│  └── Oracle client (blockchain anchoring, Stripe payments)  │
│                                                              │
│  Renderer (IPC via contextBridge)                            │
│  ├── window.scruple.getState()                              │
│  ├── window.scruple.getProjects()                           │
│  ├── window.scruple.activateProject(id)                     │
│  ├── window.scruple.deactivateProject()                     │
│  ├── window.scruple.lockProject(id, lockType, options)      │
│  ├── window.scruple.getIterations(projectId)                │
│  ├── window.scruple.getTrainingRuns(projectId)              │
│  ├── window.scruple.archiveProject(id)                      │
│  ├── window.scruple.setupPaths(paths)                       │
│  └── window.scruple.browseFolder()                          │
└─────────────────────────────────────────────────────────────┘
```

### Three Communication Channels

**Channel 1: HTTP REST (Python → Electron Express Server)**

The primary data channel. Python nodes discover Studio by brute-force port scanning:

```python
# studio_terminal.py._find_studio_port()
STUDIO_HOST = "127.0.0.1"
STUDIO_PORT_START = 5742

for port in range(STUDIO_PORT_START, STUDIO_PORT_START + 10):
    url = f"http://{STUDIO_HOST}:{port}/api/health"
    req = urllib.request.Request(url, method='GET')
    with urllib.request.urlopen(req, timeout=2) as response:
        if response.status == 200:
            return port
```

Status polling to determine active project:

```python
# studio_terminal.py._poll_studio()
url = f"http://{STUDIO_HOST}:{self.studio_port}/api/capture-status"
req = urllib.request.Request(url, method='GET')
with urllib.request.urlopen(req, timeout=STUDIO_TIMEOUT) as response:
    return json.loads(response.read().decode('utf-8'))
```

Manifest submission is the "atomic JSON handoff" referenced in the file header. The exact POST endpoint is not fully visible in the provided code snippets, but the architecture is unambiguous: the terminal node builds a complete manifest and sends it to Studio.

**Channel 2: Filesystem Sideband (Session Identity)**

Session identity is passed via a flat file in ComfyUI's root directory:

```python
# studio_terminal.py
SESSION_FILE = COMFYUI_ROOT / "scruple_session.txt"

def _read_session_id(self):
    if SESSION_FILE.exists():
        return SESSION_FILE.read_text(encoding='utf-8').strip()
    return None
```

The Electron app writes this file. The Python nodes read it. This is a unidirectional identity channel — Studio tells the ComfyUI process which session it belongs to. No authentication, no encryption, no token rotation. Security relies entirely on localhost trust and filesystem permissions.

**Channel 3: Window Injection (Studio → ComfyUI Webview)**

For the ComfyUI browser UI, Studio can inject JavaScript globals directly:

```javascript
// scruple_display.js
window.scrupleProjectName = window.scrupleProjectName || "";
window.scrupleStudioConnected = window.scrupleStudioConnected || false;
```

This confirms Studio embeds or controls ComfyUI's webview and can inject state directly. The display widget also has a fallback HTTP polling path identical to the Python nodes:

```javascript
// scruple_display.js.pollStudio()
for (let port = 5742; port < 5752; port++) {
    const response = await fetch(
        `http://127.0.0.1:${port}/api/capture-status`
    );
    // ...
}
```

### The Data Flow for a Single Image Generation

1. User constructs a ComfyUI workflow with `ScrupleTap` nodes attached to key inputs (prompt, model, seed, etc.) and a `ScrupleOutputCapture` node attached to the final image output
2. Workflow executes. Each `ScrupleTap` node extracts the "DNA" of its connected input — the raw value, a label, and a hash — and passes it through unchanged (passthrough architecture, does not alter the workflow)
3. `ScrupleOutputCapture` captures the raw IMAGE tensor
4. `ScrupleStudioTerminal` receives up to 15 telemetry inputs from taps plus the image tensor
5. Terminal performs: image hashing (`_hash_image_file()` → SHA-256), session ID read from filesystem, Studio polling for active project, full node graph extraction (`_extract_all_settings()` walks the entire ComfyUI prompt dictionary), manifest assembly (version 3.0), atomic write of JSON + PNG to disk, HTTP POST to Studio
6. Studio main process receives manifest, stores in SQLite, recomputes Merkle tree for the project, updates iteration count
7. Renderer polls state, updates UI

### Training Terminal Specifics

`studio_training_terminal.py` extends this with:

- **Dataset Merkle trees:** `_compute_folder_merkle()` hashes every image and caption file in a training dataset folder and builds a Merkle tree. The root hash becomes part of the training provenance record.
- **Upstream graph walking:** `_find_upstream_nodes()` recursively traverses the ComfyUI node graph backwards from the output to discover all contributing nodes.
- **Heuristic node classification:** Discovered nodes are automatically categorized as datasets, models, or hyperparameters, making the system work with arbitrary training workflows (Flux, Kohya, Simpletuner) without hardcoded node type lists.
- **Lineage tracking:** Training runs have explicit `lineage_type` (ROOT, VERSION, BRANCH) and `parent_run_id`, forming a tree structure with lock state propagation through ancestors.

---

## render-workspace.js: What Stooges Should Adopt

### What This File Actually Is

`render-workspace.js` is **not a React component**. It is a vanilla JavaScript function that returns HTML as a template literal string:

```javascript
function renderWorkspace(
    project, activeProject, iterations = [], 
    trainingRuns = [], isInterlocked = false
) {
    return `<div class="workspace">...</div>`;
}
```

The entire Scruple Studio frontend is React-free. Rendering is string-based. Event handlers are re-bound after every render via `setupMainAppHandlers()` in `handlers.js`. State lives in a 40-line reactive store (`state.js`) with `requestAnimationFrame` batching. This is functional for an Electron app but is the antipattern React was invented to solve.

**Nothing from this file can be imported or directly reused.** Everything must be rebuilt as React components. The value is as a **detailed, validated design specification**.

### Patterns to Adopt

**Pattern 1: Stats Bar with Cryptographic Summary**

```javascript
<div class="workspace-stats">
  <div class="stat-card">
    <span class="stat-value">${project.iteration_count || 0}</span>
    <span class="stat-label">Iterations</span>
  </div>
  <div class="stat-card">
    <span class="stat-value">
      ${project.merkle_root ? truncateHash(project.merkle_root) : 'N/A'}
    </span>
    <span class="stat-label">Merkle Root</span>
  </div>
  ${project.scr_id ? `
    <div class="stat-card highlight">
      <span class="stat-value">${project.scr_id}</span>
      <span class="stat-label">SCR ID</span>
    </div>
  ` : ''}
</div>
```

**Adopt as:** `<StatsBar>` React component. Horizontal row of stat cards. Merkle root truncated to first 12 + last 6 characters (`truncateHash()` utility). SCR ID card conditionally rendered and highlighted only when assigned.

**Pattern 2: Iteration Card with Leaf Hash**

```javascript
<div class="iteration-card">
  <div class="iteration-image" 
       data-project="${project.name}" 
       data-image="${iter.image_filename || ''}">
    <span class="image-placeholder">[IMG]</span>
  </div>
  <div class="iteration-details">
    <div class="iteration-header">
      <span class="iteration-number">#${iter.run_sequence}</span>
      <span class="iteration-ci">
        <span class="ci-dot ci-placeholder"></span>
        <span class="ci-value">--</span>
      </span>
    </div>
    <div class="iteration-hash">
      <span class="label">Leaf:</span>
      <code>${iter.leaf_hash ? iter.leaf_hash.substring(0, 16) + '...' : 'N/A'}</code>
    </div>
  </div>
</div>
```

**Adopt as:** `<IterationCard>` React component. Key data per iteration: `run_sequence` (sequential number), `leaf_hash` (SHA-256 of image, truncated to 16 chars in display), `image_filename`, `created_at`, and a chain integrity indicator (`ci-dot` / `ci-value` — currently placeholder in Scruple, which we can implement). The grid layout (`iterations-grid`) works well for visual browsing.

**Pattern 3: Six-Tier Lock Progression**

```javascript
const statusLabels = {
  'unlocked': 'Unlocked',
  'checkpointed': 'Checkpointed',
  'local_locked': 'Finalized',
  'chain_locked': 'Chain Locked',
  'persistent_locked': 'Persistent Locked',
  'permanent_locked': 'Permanent Locked'
};
```

**Adopt as:** `<LockStatusBadge>` and `<LockActionPanel>` React components. The progression is meaningful:

- **Unlocked:** Active project, capturing iterations
- **Checkpointed:** Snapshot taken, but work can continue (non-terminal — this is critical for UX)
- **Finalized (local_locked):** Locally sealed, hash chain complete, no more iterations
- **Chain Locked:** Anchored to Ravencoin blockchain (50 TSD)
- **Persistent Locked:** Also pinned to IPFS (65 TSD)
- **Permanent Locked:** Also stored on Arweave

The lock section appears only when a project is not actively tracking — a smart UX choice that prevents accidental locking mid-capture.

**Pattern 4: Training Run Lineage**

```javascript
const lineageIcons = {
  'ROOT': 'Root',
  'VERSION': 'Version',
  'BRANCH': 'Branch'
};
```

**Adopt if Stooges supports training:** `<TrainingCard>` with visual lineage indicators. ROOT is the initial training run, VERSION is a refinement of the same base, BRANCH is a divergent exploration. `parent_run_id` creates a tree. `hasLockedAncestors` check prevents modifications to runs whose parent chain is already locked.

**Pattern 5: Preflight Verification Panel**

Referenced as `${renderPreflightPanel()}` in the workspace. Validates chain integrity before a lock operation. This is directly relevant: before any lock transition, Stooges should run integrity checks (all leaf hashes valid, Merkle root recomputable, no missing iterations).

### Utility Functions to Port

```javascript
// From api.js — directly portable to TypeScript
function truncateHash(hash: string): string {
  if (!hash || hash.length < 18) return hash || 'N/A';
  return hash.substring(0, 12) + '...' + hash.substring(hash.length - 6);
}

function truncateAddress(address: string): string {
  if (!address || address.length < 14) return address || 'N/A';
  return address.substring(0, 8) + '...' + address.substring(address.length - 6);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
```

### What NOT to Adopt

- **innerHTML-based rendering.** XSS risk; `escapeHtml()` is applied inconsistently in the source.
- **Event handler rebinding on every render.** React's synthetic event system eliminates this.
- **`State` reactive store.** Replace with Zustand, Redux, or React Context depending on Stooges' existing patterns.
- **Electron-specific file dialogs.** `window.scruple.browseFolder()` → web file picker or cloud storage picker.
- **String concatenation for conditional UI.** Ternary operators in template literals → proper JSX conditional rendering.

---

## Definitive Build Sequence

### Phase 0: Protocol Documentation and Proof of Concept (Week 1–2)

**Goal:** Prove we can produce Scruple-compatible provenance data in the browser.

| Task | Deliverable | Acceptance Criteria |
|---|---|---|
| Document manifest schema from `studio_terminal.py` | `manifest-schema.json` JSON Schema file | Schema validates against a real manifest captured from a Scruple Studio session |
| Implement browser SHA-256 hashing | `src/scruple/crypto/hash.ts` | `hashArtifact(imageBytes)` returns identical hash to `studio_terminal.py._hash_image_file()` for same input |
| Implement Merkle tree computation | `src/scruple/crypto/merkle.ts` | `computeMerkleRoot(leafHashes)` returns identical root to `studio_training_terminal.py._compute_folder_merkle()` for same input set |
| Build minimal manifest builder | `src/scruple/manifest/builder.ts` | Given hardcoded inputs, produces a valid v3.0 manifest JSON |
| Capture a real Scruple manifest | `test-fixtures/reference-manifest.json` | Obtained by running ComfyUI with Scruple nodes and intercepting the JSON handoff |

**Key technical decisions:**

- Hashing: `crypto.subtle.digest('SHA-256', buffer)` — native Web Crypto API, no polyfill needed in modern browsers
- Merkle tree: Binary tree, SHA-256 of concatenated child hashes, left-padded for odd leaf counts (verify against Python implementation)
- Manifest version: Target 3.0 to match current Scruple

### Phase 1: Generation Adapters and Capture Pipeline (Week 3–4)

**Goal:** Generate images via DALL-E/Leonardo and automatically capture provenance manifests.

| Task | Deliverable | Acceptance Criteria |
|---|---|---|
| Define `GenerationAdapter` interface | `src/scruple/adapters/types.ts` | Interface covers: input capture (pre-generation), output capture (post-generation), error handling |
| DALL-E adapter | `src/scruple/adapters/dalle.ts` | Calls OpenAI API, captures prompt/model/size/quality as telemetry, hashes response image, returns manifest-ready data |
| Leonardo adapter | `src/scruple/adapters/leonardo.ts` | Same as above for Leonardo API |
| Manifest builder integration | `src/scruple/manifest/pipeline.ts` | `generateWithProvenance(adapter, params)` → returns `{ image: Blob, manifest: GenerationManifest }` |
| Local provenance store | `src/scruple/store/provenance.ts` | IndexedDB-backed store for projects, iterations, manifests |

**Adapter interface:**

```typescript
interface GenerationAdapter {
  readonly provider: string; // "openai-dalle-3", "leonardo-phoenix", etc.
  
  // Pre-generation: capture all input parameters as telemetry
  captureInputs(params: GenerationParams): TelemetryPacket[];
  
  // Execute generation, return raw image + API-specific metadata
  generate(params: GenerationParams): Promise<GenerationResult>;
  
  // Post-generation: hash the output, capture any API-returned metadata
  captureOutput(result: GenerationResult): Promise<{
    leaf_hash: string;
    telemetry: TelemetryPacket[];
  }>;
}

interface GenerationParams {
  prompt: string;
  negative_prompt?: string;
  model: string;
  width: number;
  height: number;
  seed?: number;
  [key: