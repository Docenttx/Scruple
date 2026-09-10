#!/usr/bin/env bash
# WO-G2 — §9.1 C2PA and §9.2 watermarking, both live, on one artifact, through
# an isolated signer. One command, non-zero if anything misbehaves.
#
# What each stage proves, and the control that must fire beside it:
#
#   1  §9.2.4  the payload is what the Standard says       · a broken gate REFUSES
#   2  §9.2.5  the detector reads the PIXELS               · a CLEAN file -> null
#   3  §9.1    the credential validates                    · get_validation_state()
#   4          both modalities survive on one artifact     · decode the SIGNED file
#   5  §5.1    the certificate belongs to the signing key  · a mismatch REFUSES
#   6          no fall back to a local key                 · a dead CVM REFUSES
#   7  §5.3    the signer answers on a Unix socket         · 0660, and it signs
#   8  §5.2    no private key can be committed under keys/ · and innocents pass
#   9  §5.2    SCRUPLE_C2PA_CERT_CHAIN is read             · and it wins
#
# 🔴 NOTHING HERE CONTACTS PRODUCTION. Signing goes to the CVM surrogate on 8799,
# which is SOFTWARE-backed: every credential it makes is a dev credential and no
# leaf it touches can be `verified`. The unreachable-CVM control uses a DEAD PORT
# rather than stopping :8799, so a shared service stays up for other gates.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
SURROGATE="${SCRUPLE_CVM_SURROGATE:-http://127.0.0.1:8799}"
OCID="${SCRUPLE_C2PA_SURROGATE_OCID:-ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey}"
RUN="$REPO/.run/g2"
CERT="$REPO/.run/d7/c2pa-surrogate/surrogate-chain.pem"
# AF_UNIX caps the path at ~107 bytes, which .run/ under this repo already
# exceeds. The socket lives in the runtime dir; nothing else does.
SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/scruple-signer-g2.sock"

case "$SURROGATE" in *:5799*|*:3001*) echo "!! $SURROGATE is production; refusing"; exit 2;; esac

rm -rf "$RUN"; mkdir -p "$RUN"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m  %-46s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m  %-46s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
stage(){ printf '\n════ %s ════\n' "$1"; }

