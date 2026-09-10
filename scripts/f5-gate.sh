#!/usr/bin/env bash
# WO-F5 — THE APP REFUSES TO WRITE A LEAF ONTO A SCHEMA BEHIND ITS TREE.
#
#   npm run f5      (bash scripts/f5-gate.sh)
#
# Finding E4-0 had two halves. WO-E2 added `059_declared_uncaptured.sql` and
# nothing applied it to the sandbox database; `next dev` does not migrate on
# boot, so every leaf submission answered 500 and WO-D6's gate reported ELEVEN
# FAILED ASSERTIONS with `no iteration row` — the symptom, saying nothing about
# the cause. It stayed silently red for over an hour.
# `scripts/preflight-schema.mjs` closed the GATE half: seven gates now ask
# before they run. This closes the SOURCE half, in `lib/v2/auth.ts` — the one
# function all eleven /v2 routes already start with — so that nothing had to be
# added to a route for a route to refuse.
#
# THE GATE: the app refuses the leaf-writing routes on a stale schema, with a
# DISTINCT ERROR NAMING THE PENDING MIGRATIONS.
#
# THE CONTROLS:
#   (a) with the schema current it serves normally — the same submission, the
#       same server build, 201 and a row read back out of the database with
#       sqlite3 rather than believed from the response.
#   (b) a route that does not touch the database is unaffected — GET
#       /api/v2/capabilities answers byte-identically on the stale server and
#       the current one.
#   (c) the refusal does not shadow the older ones: unauthenticated is still
#       401 and wrong-scope is still 403, and neither leaks the schema state of
#       a deployment to a caller who has not authenticated.
#   (d) THE DELIBERATE BOUNDARY: `baseline:write` writes a registry row, not a
#       leaf, and is NOT refused. Shown, not asserted in prose.
#
# AND THE RED BEFORE, which is E4-0 reproduced rather than quoted: the SAME
# submission against a server built from the parent commit, on the same stale
# database, in a worktree this gate makes and removes. It answers 500, names no
# migration — and leaves a leaf in the witness with no row in the app, which is
# the mess the finding is actually about.
#
# 🔴 Rails. Every server this gate starts is bound to 127.0.0.1 and pointed at
# the scratch witness on :5899 by an explicit WITNESS_SERVER_URL — the default
# in lib/scruple/witness.ts is :5799, which is production, and a gate that
# forgot it would dial it. Nothing touches :3001. The shared scratch database
# is READ ONLY here: both fixtures are new files under .run/f5, seeded by
# copying rows OUT of it. The live witness database is never opened at all; the
# scratch witness's own sqlite is opened read-only to count rows.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
WEB="${SCRUPLE_WEB_REPO:-/data/scruple-web}"
RUN="$REPO/.run/f5"
SCRATCH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
WDB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
WITNESS="${WITNESS_SERVER_URL:-http://127.0.0.1:5899}"
APP="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
PRE="$REPO/vendor/scruple-web/scripts/preflight-schema.mjs"
P_BEFORE=3941; P_STALE=3942; P_CURRENT=3943

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-66s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-66s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
differs(){ if [ "$2" != "$3" ]; then printf '   ok    %-66s %s != %s\n' "$1" "${2:0:16}" "${3:0:16}"; ok=$((ok+1));
           else printf '   FAIL  %-66s both %s\n' "$1" "${2:0:16}"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-66s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }
J(){ python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print('-'); raise SystemExit
cur=d
for k in sys.argv[2].split('.'):
    if cur is None: break
    cur=cur[int(k)] if isinstance(cur,list) else cur.get(k)
print('-' if cur is None else (cur if isinstance(cur,str) else json.dumps(cur)))
" "$1" "$2" 2>/dev/null || echo '-'; }
wq(){ sqlite3 "file:$WDB?mode=ro" -batch "$1" 2>/dev/null; }
# ⚑ `grep -c` prints its count AND exits 1 when the count is zero, so the
# obvious `$(grep -c X f || echo 0)` prints TWO zeroes and fails a check that
# should pass. The first run of this gate scored six FAILs on exactly that.
hits(){ if [ -f "$1" ]; then { grep -c "$2" "$1" 2>/dev/null || true; }; else echo "no-file"; fi; }
ihits(){ if [ -f "$1" ]; then { grep -ci "$2" "$1" 2>/dev/null || true; }; else echo "no-file"; fi; }

case "$WITNESS$APP" in *5799*|*3001*) echo "!! refusing: production endpoint in the environment"; exit 2;; esac
[ -f "$SCRATCH" ] || { echo "!! no scratch database at $SCRATCH"; exit 2; }
[ -d "$WEB/.git" ] || { echo "!! no server repo at $WEB"; exit 2; }
command -v sqlite3 >/dev/null || { echo "!! sqlite3 not on PATH"; exit 2; }

