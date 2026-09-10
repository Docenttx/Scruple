#!/usr/bin/env bash
# WO-G1 — SCRUPLE Studio's own interface, running on Electron 38.
#
# The gate boots the real app three times, with three configurations, and
# compares the WHOLE tab set each time against a declared expectation. A set
# comparison rather than a list of presences: a sixth tab nobody justified is the
# drift this series exists to catch, and "is Workspace present" cannot see it.
#
# Boot A  comfy on,  wallet=fiat        -> ComfyUI · Workspace · Fiat
# Boot B  comfy on,  wallet=blockchain  -> ComfyUI · Workspace · Blockchain
# Boot C  comfy OFF, wallet=fiat        -> Workspace · Fiat        (ABSENT, not empty)
#
# Boot C is the control. It must have NO ComfyUI node in the document at all —
# not a disabled button, not an empty container. That is existing behaviour and
# the work order requires it preserved.

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
RUN="$ROOT/.run/g1"
ELECTRON="$ROOT/node_modules/.bin/electron"

rm -rf "$RUN"; mkdir -p "$RUN"
mkdir -p "$RUN/fake-comfyui" "$RUN/training"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s  %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s  %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

# seed_home <dir> <comfyEnabled true|false> <beta.paymentMode> <beta.rvnMode>
#
# ⚑ BOTH keys, and that is a finding rather than belt-and-braces. `beta.paymentMode`
# is what the renderer reads at startup (renderer/api.js:117-122); `beta.rvnMode` is
# what the View menu reads and writes (main-modular.js:374-386). They mean the same
# thing and nothing keeps them in step — see docs/G1-PORT-REPORT.md.
seed_home() {
  mkdir -p "$1/config"
  cat > "$1/config/scruple_studio.json" <<JSON
{
  "comfyUIPath": "$RUN/fake-comfyui",
  "trainingOutputDir": "$RUN/training",
  "comfyUIEnabled": $2,
  "kohyaEnabled": false,
  "beta": { "paymentMode": "$3", "rvnMode": "$4" },
  "setupComplete": true
}
JSON
}

# boot <label> <home> <result.json>
boot() {
  SCRUPLE_HOME="$2" \
  SCRUPLE_SCENARIO_RESULT="$3" \
  timeout 180 xvfb-run -a -s "-screen 0 1600x900x24" \
    "$ELECTRON" app-legacy --scenario=scenarios/g1-shell.json \
    > "$RUN/$1.log" 2>&1
  echo $?
}

# tabset <result.json>  ->  the tab labels, sorted, comma-joined
tabset() {
  node -e '
    const r = require(process.argv[1]);
    const t = r.steps?.dom?.value?.selectors?.[".view-toggle-btn"]?.text || "";
    const set = t.split(" · ").map(s => s.replace(/[^A-Za-z_]/g, "").trim()).filter(Boolean).sort();
    console.log(set.join(","));
  ' "$1"
}

# ── the three boots ───────────────────────────────────────────────────────────
# ⚑ WO-G4 ADDED `Blender`, AND THIS GATE CAUGHT IT — which is the whole reason
# it compares a SET rather than checking that each expected tab is present. The
# three sets below changed in one commit, with a reason, instead of a new tab
# arriving unremarked. That is the difference between a change and a drift.
#
# Blender appears in all three because this box HAS one: the tab is gated on
# fs.existsSync of the resolved binary, so on a machine without Blender all three
# sets lose it together. scripts/g4-gate.sh is what proves that, by booting twice.
declare -A EXPECT=(
  [A]="Blender,ComfyUI,Fiat,Workspace"
  [B]="Blender,Blockchain,ComfyUI,Workspace"
  [C]="Blender,Fiat,Workspace"
)
declare -A CONF=( [A]="true fiat auto" [B]="true blockchain user" [C]="false fiat auto" )

for L in A B C; do
  read -r EN PM RV <<< "${CONF[$L]}"
  echo "── boot $L: comfyUIEnabled=$EN beta.paymentMode=$PM beta.rvnMode=$RV"
  seed_home "$RUN/home-$L" "$EN" "$PM" "$RV"
  rc=$(boot "$L" "$RUN/home-$L" "$RUN/result-$L.json")
  if [ "$rc" != "0" ]; then bad "boot-$L-completed" "exit $rc — see $RUN/$L.log"; continue; fi
  ok "boot-$L-completed"
  if [ ! -f "$RUN/result-$L.json" ]; then bad "boot-$L-wrote-a-result"; continue; fi

  got=$(tabset "$RUN/result-$L.json")
  if [ "$got" = "${EXPECT[$L]}" ]; then ok "boot-$L-tab-set-is-exactly" "$got"
  else bad "boot-$L-tab-set-is-exactly" "got [$got] expected [${EXPECT[$L]}]"; fi
done

# ── the control, asked of the whole serialised document ───────────────────────
# ABSENT, NOT EMPTY. Boot C had ComfyUI switched off; the string "comfyui" must
# not appear in the tab bar's markup at all. `dom-unmentioned` on the whole
# document would be stronger still, but the ComfyUI PATH is legitimately in the
# page's state, so the question is asked of the tab bar.
node -e '
  const A = require(process.argv[1]), C = require(process.argv[2]);
  const sel = (r, s) => r.steps?.dom?.value?.selectors?.[s]?.count ?? -1;
  const checks = [
    ["comfy-tab-present-when-enabled",  sel(A, ".view-toggle-btn[data-view=\"comfyui\"]") === 1],
    ["comfy-tab-ABSENT-when-disabled",  sel(C, ".view-toggle-btn[data-view=\"comfyui\"]") === 0],
    ["comfy-container-present-when-enabled", sel(A, ".comfy-webview-container") === 1],
    ["comfy-container-ABSENT-when-disabled", sel(C, ".comfy-webview-container") === 0],
    ["comfy-webview-tag-exists",        sel(A, ".comfy-webview-container webview") === 1],
    ["kohya-tab-absent-no-kohya-running", sel(A, ".view-toggle-btn[data-view=\"kohya\"]") === 0],
    ["kohya-not-even-mentioned",        (A.steps?.dom?.value?.mentions?.["data-view=\"kohya\""] ?? -1) === 0],
    ["wallet-modes-are-mutually-exclusive",
      sel(A, ".view-toggle-btn[data-view=\"wallet\"][data-wallet-mode=\"fiat\"]") === 1 &&
      sel(A, ".view-toggle-btn[data-view=\"wallet\"][data-wallet-mode=\"blockchain\"]") === 0],
  ];
  let bad = 0;
  for (const [id, okk] of checks) { console.log(`  ${okk ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${id}`); if (!okk) bad++; }
  process.exit(bad ? 1 : 0);
' "$RUN/result-A.json" "$RUN/result-C.json"
absrc=$?
if [ $absrc -eq 0 ]; then pass=$((pass+8)); else fail=$((fail+1)); fi

echo
echo "  g1 gate: $pass pass, $fail fail"
[ $fail -eq 0 ] || exit 1