# ── 1 · 2 · 4 ─ the watermark, and the detector's control ─────────────────────
stage "§9.2 the mark, the payload, and the detector"
PY_WM=$(RUN="$RUN" WEB="$WEB" python3 - <<'PY'
import json, os, subprocess, sys
RUN, WEB = os.environ["RUN"], os.environ["WEB"]
sys.path.insert(0, f"{WEB}/services")
from watermark.payload import build_payload_tier_1_3, Tier, payload_hex, decode_payload, MAGIC, PAYLOAD_BYTES
import numpy as np
from PIL import Image

out = {}
p = build_payload_tier_1_3(Tier.LOCAL_LOCK, signed_at_unix_seconds=1789000000)
out["structure"] = (len(p) == PAYLOAD_BYTES == 16 and p[0] == MAGIC
                    and (p[1] >> 4) & 0xF == 1 and p[1] & 0xF == 3
                    and int.from_bytes(p[2:10], "big") == 1789000000)
refused = 0
for m in (lambda b: b.__setitem__(0, 0x00),
          lambda b: b.__setitem__(1, (0xF << 4) | (b[1] & 0xF))):
    b = bytearray(p); m(b)
    try: decode_payload(bytes(b))
    except Exception: refused += 1
try: decode_payload(bytes(p)[:12])
except Exception: refused += 1
out["gate_refuses"] = refused == 3
out["no_confidence_score"] = not any("conf" in k for k in decode_payload(p))

rng = np.random.default_rng(12345)
x = np.linspace(0, 1, 512); X, Y = np.meshgrid(x, x)
base = 0.45 + 0.35 * np.sin(6 * X) * np.cos(4 * Y)
img = np.clip(np.stack([base, base * .9 + .05, base * .8 + .1], -1) + rng.normal(0, .02, (512, 512, 3)), 0, 1)
Image.fromarray((img * 255).astype("uint8")).save(f"{RUN}/clean.png")

def wm(job):
    r = subprocess.run([sys.executable, f"{WEB}/services/watermark/cli.py"],
                       input=json.dumps(job).encode(), capture_output=True)
    return json.loads(r.stdout.decode().strip().splitlines()[-1])

hexp = payload_hex(p)
out["embedded"] = wm({"action": "embed", "input_path": f"{RUN}/clean.png",
                      "output_path": f"{RUN}/marked.png", "output_format": "PNG",
                      "payload_hex": hexp}).get("ok") is True
d = wm({"action": "decode", "input_path": f"{RUN}/marked.png"}).get("decoded")
out["decoded_from_pixels"] = bool(d) and d.get("signed_at_unix_seconds") == 1789000000
out["clean_file_is_null"] = wm({"action": "decode", "input_path": f"{RUN}/clean.png"}).get("decoded") is None
raw = open(f"{RUN}/marked.png", "rb").read()
out["not_in_metadata"] = (bytes.fromhex(hexp) not in raw and hexp.encode() not in raw
                          and not any(c in raw for c in (b"tEXt", b"iTXt", b"zTXt")))
print(json.dumps(out))
PY
)
for k in structure gate_refuses no_confidence_score embedded decoded_from_pixels clean_file_is_null not_in_metadata; do
  v=$(printf '%s' "$PY_WM" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$k'))" 2>/dev/null)
  [ "$v" = "True" ] && ok "wm-$k" || bad "wm-$k" "$v"
done

# ── 3 · 4 · 5 · 6 · 7 · 9 ─ signing ───────────────────────────────────────────
stage "§9.1 + §5.1 + §5.3 signing"
[ -f "$CERT" ] || bash scripts/d7-surrogate-cert.sh >/dev/null 2>&1
[ -f "$CERT" ] || { bad "surrogate-cert-issued"; echo; echo "  g2 gate: $pass pass, $((fail+1)) fail"; exit 1; }
ok "surrogate-cert-issued"

job(){ cat <<JSON
{"asset_path":"$RUN/marked.png","output_path":"$1","cert_path":"$2",
 "manifest":{"claim_generator":"Scruple-Desktop/3.1","format":"image/png","title":"g2","assertions":[]},
 "intent":"CREATE","digital_source_type":"TRAINED_ALGORITHMIC_MEDIA","actions":[]}
JSON
}
sign(){ ( cd "$WEB/services/c2pa-signer" && env "$@" python3 sign.py ) 2>/dev/null \
        | grep '^{' | tail -1; }

R=$(job "$RUN/signed.png" "$CERT" | sign SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE")
M=$(printf '%s' "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('signing_mode'))" 2>/dev/null)
[ "$M" = "kms-http" ] && ok "signs-through-the-cvm-surrogate" "$M" || bad "signs-through-the-cvm-surrogate" "$M"
KB=$(printf '%s' "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);k=d.get('key_binding') or {};print(k.get('method'),k.get('matches'))" 2>/dev/null)
[ "$KB" = "es256-challenge True" ] && ok "cert-key-binding-verified" "$KB" || bad "cert-key-binding-verified" "$KB"

V=$(python3 -c "
import c2pa,sys
with open('$RUN/signed.png','rb') as f: print(c2pa.Reader('image/png',f).get_validation_state())
" 2>/dev/null)
[ "$V" = "Valid" ] && ok "credential-validates" "get_validation_state()=$V" || bad "credential-validates" "$V"

D=$(echo "{\"action\":\"decode\",\"input_path\":\"$RUN/signed.png\"}" | python3 "$WEB/services/watermark/cli.py" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin).get('decoded');print((d or {}).get('signed_at_unix_seconds'))")
[ "$D" = "1789000000" ] && ok "watermark-survives-c2pa-signing" "both modalities, one artifact" || bad "watermark-survives-c2pa-signing" "$D"

# CONTROL: the certificate does not belong to the signing key.
openssl ecparam -name prime256v1 -genkey -noout -out "$RUN/other.key" 2>/dev/null
openssl req -new -x509 -key "$RUN/other.key" -out "$RUN/other.pem" -days 30 -subj "/CN=Not The Signing Key" 2>/dev/null
rm -f "$RUN/mismatch.png"
C=$(job "$RUN/mismatch.png" "$RUN/other.pem" | sign SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE" \
     | python3 -c "import sys,json;print(json.load(sys.stdin).get('code'))" 2>/dev/null)
[ "$C" = "certificate_key_mismatch" ] && [ ! -f "$RUN/mismatch.png" ] \
  && ok "CONTROL-cert-key-mismatch-refuses" "no output asset written" \
  || bad "CONTROL-cert-key-mismatch-refuses" "code=$C output_exists=$([ -f "$RUN/mismatch.png" ] && echo yes || echo no)"

# CONTROL: the CVM is unreachable. No local-key fallback, no asset.
rm -f "$RUN/deadcvm.png"
DEAD=39799
if ss -ltn 2>/dev/null | grep -q ":$DEAD "; then bad "CONTROL-dead-cvm-refuses" "port $DEAD is in use — inconclusive, not a pass"
else
  job "$RUN/deadcvm.png" "$CERT" | sign SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="http://127.0.0.1:$DEAD" >/dev/null
  [ ! -f "$RUN/deadcvm.png" ] && ok "CONTROL-dead-cvm-refuses" "no asset, no local-key fallback" \
                             || bad "CONTROL-dead-cvm-refuses" "an asset was written"
fi

# §5.3 — the daemon, on its socket.
stage "§5.3 the signer behind a Unix socket"
rm -f "$SOCK"
( cd "$WEB/services/c2pa-signer" && SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE" \
  nohup python3 sign_daemon.py --socket "$SOCK" > "$RUN/daemon.log" 2>&1 & )
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.3; done
if [ ! -S "$SOCK" ]; then bad "daemon-listens" "$(tail -2 "$RUN/daemon.log" 2>/dev/null)"; else
  ok "daemon-listens" "$SOCK"
  MODE=$(stat -c '%a' "$SOCK"); [ "$MODE" = "660" ] && ok "socket-mode-0660" || bad "socket-mode-0660" "$MODE"
  SOCK="$SOCK" RUN="$RUN" CERT="$CERT" python3 - <<'PY' > "$RUN/sock.json"
import socket, json, os
S=os.environ["SOCK"]; RUN=os.environ["RUN"]; CERT=os.environ["CERT"]
def call(j):
    s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(300); s.connect(S)
    s.sendall((json.dumps(j)+"\n").encode()); buf=b""
    while not buf.endswith(b"\n"):
        c=s.recv(65536)
        if not c: break
        buf+=c
    s.close(); return json.loads(buf.decode())
out={"ping": call({"action":"ping"}).get("pong") is True,
     "whoami": "uid" in call({"action":"whoami"})}
r=call({"asset_path":f"{RUN}/marked.png","output_path":f"{RUN}/sock-signed.png","cert_path":CERT,
        "manifest":{"claim_generator":"Scruple-Desktop/3.1","format":"image/png","title":"g2-sock","assertions":[]},
        "intent":"CREATE","digital_source_type":"TRAINED_ALGORITHMIC_MEDIA","actions":[]})
out["signed"]=r.get("ok") is True and r.get("signing_mode")=="kms-http"
out["bad_job_refused"]= call({"asset_path":"/nope"}).get("ok") is False
print(json.dumps(out))
PY
  for k in ping whoami signed bad_job_refused; do
    v=$(python3 -c "import json;print(json.load(open('$RUN/sock.json')).get('$k'))" 2>/dev/null)
    [ "$v" = "True" ] && ok "socket-$k" || bad "socket-$k" "$v"
  done
  V2=$(python3 -c "
import c2pa
with open('$RUN/sock-signed.png','rb') as f: print(c2pa.Reader('image/png',f).get_validation_state())
" 2>/dev/null)
  [ "$V2" = "Valid" ] && ok "socket-signed-credential-validates" "$V2" || bad "socket-signed-credential-validates" "$V2"
  pkill -f "sign_daemon.py --socket $SOCK" >/dev/null 2>&1
fi

# §5.2 — the pre-commit hook.
stage "§5.2 no private key under services/c2pa-signer/keys/"
HOOK="$WEB/.githooks/pre-commit"
if [ ! -x "$HOOK" ]; then bad "hook-present"; else
  ok "hook-present"
  [ "$(cd "$WEB" && git config --get core.hooksPath)" = ".githooks" ] \
    && ok "hook-installed" "core.hooksPath=.githooks" \
    || bad "hook-installed" "core.hooksPath is not .githooks — the hook would never run"
  ( cd "$WEB" && openssl ecparam -name prime256v1 -genkey -noout -out services/c2pa-signer/keys/g2-probe.key 2>/dev/null \
    && git add -f services/c2pa-signer/keys/g2-probe.key >/dev/null 2>&1 )
  ( cd "$WEB" && "$HOOK" >/dev/null 2>&1 ); rc=$?
  [ $rc -ne 0 ] && ok "CONTROL-hook-refuses-a-private-key" "exit $rc" || bad "CONTROL-hook-refuses-a-private-key" "exit 0"
  ( cd "$WEB" && git reset -q services/c2pa-signer/keys/g2-probe.key >/dev/null 2>&1; rm -f services/c2pa-signer/keys/g2-probe.key )
  ( cd "$WEB" && "$HOOK" >/dev/null 2>&1 ); rc=$?
  [ $rc -eq 0 ] && ok "hook-allows-innocent-files" || bad "hook-allows-innocent-files" "exit $rc — the hook fires on everything"
fi

# §5.2 — the cert-chain variable the Standard names.
stage "§5.2 SCRUPLE_C2PA_CERT_CHAIN"
N=$(cd "$WEB" && grep -rn "SCRUPLE_C2PA_CERT_CHAIN" --include=*.ts --include=*.py --include=*.service . 2>/dev/null | grep -vc node_modules)
[ "${N:-0}" -gt 0 ] && ok "cert-chain-variable-is-read" "$N references" || bad "cert-chain-variable-is-read" "zero references — configuring from the Standard configures nothing"

# ── the desktop's own path: server mints, desktop embeds ──────────────────────
stage "the app's lock actions, tier by tier"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
KEY="$(python3 -c "import json;print(json.load(open('.run/sandbox/app-comfy.json'))['apiKey'])" 2>/dev/null)"
if [ "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$APP_URL/api/v2/capabilities?profile=desktop")" != "200" ] || [ -z "$KEY" ]; then
  # NOT counted as a pass. A stage that could not run is inconclusive, and an
  # inconclusive control is never a pass — say so and fail the gate.
  bad "app-reachable" "no app on $APP_URL or no sandbox key — this stage is INCONCLUSIVE, not green"
else
  ok "app-reachable" "$APP_URL"
  mint(){ curl -s -m 15 -X POST "$APP_URL/api/scruple/watermark/payload" \
            -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "$1"; }
  for spec in 'checkpoint|{"tier":"checkpoint"}|2' \
              'local-lock|{"tier":"local-lock"}|3' \
              'chain-lock-basic|{"tier":"chain-lock-basic","scr_id":"SCR_7BE97C81"}|4' \
              'chain-lock-pinned|{"tier":"chain-lock-pinned","scr_id":"SCR_7BE97C81","pinned_hint":43981}|5'; do
    IFS='|' read -r tname tbody tint <<< "$spec"
    got=$(mint "$tbody" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('tier_int'))" 2>/dev/null)
    [ "$got" = "$tint" ] && ok "payload-tier-$tname" "tier_int=$got" || bad "payload-tier-$tname" "$got"
  done
  # CONTROLS: the server refuses to mint a chain payload it cannot fill.
  e=$(mint '{"tier":"chain-lock-basic"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('error'))" 2>/dev/null)
  [ "$e" = "scr_id_required" ] && ok "CONTROL-chain-payload-needs-an-scr-id" || bad "CONTROL-chain-payload-needs-an-scr-id" "$e"
  e=$(mint '{"tier":"chain-lock-pinned","scr_id":"SCR_7BE97C81"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('error'))" 2>/dev/null)
  [ "$e" = "pinned_hint_required" ] && ok "CONTROL-pinned-payload-needs-a-hint" || bad "CONTROL-pinned-payload-needs-a-hint" "$e"
  c=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST "$APP_URL/api/scruple/watermark/payload" \
        -H 'content-type: application/json' -d '{"tier":"local-lock"}')
  [ "$c" = "401" ] && ok "CONTROL-payload-needs-auth" || bad "CONTROL-payload-needs-auth" "$c"

  # THE CHANNEL: the desktop asks, embeds, and reads the mark back OUT.
  cp "$RUN/clean.png" "$RUN/app-master.png"
  APPOUT=$(SCRUPLE_CREDENTIAL_API_KEY="$KEY" SCRUPLE_APP_URL="$APP_URL" node -e '
    const { applyModalities } = require("./app/ipc-modalities");
    (async () => {
      const out = [];
      for (const action of ["checkpoint", "local-lock"]) {
        const r = await applyModalities({
          action, assetPath: process.env.RUN + "/app-master.png",
          outputPath: process.env.RUN + "/app-" + action + ".wm.png",
          digitalSourceType: "TRAINED_ALGORITHMIC_MEDIA", projectId: Number(process.env.PID || 0) });
        out.push({ action, tier: r.tier, code: r.code || null,
                   payload_tier: r.watermark ? r.watermark.payload.tier
                               : (r.derivative ? r.derivative.payload.tier : null) });
      }
      console.log(JSON.stringify(out));
    })();
  ' 2>/dev/null | tail -1)
  for pair in 'checkpoint|2' 'local-lock|3'; do
    IFS='|' read -r a t <<< "$pair"
    got=$(printf '%s' "$APPOUT" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('none'); raise SystemExit
print(next((str(x['payload_tier']) for x in d if x['action']=='$a'), 'none'))" 2>/dev/null)
    [ "$got" = "$t" ] && ok "app-$a-embeds-tier-$t" "read back out of the derivative" \
                      || bad "app-$a-embeds-tier-$t" "$got"
  done
fi

echo
echo "  g2 gate: $pass pass, $fail fail"
[ $fail -eq 0 ] || exit 1
