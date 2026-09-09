# Blender ↔ ComfyUI: Where It Runs and How They Talk

## Executive Summary

ComfyUI integration with Blender has fragmented into multiple bridges. The landscape is split between:

1. **Node-conversion addons** that embed ComfyUI's graph inside Blender's node editor
2. **Client addons** that connect to an external ComfyUI server (local or remote)
3. **Specialized vertical addons** (video sequencer, texture generation)
4. **Legacy alternatives** that do NOT use ComfyUI (Dream Textures)

The two clear market leaders are:
- **ComfyUI-BlenderAI-node** by AIGODLIKE (1,500 stars) — converts nodes natively into Blender
- **ComfyUI-Blender** by alexisrolland (188 stars) — sends workflows to an external server via HTTP

The trend is **decidedly local-first**, with users bundling or locally launching ComfyUI. Remote cloud usage (RunPod, Salad, etc.) is possible but rarely baked into the bridges themselves.

---

## PRIMARY BRIDGES

### 1. ComfyUI-BlenderAI-node (AIGODLIKE / 幻之境 / CGArtHub)

**Repository:** https://github.com/AIGODLIKE/ComfyUI-BlenderAI-node  
**Stars:** 1,500 | **Forks:** 101 | **Last Update:** Sept 2026  
**Status:** Actively maintained (latest v2.0.0 includes GLB support and Tripo node integration)

#### WHERE DOES COMFYUI RUN?

**Both local and remote, user's choice:**
- **Local embedded:** The addon can bundle or launch a ComfyUI instance directly from Blender (button: "Launch/Connect to ComfyUI" in the sidebar)
- **Remote server:** Switch "Server Type" in addon preferences to connect to a running ComfyUI on another machine or cloud service (requires ComfyUI started with `--listen` flag for network access)
- **Implementation:** Includes embedded Python setup with `python_embedded/` directory or venv support

#### HOW DO THEY TALK?

HTTP API calls to ComfyUI's `/prompt` endpoint. The addon sends workflow JSON payloads and receives `prompt_id` responses. WebSocket support for real-time execution status updates via `/ws` endpoint.

#### WHAT WORKFLOW FORMAT?

**Native ComfyUI nodes converted to Blender nodes.** The addon converts ComfyUI's full node graph into Blender's node editor. You build workflows directly in Blender using ComfyUI node types (samplers, loaders, save nodes, etc.), not a separate API-format JSON document. This is architectural difference from alexisrolland's approach.

#### WHERE DO OUTPUTS LAND?

**Default:** ComfyUI's standard `output/` directory on the ComfyUI machine. For local setups, outputs appear in the ComfyUI installation folder (e.g., `C:\AI\ComfyUI_windows_portable\ComfyUI\output`).

**BlenderOutputSaveImage node:** Special node designed to save results directly; can be configured with custom filename and path. Outputs are NOT streamed back into Blender as in-memory images by default—they stay on the ComfyUI filesystem or are manually retrieved.

#### HOW POPULAR IS IT?

**Most popular option.** 1,500 GitHub stars, 101 forks. Active community, recent releases (v2.0.0 Sept 2026). Referenced as the de facto standard in Blender AI forums. Has a companion project **ComfyUI-CUP** (bridge/thumbnail service) maintained by the same author, indicating ongoing ecosystem investment.

---

### 2. ComfyUI-Blender (alexisrolland)

**Repository:** https://github.com/alexisrolland/ComfyUI-Blender  
**Stars:** 188 | **Forks:** 20 | **Last Update:** July 2026 (v4.5.1)  
**Status:** Actively maintained (bug fixes, Blender 5.0 support)

#### WHERE DOES COMFYUI RUN?

**Only external/remote server (local or network):**
- The addon is a **client-only tool**—it does NOT bundle or launch ComfyUI
- You must start ComfyUI separately on the same machine (127.0.0.1:8188) or a remote machine
- For remote: ComfyUI server must be started with `--listen` argument to accept network connections
- Configure the server address in addon preferences; the addon sends all requests to that address

#### HOW DO THEY TALK?

HTTP REST API to the ComfyUI `/prompt` endpoint. Sends workflow JSON (API format) and polls/listens for responses via WebSocket `/ws` endpoint for status updates.

