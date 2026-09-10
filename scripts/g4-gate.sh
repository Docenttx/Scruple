#!/usr/bin/env bash
# WO-G4 — the Blender tab, beside ComfyUI and Kohya_ss.
#
# Two boots, because one process cannot both have a Blender and not have one:
#
#   present  SCRUPLE_BLENDER_BIN points at the vendored Blender
#   absent   the binary is taken away, exactly as WO-E5's `blender-absent`
#            mutation does it
#
# THE CONTROL IS THE DIFF. Between those two runs the tab set must differ by
# EXACTLY the Blender button and by nothing else. "The other tabs look fine" is
# how a missing tab survived seven work orders; this subtracts one set from the
# other and prints what is left.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
RUN="$REPO/.run/g4"
ELECTRON="$REPO/node_modules/.bin/electron"
HOME_DIR="$RUN/home"

rm -rf "$RUN"; mkdir -p "$RUN/fake-comfyui" "$RUN/training" "$RUN/no-apps" "$HOME_DIR/config"
cat > "$HOME_DIR/config/scruple_studio.json" <<JSON
{ "comfyUIPath": "$RUN/fake-comfyui", "trainingOutputDir": "$RUN/training",
  "comfyUIEnabled": true, "kohyaEnabled": false,
  "beta": { "paymentMode": "fiat", "rvnMode": "auto" }, "setupComplete": true }
JSON

pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m  %-44s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m  %-44s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

boot(){ # boot <label> <extra env assignments...>
  local label="$1"; shift
  env SCRUPLE_HOME="$HOME_DIR" SCRUPLE_SCENARIO_RESULT="$RUN/$label.json" "$@" \
    timeout 300 xvfb-run -a -s "-screen 0 1600x900x24" \
    "$ELECTRON" app-legacy --scenario=scenarios/g4-blender-tab.json > "$RUN/$label.log" 2>&1
  echo $?
}
tabset(){ node -e '
  const r=require(process.argv[1]);
  const t=r.steps?.dom?.value?.selectors?.[".view-toggle-btn"]?.text||"";
  console.log(t.split(" · ").map(s=>s.replace(/[^A-Za-z_]/g,"").trim()).filter(Boolean).sort().join(","));
' "$1"; }
sel(){ node -e '
  const r=require(process.argv[1]);
  console.log(r.steps?.dom?.value?.selectors?.[process.argv[2]]?.count ?? -1);
' "$1" "$2"; }
mention(){ node -e '
  const r=require(process.argv[1]);
  console.log(r.steps?.dom?.value?.mentions?.[process.argv[2]] ?? -1);
' "$1" "$2"; }

BLENDER_BIN="${SCRUPLE_BLENDER_BIN:-$REPO/vendor/blender/bin/blender}"
[ -x "$BLENDER_BIN" ] || { echo "!! no Blender at $BLENDER_BIN — run npm run e3:install"; exit 2; }

echo "── boot A: this machine HAS a Blender"
rc=$(boot present SCRUPLE_BLENDER_BIN="$BLENDER_BIN")
[ "$rc" = "0" ] && ok "boot-present-completed" || bad "boot-present-completed" "exit $rc — see $RUN/present.log"

echo "── boot B: the Blender is taken away"
rc=$(boot absent SCRUPLE_BLENDER_VENDOR="$RUN/no-apps/blender" SCRUPLE_BLENDER_SEARCH_PATH="$RUN/no-apps")
[ "$rc" = "0" ] && ok "boot-absent-completed" || bad "boot-absent-completed" "exit $rc — see $RUN/absent.log"

if [ -f "$RUN/present.json" ] && [ -f "$RUN/absent.json" ]; then
  P=$(tabset "$RUN/present.json"); A=$(tabset "$RUN/absent.json")
  [ "$(sel "$RUN/present.json" '.view-toggle-btn[data-view="blender"]')" = "1" ] \
    && ok "tab-present-when-blender-is" "$P" || bad "tab-present-when-blender-is" "$P"

  # 🔴 ABSENT, NOT GREYED — asked of the whole serialised document, which is a
  # stronger question than "is there a node": it catches a tab rendered hidden,
  # or disabled, or left behind in a data attribute.
  [ "$(sel "$RUN/absent.json" '.view-toggle-btn[data-view="blender"]')" = "0" ] \
    && [ "$(mention "$RUN/absent.json" 'data-view="blender"')" = "0" ] \
    && [ "$(sel "$RUN/absent.json" '.blender-container')" = "0" ] \
    && [ "$(mention "$RUN/absent.json" 'blender-container')" = "0" ] \
    && ok "CONTROL-absent-not-greyed" "no node, and not even mentioned" \
    || bad "CONTROL-absent-not-greyed" "tabs=$A container=$(sel "$RUN/absent.json" '.blender-container') mention=$(mention "$RUN/absent.json" 'data-view=\"blender\"')"

  # 🔴 THE DIFF. Exactly one tab appears, and nothing else moves.
  DIFF=$(node -e '
    const a=process.argv[1].split(",").filter(Boolean), b=process.argv[2].split(",").filter(Boolean);
    const added=a.filter(x=>!b.includes(x)), removed=b.filter(x=>!a.includes(x));
    console.log(JSON.stringify({added,removed}));
  ' "$P" "$A")
  [ "$DIFF" = '{"added":["Blender"],"removed":[]}' ] \
    && ok "CONTROL-the-only-difference-is-Blender" "$DIFF" \
    || bad "CONTROL-the-only-difference-is-Blender" "$DIFF"

  # No webview in the Blender tab. Blender is native; a webview would mean the
  # tab had been pointed at something that is not Blender.
  [ "$(sel "$RUN/present.json" '.blender-container webview')" = "0" ] \
    && ok "no-webview-in-the-blender-tab" "it is native — there is no URL to embed" \
    || bad "no-webview-in-the-blender-tab"
  [ "$(sel "$RUN/present.json" '.blender-container .webview-overlay')" = "1" ] \
    && ok "reuses-the-existing-overlay-shape" || bad "reuses-the-existing-overlay-shape"
  [ "$(sel "$RUN/present.json" '.blender-container #measure-blender')" = "1" ] \
    && ok "offers-the-one-action" || bad "offers-the-one-action"
  # The neighbours, in BOTH runs.
  for f in present absent; do
    [ "$(sel "$RUN/$f.json" '.comfy-webview-container')" = "1" ] \
      && ok "comfy-container-intact-$f" || bad "comfy-container-intact-$f"
    [ "$(sel "$RUN/$f.json" '.project-list')" = "1" ] \
      && ok "sidebar-intact-$f" || bad "sidebar-intact-$f"
    [ "$(sel "$RUN/$f.json" '[data-region]')" = "0" ] \
      && ok "no-d5-regions-$f" || bad "no-d5-regions-$f"
  done
else
  bad "both-runs-wrote-results" "present=$([ -f "$RUN/present.json" ] && echo yes || echo no) absent=$([ -f "$RUN/absent.json" ] && echo yes || echo no)"
fi

echo
echo "  g4 gate: $pass pass, $fail fail"
[ $fail -eq 0 ] || exit 1