rm -rf "$RUN"; mkdir -p "$RUN"
PIDS=()
# ⚑ `next dev` FORKS: the pid this script holds is the wrapper, and the process
# that actually holds the port is its child. Killing only the wrapper leaves the
# port bound, and the next run of this gate refuses to start on it — which is
# how the first run of this stage ended. The listener is looked up in `ss` and
# killed by port, the same way WO-F8 reads a bind rather than trusting a log.
port_pid(){ ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
stop_servers(){
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  for port in "$P_BEFORE" "$P_STALE" "$P_CURRENT"; do
    lp="$(port_pid "$port")"
    [ -n "$lp" ] && kill "$lp" 2>/dev/null
  done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
  for port in "$P_BEFORE" "$P_STALE" "$P_CURRENT"; do
    lp="$(port_pid "$port")"
    [ -n "$lp" ] && kill -9 "$lp" 2>/dev/null
  done
  PIDS=()
  rm -rf "$WEB/.next-f5-stale" "$WEB/.next-f5-current"
}
cleanup(){
  stop_servers
  # ⚑ `next dev` REWRITES tsconfig.json on startup — it reformats the file and
  # adds `<distDir>/types/**/*.ts` to `include`. Two of the three servers below
  # run out of $WEB, which is the tree a live `next dev` on :3001 and every
  # other rig on this box are also serving from, so a gate that did not put it
  # back would leave a modified shared file behind and the next person to run
  # `git status` there would find a change nobody made on purpose. Finding F5-3.
  if [ -f "$RUN/tsconfig.json.orig" ]; then
    cp "$RUN/tsconfig.json.orig" "$WEB/tsconfig.json"
  fi
  rm -rf "$WEB/.next-f5-stale" "$WEB/.next-f5-current"
  if [ -d "$RUN/before" ]; then
    rm -f "$RUN/before/node_modules"
    git -C "$WEB" worktree remove --force "$RUN/before" >/dev/null 2>&1
    git -C "$WEB" worktree prune >/dev/null 2>&1
  fi
}
trap cleanup EXIT

cp "$WEB/tsconfig.json" "$RUN/tsconfig.json.orig"
TSCONFIG_SHA="$(sha256sum "$WEB/tsconfig.json" | cut -d' ' -f1)"

note "STAGE 0 — what is under test, named rather than described"
echo "   server repo   $WEB @ $(git -C "$WEB" rev-parse --short HEAD)$( [ -n "$(git -C "$WEB" status --porcelain)" ] && echo ' +uncommitted')"
echo "   desktop repo  $REPO @ $(git -C "$REPO" rev-parse --short HEAD)"
echo "   witness       $WITNESS   (its sqlite $WDB, read-only)"
echo "   scratch db    $SCRATCH   (read-only: rows are copied OUT of it)"
echo "   run dir       $RUN"

AFTER_REF="$(git -C "$WEB" log --format=%H -1 --grep='^WO-F5:' 2>/dev/null)"
if [ -n "$AFTER_REF" ]; then BEFORE_REF="$(git -C "$WEB" rev-parse "$AFTER_REF^")"
else BEFORE_REF="$(git -C "$WEB" rev-parse HEAD)"; fi
echo "   before        $(git -C "$WEB" rev-parse --short "$BEFORE_REF")  $(git -C "$WEB" log --format=%s -1 "$BEFORE_REF")"

note "STAGE 1 — two databases, and proof that one is behind the tree and one is not"
# The CURRENT fixture: every migration in the tree.
node "$PRE" --db="$RUN/current.db" --apply >"$RUN/pre-current.log" 2>&1
check "the current fixture applied cleanly" "0" "$?"
# The STALE fixture: the same tree with its LAST migration withheld, so the
# database is genuinely missing the columns rather than merely missing a row in
# `_migrations`. That difference is the whole of stage 3.
mkdir -p "$RUN/tree-minus-one/lib/db/migrations"
ALL=( $(ls "$WEB/lib/db/migrations"/*.sql | sort) )
WITHHELD="$(basename "${ALL[${#ALL[@]}-1]}")"
for f in "${ALL[@]:0:${#ALL[@]}-1}"; do cp "$f" "$RUN/tree-minus-one/lib/db/migrations/"; done
SCRUPLE_REPO_ROOT="$RUN/tree-minus-one" node "$PRE" --db="$RUN/stale.db" --apply >"$RUN/pre-stale.log" 2>&1
check "the stale fixture applied every migration but one" "0" "$?"
echo "   withheld      $WITHHELD"
node "$PRE" --db="$RUN/current.db" >"$RUN/pre-check-current.log" 2>&1; CUR_RC=$?
node "$PRE" --db="$RUN/stale.db"   >"$RUN/pre-check-stale.log"   2>&1; STL_RC=$?
check "…the preflight calls the current fixture current" "0" "$CUR_RC"
check "…and the stale fixture PENDING, by its own exit code" "3" "$STL_RC"
check "…naming exactly the file that was withheld" "1" \
  "$(grep -c "PENDING $WITHHELD" "$RUN/pre-check-stale.log")"
check "…and nothing else" "1" "$(grep -c 'PENDING ' "$RUN/pre-check-stale.log")"
# Missing COLUMNS, not just a missing row: asked of sqlite3, outside everything.
COL="$(sqlite3 "$RUN/stale.db" "SELECT COUNT(*) FROM pragma_table_info('iterations') WHERE name='imported_datablocks_source';")"
COLC="$(sqlite3 "$RUN/current.db" "SELECT COUNT(*) FROM pragma_table_info('iterations') WHERE name='imported_datablocks_source';")"
check "⚑ the stale database really lacks the column the tree adds" "0" "$COL"
check "…and the current one really has it" "1" "$COLC"

# Seed both from the scratch database: a tenant, a key set, and the baselines
# every leaf must reference. Copied, not invented — a baseline this gate made up
# would prove the route accepts one this gate made up.
seed(){ sqlite3 "$1" "ATTACH 'file:$SCRATCH?mode=ro' AS src;
  INSERT OR IGNORE INTO users SELECT * FROM src.users;
  INSERT OR IGNORE INTO tenants SELECT * FROM src.tenants;
  INSERT OR IGNORE INTO api_keys SELECT * FROM src.api_keys;
  INSERT OR IGNORE INTO baselines SELECT * FROM src.baselines;
  INSERT OR IGNORE INTO projects SELECT * FROM src.projects;" 2>>"$RUN/seed.log"; }
seed "$RUN/current.db"; seed "$RUN/stale.db"
TENANT="$(sqlite3 "$RUN/current.db" "SELECT tenant_id FROM baselines WHERE retired_at IS NULL ORDER BY activated_at DESC LIMIT 1;")"
BREF="$(sqlite3 "$RUN/current.db" "SELECT baseline_hash FROM baselines WHERE tenant_id='$TENANT' AND retired_at IS NULL ORDER BY activated_at DESC LIMIT 1;")"
BREF_S="$(sqlite3 "$RUN/stale.db" "SELECT baseline_hash FROM baselines WHERE tenant_id='$TENANT' AND retired_at IS NULL ORDER BY activated_at DESC LIMIT 1;")"
check "both fixtures carry the same active baseline" "$BREF" "$BREF_S"
[ -n "$BREF" ] || { echo "!! no active baseline to reference"; exit 2; }
WKEY="sk_f5_w_$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
RKEY="sk_f5_r_$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
mint(){ python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys, hashlib, sqlite3, uuid
db, token, scopes, user = sys.argv[1:5]
c = sqlite3.connect(db)
# created_at is supplied rather than defaulted: the column's DEFAULT calls
# unixepoch(), which arrived in SQLite 3.38, and the module this python is
# linked against is older than the one better-sqlite3 created the table with.
c.execute("INSERT INTO api_keys (id,user_id,key_hash,key_prefix,scopes_json,label,created_at)"
          " VALUES (?,?,?,?,?,?,strftime('%s','now'))",
          (str(uuid.uuid4()), user, hashlib.sha256(token.encode()).hexdigest(), token[:12], scopes, 'wo-f5'))
c.commit()
PY
}
BKEY="sk_f5_b_$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
BTENANT="wo-f5-registry-tenant"
for db in "$RUN/current.db" "$RUN/stale.db"; do
  mint "$db" "$WKEY" '["witness:write","mark:write","baseline:write","read"]' "$TENANT"
  mint "$db" "$RKEY" '["read"]' "$TENANT"
  mint "$db" "$BKEY" '["baseline:write"]' "$BTENANT"
done
echo "   tenant        $TENANT"
echo "   baseline_ref  ${BREF:0:16}…"
echo "   write key     ${WKEY:0:12}…    read-only key ${RKEY:0:12}…"

note "STAGE 2 — three servers: the parent commit and this one, on the two fixtures"
git -C "$WEB" worktree add --detach "$RUN/before" "$BEFORE_REF" >"$RUN/worktree.log" 2>&1
if [ -d "$RUN/before/app" ]; then
  ln -sfn "$WEB/node_modules" "$RUN/before/node_modules"
  echo "   worktree      $RUN/before @ $(git -C "$RUN/before" rev-parse --short HEAD)"
  check "⚑ the parent-commit tree does NOT carry the guard" "0" \
    "$(hits "$RUN/before/lib/v2/auth.ts" 'schemaGuard')"
  check "…and this one does" "1" "$(grep -c 'schemaGuard' "$WEB/lib/v2/auth.ts")"
else
  incon "the parent-commit worktree was created" "$(tail -2 "$RUN/worktree.log" | tr '\n' ' ')"
fi

serve(){ # name cwd port db distdir [repo_root]
  local name="$1" dir="$2" port="$3" db="$4" dist="$5" root="${6:-}"
  ( cd "$dir" && env -u SCRUPLE_REPO_ROOT \
      WITNESS_SERVER_URL="$WITNESS" \
      SCRUPLE_DB_PATH="$db" \
      SCRUPLE_DIST_DIR="$dist" \
      SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 \
      SCRUPLE_BDK_ALLOW_DEV=1 \
      ${root:+SCRUPLE_REPO_ROOT="$root"} \
      node node_modules/.bin/next dev -H 127.0.0.1 -p "$port" >"$RUN/$name.log" 2>&1 ) &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$port/api/health" 2>/dev/null)" != "000" ] && return 0
    sleep 2
  done
  return 1
}
free_port(){ ! ss -lptn 2>/dev/null | grep -q ":$1 "; }
for p in $P_BEFORE $P_STALE $P_CURRENT; do free_port "$p" || { echo "!! port $p is already in use"; exit 2; }; done

# The current server reads its migrations from a COPY of the tree, so that
# stage 7 can drop a file into it while it is running without touching the tree
# every other rig on this box is serving from.
mkdir -p "$RUN/tree-live/lib/db/migrations"
cp "$WEB/lib/db/migrations"/*.sql "$RUN/tree-live/lib/db/migrations/"

B_UP=no; S_UP=no; C_UP=no
[ -d "$RUN/before/app" ] && { serve before "$RUN/before" "$P_BEFORE" "$RUN/stale.db" ".next-f5-before" && B_UP=yes; }
serve stale   "$WEB" "$P_STALE"   "$RUN/stale.db"   ".next-f5-stale" && S_UP=yes
serve current "$WEB" "$P_CURRENT" "$RUN/current.db" ".next-f5-current" "$RUN/tree-live" && C_UP=yes
BEFORE_URL="http://127.0.0.1:$P_BEFORE"; STALE_URL="http://127.0.0.1:$P_STALE"; CUR_URL="http://127.0.0.1:$P_CURRENT"
echo "   before  @ $BEFORE_URL  stale.db    up=$B_UP"
echo "   stale   @ $STALE_URL  stale.db    up=$S_UP"
echo "   current @ $CUR_URL  current.db  up=$C_UP"

body(){ python3 -c "
import json,hashlib,os
print(json.dumps({'baseline_ref':'$BREF','kind':'document_save','mime':'image/png',
                  'content_hash':hashlib.sha256(os.urandom(16)).hexdigest()}))"; }
post(){ # url key out [body]
  local b="${4:-$(body)}"
  curl -s -o "$3" -w '%{http_code}' -m 90 -X POST "$1/api/v2/witness" \
    -H "authorization: Bearer $2" -H 'content-type: application/json' --data "$b"; }

note "STAGE 3 — RED BEFORE: the parent commit, on the stale database"
if [ "$B_UP" != yes ]; then
  incon "the parent-commit server answered /api/health" "see $RUN/before.log"
else
  check "the parent-commit server is alive on a route with no database" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$BEFORE_URL/api/v2/capabilities?profile=desktop")"
  W0="$(wq 'SELECT COUNT(*) FROM witnesses;')"
  RC_B="$(post "$BEFORE_URL" "$WKEY" "$RUN/before-post.json")"
  W1="$(wq 'SELECT COUNT(*) FROM witnesses;')"
  check "⚑ RED: a leaf submission answers 500, the symptom E4-0 was found as" "500" "$RC_B"
  check "…and names no migration file anywhere in its body" "0" \
    "$(hits "$RUN/before-post.json" "$WITHHELD")"
  check "…nor the word pending" "0" "$(ihits "$RUN/before-post.json" 'pending')"
  # ⚑ AND THIS IS THE FINDING, NOT A DETAIL: the body is EMPTY. Not a wrong
  # diagnosis — no diagnosis. A caller sees a bare 500 and cannot tell a schema
  # from a bug from an outage, which is precisely why WO-D6's gate read the
  # event as eleven assertion failures.
  check "…and the body it answers with is EMPTY: the caller is told nothing at all" "0" \
    "$(stat -c%s "$RUN/before-post.json")"
  check "⚑ …while the server's OWN LOG knew exactly what was wrong all along" "1" \
    "$(hits "$RUN/before.log" 'no column named')"
  grep -m1 -oE 'SqliteError:.*' "$RUN/before.log" | sed 's/^/   server log:  /'
  check "⚑ …and the app wrote NO row" "0" \
    "$(sqlite3 "$RUN/stale.db" 'SELECT COUNT(*) FROM iterations;')"
  check "⚑ …while the WITNESS took a leaf for it — evidence with nothing pointing at it" "1" \
    "$((W1 - W0))"
  echo "   witnesses    $W0 -> $W1"
fi

note "STAGE 4 — GREEN AFTER: this commit, on the same stale database"
if [ "$S_UP" != yes ]; then
  incon "the stale-schema server answered /api/health" "see $RUN/stale.log"
else
  W0="$(wq 'SELECT COUNT(*) FROM witnesses;')"
  RC_S="$(post "$STALE_URL" "$WKEY" "$RUN/stale-post.json")"
  W1="$(wq 'SELECT COUNT(*) FROM witnesses;')"
  check "⚑ THE GATE: the leaf-writing route refuses" "503" "$RC_S"
  check "…with a code a caller can switch on" "schema_stale" "$(J "$RUN/stale-post.json" error.code)"
  check "…naming the pending migration in the message" "1" \
    "$(hits "$RUN/stale-post.json" "$WITHHELD")"
  check "…and carrying it as data, not only as prose" "[\"$WITHHELD\"]" \
    "$(J "$RUN/stale-post.json" error.detail.pending)"
  check "…with the reason it is refusing" "migrations_pending" "$(J "$RUN/stale-post.json" error.detail.reason)"
  check "…and the count it counted" "1" "$(J "$RUN/stale-post.json" error.detail.pending_count)"
  echo "   message      $(J "$RUN/stale-post.json" error.message | head -c 150)"
  check "⚑ …and the refusal is ABOVE every write: the witness took nothing" "0" "$((W1 - W0))"
  check "…and no row was written" "0" "$(sqlite3 "$RUN/stale.db" 'SELECT COUNT(*) FROM iterations;')"
  # The SECOND leaf-writing route. Nothing in app/api/v2/mark/route.ts was
  # edited by this work order; it refuses because it asks for a leaf-writing
  # scope, which is the property being bought.
  MK="$(curl -s -o "$RUN/stale-mark.json" -w '%{http_code}' -m 30 -X POST "$STALE_URL/api/v2/mark" \
        -H "authorization: Bearer $WKEY" -H 'content-type: application/json' \
        --data '{"leaf_id":"1","host":"blender","modalities":[]}')"
  check "⚑ the OTHER leaf-writing route refuses too, and it was not edited" "503" "$MK"
  check "…with the same code" "schema_stale" "$(J "$RUN/stale-mark.json" error.code)"
  check "…and app/api/v2/mark/route.ts says nothing about a schema at all" "0" \
    "$(grep -ci 'schema' "$WEB/app/api/v2/mark/route.ts")"
  # The other half of the sentence stage 3 ends on: the operator, who is reading
  # the server log and not the caller's error toast, is told too — and told the
  # filename, which is the one thing that turns this into an action.
  check "⚑ …and the operator's half is in the server's log, with the filename in it" "yes" \
    "$(grep -q "REFUSED witness:write.*$WITHHELD" "$RUN/stale.log" && echo yes || echo no)"
  grep -m1 -oE '\[schema\] REFUSED.*' "$RUN/stale.log" | sed 's/^/   server log:  /'
fi

note "STAGE 5 — CONTROL (a): with the schema current it serves normally"
if [ "$C_UP" != yes ]; then
  incon "the current-schema server answered /api/health" "see $RUN/current.log"
else
  RC_C="$(post "$CUR_URL" "$WKEY" "$RUN/current-post.json")"
  check "⚑ the same submission, the same build, a current schema" "201" "$RC_C"
  check "…and the leaf id it returns is a row in the database" "1" \
    "$(sqlite3 "$RUN/current.db" "SELECT COUNT(*) FROM iterations WHERE id=$(J "$RUN/current-post.json" leaf_id);" 2>/dev/null || echo 0)"
  check "…read back by sqlite3, not believed from the response" "1" \
    "$(sqlite3 "$RUN/current.db" 'SELECT COUNT(*) FROM iterations;')"
  check "…and it is witnessed" "true" "$(J "$RUN/current-post.json" witnessed)"
  echo "   leaf         id=$(J "$RUN/current-post.json" leaf_id)  hash=$(J "$RUN/current-post.json" leaf_hash | head -c 16)…"
  MKC="$(curl -s -o "$RUN/current-mark.json" -w '%{http_code}' -m 30 -X POST "$CUR_URL/api/v2/mark" \
        -H "authorization: Bearer $WKEY" -H 'content-type: application/json' \
        --data "{\"leaf_id\":\"$(J "$RUN/current-post.json" leaf_id)\",\"host\":\"blender\",\"modalities\":[]}")"
  check "…and the mark route is not refused either" "200" "$MKC"
  differs "the two servers answer the same request differently" "$RC_S" "$RC_C"
fi

note "STAGE 6 — CONTROLS (b),(c),(d): what must NOT change"
if [ "$S_UP" = yes ] && [ "$C_UP" = yes ]; then
  curl -s -m 30 -o "$RUN/cap-stale.json" "$STALE_URL/api/v2/capabilities?profile=desktop&host_apps=comfyui"
  curl -s -m 30 -o "$RUN/cap-current.json" "$CUR_URL/api/v2/capabilities?profile=desktop&host_apps=comfyui"
  check "(b) a route that touches no database still answers on the stale server" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$STALE_URL/api/v2/capabilities?profile=desktop")"
  check "(b) …byte-identically to the current one" "same" \
    "$(cmp -s "$RUN/cap-stale.json" "$RUN/cap-current.json" && echo same || echo DIFFERENT)"
  check "(b) …and it is not an empty answer that would match anything" "true" \
    "$(python3 -c "import json;print(str(len(json.load(open('$RUN/cap-stale.json')).get('regions',[]))>0).lower())" 2>/dev/null || echo false)"
  # A READ against the stale database still serves, deliberately: see the
  # comment on V2_LEAF_WRITE_SCOPES. A row already written is not made wrong by
  # a file appearing in lib/db/migrations.
  check "(b) …and a read-scope route on the STALE database still answers" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H "authorization: Bearer $RKEY" "$STALE_URL/api/v2/baseline/current")"
  # (c) order, and no leak to a caller who has not authenticated.
  UN="$(curl -s -o "$RUN/unauth.json" -w '%{http_code}' -m 30 -X POST "$STALE_URL/api/v2/witness" \
        -H 'content-type: application/json' --data "$(body)")"
  check "(c) unauthenticated is still 401, not the schema refusal" "401" "$UN"
  check "(c) …and tells an anonymous caller nothing about the schema" "0" \
    "$(ihits "$RUN/unauth.json" "$WITHHELD\|pending")"
  WS="$(post "$STALE_URL" "$RKEY" "$RUN/wrongscope.json")"
  check "(c) a read-only key is still 403 forbidden_scope" "403" "$WS"
  check "(c) …with the older code, not shadowed by the newer one" "forbidden_scope" \
    "$(J "$RUN/wrongscope.json" error.code)"
  # (d) the boundary, demonstrated: a registry write is not a leaf write. On a
  # tenant of its own, because the copied tenant already holds an active
  # baseline and §4 answers a second genesis with `conflict` — which would
  # prove the route was reached but not that it still WRITES.
  TSH="$(python3 -c "import hashlib,os;print(hashlib.sha256(os.urandom(16)).hexdigest())")"
  BB="{\"host\":\"blender\",\"integration_version\":\"wo-f5-control-d\",\"tamper_surface_hash\":\"$TSH\"}"
  BL="$(curl -s -o "$RUN/baseline.json" -w '%{http_code}' -m 30 -X POST "$STALE_URL/api/v2/baseline" \
        -H "authorization: Bearer $BKEY" -H 'content-type: application/json' --data "$BB")"
  check "(d) baseline:write is NOT refused on the stale schema" "201" "$BL"
  check "(d) …and the registry row is really there, on the stale database" "1" \
    "$(sqlite3 "$RUN/stale.db" "SELECT COUNT(*) FROM baselines WHERE baseline_hash='$TSH';")"
  check "(d) …while the leaf door on the same server, same key, still refuses" "503" \
    "$(post "$STALE_URL" "$WKEY" "$RUN/stale-post2.json")"
else
  incon "controls (b),(c),(d) need both servers" "stale=$S_UP current=$C_UP"
fi

note "STAGE 7 — E4-0's OWN TIMELINE: a migration appears under a running server"
if [ "$C_UP" != yes ]; then
  incon "the live-flip stage needs the current server" "up=$C_UP"
else
  PID_BEFORE="$(port_pid "$P_CURRENT")"
  cat > "$RUN/tree-live/lib/db/migrations/061_f5_probe.sql" <<'SQL'
-- A migration that appears in the tree at 17:43 under a server that started at
-- 15:00. WO-E2 did exactly this and nothing noticed for over an hour.
SELECT 1;
SQL
  RC_F="$(post "$CUR_URL" "$WKEY" "$RUN/flip-post.json")"
  check "⚑ the running server refuses within one request of the file appearing" "503" "$RC_F"
  check "…naming the file that appeared, which nobody restarted anything to learn" "1" \
    "$(hits "$RUN/flip-post.json" '061_f5_probe.sql')"
  PID_AFTER="$(port_pid "$P_CURRENT")"
  check "…and it is the same process, read out of ss and not assumed" "$PID_BEFORE" "$PID_AFTER"
  rm -f "$RUN/tree-live/lib/db/migrations/061_f5_probe.sql"
  RC_R="$(post "$CUR_URL" "$WKEY" "$RUN/recover-post.json")"
  check "⚑ …and it serves again when the tree and the database agree" "201" "$RC_R"
  check "…with two rows now written by this server" "2" \
    "$(sqlite3 "$RUN/current.db" 'SELECT COUNT(*) FROM iterations;')"
fi

note "STAGE 8 — the three answers that are not 'pending', asked of the function"
bash scripts/tsx.sh scripts/f5-schema-probe.ts --db "$RUN/current.db" --tree "$WEB" \
  >"$RUN/probe.json" 2>"$RUN/probe.log"
PJ(){ python3 -c "
import json,sys
d=json.load(open('$RUN/probe.json'))
for c in d:
    if c['case']==sys.argv[1]: print(json.dumps(c[sys.argv[2]])); break
else: print('-')" "$1" "$2" 2>/dev/null || echo '-'; }
if [ -s "$RUN/probe.json" ]; then
  check "a tree that matches the database is CURRENT" "true" "$(PJ tree-matches-database current)"
  check "…which is the control: this function can say yes" "null" "$(PJ tree-matches-database reason)"
  check "a tree with one more file than the database has seen is PENDING" "false" \
    "$(PJ tree-has-a-file-the-database-has-not current)"
  check "…named" "[\"999_f5_probe.sql\"]" "$(PJ tree-has-a-file-the-database-has-not pending)"
  check "⚑ an EMPTY migrations directory REFUSES rather than reading as 'nothing pending'" "false" \
    "$(PJ migrations-directory-is-empty current)"
  check "…with the reason" "\"migrations_unreadable\"" "$(PJ migrations-directory-is-empty reason)"
  check "⚑ a missing migrations directory REFUSES" "false" "$(PJ migrations-directory-does-not-exist current)"
  check "…with the reason" "\"migrations_unreadable\"" "$(PJ migrations-directory-does-not-exist reason)"
else
  incon "the schemaState() probe produced output" "$(tail -2 "$RUN/probe.log" | tr '\n' ' ')"
fi

note "STAGE 9 — the suites, and the sandbox app that other gates share"
# ⚑ The three servers are stopped FIRST. Not for tidiness: the first run of this
# stage scored a FAIL in `test:v2` — one subtest of 972, the C-6 anti-vacuity
# control, reading `expected at least 250 steps, got 0` on a 201 — while three
# `next dev` instances were compiling on the same box. It passes standalone and
# it cannot be this work order's doing (the guard's only output is a 503, and
# that assertion is reached through a 201), but `npm run test:v2` hands ONE
# temp database to every test FILE and node runs those files in parallel, so
# the suite has a load-sensitive race in it that is nothing to do with the
# server. Finding F5-2 in docs/WO-F5.md. Running the suites on a quiet box is
# not a fix for that and is not offered as one.
check "the two servers out of the shared tree built into dist dirs of their own" "2" \
  "$(ls -d "$WEB"/.next-f5-* 2>/dev/null | wc -l)"
stop_servers
( cd "$WEB" && npm run test:v2 >"$RUN/test-v2.log" 2>&1 ); check "the server's v2 suite is green" "0" "$?"
grep -E '^# (tests|pass|fail)' "$RUN/test-v2.log" | sed 's/^/   /'
( cd "$WEB" && npm run test:conformance >"$RUN/test-conf.log" 2>&1 ); check "…and the conformance suite" "0" "$?"
grep -E '^# (tests|pass|fail)' "$RUN/test-conf.log" | sed 's/^/   /'
node "$PRE" --db="$SCRATCH" >"$RUN/pre-sandbox.log" 2>&1
check "the shared sandbox database is still current" "0" "$?"
# The shared app on :3902 is serving THIS working tree — every other F gate
# runs through it. An unauthenticated leaf submission must still be 401: the
# guard runs after the key resolves, so a change that moved it above the auth
# check would show up right here as a 503.
SB="$(curl -s -o "$RUN/sandbox-post.json" -w '%{http_code}' -m 60 -X POST "$APP/api/v2/witness" \
      -H 'content-type: application/json' --data '{}' )"
check "…and the sandbox app on :3902 still refuses an anonymous write as 401" "401" "$SB"
check "…not as a schema refusal" "unauthorized" "$(J "$RUN/sandbox-post.json" error.code)"
check "…on a route with no database too" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP/api/v2/capabilities?profile=desktop")"
# The rail: this gate starts servers out of a tree other people are serving
# from, and must give it back unchanged. Measured in the only order that means
# anything — the damage FIRST, so that the restoration below is not a `cp`
# checking its own copy.
check "⚑ F5-3: the dev servers DID rewrite the shared tree's tsconfig.json" "changed" \
  "$( [ "$(sha256sum "$WEB/tsconfig.json" | cut -d' ' -f1)" = "$TSCONFIG_SHA" ] && echo unchanged || echo changed)"
cp "$RUN/tsconfig.json.orig" "$WEB/tsconfig.json"
check "RAIL: …and this gate puts it back, byte for byte" "$TSCONFIG_SHA" \
  "$(sha256sum "$WEB/tsconfig.json" | cut -d' ' -f1)"
check "RAIL: …and none of them is left in it" "0" \
  "$(ls -d "$WEB"/.next-f5-* 2>/dev/null | wc -l)"

note "VERDICT"
printf '   %d checks ok / %d FAIL / %d inconclusive\n' "$ok" "$fail" "$inconclusive"
echo "   artefacts: $RUN"
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then echo "   WO-F5 GATE: PASS"; exit 0; fi
if [ "$fail" -eq 0 ]; then echo "   WO-F5 GATE: INCONCLUSIVE"; exit 1; fi
echo "   WO-F5 GATE: FAIL"; exit 1
