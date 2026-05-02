# Scruple × Stooges — Strategy Decisions
_2026-04-08T17:41:14.608Z_



# Definitive Product Decisions: Scruple Provenance × Stooges

---

## Decision 1: Integration vs. Standalone

**Verdict:** Lightweight integration via a provenance sidebar within Stooges — not a full merge, not fully standalone.

**Reasoning:**
- Both council members agreed that a deep merge creates an identity crisis. That's correct. Stooges should never become a provenance management app, and Scruple should never become a chatbot.
- But Cleopatra's blanket rejection of integration rests on an unvalidated claim that the overlap user "barely exists." Pinocchio rightly flagged this. The user who generates AI images, iterates on them through critique, and then needs to prove creative origin is not a unicorn — it's any professional digital artist or agency using AI tools under increasing IP scrutiny. This user base is *growing*, not shrinking.
- The real question isn't "merge vs. separate" — it's "what's the thinnest possible integration that captures provenance at the moment of creation without disrupting the council workflow?" The answer is: automatic capture at generation time, surfaced in a non-intrusive provenance panel, with Scruple desktop as the deep management tool.
- Full standalone with manual export is a cop-out that guarantees provenance is an afterthought. If provenance isn't captured at the moment the image is born inside Stooges, it's worthless — the chain of custody has a gap.
- Stooges becomes the *capture point*. Scruple desktop remains the *management and verification tool*. They share a data layer, not a UI.

**What this means for the build:**
- Stooges automatically generates provenance records (hash, prompt, model, timestamp, session context) whenever an image is created via DALL-E/Leonardo within a Bit.
- A collapsible provenance sidebar in the image generation panel shows current chain state — not the full Scruple project management UI.
- Scruple desktop reads from the same provenance store and provides full project management, locking, export, and verification.
- No Scruple project management UI inside Stooges. No council UI inside Scruple desktop.

---

## Decision 2: Council Value for Image Generation

**Verdict:** Council-in-the-loop adds genuine, unique value for image generation — specifically in prompt refinement and structured critique — and should be a core Stooges capability, not an optional novelty.

**The roles that matter:**

| Role | What they actually do in an image session |
|---|---|
| **Art Director** | Evaluates composition, color palette, visual hierarchy. Gives specific revision directives ("too centered, shift subject to rule-of-thirds left"). |
| **Prompt Engineer** | Analyzes the gap between user intent and generated output. Rewrites the prompt with technical specificity (negative prompts, style tokens, weight adjustments). |
| **Brand Strategist** | Evaluates whether the image serves its intended purpose — campaign fit, audience resonance, tonal alignment. Asks "who is this for and does it work?" |
| **Technical Critic** | Flags artifacts, anatomical errors, lighting inconsistencies, resolution issues. Pure quality control. |

**The roles that don't:**
- **Philosopher/Ethicist** — Adds friction without actionable output for most image work. Edge cases (sensitive content) are better handled by platform guardrails than council debate.
- **Comedian/Entertainer** — Breaks the creative flow. Humor in critique dilutes signal.
- **Researcher** — Trend context is useful but not per-image. Better as a pre-session briefing, not a per-round participant.

**What a council-driven image session looks like:**

1. **User sets intent.** Opens a Bit (or continues one), states the creative goal: "Hero image for a solarpunk architecture blog post. Warm, hopeful, detailed."
2. **Council expands the brief.** Art Director, Prompt Engineer, and Brand Strategist each propose a detailed prompt variation. User sees 3 distinct interpretations side by side.
3. **User selects or merges.** Picks one prompt or synthesizes elements from multiple. Conductor summarizes the chosen direction.
4. **Image generates.** DALL-E or Leonardo produces the image. Provenance record is automatically created (hash, prompt, model, parameters, timestamp, Bit/session context).
5. **Council critiques.** Each active role evaluates the result against the brief. Art Director flags composition. Technical Critic flags artifacts. Prompt Engineer suggests specific prompt edits for the next iteration. Brand Strategist assesses fit.
6. **Conductor synthesizes.** Produces a single prioritized revision plan: "Fix the sky gradient (Art Director), add 'detailed vegetation' to prompt (Prompt Engineer), keep the warm tone (Brand Strategist confirms)."
7. **User triggers next iteration.** Refined prompt generates a new image. New provenance record is created, linked to the previous iteration as a revision chain.
8. **Repeat or lock.** User iterates until satisfied. Final image can be marked as "selected" in the provenance sidebar, which Scruple desktop picks up for locking and export.

---

## Decision 3: Workspace Structure

**The key insight:** A Scruple project is a *provenance container that spans Bits*; a Bit is a *conversation container that spawns provenance records*. They have a many-to-many relationship, and the user should never have to manage that relationship manually — it should be inferred from project assignment at generation time.

**Data model:**

```
scruple_project
  ├── id (uuid)
  ├── name
  ├── created_at
  ├── lock_state (open | sealed | locked)
  └── merkle_root (nullable, set on lock)

image_provenance
  ├── id (uuid / SCR-ID)
  ├── scruple_project_id (FK → scruple_project)
  ├── bit_id (FK → bit)
  ├── session_id (FK → session)
  ├── round_number (int)
  ├── parent_iteration_id (FK → self, nullable — revision chain)
  ├── image_hash (sha256)
  ├── prompt_text
  ├── model (dall-e-3 | leonardo-xyz)
  ├── generation_params (json)
  ├── timestamp
  ├── is_selected (boolean — user's chosen final)
  └── council_critique_summary (text, nullable)

bit
  ├── id
  ├── name
  └── default_scruple_project_id (FK → scruple_project, nullable)

session (existing Stooges entity)
  ├── id
  ├── bit_id (FK → bit)
  └── ...existing fields...
```

