#!/usr/bin/env bash
# WO-E1 — the C2PA signer must refuse a certificate it did not sign with.
#
# docs/STATE.md §4.3 (desktop repo): with SCRUPLE_C2PA_VAULT_KEY_OCID +
# SCRUPLE_C2PA_KMS_ENDPOINT set the signer signs through the surrogate and
# still embeds services/c2pa-signer/keys/signer.pem, the certificate issued
# for the LOCAL key, because cert_path is chosen (`?? DEV_CERT`) independently
# of which key signs. The route answers ok:true and c2pa.Reader answers
# claimSignature.mismatch.
#
# THE PROBE IS ALWAYS A SIGNATURE READ BACK, NEVER AN ENVIRONMENT VARIABLE.
# Every stage POSTs a real PNG to /api/scruple/c2pa/sign and then reads the
# answer -- and, when there is an output asset, reads that asset back through
# c2pa.Reader.get_validation_state(). An app that reported the right mode and
# embedded the wrong certificate passes an env check and fails this.
#
# Stages:
#   1  RED, at the parent commit, in a worktree: mismatched pair -> ok:true
#      and claimSignature.mismatch in the manifest.       MUST fire.
#   2  GREEN, at HEAD: the same mismatched pair -> refusal with
#      code=certificate_key_mismatch and NO output asset. MUST fire.
#   3  CONTROL (a): the correctly-paired surrogate certificate from
#      scripts/d7-surrogate-cert.sh still signs, and the result reads
#      validation_state=Valid.                            MUST NOT fire.
#   4  CONTROL (b): local-key signing with the local certificate (no KMS env
#      at all) is unaffected and reads Valid.             MUST NOT fire.
#
# 🔴 Restarts the sandbox app on :3902 only, and restores the environment it
# was started with. Never touches :3001 or :5799.
set -uo pipefail
cd "$(dirname "$0")/.."
WEB="$PWD"
PARENT_TREE="${E1_PARENT_TREE:-/data/scruple-web-e1-parent}"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
SURROGATE="${SCRUPLE_CVM_SURROGATE:-http://127.0.0.1:8799}"
DESKTOP="${SCRUPLE_DESKTOP_ROOT:-/mnt/corpus/scruple-desktop}"
SURR_CERT="${D7_CERT_DIR:-$DESKTOP/.run/d7/c2pa-surrogate}/surrogate-chain.pem"
OCID="${SCRUPLE_C2PA_SURROGATE_OCID:-ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey}"
RUN="$WEB/.run/e1"
ENVFILE="$RUN/app-env.sh"
PORT="${APP_URL##*:}"; PORT="${PORT%%/*}"
mkdir -p "$RUN"

case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$PORT" in 3902) ;; *) echo "!! this restarts the app on :3902 only; $APP_URL is not it"; exit 2;; esac
case "$SURROGATE" in *:5799*|*:3001*) echo "!! $SURROGATE is production; refusing"; exit 2;; esac

KEY="$(python3 -c "import json;print(json.load(open('$DESKTOP/.run/sandbox/app-comfy.json'))['apiKey'])" 2>/dev/null)"
[ -n "$KEY" ] || { echo "!! no sandbox key at $DESKTOP/.run/sandbox/app-comfy.json"; exit 2; }
PROJECT="${E1_PROJECT:-$(curl -s -m 20 "$APP_URL/api/projects?limit=5" -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get('projects',[])
print(d[0]['id'] if d else '')" 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "!! no sandbox project on $APP_URL"; exit 2; }

# The env the app was started with, captured from /proc rather than
# reconstructed from memory -- a variable this script forgot would come back
# as a differently-configured app, and every gate that shares :3902 would pay.
capture_env() {
  local pid; pid="$(ss -ltnp 2>/dev/null | awk '/:3902 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)"
  [ -n "$pid" ] || { echo "!! nothing is listening on :3902"; return 1; }
  python3 - "$pid" "$ENVFILE" <<'PY'
import sys, shlex
keep = ('SCRUPLE_', 'TMPDIR', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'HOME', 'USER', 'LANG', 'DBUS_')
env = dict(kv.split('=',1) for kv in open(f'/proc/{sys.argv[1]}/environ').read().split('\0') if '=' in kv)
with open(sys.argv[2],'w') as f:
    for k,v in sorted(env.items()):
        if k.startswith(keep): f.write(f'export {k}={shlex.quote(v)}\n')
PY
}

