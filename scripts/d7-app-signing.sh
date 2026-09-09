#!/usr/bin/env bash
# Make the SERVER sign C2PA credentials through the CVM surrogate — and prove
# it did, by signing.
#
# docs/DESIGN.md: "Everything requiring a signature happens on the server. The
# key is deliberately somewhere the desktop cannot reach." Which key that is,
# is the server's configuration, not the desktop's: `signAsset()` dispatches on
# SCRUPLE_C2PA_VAULT_KEY_OCID + SCRUPLE_C2PA_KMS_ENDPOINT, read in the Next
# process. A dev server holds its environment from the moment it booted, so
# this restarts it — with the environment it already had, plus three variables:
#
#   SCRUPLE_C2PA_VAULT_KEY_OCID   the surrogate's key. 🔴 SOFTWARE-backed.
#   SCRUPLE_C2PA_KMS_ENDPOINT     where that key answers.
#   SCRUPLE_C2PA_CERT             a certificate for THAT key — see
#                                 scripts/d7-surrogate-cert.sh for why the
#                                 default one is the wrong one.
#
# ⚑ THE PROBE IS A SIGNATURE, NOT A VARIABLE. Nothing here reads the app's
# environment to decide whether it is configured: it POSTs a real asset to
# /api/scruple/c2pa/sign and reads `signing_mode` off the answer. An app that
# reported kms-http and signed locally would pass an env check and fail this.
set -uo pipefail
cd "$(dirname "$0")/.."
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
SURROGATE="${SCRUPLE_CVM_SURROGATE:-http://127.0.0.1:8799}"
PORT="${APP_URL##*:}"; PORT="${PORT%%/*}"
CERT="${D7_CERT_DIR:-$PWD/.run/d7/c2pa-surrogate}/surrogate-chain.pem"
OCID="${SCRUPLE_C2PA_SURROGATE_OCID:-ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey}"

case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$PORT" in 3902) ;; *) echo "!! this restarts the app on :3902 only; $APP_URL is not it"; exit 2;; esac

KEY="$(python3 -c "import json;print(json.load(open('.run/sandbox/app-comfy.json'))['apiKey'])" 2>/dev/null)"
[ -n "$KEY" ] || { echo "!! no sandbox key; run scripts/tsx.sh scripts/d3-sandbox.ts --surface app/comfy"; exit 2; }
PROJECT="$(curl -s -m 20 "$APP_URL/api/projects?limit=5" -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get('projects',[])
print(d[0]['id'] if len(d)==1 else '')" 2>/dev/null)"

# The probe: sign a real file and read back which key did it.
probe() {
  [ -n "$PROJECT" ] || { echo "no-project"; return; }
  mkdir -p .run/d7
  python3 - <<'PY'
import struct, zlib, pathlib
raw=b''.join(b'\x00'+bytes((7,7,7))*8 for _ in range(8))
def c(t,d):
    b=t+d; return struct.pack('>I',len(d))+b+struct.pack('>I',zlib.crc32(b)&0xffffffff)
pathlib.Path('.run/d7/signing-probe.png').write_bytes(
  b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))
PY
  curl -s -m 180 -X POST "$APP_URL/api/scruple/c2pa/sign" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"project_id\":$PROJECT,\"asset_path\":\"$PWD/.run/d7/signing-probe.png\",\"product\":\"studio\",\"tier\":\"bare\",\"digital_source_type\":\"TRAINED_ALGORITHMIC_MEDIA\",\"title\":\"signing probe\"}" \
    | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print('no-json'); raise SystemExit
print(d.get('signing_mode') or ('refused:'+str(d.get('code') or d.get('error'))[:60]))"
}

MODE="$(probe)"
echo "[d7-app-signing] the app signs in mode: $MODE"
if [ "$MODE" = "kms-http" ]; then echo "[d7-app-signing] already configured; nothing to restart"; exit 0; fi
if [ "${D7_NO_RESTART:-0}" = "1" ]; then echo "[d7-app-signing] D7_NO_RESTART=1; leaving it as it is"; exit 1; fi

[ -f "$CERT" ] || bash scripts/d7-surrogate-cert.sh >/dev/null || { echo "!! could not issue the surrogate cert"; exit 2; }

# Restart with the environment it already had. Read from /proc rather than
# reconstructed from memory: a variable this script forgot would come back as a
# differently-configured app, and the gates that share :3902 would pay for it.
PID="$(ss -ltnp 2>/dev/null | awk '/:3902 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)"
[ -n "$PID" ] || { echo "!! nothing is listening on :3902"; exit 2; }
ENVFILE="$PWD/.run/d7/app-env.sh"; mkdir -p .run/d7
python3 - "$PID" "$ENVFILE" <<'PY'
import sys, shlex
keep_prefix = ('SCRUPLE_', 'TMPDIR', 'NODE_', 'PATH', 'HOME', 'USER', 'LANG', 'DBUS_')
env = dict(
    kv.split('=', 1)
    for kv in open(f'/proc/{sys.argv[1]}/environ').read().split('\0')
    if '=' in kv
)
with open(sys.argv[2], 'w') as f:
    for k, v in sorted(env.items()):
        if k.startswith(keep_prefix):
            f.write(f'export {k}={shlex.quote(v)}\n')
print(f'[d7-app-signing] captured {len([k for k in env if k.startswith(keep_prefix)])} vars from pid {sys.argv[1]}')
PY

echo "[d7-app-signing] stopping the app on :3902 (pid $PID and its parents)"
pkill -f "next dev -p 3902" >/dev/null 2>&1
kill "$PID" >/dev/null 2>&1
for _ in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":3902 " || break; sleep 1; done

cd "$WEB"
set -a; . "$ENVFILE"; set +a
export SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID"
export SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE"
export SCRUPLE_C2PA_CERT="$CERT"
nohup npx next dev -p 3902 >> "$OLDPWD/.run/d7/app-3902.log" 2>&1 &
cd "$OLDPWD"
echo "[d7-app-signing] restarted; waiting for it to answer"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$APP_URL/api/v2/capabilities?profile=desktop")
  [ "$code" = "200" ] && break
  sleep 2
done
echo "[d7-app-signing] capabilities: $(curl -s -o /dev/null -m 10 -w '%{http_code}' "$APP_URL/api/v2/capabilities?profile=desktop")"
MODE="$(probe)"
echo "[d7-app-signing] the app now signs in mode: $MODE"
[ "$MODE" = "kms-http" ] || exit 1