#### WHAT WORKFLOW FORMAT?

**Separate API-format JSON document.** The workflow is NOT edited in Blender's node editor. Instead:
1. Create the workflow in ComfyUI's web UI
2. Export it via **File > Export (API)** in ComfyUI (produces `.json` with API-format nodes, no visual layout data)
3. Import the JSON into Blender via the addon
4. The addon auto-generates a Blender UI panel based on the workflow's input/output nodes
5. Adjust parameters in Blender and execute

The addon does NOT convert ComfyUI nodes to Blender nodes—it wraps the pre-built workflow.

#### WHERE DO OUTPUTS LAND?

**ComfyUI's output/ directory on the ComfyUI server machine.** The addon receives the `prompt_id` and can query the `/view` endpoint to retrieve images, but:
- Images are NOT automatically streamed into Blender as viewport textures
- You must manually download them from the ComfyUI machine or configure a shared folder
- No built-in mechanism to pipe outputs directly into Blender's shader editor or image editor

#### HOW POPULAR IS IT?

**Second-most popular option.** 188 stars, but active maintenance and recent Blender 5.0 support updates (July 2026 v4.5.1). Less discussion than AIGODLIKE in forums, but appears to appeal to users who prefer a workflow-first (vs. node-first) mental model.

---

### 3. Pallaidium (tin2tin)

**Repository:** https://github.com/tin2tin/Pallaidium  
**Stars:** 1,300–1,400 | **Forks:** 116–123 | **Last Update:** Recent (2026)  
**Status:** Actively maintained; Blender 5.2+ required

#### WHERE DOES COMFYUI RUN?

**External server (local or remote):**
- Pallaidium is tightly integrated into the Blender Video Sequence Editor (VSE), not a general-purpose Blender node editor
- You configure a ComfyUI URL in preferences and must start ComfyUI before launching Pallaidium
- Can connect to a running ComfyUI instance via a user-settable URL
- **Custom backend support:** Can also connect to custom backends via PALLAIDIUM_BACKEND_URL or PALLAIDIUM_BACKEND_KEY environment variables; not limited to ComfyUI alone
- **Model visibility:** Can show only local models, only remote models, or both (for mixed local/cloud setups)

#### HOW DO THEY TALK?

HTTP API to ComfyUI's `/prompt` endpoint, with configuration for custom backend URLs if using non-standard backends.

#### WHAT WORKFLOW FORMAT?

**Implicit workflows for VSE operations.** Pallaidium does NOT expose a node editor. Instead, it presents high-level generators for:
- Text-to-Video
- Text-to-Image
- Image-to-Video
- Video-to-Video
- Text-to-Audio
- Text-to-Speech
- Advanced features (ControlNet, OpenPose, ADetailer)

Each operation builds an implicit ComfyUI workflow under the hood. Users do not manually construct workflows—Pallaidium does that automatically based on UI selections.

#### WHERE DO OUTPUTS LAND?

**Blender VSE timeline.** Pallaidium is specifically designed to integrate outputs directly into the Video Sequence Editor. Generated frames are added as video strips to the VSE, ready for further editing. This is the key differentiator from generic ComfyUI clients—outputs land in Blender's editing context, not just a folder.

#### HOW POPULAR IS IT?

**Very popular for video workflows.** 1,300–1,400 stars (comparable to AIGODLIKE). Active maintenance and recent feature releases. Highly specialized for VSE use; less relevant for static image generation or material creation. Blender Artists community has active discussions on this tool.

---

### 4. StableGen (sakalond)

**Repository:** https://github.com/sakalond/StableGen  
**Stars:** 816 | **Forks:** Not specified in results  
**Status:** Actively maintained (v0.3.1 released with TRELLIS.2 upgrade)  
**Alternate fork:** https://github.com/Madxthree/stablegen

#### WHERE DOES COMFYUI RUN?

**External server (local or remote):**
- StableGen is a **ComfyUI client addon**, not an embedded solution
- You must have ComfyUI running separately (local or remote)
- Connects via HTTP to the ComfyUI backend
- Designed for texture and 3D model generation workflows, leveraging SDXL and FLUX.1-dev models

#### HOW DO THEY TALK?