# 🔴 PORT-SPECIFIC, ALWAYS. This box runs ~30 other `next dev` servers,
# :3001 among them, and the rails forbid touching that one. Every pattern
# here names the port; nothing matches a bare `next dev`.
stop_app() {
  local pid
  pid="$(ss -ltnp 2>/dev/null | awk '/:3902 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)"
  pkill -f "next dev -p 3902" >/dev/null 2>&1
  [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1
  for _ in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":3902 " || return 0; sleep 1; done
  pid="$(ss -ltnp 2>/dev/null | awk '/:3902 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)"
  [ -n "$pid" ] && kill -9 "$pid" >/dev/null 2>&1
  for _ in $(seq 1 10); do ss -ltn 2>/dev/null | grep -q ":3902 " || return 0; sleep 1; done
  echo "!! :3902 would not stop"; return 1
}

# start_app <tree> <cert-mode>
#   cert-mode default   kms-http + NO SCRUPLE_C2PA_CERT -> signAsset's `?? DEV_CERT`
#                       picks the LOCAL certificate. This IS the §4.3 defect.
#   cert-mode surrogate kms-http + the correctly-paired certificate.
#   cert-mode local     no KMS env at all: local key, local certificate.
start_app() {
  local tree="$1"
  local mode="$2"
  local log="$RUN/app-$mode.log"
  ( set -a; . "$ENVFILE"; set +a
    unset SCRUPLE_C2PA_CERT SCRUPLE_C2PA_KEY
    case "$mode" in
      default)   export SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE" ;;
      surrogate) export SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE" SCRUPLE_C2PA_CERT="$SURR_CERT" ;;
      local)     unset SCRUPLE_C2PA_VAULT_KEY_OCID SCRUPLE_C2PA_KMS_ENDPOINT ;;
      *) echo "!! unknown cert-mode $mode"; exit 2 ;;
    esac
    # setsid + all three fds redirected: the app must not stay a child of
    # this script, and must not hold its stdout open -- a backgrounded server
    # writing down the script's own pipe is a gate that never returns.
    cd "$tree" && setsid npx next dev -p 3902 </dev/null >> "$log" 2>&1 & )
  for _ in $(seq 1 150); do
    [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$APP_URL/api/v2/capabilities?profile=desktop")" = "200" ] && return 0
    sleep 2
  done
  echo "!! app from $tree never answered on :3902 (see $log)"; return 1
}

make_png() {
  python3 - "$1" <<'PY'
import struct, zlib, pathlib, sys
raw=b''.join(b'\x00'+bytes((11,22,33))*8 for _ in range(8))
def c(t,d):
    b=t+d; return struct.pack('>I',len(d))+b+struct.pack('>I',zlib.crc32(b)&0xffffffff)
pathlib.Path(sys.argv[1]).write_bytes(
  b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))
PY
}

# sign <tag> -> writes $RUN/<tag>.route.json, echoes the output_path or ''
sign() {
  local tag="$1"
  local src="$RUN/$tag.png"
  make_png "$src"
  curl -s -m 300 -X POST "$APP_URL/api/scruple/c2pa/sign" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -w '\n{"__http":%{http_code}}\n' \
    -d "{\"project_id\":$PROJECT,\"asset_path\":\"$src\",\"product\":\"studio\",\"tier\":\"bare\",\"digital_source_type\":\"TRAINED_ALGORITHMIC_MEDIA\",\"title\":\"e1 $tag\"}" \
    > "$RUN/$tag.route.raw"
  python3 - "$RUN/$tag.route.raw" "$RUN/$tag.route.json" <<'PY'
import json, sys
lines = [l for l in open(sys.argv[1]).read().splitlines() if l.strip()]
http = json.loads(lines[-1]).get("__http")
try: body = json.loads("\n".join(lines[:-1]))
except Exception as e: body = {"__unparsed": "\n".join(lines[:-1])[:400], "__err": str(e)}
body["__http"] = http
json.dump(body, open(sys.argv[2], "w"), indent=2, sort_keys=True)
PY
  python3 -c "import json,sys;d=json.load(open('$RUN/$tag.route.json'));print(d.get('signed_path') or d.get('output_path') or d.get('signed_asset_path') or '')"
}

