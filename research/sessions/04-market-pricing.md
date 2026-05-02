# Scruple × Stooges — Market Research & Product Decision
_2026-04-08T18:00:27.378Z_



# Definitive Market Brief + Product Decision

---

## Market Reality: The Numbers

| Metric | Figure | Confidence |
|---|---|---|
| ChatGPT weekly active users | 200M–400M (grew rapidly through 2024) | High — OpenAI disclosed |
| DALL-E–specific monthly actives | 1–2M (estimated; subset of ChatGPT) | Low — no official breakout |
| Leonardo.ai registered users | 1M+ | Medium — company claim, mid-2023 |
| Leonardo.ai monthly actives | 100K–200K | Low — inferred from Discord, web traffic |
| Leonardo.ai paying users | 20K–70K (implied by $7M ARR at $10–30/mo) | Medium — derived from Series A reporting |
| Midjourney actives | ~2M | Medium — company stats, late 2023 |
| Adobe Creative Cloud subscribers | 43M (Firefly embedded) | High — earnings report |
| Professional creators across DALL-E + Leonardo who might value provenance | 110K–440K | Low — estimated at 10–20% of active bases |
| Realistic paying users for a niche provenance tool | 5,500–44,000 | Low — 5–10% conversion assumption |
| Revenue ceiling at $10–20/mo | $55K–$880K/month | Derived — wide range reflects uncertainty |
| C2PA member organizations | 1,500+ | High — public registry |
| Adobe Content Credentials enterprise adoption | ~30% of enterprise base | Medium — Adobe press, mid-2024 |
| Adobe Content Credentials consumer adoption | <5% | Low — estimate |
| Competitors (Truepic, Numbers Protocol) combined users | <50K | Low — inferred from app/web traffic |

**Bottom line:** The total provenance-motivated market across DALL-E and Leonardo is sub-500K users. The paying segment is likely under 50K. This is a real market, but it is small, niche, and pre-regulatory.

---

## The Provenance-Motivated User

This person exists. They are not hypothetical. But they are rare.

**Profile:** A 30–45-year-old digital asset manager, freelance graphic designer, or creative director at a mid-sized agency. They generate AI images commercially — for marketing campaigns, game assets, or stock library submissions. They work with clients who ask uncomfortable questions about IP ownership. They submit to Getty or Shutterstock, which already ban unprovenanced AI content. They have been burned or fear being burned: a rejected stock submission, an ambiguous client contract, a legal gray zone they can't resolve.

**What they do today:** Manually screenshot prompts, save version histories in folders, watermark inconsistently, and hope for the best. Maybe 20% watermark consistently. Fewer than 10% register copyright. Almost none use C2PA tooling outside Adobe's ecosystem.

**What they'd pay:** $10–30/month for a tool that integrates into their existing workflow and produces outputs that platforms and clients accept. Enterprise buyers (agencies, studios) would pay $50–200/seat/month if it reduced legal exposure and unlocked platform compliance.

**How many exist:** Realistically, 5,500–44,000 who would pay today. This number grows meaningfully only when regulations or platform mandates force the issue — likely 2026 at the earliest.

---

## Regulatory Forcing Function

This is the single most important variable in the entire analysis. It determines whether provenance is a nice-to-have or a must-have.

| Regulation / Mandate | Timeline | Impact |
|---|---|---|
| EU AI Act — full enforcement | August 2026 | Mandates disclosure/labeling of AI-generated content in commercial contexts. Fines up to €35M or 7% global revenue. |
| US Copyright Office position | Active now (March 2023 guidance) | AI-only works not copyrightable. Provenance documenting human input is the path to protection. |
| Getty/Shutterstock metadata requirements | Active now (since late 2022) | Already banning unprovenanced AI content. Immediate forcing function for stock contributors. |
| LinkedIn, X — C2PA integration | Exploratory, targeting 2025 | Not yet enforced. Background signal, not a deadline. |
| AP, Reuters, BBC — C2PA pilots | Active, 2024 | Relevant for news/media contexts, less so for creative tools. |

**Verdict:** The EU AI Act is a real deadline, not background noise. August 2026 gives the market roughly 18–20 months from now. But regulatory adoption curves are slow — enforcement will lag, grace periods will extend, and most small creators won't feel the pain until 2027–2028. The *immediate* forcing functions are stock platform policies (Getty, Shutterstock), which affect a narrow but motivated segment today.

**Net assessment:** Regulatory pressure is a tailwind that will double or triple the addressable market by 2027, but it is not creating panic-level urgency today. The window is real but not yet acute for most users.

---

## Stated vs. Revealed Preference

This is where the market story either holds or collapses. It mostly collapses.

- **68% of professional creators** say they worry about authorship of AI content (NAB, 2023).
- **72% of stock contributors** say they want mandatory provenance metadata (Getty, 2023).
- **<5% of consumers** use Adobe Content Credentials, the most accessible provenance tool on the market.
- **~30% of enterprise users** adopt Content Credentials — meaningful, but these are Adobe's existing paying customers with low switching costs.
- **<20% of professional creators** consistently watermark AI content.
- **<10%** register copyright for digital works.

