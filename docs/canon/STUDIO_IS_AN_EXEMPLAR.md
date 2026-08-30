# Studio is an exemplar, not the skeleton

_2026-08-30, founder direction. Constrains everything in `docs/canon/`._

## The rule

**Studio is a worked example of what a vendor's end-to-end workflow could look
like. It must be perfect *as an example*. It must not BE the SDK — it should be
rebuilt using the SDK.**

The dependency runs one way: **SDK → Studio.** Studio consumes; it does not
donate.

## The test that decides it

> **Studio may not contain capture logic that is absent from the SDK.**

If Studio needs something the SDK lacks, there are exactly two possibilities and
both have the same fix location:

1. **The SDK is missing a capability** → add it *to the SDK*, and let Studio
   consume it.
2. **Studio is doing something a vendor could not do** → that makes Studio a
   *worse* example, not a better product.

This is `CANON_SKELETON.md` §5's adapter rule — *"If an adapter needs one of
these, the SDK is missing something and the SDK is where it gets added"* —
applied to Studio itself, which is the one place it had not been applied.

## Where we are actually violating this today

The canvas retrofit consumed the component's frame decoder, MIME tables and
correlator — correct direction. But it also:

- **Forked `BYTE_EGRESS` and `CONTROL_PLANE`** (five lines) because they are
  module-private in `http-gate.ts`. Mitigated by a drift test that parses the
  component's source, which is a good mitigation of the wrong thing. **Export
  them; delete the fork.**
- **Could not reuse `HttpGate`/`WsGate`**, for four reasons. Two were component
  bugs and are fixed (https proxying, WS keepalive). **The two I recorded as
  "structural rather than bugs" were mis-classified**, and this rule is what
  exposes it.

## The mis-classification, corrected

I wrote that two blockers were structural limits rather than defects:

1. `HttpGate.handle()` takes raw `node:http` req/res; a Next route handler has
   neither.
2. The component is single-upstream by construction; canvas resolves a different
   upstream per session.

Under "Studio is the reference implementation" those read as Studio quirks.
Under **"Studio is an example of what a vendor does"** they are obviously
**SDK gaps**:

- **Any vendor with a Next.js (or any framework) frontend hits the first one.**
- **Any vendor hosting more than one tenant hits the second** — per-tenant
  upstream resolution is the normal case for a hosting vendor, not a Studio
  peculiarity. It is, in fact, the exact shape Hugging Face and RunPod have.

So the component needs a framework-agnostic request adapter and multi-upstream
resolution. **Studio discovered two SDK deficiencies, which is precisely what an
exemplar is for** — the same way it discovered the https-proxy throw and the
missing keepalive, which nothing inside the reference deployment could see.

## What "perfect" means for Studio

Not *most capable*. **Most faithful.** A capability Studio uses that a vendor
cannot have makes it a worse example. The measure is: could a vendor reproduce
every Scruple-relevant thing Studio does, using only the SDK, the skeleton and
their own topology? Where the answer is no, that is a defect — in the SDK if the
capability should exist, in Studio if it should not.

## Consequences to schedule

1. Export the forked constants; delete the copy.
2. Framework-agnostic request adapter in the component (fixes blocker 1).
3. Multi-upstream/per-session resolution in the component (fixes blocker 2).
4. **Rebuild canvas as a thin consumer** of the component rather than a parallel
   implementation that borrows pieces.
5. **Enforce the rule mechanically** — a test that fails if Studio's capture
   path reimplements what the SDK exports. Every other invariant this week that
   was left to discipline was violated within a day; this one should not be an
   exception.