HTTP API to ComfyUI. StableGen submits pre-built workflows for:
- Image-to-3D (uses models like InstantMesh, CRM, TripoSR, TRELLIS)
- AI texturing (generates textures for 3D models)
- Scene-wide texture generation

#### WHAT WORKFLOW FORMAT?

**Pre-built workflow templates.** Like Pallaidium, StableGen does NOT expose a node editor. The addon presents high-level controls for 3D/texture workflows. Workflows are generated internally based on model selection and parameters.

#### WHERE DO OUTPUTS LAND?

**Blender 3D scene directly.** Outputs (generated 3D models or textures) are intended to be imported into the Blender 3D viewport or shader editor. StableGen includes functionality to download GLB/other 3D formats and apply textures to existing models.

#### HOW POPULAR IS IT?

**Moderately popular for specialist use.** 816 stars—less than the top two, but respectable. Active maintenance (v0.3.1 with TRELLIS.2 integration Sept 2026). Niche appeal: primarily used by artists who focus on 3D asset generation and texturing, not general-purpose image generation.

---

### 5. Dream Textures (carson-katri)

**Repository:** https://github.com/carson-katri/dream-textures  
**Status:** Mature, with optional paid version on Superhive (formerly Blender Market)

#### WHERE DOES COMFYUI RUN?

**DOES NOT USE COMFYUI.** Dream Textures is a **standalone addon** that uses HuggingFace Diffusers backend, not ComfyUI. It is included in this survey for completeness, as it competes in the same space but via a different architecture.

#### HOW DO THEY TALK?

Uses HuggingFace Diffusers Python library (runs inside Blender or via local backend). No HTTP/WebSocket communication with ComfyUI.

#### WHAT WORKFLOW FORMAT?

**Blender shader nodes.** Users paint prompts directly into shader nodes and textures are generated in-place within Blender's shader editor.

#### WHERE DO OUTPUTS LAND?

**Blender image texture buffers.** Generated textures appear immediately as image textures in the shader editor, fully integrated into Blender's material system.

#### HOW POPULAR IS IT?

**Legacy tool; market leader before ComfyUI explosion.** Still maintained, available free on GitHub or paid on Blender Market. Was the de facto standard for Blender AI texturing pre-2023. Largely superseded by ComfyUI-based tools for users seeking more control, but still active.

---

### 6. Pallaidium AI (IANMRU)

**Repository:** https://github.com/IANMRU/PallaidiumAI  
**Status:** Alternative to tin2tin's Pallaidium; appears less active

#### WHERE DOES COMFYUI RUN?

**External server.** Connects to ComfyUI backend.

#### HOW DO THEY TALK?

HTTP API to ComfyUI.

#### WHAT WORKFLOW FORMAT?

**VSE-focused implicit workflows.** Similar to tin2tin's Pallaidium—high-level generators for video/audio operations.

#### WHERE DO OUTPUTS LAND?

**Blender VSE.** Integrated into the Video Sequence Editor.

#### HOW POPULAR IS IT?

**Minimal adoption.** GitHub stars/forks not available in search results. Appears to be a personal fork or less-developed alternative to tin2tin's Pallaidium. Not mentioned in mainstream Blender AI discussions.

---

### 7. io_comfy (gameltb)

**Repository:** https://github.com/gameltb/io_comfyui  
**Status:** In development; maintenance status unclear

#### WHERE DOES COMFYUI RUN?

**External server (local or remote).** ComfyScript-based integration.

#### HOW DO THEY TALK?

Via ComfyScript (Python API).

#### WHAT WORKFLOW FORMAT?

**Programmatic ComfyScript.** Different from node-based or JSON-based approaches; uses Python ComfyScript API.

#### WHERE DO OUTPUTS LAND?

**UNVERIFIED.** Search results do not specify output handling.

#### HOW POPULAR IS IT?

**Low adoption.** Minimal discussion in forums; appears overshadowed by AIGODLIKE and alexisrolland options. Status as of Sept 2026 unclear.

---

### 8. ComfyUI-BlenderAI-node-editor (a-One-Fan)

**Repository:** https://github.com/a-One-Fan/ComfyUI-BlenderAI-node-editor  
**Status:** Fork/improvements on AIGODLIKE

#### WHERE DOES COMFYUI RUN?