**Key relationships:**
- A Bit can optionally be assigned to a Scruple project. All images generated within that Bit auto-associate.
- A Scruple project can receive images from multiple Bits.
- An image_provenance record always knows its Bit, session, and round — this is captured automatically, not manually tagged.
- Revision chains are tracked via `parent_iteration_id` — each iteration knows what it refined.

**Workspace layout:**

```
┌─────────────────────────────────────────────────────────┐
│  [Bit Name ▾]              [Stooges]     [? Help]      │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  SIDEBAR   │   MAIN PANEL                              │
│            │                                            │
│  Bits      │   ┌─────────────────────┬───────────────┐ │
│  ├ Bit 1   │   │                     │ PROVENANCE    │ │
│  ├ Bit 2 ● │   │  COUNCIL CHAT       │ SIDEBAR       │ │
│  └ Bit 3   │   │                     │ (collapsible) │ │
│            │   │  Session rounds,    │               │ │
│  ─────────  │   │  stooge responses,  │ Project: ___  │ │
│  Scruple   │   │  conductor synth    │ Iterations: 4 │ │
│  Projects  │   │                     │ ┌───┐ ┌───┐  │ │
│  ├ Proj A  │   │  ┌────────────────┐ │ │ 1 │ │ 2 │  │ │
│  └ Proj B  │   │  │ IMAGE PANEL    │ │ └───┘ └───┘  │ │
│            │   │  │ [Generated Img]│ │ ┌───┐ ┌───┐  │ │
│            │   │  │ [Generate Next]│ │ │ 3 │ │✓4 │  │ │
│            │   │  └────────────────┘ │ └───┘ └───┘  │ │
│            │   │                     │               │ │
│            │   │                     │ Chain: ✓      │ │
│            │   │                     │ Hash: a3f2... │ │
│            │   │                     │               │ │
│            │   │                     │ [Open in      │ │
│            │   │                     │  Scruple ↗]   │ │
│            │   └─────────────────────┴───────────────┘ │
└────────────┴────────────────────────────────────────────┘
```

**Navigation:**
- **Left sidebar** shows both Bits and Scruple Projects as top-level entities. Clicking a Bit opens the council workspace. Clicking a Scruple Project opens a read-only iteration gallery (thumbnails, chain status, provenance stats) — *not* full Scruple project management.
- **Provenance sidebar** (right) appears automatically when a Bit has generated images. Shows the iteration chain for the current Bit's assigned Scruple project. Collapsible to stay out of the way during pure council work.
- **"Open in Scruple"** button deep-links to the Scruple desktop app for full project management, locking, export, and verification. This is the escape hatch — Stooges shows provenance *status*, Scruple manages provenance *lifecycle*.
- **Project assignment** happens once: when the first image is generated in a Bit, user is prompted to assign it to an existing Scruple project or create a new one. After that, it's automatic.

**What's shared vs. separate:**

| Shared | Separate |
|---|---|
| Provenance data store (both apps read/write) | Council logic (Stooges only) |
| Image files + hashes | Project locking & sealing (Scruple desktop only) |
| Project assignment (set in Stooges, managed in Scruple) | Full iteration management UI (Scruple desktop only) |
| Generation metadata (prompt, model, params) | Verification & export (Scruple desktop only) |
| Iteration chain (parent/child links) | Stooge role configuration (Stooges only) |

---

## What NOT to Build

1. **Full Scruple project management UI inside Stooges.** No lock controls, no Merkle tree visualization, no export workflows in the web app. Stooges shows provenance *status*. Scruple desktop manages provenance *lifecycle*. Building both is how you get a bloated app nobody trusts for either job.

2. **Automated council-to-provenance mapping via manual tagging.** Cleopatra's fallback proposal of dropdown-based "Associate w/ Bit" manual linking is dead on arrival. Users won't do it. Provenance capture must be automatic at generation time or it won't happen. Build it into the generation action, not as a post-hoc chore.

3. **A "Provenance Tab" as a co-equal top-level workspace.** This creates the two-apps-duct-taped-together problem both council members warned about. Provenance is a *sidebar* and a *data layer*, not a destination. The council workspace is primary; provenance is contextual.

4. **Council roles for every image evaluation.** Don't build Philosopher, Comedian, Researcher, or Ethicist roles into image sessions. They add latency and noise. Start with Art Director, Prompt Engineer, Brand Strategist, Technical Critic. Add others only if user demand surfaces.

5. **Bidirectional sync between Scruple desktop and Stooges for council data.** Scruple doesn't need to know about stooge roles, session rounds, or conductor syntheses. It needs the image, the hash, the prompt, the model, and the chain. Don't leak council concepts into the provenance domain.

---

## Recommended First Feature

**Automatic provenance capture on image generation within a Bit.**

Build this and only this first:
- When a user generates an image via DALL-E or Leonardo inside a Stooges Bit, the system automatically creates an `image_provenance` record: hash, prompt, model, params, timestamp, bit_id, session_id, round.
- The provenance sidebar appears showing the record: thumbnail, hash snippet, timestamp.
- No Scruple project assignment yet. No iteration chains. No council critique summary. Just: *the image was born here, and we can prove it.*

**Why this is the smallest testable unit:** It validates the core hypothesis — that capturing provenance at the moment of creation inside a council workflow is both technically feasible and valued by users — without building any project management, locking, or cross-app sync. If users ignore the sidebar, integration has no legs. If they start asking "can I group these?" and "can I lock this?" — you've proven demand for the full integration and earned the right to build Decisions 1 and 3.