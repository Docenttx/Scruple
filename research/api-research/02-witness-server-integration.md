---
name: Scruple + Leonardo API integration
description: Full architecture for Stooges image generation with Scruple provenance — witness server live, copyright model resolved, human-approval gate is the key constraint
type: project
---

## What Scruple is
SCRUPLE Studio (patent pending, Docent Technologies / Aquanomous LLC) is an AI provenance middleware platform. It creates cryptographically verifiable, blockchain-anchored proof-of-authorship records for AI-generated content. Each generation event is a provenance artifact; a Merkle tree is built over the full creative session and anchored to Ravencoin blockchain + IPFS + Arweave.

Core data model:
- **project_id** — one per creative session
- **run_sequence** — ordered iteration within a project (each generation event)
- **content_hash** — SHA-256 of the output at the moment of creation, before any modification
- **Merkle root** — computed over all content_hashes in the project; derives the SCR_XXXXXX ID
- **Lock** — seals the project; no new iterations accepted after this point

## Witness server
- Live at **localhost:5799** on this server
- `POST /api/witness` — witness one iteration: `{project_id, run_sequence, content_hash, visual_hash?, client_timestamp?}` → returns `{witness_id, server_timestamp, signature}`
- `GET /api/witness/:projectId` — retrieve all witnessed iterations for a project
- `POST /api/lock/:projectId` — seal project, compute Merkle root, return SCR ID
- `POST /api/verify` — verify local chain against server records
- TSD micropayment system (token-based) and Stripe payment layer already built
- Blockchain anchoring (RVN mint, IPFS pin, Arweave) — code exists, currently returning mock responses; not yet wired to live chain ops

## Integration plan: Stooges + Leonardo API + Scruple

**Mapping:**
- Stooges session ID = Scruple `project_id`
- Each model response (text or image) = a `run_sequence`
- Text responses: `content_hash` = SHA-256 of (prompt + model output)
- Images: `content_hash` = SHA-256 of raw image bytes at download time; `visual_hash` = perceptual hash

**Flow:**
1. Session starts → register project_id with witness server
2. Each council round completes → `POST /api/witness` for each model response
3. Image generation: human-approval gate fires (see copyright section) → Leonardo API called → image bytes hashed → `POST /api/witness` with visual_hash
4. Session end or user clicks "Lock Session" → `POST /api/lock/:sessionId` → Merkle root + SCR_ID returned
5. SCR_ID stored in sessions DB record, displayed in UI as a provenance receipt

**Infrastructure already in place in Stooges:**
- project_id per session
- Round sequencing with conductor logging
- DB session records
- Google Drive sync for outputs

## Copyright architecture

**Crux:** Human creative control is the legal test for copyright in AI-assisted work.

**Problem with naive council → image flow:** If AI generates the prompt and AI generates the image, the human's creative contribution is hard to assert. Scruple would document a weak claim, not a strong one.

**Solution — partitioned "feature session" mode:**
1. Council (watchers) generates N prompt candidates → AI as brainstorming tool only
2. Human reviews candidates, selects one, optionally edits it → **this selection/edit event is the creative act**
3. Human's approved prompt is witnessed by Scruple (`POST /api/witness`) before Leonardo is called
4. Leonardo generates image → image hash witnessed at generation time
5. Full provenance chain: human intent → council suggestions → **human selection (witnessed)** → approved prompt (witnessed) → image (witnessed)

**Key structural constraint:** Conductor cannot call Leonardo until a human selection event has been witnessed. Architectural, not a policy — same pattern as kids mode safety. The enforcement layer is unreachable by the user.

**Why this is stronger than solo prompting:** The provenance chain documents creative decision-making at each step. Human choices are the witnessed artifact. No comparable evidence trail exists for a human typing a prompt alone without Scruple.

**run_sequence mapping for a full image session:**
- Runs 1–N: council prompt candidates (witnessed as text)
- Run N+1: human-selected/edited prompt (witnessed — this is the legal anchor)
- Run N+2: generated image (witnessed with visual_hash)
- Lock → Merkle root covers the entire creative session

**How to apply:** Always build the human-approval gate as a hard prerequisite to the Leonardo call. No witnessed selection event = no image generation. This is non-negotiable for the copyright claim to hold.

## What still needs building
- Leonardo API integration (research API capabilities — generation metadata returned per call)
- Stooges-side Scruple client (`lib/scruple/witness.ts`) — thin wrapper around localhost:5799
- Human-approval UI component — prompt review step between council brainstorm and generation
- "Lock Session" button in ConductorBox
- SCR_ID display in session output / Drive sync
- Wire blockchain anchoring on witness server (RVN mint, IPFS, Arweave) — currently mocked