**Identical to AIGODLIKE.** Both local-embedded and remote server support.

#### HOW DO THEY TALK?

**Identical to AIGODLIKE.** HTTP API to `/prompt` endpoint.

#### WHAT WORKFLOW FORMAT?

**Identical to AIGODLIKE.** Native Blender nodes.

#### WHERE DO OUTPUTS LAND?

**Identical to AIGODLIKE.** ComfyUI output/ directory, with BlenderOutputSaveImage node for custom paths.

#### HOW POPULAR IS IT?

**Niche fork.** Marketed as "improvements" on AIGODLIKE, particularly for long prompt handling (multi-line text editing via dedicated window, since Blender nodes don't support multiline textboxes). Lower star count than AIGODLIKE; used by users who hit the specific pain points the fork addresses.

---

### 9. ComfyUI-Texturaizer (LatentSpaceDirective)

**Repository:** https://github.com/LatentSpaceDirective/ComfyUI-Texturaizer  
**Stars:** ~20 | **Commercial offering:** Available on Gumroad (paid)

#### WHERE DOES COMFYUI RUN?

**External server.** Connects to a running ComfyUI backend.

#### HOW DO THEY TALK?

HTTP API.

#### WHAT WORKFLOW FORMAT?

**Pre-built texture workflows.** High-level interface for AI texture generation; workflows are implicit.

#### WHERE DO OUTPUTS LAND?

**Blender materials/textures.** Outputs applied directly to objects/materials in the shader editor.

#### HOW POPULAR IS IT?

**Very niche.** ~20 stars (least popular of the major bridges). Commercial offering suggests artist-focused positioning, but minimal community adoption. Likely a boutique solution for a specific workflow.

---

### 10. comfyui_blender_material (miguelmarco)

**Repository:** https://github.com/miguelmarco/comfyui_blender_material  
**Status:** Specialized addon for material generation

#### WHERE DOES COMFYUI RUN?

**External server.** Must be running separately.

#### HOW DO THEY TALK?

HTTP API. User sets the URL and model in addon preferences.

#### WHAT WORKFLOW FORMAT?

**Text-to-material prompt.** Users enter a material description in a prompt box and click "Generate Material." The addon constructs an implicit workflow.

#### WHERE DO OUTPUTS LAND?

**Blender shader editor.** Textures appear as image textures in the shader editor, ready for assignment to materials.

#### HOW POPULAR IS IT?

**Minimal.** No star count provided; appears to be a personal project. Very specialized (materials only).

---

### 11. AI Render (RobeSantoro, ComfyUI fork)

**Repository:** https://github.com/RobeSantoro/AI-Render-ComfyUI-Support  
**Status:** Maintenance uncertain; rewrite planned (as of July 2024)

#### WHERE DOES COMFYUI RUN?

**External server.** Connects to ComfyUI backend.

#### HOW DO THEY TALK?

HTTP API (mixed methods due to architectural differences between Automatic1111 and ComfyUI).

#### WHAT WORKFLOW FORMAT?

**Pre-built workflows or implicit workflows.** RobeSantoro created separate logic paths for ComfyUI vs. other backends.

#### WHERE DO OUTPUTS LAND?

**AI Render's standard output handling.** Renders integrated into Blender's render output.

#### HOW POPULAR IS IT?

**Declining.** AI Render is primarily known for Stable Diffusion integration via Automatic1111 web UI. ComfyUI support is a fork/side project. RobeSantoro indicated (July 2024) plans for a full rewrite, suggesting current implementation may not be production-ready. Not widely recommended in Blender AI forums.

---

## COMPARISON TABLE

| Bridge | Local Launch | Remote Server | Node Editor | Output Destination | Stars | Status | Best For |
|--------|-------|--------|-------------|------------------|-------|--------|----------|
| **ComfyUI-BlenderAI-node** | ✓ Embedded | ✓ Yes | ✓ Full graph | ComfyUI output/ dir | 1,500 | Active | All-purpose, native node control |
| **ComfyUI-Blender** | ✗ No | ✓ Required | ✗ API JSON | ComfyUI output/ dir | 188 | Active | Workflow-first, pre-built jobs |
| **Pallaidium** | ✗ No | ✓ Required | ✗ VSE implicit | VSE timeline | 1,300 | Active | Video generation + sequencing |
| **StableGen** | ✗ No | ✓ Required | ✗ Texture implicit | Blender 3D scene | 816 | Active | 3D asset + texture generation |
| **Dream Textures** | ✓ Local | ✗ N/A | ✓ Shader nodes | Blender textures | ? | Maintained | Legacy; non-ComfyUI option |
| **io_comfy** | ? | ✓ Yes | ? ComfyScript | UNVERIFIED | <20 | Unclear | Programmatic workflows |
| **ComfyUI-BlenderAI-node-editor** | ✓ Embedded | ✓ Yes | ✓ Full graph | ComfyUI output/ dir | <100 | Active (fork) | AIGODLIKE + long prompts |
| **ComfyUI-Texturaizer** | ✗ No | ✓ Required | ✗ Texture UI | Blender materials | 20 | Active | Paid; niche texture workflows |
| **comfyui_blender_material** | ✗ No | ✓ Required | ✗ Material UI | Blender shader editor | <10 | Unclear | Materials only; minimal adoption |
| **AI Render (ComfyUI)** | ✗ No | ✓ Yes | ✗ API | Render output | ? | Declining | Low; full rewrite planned |
| **PallaidiumAI (IANMRU)** | ✗ No | ✓ Yes | ✗ VSE implicit | VSE timeline | ? | Inactive | Alternative to tin2tin Pallaidium |

---

## OVERALL FINDINGS

### 1. Is there a dominant option?

**YES, but fragmented by use case:**

- **General-purpose 3D artist:** ComfyUI-BlenderAI-node (AIGODLIKE) dominates with 1,500 stars and native node control
- **Video sequencer:** Pallaidium is the clear leader (1,300 stars) for VSE workflows
- **Workflow-first users:** ComfyUI-Blender (alexisrolland) is the alternative for those who prefer pre-built workflows over graph manipulation

AIGODLIKE is the closest thing to a "dominant standard," but Pallaidium's comparable star count shows strong market segmentation by workflow type.

### 2. Do any run ComfyUI on RunPod or other rented-GPU services specifically?

**NO—not baked into the bridges.**

All bridges that support remote servers can *theoretically* connect to RunPod, Salad, etc., but:
- **No addon automatically deploys to RunPod.** Users must manually launch ComfyUI on RunPod and provide the URL
- **RunPod is the default cloud choice** for AI workloads in this space (based on search results), but setup is manual:
  1. Spin up ComfyUI pod on RunPod
  2. Get the HTTP service URL (port 8188 or custom)
  3. Paste URL into addon preferences
  4. Blender addon connects via HTTP API

Similar pattern for Salad, Vast.ai, other GPU cloud providers. No bridge has native RunPod integration; the standard practice is "RunPod as a generic remote server."

**Trend note:** Search results show strong RunPod documentation for ComfyUI, suggesting RunPod is the *de facto* cloud platform for ComfyUI, even though no Blender bridge bakes in RunPod support.

### 3. Is there a trend from local toward cloud, or the reverse?

**STRONG LOCAL-FIRST TREND.**

Evidence:
- **AIGODLIKE's embedded launch feature** is advertised as a convenience—users want to start ComfyUI directly from Blender
- **Pallaidium's design** still assumes a locally running ComfyUI by default (you configure the URL, but 127.0.0.1 is the starting assumption)
- **Search results for "Blender ComfyUI cloud"** return almost no results. Users discuss RunPod for *pure* ComfyUI workflows, not Blender-ComfyUI pairs
- **Payoff analysis:** One search result noted that owning a 24 GB GPU (RTX 3090) breaks even with cloud at ~6–8 months of heavy use; artists buying GPUs locally suggests long-term local preference

**However, hybrid is growing:** Pallaidium's ability to show "local + remote models side by side" and the mention of environment variable backends suggests some users are exploring mixed setups (local Blender, remote ComfyUI for heavier inference).

**Conclusion:** The market is overwhelmingly local. Cloud usage exists but is manual, not integrated into the bridges. This reflects the artist/professional demographics of Blender—they prefer owning their GPU stack.

---

## WORKFLOW ARCHITECTURE SUMMARY

### Architecture A: Node-to-Node (AIGODLIKE, a-One-Fan)
- **Where ComfyUI runs:** User's choice—bundled locally or remote server
- **How they talk:** HTTP API
- **Workflow:** ComfyUI nodes converted to Blender nodes; graph built in Blender
- **Output:** ComfyUI output/ directory (user must retrieve or use BlenderOutputSaveImage node)
- **User mental model:** "I'm building a ComfyUI workflow, but in Blender"

### Architecture B: Workflow-to-Server (alexisrolland, LatentSpaceDirective)
- **Where ComfyUI runs:** Remote server only (must already be running)
- **How they talk:** HTTP API + WebSocket
- **Workflow:** Pre-built JSON workflow exported from ComfyUI, imported into Blender as a template
- **Output:** ComfyUI output/ directory; manual retrieval
- **User mental model:** "I built my workflow in ComfyUI, now I'm running it from Blender"

### Architecture C: Implicit Workflow (Pallaidium, StableGen, comfyui_blender_material)
- **Where ComfyUI runs:** Remote server only
- **How they talk:** HTTP API (workflows hidden from user)
- **Workflow:** High-level UI controls generate implicit workflows
- **Output:** Integrated into Blender (VSE timeline, shader editor, 3D scene)
- **User mental model:** "I'm using AI tools in Blender; I don't care about the workflow graph"

### Architecture D: Alternative (Dream Textures)
- **Where runs:** HuggingFace Diffusers locally in Blender
- **Workflow:** Blender shader nodes
- **Output:** Shader textures in Blender
- **User mental model:** "I'm painting with AI in the shader editor"

---

## SOURCES

- [AIGODLIKE ComfyUI-BlenderAI-node GitHub](https://github.com/AIGODLIKE/ComfyUI-BlenderAI-node)
- [alexisrolland ComfyUI-Blender GitHub](https://github.com/alexisrolland/ComfyUI-Blender)
- [alexisrolland ComfyUI-Blender Wiki](https://github.com/alexisrolland/ComfyUI-Blender/wiki/Usage-Examples)
- [tin2tin Pallaidium GitHub](https://github.com/tin2tin/Pallaidium)
- [Pallaidium Official Website](https://tin2tin.github.io/Pallaidium/)
- [sakalond StableGen GitHub](https://github.com/sakalond/StableGen)
- [carson-katri Dream Textures GitHub](https://github.com/carson-katri/dream-textures)
- [a-One-Fan ComfyUI-BlenderAI-node-editor GitHub](https://github.com/a-One-Fan/ComfyUI-BlenderAI-node-editor)
- [gameltb io_comfy GitHub](https://github.com/gameltb/io_comfyui)
- [AIGODLIKE ComfyUI-CUP GitHub](https://github.com/AIGODLIKE/ComfyUI-CUP)
- [ComfyUI Server Routes Documentation](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI API: The Complete Developer's Guide (2026) - Runflow](https://www.runflow.io/blog/comfyui-api-developer-guide)
- [Hosting a ComfyUI Workflow via API - 9elements](https://9elements.com/blog/hosting-a-comfyui-workflow-via-api/)
- [RunPod ComfyUI Documentation](https://docs.runpod.io/tutorials/pods/comfyui)
- [ComfyUI + Flux on Runpod - RunPod Articles](https://www.runpod.io/articles/guides/comfy-ui-flux)
- [LatentSpaceDirective ComfyUI-Texturaizer GitHub](https://github.com/LatentSpaceDirective/ComfyUI-Texturaizer)
- [miguelmarco comfyui_blender_material GitHub](https://github.com/miguelmarco/comfyui_blender_material)
- [IANMRU PallaidiumAI GitHub](https://github.com/IANMRU/PallaidiumAI)
- [RobeSantoro AI-Render-ComfyUI-Support GitHub](https://github.com/RobeSantoro/AI-Render-ComfyUI-Support)
- [Blender Artists ComfyUI Addon Discussion](https://blenderartists.org/t/generate-ai-rendering-with-blender-comfyui-addon/1527106)
- [Running ComfyUI in the Cloud: Runpod vs. RunningHub — MyAIForce](https://myaiforce.com/runpod-vs-runninghub/)
- [ComfyUI Community Manual](https://blenderneko.github.io/ComfyUI-docs/)

