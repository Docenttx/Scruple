#!/usr/bin/env bash
# Overnight investigation: bring Scruple Web Studio to full L2.
#
# Runs DETACHED so it survives the session disconnecting. Each phase is a
# headless `claude -p` run writing a markdown report to
# docs/canon/studio-l2/. Nothing is committed, pushed, or applied — the
# output is analysis and precise plans, so a human reviews before any
# change lands.
#
# Launch:  nohup bash scripts/overnight-studio-l2.sh > /tmp/studio-l2.log 2>&1 &
# Watch:   tail -f docs/canon/studio-l2/STATUS.md

set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
OUT="$REPO/docs/canon/studio-l2"
STATUS="$OUT/STATUS.md"
mkdir -p "$OUT"

# ── Safety rails, learned the hard way on 2026-08-29 ───────────────────
# A local run wrote 9 rows into the PRODUCTION witness audit log because
# WITNESS_SERVER_URL defaults to the live service. Never again.
export WITNESS_SERVER_URL="http://127.0.0.1:1"
export SCRUPLE_DB_PATH="/tmp/studio-l2-scratch.db"
unset SCRUPLE_C2PA_VAULT_KEY_OCID 2>/dev/null || true

# The mock CVM is the target for all signing work — the real one stays down.
SURROGATE_PORT=8799
if ! curl -sf -m 2 "http://127.0.0.1:${SURROGATE_PORT}/health" >/dev/null 2>&1; then
  nohup python3 "$REPO/services/cvm-surrogate/surrogate.py" > /tmp/surrogate-overnight.log 2>&1 &
  sleep 3
fi
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:${SURROGATE_PORT}"

note() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }

cat > "$STATUS" <<HDR
# Overnight — Studio to full L2

Started $(date -u +%Y-%m-%dT%H:%M:%SZ). Detached; survives disconnect.
Target: the CVM **surrogate** at $SCRUPLE_CVM_SURROGATE. The real CVM stays down.
Reports land in this directory as each phase finishes.

HDR

run_phase () {
  local name="$1" file="$2" prompt="$3"
  note "START  $name"
  if timeout 5400 claude -p "$prompt" \
        --permission-mode bypassPermissions \
        > "$OUT/$file" 2>> /tmp/studio-l2-phase.log; then
    note "DONE   $name -> $file ($(wc -l < "$OUT/$file") lines)"
  else
    note "FAILED $name (exit $?) — see /tmp/studio-l2-phase.log"
  fi
}

COMMON='You are investigating the Scruple codebase at /data/scruple-web.

STRICT RULES:
- READ ONLY. Do not edit, create, delete, commit, or push ANYTHING. Your
  entire output is the markdown report you print to stdout.
- Never send a request to 127.0.0.1:5799 (the production witness) — it is
  a live audit log. A previous run polluted it.
- The real Signer CVM is DOWN and stays down. All signing work targets the
  surrogate at http://127.0.0.1:8799 (services/cvm-surrogate/), which is
  wire-compatible with OCI KMS.
- Distinguish what the code DOES from what a doc CLAIMS. Cite file:line.
- Where you are unsure, write UNVERIFIED rather than guessing.

CONTEXT — read these first:
  docs/canon/STUDIO_L2_MERGE.md   the three gaps, already established
  docs/canon/L2_FLOOR.md          what L2 requires of every path
  docs/canon/CANON_SKELETON.md    the canon surface design
  services/cvm-surrogate/README.md

Scruple Web Studio is a STANDALONE product with ComfyUI and Kohya running
inside it — not a plugin. Its path is app/canvas-proxy/ -> lib/canvas/ ->
lib/iterations/ingest.ts -> the witness server, plus modal/scruple_runner.py
in the container.

Output a detailed markdown report. Be concrete: file paths, line numbers,
function names, and exact changes proposed as before/after descriptions
rather than applied edits.'

run_phase "1 · leaf signatures (cheapest win)" "01-leaf-signature.md" "$COMMON

PHASE 1 — Studio leaves are unsigned, and the fix looks small. Verify that
and specify it exactly.

lib/iterations/ingest.ts around lines 300-365 stores the witness server's
witness_id, server_timestamp and HMAC signature, and appears to DISCARD the
new leaf_signature / leaf_signer_key_id / leaf_signature_alg fields that
H-1 added to the witness response (see services/witness-server/leaf_signer.js
and server.js).

Answer precisely:
1. What exactly does ingestIteration store today, and what does the witness
   response now contain that it drops? Quote both.
2. What migration is needed on the iterations table? Give the exact SQL,
   following the numbering convention in lib/db/migrations/ (039 and 040
   exist).
3. What changes in ingest.ts? Before/after for each line.
4. /api/v2/verify decides independently_verifiable by reading
   witness_signature — which is the HMAC, not the ECDSA signature. Confirm
   this is wrong and specify the fix.