**The gap is enormous.** A 60–70% stated concern translates to a 5–20% action rate among professionals and a sub-5% action rate among consumers. This is the classic "everyone says they'd pay for privacy but nobody reads the terms of service" problem.

**What this means for product decisions:**
- Do not size any market based on survey data. Size it based on revealed behavior — tool adoption, payment rates, platform compliance actions.
- The realistic demand for a paid provenance tool is the intersection of (a) professional users, (b) under active platform or regulatory pressure, and (c) not already served by Adobe. That intersection is **small — likely 10K–30K users today**, growing to 50K–100K by 2027.
- Conversion requires reducing friction to near zero and delivering immediate, tangible value (platform acceptance, legal defensibility) — not abstract "peace of mind."

---

## The Opportunity No One Is Capturing

"Creative provenance" — the decision trail, not just the hash chain — is the most interesting idea in this entire analysis. Let me be honest about whether it's real.

**What it is:** Every provenance tool today captures *what* was generated and *when*. C2PA, Content Credentials, blockchain anchoring — they all produce technical metadata. None of them capture *why* a creative chose version 3 over version 7, what the council debated, what the rejection rationale was, or how human judgment shaped the final output.

**Why it could matter:**
1. **Legal defensibility.** The US Copyright Office requires "significant human input" for copyright protection. A hash proves a file existed. A decision trail proves a human made choices. This is the difference between "I generated this" and "I authored this."
2. **Client trust.** Agencies selling AI-assisted work to clients need to demonstrate creative control, not just technical provenance. A decision narrative is more persuasive than a Merkle tree.
3. **Regulatory compliance.** The EU AI Act's disclosure requirements will evolve. Demonstrating human oversight (not just labeling) may become the standard. A decision trail preempts this.

**Why it might not matter:**
1. **No one has asked for it yet.** There is zero revealed demand data for "creative provenance" specifically. It is a hypothesis, not a validated need.
2. **It adds friction.** Capturing decision rationale requires user input — annotations, selections, explanations. Most creators won't do this voluntarily.
3. **Legal standards are undefined.** Courts and regulators haven't specified what "proof of human authorship" looks like. A decision trail *might* satisfy them. Or it might be irrelevant.

**Verdict:** Creative provenance is a **real differentiator but an unproven market.** It is the strongest unique angle available to either product. It deserves a focused experiment — not a major build. The right move is to test whether 100 professional users will use it and whether it changes outcomes (platform acceptance, legal defensibility, client trust). If it does, it's a category-defining feature. If it doesn't, it's a clever story that nobody needed.

---

## Product Decision: Stooges

### 1. Is the provenance market large and urgent enough for Stooges to build toward it?

**No.**

The provenance market is 10K–30K paying users today, growing to maybe 100K by 2027. It is a compliance-driven niche dominated by professional creators under platform or regulatory pressure. Stooges is a web-based multi-model council product. Its user base is text-focused thinkers, strategists, and creatives who value iterative multi-perspective critique. The overlap between "people who want AI councils to debate their ideas" and "people who need C2PA-compliant hash chains for stock photo submissions" is vanishingly small.

Building provenance as a core feature in Stooges would mean chasing a small, misaligned market at the cost of product identity and development focus. The math doesn't work.

### 2. Is Stooges a council product with provenance, or a provenance product with council?

**Stooges is a council product. Full stop.**

Provenance belongs in Scruple Studio, which is architecturally and conceptually built for it (Electron desktop, file-system access, local hashing, Merkle chains, blockchain anchoring). Stooges' moat is the multi-model council — the debate, the iteration, the synthesis of competing perspectives. That is what users come for. That is what no one else offers.

The temptation to bolt provenance onto Stooges comes from seeing regulatory tailwinds and imagining they apply universally. They don't. They apply to a specific professional segment that Scruple already targets.

### 3. What is the single clearest user story that justifies an integration?

> **"I used Stooges to run a council debate on five versions of a hero image for a client campaign. The council chose version 3 and documented why. I need to export that decision trail — the prompts, the critiques, the rejection rationales — into Scruple Studio so my client has a full authorship narrative alongside the technical provenance chain."**

This is a **handoff story**, not an integration story. Stooges captures the *why*. Scruple captures the *what* and *when*. The user needs both, but in sequence, not in the same product. The connection is an export — a structured JSON or PDF of the council's decision trail that Scruple can ingest and attach to its provenance record.

### 4. What is the first thing to build?

**A "Decision Trail Export" from Stooges.**

Not a provenance workspace. Not a hash chain. Not C2PA compliance. Just a clean, structured export of a council session's decision history — which options were considered, what each council member said, which was chosen, and why. Format it as structured data (JSON) and a human-readable document (PDF). Make it downloadable.

This is:
- **Low cost to build** — it's a serialization of data Stooges already generates.
- **Immediately useful** — even without Scruple integration, users can attach it to client deliverables, legal files, or portfolio documentation.
- **A test of the "creative provenance" hypothesis** — if users actually download and use these exports, the market signal is clear. If they don't, you've saved months of building the wrong thing.
- **A bridge to Scruple** — once the export exists, Scruple can ingest it. The integration writes itself later, if demand warrants it.

Build the export. Ship it. Watch what users do with it. Let their wallets, not their words, tell you what comes next.