show() { python3 -c "
import json;d=json.load(open('$RUN/$1.route.json'))
print('   http', d.get('__http'), '| ok', d.get('ok'), '| mode', d.get('signing_mode'), '| code', d.get('code'))
print('   identity', str(d.get('signer_identity'))[:110])
print('   error', str(d.get('error'))[:200] if d.get('error') else '-')
"; }

PASS=0; FAIL=0
verdict() { if [ "$1" = "0" ]; then echo "   PASS  $2"; PASS=$((PASS+1)); else echo "   FAIL  $2"; FAIL=$((FAIL+1)); fi; }

capture_env || exit 2
echo "[e1] app env captured to $ENVFILE"

# WHERE THE ROUTE WRITES. `signed_path` comes from fs.mkdtemp(os.tmpdir()),
# so the directory to search for a stray output asset is the APP's TMPDIR,
# not this shell's -- they differ here, and searching the wrong one returned
# a confident, meaningless zero the first time stage 2 ran. Stage 1
# calibrates it: if the probe cannot see an asset where one certainly was
# written, stage 2's zero proves nothing and the gate says so.
APP_TMPDIR="$(sed -n "s/^export TMPDIR=//p" "$ENVFILE" | tr -d \"\' | head -1)"
APP_TMPDIR="${APP_TMPDIR:-${TMPDIR:-/tmp}}"
echo "[e1] the app writes signed assets under $APP_TMPDIR"
echo "[e1] project $PROJECT on $APP_URL, surrogate $SURROGATE"
[ -f "$SURR_CERT" ] || { echo "[e1] issuing the paired surrogate cert"; bash "$DESKTOP/scripts/d7-surrogate-cert.sh" >/dev/null || exit 2; }

STAGES="${1:-1234}"
trap 'echo "[e1] restoring the app on :3902 from '"$WEB"'"; stop_app; start_app "$WEB" surrogate >/dev/null 2>&1' EXIT

# ---------------------------------------------------------------- stage 1 RED
if [[ "$STAGES" == *1* ]]; then
  echo
  echo "== stage 1  RED at the parent commit ($PARENT_TREE) =========================="
  [ -d "$PARENT_TREE" ] || { echo "!! no worktree at $PARENT_TREE"; exit 2; }
  echo "   HEAD $(git -C "$PARENT_TREE" log --oneline -1)"
  stop_app && start_app "$PARENT_TREE" default || exit 2
  OUT="$(sign red)"
  show red
  echo "   output_path $OUT"
  if [ -n "$OUT" ] && [ -f "$OUT" ]; then
    python3 "$WEB/scripts/e1-read-manifest.py" "$OUT" | tee "$RUN/red.manifest.json"
  else
    echo '{"error":"no output asset"}' | tee "$RUN/red.manifest.json"
  fi
  python3 - "$RUN/red.route.json" "$RUN/red.manifest.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
ok = r.get("ok") is True and r.get("signing_mode") == "kms-http"
mismatch = "claimSignature.mismatch" in (m.get("failure_codes") or [])
print(f"   route ok={r.get('ok')} mode={r.get('signing_mode')} | failure_codes={m.get('failure_codes')} state={m.get('validation_state')}")
sys.exit(0 if (ok and mismatch) else 1)
PY
  R=$?
  # Calibrate the filesystem probe stage 2 uses. `no signed asset was
  # written` only means something if the same find WOULD have found one, so
  # run it here where an asset certainly was written.
  WROTE=$(find "$APP_TMPDIR" -maxdepth 2 -name '*.c2pa.png' -newer "$RUN/red.png" 2>/dev/null | wc -l)
  echo "   calibration: signed assets the stage-2 probe would have seen here: $WROTE"
  [ "$WROTE" -ge 1 ] || { echo "   !! the stage-2 filesystem probe is blind; its 0 would prove nothing"; R=1; }
  verdict $R "RED: the route called it ok and the manifest reads claimSignature.mismatch"
fi

# -------------------------------------------------------------- stage 2 GREEN
if [[ "$STAGES" == *2* ]]; then
  echo
  echo "== stage 2  GREEN at HEAD ($WEB), same mismatched pair ======================"
  echo "   HEAD $(git -C "$WEB" log --oneline -1)"
  stop_app && start_app "$WEB" default || exit 2
  OUT="$(sign green)"
  show green
  python3 - "$RUN/green.route.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
bad = []
if r.get("ok") is True: bad.append("route reported ok")
if r.get("code") != "certificate_key_mismatch": bad.append(f"code={r.get('code')!r}")
if r.get("__http") == 200: bad.append("http 200")
for k in ("signed_path", "output_path", "signed_asset_path"):
    if r.get(k): bad.append(f"{k} present")
print("   " + ("refused with a distinct code and no output path" if not bad else "; ".join(bad)))
sys.exit(1 if bad else 0)
PY
  R=$?
  # And no asset anywhere under the route's mkdtemp prefix from this run.
  STRAY=$(find "$APP_TMPDIR" -maxdepth 2 -name '*.c2pa.png' -newer "$RUN/green.png" 2>/dev/null | wc -l)
  echo "   signed assets written since the request: $STRAY"
  [ "$STRAY" = "0" ] || R=1
  verdict $R "GREEN: refusal with code=certificate_key_mismatch and no output asset"
fi

# ---------------------------------------------------------- stage 3 CONTROL a
if [[ "$STAGES" == *3* ]]; then
  echo
  echo "== stage 3  CONTROL (a) the correctly-paired surrogate certificate =========="
  echo "   cert $SURR_CERT"
  stop_app && start_app "$WEB" surrogate || exit 2
  OUT="$(sign ctl-surrogate)"
  show ctl-surrogate
  echo "   output_path $OUT"
  if [ -n "$OUT" ] && [ -f "$OUT" ]; then
    python3 "$WEB/scripts/e1-read-manifest.py" "$OUT" | tee "$RUN/ctl-surrogate.manifest.json"
  else
    echo '{"error":"no output asset"}' | tee "$RUN/ctl-surrogate.manifest.json"
  fi
  python3 - "$RUN/ctl-surrogate.route.json" "$RUN/ctl-surrogate.manifest.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
bad = []
if r.get("ok") is not True: bad.append(f"route refused: {r.get('code')} {str(r.get('error'))[:120]}")
if r.get("signing_mode") != "kms-http": bad.append(f"mode={r.get('signing_mode')!r}")
if m.get("validation_state") not in ("Valid", "Trusted"): bad.append(f"state={m.get('validation_state')!r}")
codes = m.get("failure_codes") or []
if "claimSignature.mismatch" in codes: bad.append("claimSignature.mismatch")
if codes and codes != ["signingCredential.untrusted"]: bad.append(f"unexpected codes {codes}")
print(f"   state={m.get('validation_state')} failure_codes={codes}")
sys.exit(1 if bad else 0)
PY
  verdict $? "CONTROL (a) MUST NOT FIRE: the paired surrogate cert still signs and reads Valid"
fi

# ---------------------------------------------------------- stage 4 CONTROL b
if [[ "$STAGES" == *4* ]]; then
  echo
  echo "== stage 4  CONTROL (b) local key + local certificate ======================="
  stop_app && start_app "$WEB" local || exit 2
  OUT="$(sign ctl-local)"
  show ctl-local
  echo "   output_path $OUT"
  if [ -n "$OUT" ] && [ -f "$OUT" ]; then
    python3 "$WEB/scripts/e1-read-manifest.py" "$OUT" | tee "$RUN/ctl-local.manifest.json"
  else
    echo '{"error":"no output asset"}' | tee "$RUN/ctl-local.manifest.json"
  fi
  python3 - "$RUN/ctl-local.route.json" "$RUN/ctl-local.manifest.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
bad = []
if r.get("ok") is not True: bad.append(f"route refused: {r.get('code')} {str(r.get('error'))[:120]}")
if r.get("signing_mode") != "local": bad.append(f"mode={r.get('signing_mode')!r}")
if m.get("validation_state") not in ("Valid", "Trusted"): bad.append(f"state={m.get('validation_state')!r}")
codes = m.get("failure_codes") or []
if "claimSignature.mismatch" in codes: bad.append("claimSignature.mismatch")
print(f"   state={m.get('validation_state')} failure_codes={codes}")
sys.exit(1 if bad else 0)
PY
  verdict $? "CONTROL (b) MUST NOT FIRE: local-key signing is unaffected"
fi

echo
echo "== e1-gate: $PASS pass, $FAIL fail =========================================="
[ "$FAIL" = "0" ]