5. Which OTHER integrations gain independent verifiability from this same
   change, since they share the ingest path? Enumerate them.
6. How would you TEST this end to end using the surrogate, without touching
   the production witness? Give the exact commands and env vars.
7. Any risk to existing rows or existing callers."

run_phase "2 · watermarking into Studio" "02-watermark.md" "$COMMON

PHASE 2 — watermarking reaches nothing. Specify how it reaches Studio.

lib/watermark/embed.ts and apply.ts implement §9.2. They are called from
app/api/lock/local/route.ts and referenced in app/api/v2/mark/route.ts,
which currently reports watermark as outstanding because services/watermark
has no HTTP server. No watermark reference exists anywhere in lib/canvas/,
app/canvas-proxy/ or modal/.

Answer precisely:
1. What do embed.ts and apply.ts actually do? Inputs, outputs, media types
   supported, and what the payload contains. Read services/watermark/ too.
2. Standard v1.7 §9.2 requires the payload to encode a SIGNING TIMESTAMP
   and be recoverable from pixels or audio alone. Does the implementation
   meet that? §9.2.4 payload structure and §9.2.5 detector semantics are in
   docs/architecture/SCRUPLE_STANDARD_v1_7.md — check against them.
3. §9.3 says a SCR_ID watermark is auto-attached with chain lock. Is that
   implemented? The canon audit says it is coded but never invoked — verify.
4. Specify the missing HTTP endpoint: path, request, response, auth, and
   where it lives (a server in services/watermark, or a Next route?).
   Justify the choice.
5. Where in the Studio flow should watermarking happen — in the Modal
   container before the bytes come back, or server-side after ingest?
   Argue both and recommend one. Consider that the leaf commits to the
   output hash, so watermarking AFTER hashing changes the bytes.
   THIS IS THE HARDEST QUESTION IN THIS PHASE — spend real effort on it.
6. Exact changes to Studio: files, functions, call sites.
7. How to test with the surrogate."

run_phase "3 · C2PA in Studio" "03-c2pa.md" "$COMMON

PHASE 3 — Studio has NEVER produced a C2PA manifest. Specify how it does.

There is no c2pa or signAsset reference anywhere in the Studio path.
Studio produces images and video, the media where §9.1 applies most.

Answer precisely:
1. Trace the existing C2PA signing path end to end: app/api/scruple/c2pa/sign
   -> lib/c2pa/signAsset.ts -> services/c2pa-signer/sign.py -> vault_sign.py.
   What does it need from a caller?
2. The route requires asset_path — a path on the SIGNER host. Studio output
   lives in Modal storage or object storage. How should the asset reach the
   signer? Options: bytes over HTTP, a storage handle the signer resolves, a
   shared volume. Argue and recommend.
3. What assertions should a Studio-signed manifest carry? Studio captures
   the workflow graph, dual model fingerprints and a container manifest with
   real git SHAs. Which belong in the C2PA manifest, and under which labels?
   Check config/c2pa-assertions.json — the allowlist is fail-closed, so any
   new label must be added there or signing refuses.
4. Should the C2PA manifest reference the Scruple leaf, and how?
5. Where in the flow does signing happen, and is it automatic or explicit?
6. Exact changes: files, functions, call sites, and the assertion-contract
   additions.
7. How to test against the SURROGATE (which signs real ECDSA with a
   software key) rather than the real CVM. Give commands."

run_phase "4 · the plan" "04-PLAN.md" "$COMMON

PHASE 4 — synthesise a single implementation plan.

READ the three reports just produced in docs/canon/studio-l2/:
01-leaf-signature.md, 02-watermark.md, 03-c2pa.md. Also read
docs/canon/WO-05-studio-comfyui-kohya.md, which has an earlier 8-task plan
for Studio covering deletion of dead code, tests, baselines and tenancy.

Produce THE plan to bring Studio to full L2 across all three capabilities,
merged with the relevant parts of WO-05. Requirements:

- Ordered tasks, each ending in a state worth stopping at, each with a gate
  that says how you know it is done.
- Say plainly which tasks are blocked on the real CVM and which can be
  completed against the surrogate. Most should be surrogate-completable.
- Studio has NO TESTS AT ALL. Say where tests go and make that an early
  task, not an afterthought — every task below it alters provenance capture.
- Call out anything that is a product or Standard decision rather than an
  engineering one, and leave it OPEN for the founder rather than deciding it.
- Estimate relative size per task (small/medium/large), not calendar time.
- End with the open questions, ranked by how much they block.

Be honest about uncertainty. If the three phase reports disagree with each
other, say so and explain which you trust."

note "ALL PHASES COMPLETE"
