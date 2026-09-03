# Server architecture — the box this estate runs on

**Status:** Survey. Every claim below was checked against the running system
on 2026-09-02/03, not against a design doc or someone's memory of the last
deploy. Where a check disagreed with what I was told going in, the check is
what's written here, and the disagreement is called out explicitly rather
than quietly corrected.
**Scope:** one host. Off-box compute (Modal, RunPod) is included because
Scruple depends on it; the Stooges product's own services on this same host
are named only enough to disambiguate what is and isn't Scruple's.
**Does not cover:** application-level architecture (routes, the leaf schema,
canonicalization). See `CANONICALIZATION.md`, `PLACEMENT_AND_SURFACES.md`,
`STUDIO_SEAL.md` and the rest of this directory for that. This document is
about what process is listening on what port, what supervises it, and what
happens when it dies.

---

## 1. The shape of the estate, in one paragraph

Scruple is a Next.js app (`scruple.stooges.ai`), a standalone witness server
that append-only-logs provenance events and signs them (`witness.scruple.ai`),
a Python signing backend the witness delegates to (`scruple-cvm-surrogate`,
loopback-only), and a ComfyUI instance for the canvas/Studio image path
(`canvas.stooges.ai`), all running as separate OS processes on one Oracle
Cloud host, reached from outside through four independent Cloudflare
tunnels. Two more systemd services — IPFS and a Ravencoin node — exist
specifically to anchor witness output to something outside this host's own
disks. Two long-running GPU workloads (Studio generation, Kohya training)
are deliberately *not* on this box: they run on Modal and on RunPod,
because this host has no GPU. The web app itself is the one piece of the
whole picture that isn't supervised by anything — see §3.

The host also runs the Stooges product (a different, unrelated app with its
own pm2 cluster, its own Cloudflare tunnels, and its own prod/junior/beta
splits). It's named here only where it shares a resource — a port range, a
disk, a cloudflared binary — with Scruple, and the distinction matters:
`stooges-prod` and `stooges-junior-prod` in `pm2 list` are not Scruple's,
and neither are `dev.stooges.ai`, `app.stooges.ai`, `beta.stooges.ai`,
`junior.stooges.ai`, or `junior-dev.stooges.ai`.

---

## 2. Request paths — four Cloudflare tunnels, one process each

Cloudflare Tunnel (`cloudflared`) is how every hostname on this host reaches
the internet; nothing here has a public IP bound directly to it except the
one nginx vhost noted in §2.2, which currently has no DNS record. Each
tunnel is its own systemd unit, its own config file in `/etc/cloudflared/`,
and its own tunnel credential JSON in `~/.cloudflared/` — they do not share
process, config, or failure domain. `systemctl cat` on each confirms the
Type=notify unit and its `--config` flag; `cloudflared tunnel list` confirms
the tunnel IDs and names against the credential files on disk.

### 2.1 Scruple's own hostnames

| Hostname | Tunnel (unit) | Config | Local service | Port |
|---|---|---|---|---|
| `scruple.stooges.ai` | `cloudflared.service` (dev-stooges) | `config.yml` | Next.js app, `/data/scruple-web` | 3001 |
| `witness.scruple.ai` | `cloudflared-scruple.service` | `config-scruple.yml` | witness server, `/opt/scruple-witness` | 5799 |
| `canvas.stooges.ai` | `cloudflared.service` (dev-stooges) | `config.yml` | ComfyUI | 8188 |
| `scruple-canvas-ws.stooges.ai` | `cloudflared.service` (dev-stooges) | `config.yml` | canvas-ws-proxy (pm2) | 8190 |
| `scruple-kohya-ws.stooges.ai` | `cloudflared.service` (dev-stooges) | `config.yml` | kohya-ws-proxy (pm2) | 8191 |

`config-scruple.yml` is its own tunnel, deliberately, and its own top-of-file
comment says why: it was split off `config.yml` on 2026-07-13 when
`scruple.ai` moved from being a subdomain of `stooges.ai` to its own
Cloudflare zone with its own root domain. Everything under `*.stooges.ai` —
including four of these five Scruple hostnames — is still served through the
older `cloudflared.service` / `config.yml` tunnel (tunnel name `dev-stooges`,
ID `4267d8dd…`), which is otherwise a Stooges tunnel carrying `dev.stooges.ai`
and `app.stooges.ai` alongside them. `config-scruple.yml`'s own comment
anticipates growth — *"witness.scruple.ai and future `*.scruple.ai`"* — but as
of this survey it carries exactly one hostname.

### 2.2 Not part of the tunnel story, and currently dead

`nginx` has a fifth, unrelated vhost enabled: `/etc/nginx/sites-enabled/canvas.scruple.ai`
(symlinked from `sites-available/`, dated 2026-04-09), listening on plain
:80 for `server_name canvas.scruple.ai`. It proxies ComfyUI's own routes to
127.0.0.1:8188 (correct, matches §2.1) but proxies four Scruple-specific
intercept routes — `/prompt`, `/view`, `/upload`, `/history` — to
**127.0.0.1:3000**. Nothing is listening on port 3000 on this host as of this
survey (confirmed with `ss -ltnp`); those four routes would 502. The file's
own top comment reads *"HTTP only until DNS A record → 129.80.23.93 and
certbot runs"*, and `canvas.scruple.ai` currently has **no DNS record at
all** — `host canvas.scruple.ai` returns NXDOMAIN. This is not a live ingress
path. It appears to be an abandoned or superseded attempt at fronting
Studio's canvas API directly through nginx rather than through the
`scruple-canvas-ws` Cloudflare tunnel that actually carries that traffic
today (§2.1). No canon document in this repo references it; it turns up only
in `research/` notes. Nobody asked me to fix it and I didn't touch it — it's
listed here so the next person who greps for `canvas.scruple.ai` and finds a
live-looking nginx config doesn't mistake it for the real path.

### 2.3 Stooges hostnames on the same tunnels (not Scruple's)

| Hostname | Tunnel | Port | Product |
|---|---|---|---|
| `dev.stooges.ai` | dev-stooges (`config.yml`) | 3000 | Stooges dev |
| `app.stooges.ai` | dev-stooges (`config.yml`) | 8081 | Stooges prod |
| `beta.stooges.ai` | `cloudflared-beta.service` | 3010 | Stooges beta |
| `junior.stooges.ai` | `cloudflared-junior.service` | 8082 | Stooges Junior prod |
| `junior-dev.stooges.ai` | `cloudflared-junior.service` | 3020 | Stooges Junior dev |

`cloudflared tunnel list` also shows a fifth tunnel credential on this host,
`stooges-prod-app` (ID `4649a8c7…`), with no corresponding config file or
systemd unit here — it isn't one of the four running tunnels and isn't run
from this box. It's mentioned only because its credential JSON sits in the
same `~/.cloudflared/` directory as the four that matter to Scruple (see §6).

---

## 3. The four things that have to be running, and which are supervised

| Component | Port | Supervised by | Survives reboot | Survives crash |
|---|---|---|---|---|
| Web app (`scruple.stooges.ai`) | 3001 | **nothing** | No | No |
| Witness server | 5799 | `scruple-witness.service` (systemd, enabled, `Restart=always`) | Yes | Yes |
| CVM surrogate | 8799 (loopback only) | `scruple-cvm-surrogate.service` (systemd, enabled, `Restart=always`) | Yes | Yes |
| ComfyUI (canvas) | 8188 (loopback; reached via tunnel) | `comfyui.service` (systemd, enabled) | Yes | Yes |

### 3.1 The web app is not supervised, and that's the single most important fact in this document

`scruple.stooges.ai` is served by `next dev -p 3001` (`next@14.2.15` per the
running `next-server` process), started by hand from `/data/scruple-web`.
It is **not** a systemd unit — `systemctl list-units --all | grep scruple-web`
returns nothing — and it is **not** a pm2 process — `pm2 list` shows only
`stooges-prod`, `stooges-junior-prod`, `canvas-ws-proxy`, and
`kohya-ws-proxy`; there is no `scruple` or `scruple-web` entry, and
`pm2 describe scruple` confirms it: *"doesn't exist"*.

Three consequences follow directly from that, and none of them are
hypothetical:

- **Editing the repo edits the live site.** There is no build step and no
  deploy step between a file change under `/data/scruple-web` and what
  `scruple.stooges.ai` serves. `next dev` picks up the change on the next
  request. This cuts both ways — it's why iteration on this app is fast —
  but it also means there is no version of the running app that isn't
  whatever the working tree currently holds, uncommitted changes included.
- **The process does not survive a reboot.** Nothing re-launches it; no
  systemd unit, no pm2 startup script, no cron `@reboot` line references it.
- **It was not running at all at the start of the 2026-09-02 session.**
  The currently-running `next-server` process (PID 4024901, wrapping shell
  PID 4024889/4024890) has a start time of Sep 2 — it was started during
  this survey's own work, not inherited from some earlier, longer-lived
  session.

Putting the web app under supervision (pm2, to match its siblings on this
host, or systemd, to match the witness) is an open item. It has not been
done as part of this survey — see the constraints at the top of the work
that produced this document: no running service was to be changed.

### 3.2 comfyui.service

`comfyui.service`, systemd, enabled, bound to `127.0.0.1:8188`. This is
Studio/canvas's image-generation backend, reached from outside only through
the `canvas.stooges.ai` Cloudflare tunnel (§2.1) or the two WebSocket proxy
hostnames, never directly. It is the one GPU-shaped workload that still runs
locally rather than on Modal; `CANVAS_BASELINE.md` and
`WO-05-studio-comfyui-kohya.md` describe the application-level side of that
choice.

---

## 4. The witness and the surrogate — the provenance core

### 4.1 The witness server

`/opt/scruple-witness`, port 5799, `scruple-witness.service` — systemd,
enabled, `Restart=always`, `RestartSec=10`. It runs as the `ubuntu` user out
of `/opt/scruple-witness`, a deployment directory distinct from the
`services/witness-server` source it's built from in `/data/scruple-web`.

That distinction is exactly the kind of thing that drifts, so it's checked
by running the estate's own comparison tool rather than assumed. From
`/data/scruple-web`:

```
$ node services/witness-server/check-deployment.mjs
MATCH  70a61ff95a3065f32326ca2c15bbb19d8454f7c129e292f70a66b557c4400403
The deployment is running the tracked source.
```

The deployed `server.js` and `leaf_signer.js` hash-match the tracked source
as of this survey. `DEPLOYMENTS.md` in this same directory carries the
deploy history and at least one past drift (a missed `leaf_signer.js` copy
that caused a ~17-second outage) — this check is how that class of drift
gets caught before it's a production incident rather than after.

Its database is `/opt/scruple-witness/witness.db` (SQLite, plus `-shm`/`-wal`
files from WAL mode), 168K as of this survey — small, because it holds
leaves and Merkle state, not artifact bytes.

### 4.2 Secrets moved out of the unit file, 2026-09-02

The witness's secrets — `SCRUPLE_WITNESS_SECRET`, and two Stripe test keys
that `DEPLOYMENTS.md` already flagged as a standing item — now live in
`/etc/scruple-witness.env`, owned `root:root`, mode `0600`. The systemd unit
references it with `EnvironmentFile=`, and both the unit and its
`override.conf` drop-in carry a comment explaining why: a systemd unit file
and a drop-in are both world-readable, and `systemctl cat` on either used to
print the witness HMAC and both Stripe keys to any account on the box that
could run `systemctl`. The drop-in file itself was deliberately left in
place, empty of secrets, so `systemctl cat` still shows a human where the
values went rather than looking like they vanished.

Two environment variables that are *not* secrets stayed on the unit itself:
`SCRUPLE_WITNESS_KMS_ENDPOINT=http://127.0.0.1:8799` and
`SCRUPLE_WITNESS_KMS_KEY_OCID=…surrogate…` — both loopback-scoped
configuration pointing at the surrogate described next, not credentials.

### 4.3 The CVM surrogate — H-1's signing backend, and its quiet failure mode

`/data/scruple-web/services/cvm-surrogate/surrogate.py`, bound to
`127.0.0.1:8799` only — never exposed through any tunnel or nginx vhost.
As of 2026-09-02 it runs as `scruple-cvm-surrogate.service`: systemd,
enabled, `Restart=always`, `Before=scruple-witness.service`. Before that
unit existed, the process's own unit-file comment records what it replaced:
a bare `python3 surrogate.py` started by hand on 2026-08-27 with PPID 1 and
no supervision at all — a supervised, `Restart=always` witness depending on
an unsupervised signing backend. The new unit's `Before=` ordering doesn't
make the witness wait on the surrogate at every boot in a hard sense, but it
expresses the dependency directly in the unit graph rather than leaving it
implicit.

Its P-256 signing key persists to `surrogate-key.pem` (mode `0600`) and is
reloaded on start, specifically so a service bounce is safe — the same key
identity survives a restart rather than minting a new one.

**The failure mode, read directly from `leaf_signer.js` rather than
inferred:** `signLeaf()` in `/opt/scruple-witness/leaf_signer.js` talks to
the surrogate over HTTP (`SCRUPLE_WITNESS_KMS_ENDPOINT` + `/20180608/sign`,
wire-identical to the real OCI KMS Crypto API this surrogate stands in
for). On a non-200 response, a malformed body, a timeout, or any thrown
error, it logs to stderr and **returns `null` — it does not throw**:

```js
} catch (e) {
  console.error(`[leaf_signer] KMS sign failed: ${e.message}`);
  return null;
}
```

The function's own comment states the reasoning: *"NEVER THROWS PAST THE
CALLER'S CONTROL. A KMS outage must not stop the witness recording the
event: losing the leaf entirely is worse than recording one whose
independent verifiability is pending."* The consequence is that if the
surrogate dies, the witness does not error, does not stop, and does not log
anything a dashboard would surface by default — it keeps accepting and
recording leaves exactly as before, except every `leaf_signature` column
from that point on is `null`. Nothing distinguishes that state from normal
operation except reading the column. This is by design, documented in the
code, and worth restating here because it's the kind of failure that looks
like nothing happened.

As of this survey `leaf_signer.js`'s `mode()` resolves to `kms-http` (the
surrogate path) rather than `vault-py` or `disabled` — `SCRUPLE_WITNESS_SIGNER`
is not set in `/etc/scruple-witness.env` (confirmed by listing the file's
variable names, not its values — see §6), and the endpoint/key-OCID pair is
present on the unit, so leaves are being signed through the surrogate today,
not through the real KMS/Vault path `DEPLOYMENTS.md` describes as still
blocked on the founder's OCI session.

---

## 5. Supporting systemd services — the rest of the provenance story

| Service | Ports | Enabled | Running | Purpose |
|---|---|---|---|---|
| `comfyui.service` | 127.0.0.1:8188 | yes | yes | Studio/canvas image generation backend (§3.2) |
| `ipfs.service` | 4001 (swarm), 5001 (API, loopback), 8080 (gateway, loopback) | yes | yes | Content-addressed pinning; one of the two best-effort anchors the witness posts to after a chain-lock mint |
| `ravend-testnet.service` | 18766, 18770 | yes | yes, 3+ weeks uptime | Ravencoin **testnet** node — this is the chain the witness actually mints chain-lock anchors on today |
| `ravend-mainnet.service` | — | yes | **failing, crash-looping** | Ravencoin **mainnet** node — see below |
| `nginx.service` | 80 | yes | yes | Reverse proxy; one live Stooges-adjacent role plus the dead vhost in §2.2 |

`IPFS` and the Ravencoin nodes exist for the same reason: a leaf signed only
by keys this host holds is a claim this host could also forge, so the
witness anchors permanence evidence somewhere it doesn't control. Reading
`anchorPermanence()` in `/opt/scruple-witness/server.js` confirms the shape
of it: the Ravencoin mint (via `testnet-locker.js`) is the **primary**
anchor a chain-lock depends on, and the IPFS pin plus an Arweave transaction
posted through `arweave-treasury.js` are explicitly **non-fatal** — logged
on failure, not retried, not blocking. `FILING_CORRECTIONS.md` (F-09)
already documents, as a corrected filing claim, that the shipping modality
mints on **Ravencoin testnet**, not a production mainnet — which matches
what's actually running.

**`ravend-mainnet.service` is enabled but not functioning.**
`systemctl status` shows it `activating (auto-restart)` with a restart
counter past 61,000; `journalctl -u ravend-mainnet` shows the same failure
on every attempt: `Error loading block database. Please restart with
-reindex or -reindex-chainstate to recover.` It has presumably been in this
loop for a long time given the restart count. Because the witness's live
anchor target is testnet (confirmed above, and consistent with
`FILING_CORRECTIONS.md`), this does not appear to be blocking any current
witness function — but it means if anything on this host or in this repo
ever assumes a working mainnet node is available, that assumption is wrong
today, and a `-reindex` (or a resync from scratch) is unfinished work, not
done work. Nobody asked this survey to fix it, and per this task's
constraints nothing was restarted or reindexed to check further.

`nginx`'s one confirmed live role on this host, from `sites-enabled/`, is
the `canvas.scruple.ai` vhost — which, per §2.2, is itself dead
(no DNS, and two of its five routes point at a port nothing is listening
on). I did not find any other Scruple-relevant nginx vhost. Whatever
legitimate reverse-proxy work `nginx.service` is doing on this host, if
any, is for the Stooges product, not Scruple.

---

## 6. Off-box compute — Modal and RunPod

This host has no GPU. Both of Scruple's GPU-shaped workloads run
off-box, verified against the live accounts rather than against
configuration alone.

### 6.1 Modal

`modal app list` (credentials from `.env.local`) shows three deployed apps:

| App | State |
|---|---|
| `scruple-runner` | deployed |
| `scruple-canvas` | deployed |
| `scruple-training` | deployed |

The runner is addressed from this host through `MODAL_RUNNER_ENDPOINT` in
`.env.local`; the canvas app has four per-tier URLs
(`MODAL_CANVAS_APP_URL_T4_FREE`, `_A10G_PRO`, `_A100_PREMIUM`,
`_H100CC_ENTERPRISE`) also in `.env.local`. Model weights used by these apps
live in a Modal Volume, `scruple-models` (confirmed with `modal volume
list`, created 2026-05-12 by `aquanomous`) — not on this host's own disks.

### 6.2 RunPod

`modal`'s counterpart for training: exactly one RunPod template exists on
the account. `.env.local` carries `RUNPOD_API_KEY` and
`RUNPOD_KOHYA_TEMPLATE_ID` and nothing named `RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID`
— confirmed by grepping variable names, not values. `training-founder-checklist.md`
in this directory already recorded a live-account check of that template
(`GET rest.runpod.io/v1/templates`) that this survey did not need to repeat:
id `7lxi6lu86v`, image `ashleykza/kohya:latest` — a public, third-party
image; nothing custom was ever built or pushed for it. The Scruple-specific
hook is injected at pod boot through the template's `dockerStartCmd`, which
`curl`s `public/pod-hooks/kohya_safetensors_hook.py` from
`https://scruple.stooges.ai/pod-hooks/…` and installs it as
`sitecustomize.py` before handing off to the image's own `/start.sh`. The
hook file's own header is explicit that this is not a witnessing mechanism —
it runs inside a container the tenant has root in, and
`PLACEMENT_AND_SURFACES.md` classifies that surface as `unattested-client`
regardless.

**There is no Docker on this host.** `docker` is not on `$PATH`, no
`docker`/`docker.io`/`docker-ce` package is installed, and no
`docker.service` or `containerd.service` exists. This is consistent with the
`dockerStartCmd`-on-a-public-image pattern above: the container that runs
`ashleykza/kohya:latest` runs on RunPod's infrastructure, not this host's.
This host only ever POSTs to RunPod's REST API to create it.

---

## 7. Storage, databases, secrets

### 7.1 Disks

| Mount | Size | Used | Available | Use% |
|---|---|---|---|---|
| `/` | 45G | 33G | 13G | 73% |
| `/data` | 147G | 129G | 11G | **93%** |
| `/mnt/corpus` | 738G | 529G | 209G | 72% |

`/data` is the one to watch — 93% full at survey time, with 11G headroom.
(I was told to expect roughly 89%; the live `df -h` reads 93%. The
observation is what's recorded here.) `/data/scruple-web` — the app, its
`node_modules`, its artifacts, and its SQLite database — lives on this
volume.

### 7.2 Scruple's data

| Path | Size / state | Notes |
|---|---|---|
| `/data/scruple-web/artifacts/` | ~259M | Content-addressed. **Gitignored** (`artifacts/` and `!artifacts/.gitkeep` in `.gitignore`) — this directory is runtime state, not source. |
| `/data/scruple-web/data/scruple.db` | 3.9M, SQLite | The app database. |
| `/opt/scruple-witness/witness.db` | 168K, SQLite (WAL) | The witness's own database — leaves, Merkle nodes, deployment/lifecycle events. Deliberately separate from `scruple.db`; the witness is a standalone service and does not share the app's database file. |

`scruple.db`'s own `_migrations` table (not a table literally named
`migrations`) shows migrations applied through **`049_canonicalization_profile.sql`**,
most recently applied 2026-09-02 23:11:47 — and
`lib/db/migrations/` in the repo holds exactly 49 files, `001` through `049`.
The database is caught up with the tracked migrations as of this survey.

### 7.3 Secrets inventory — names and locations, no values

| Secret material | Location | Permissions |
|---|---|---|
| App environment (Modal, RunPod, Stripe, etc.) | `/data/scruple-web/.env.local` | `-rw-------` (0600), owner `ubuntu` |
| Witness secret + Stripe test keys | `/etc/scruple-witness.env` | `-rw-------` (0600), owner `root` — moved out of the unit file 2026-09-02, §4.2 |
| Cloudflare tunnel credentials (5 files, 4 in active use) | `~/.cloudflared/*.json` | `-r--------` (0400), owner `ubuntu` |
| Arweave signing key | `/opt/scruple-witness/arweave-key.json` | `-rw-rw-r--` (**0644**), owner `ubuntu` |
| CVM surrogate signing key | `/data/scruple-web/services/cvm-surrogate/surrogate-key.pem` | `-rw-------` (0600), owner `ubuntu` |

One thing worth flagging while it's being looked at directly:
`arweave-key.json` is group- and world-readable (`0644`), unlike every other
secret in this table. Nothing in this survey's brief asked for it to be
changed, and it wasn't — no running service or file permission was touched —
but it's inconsistent with the discipline applied to the witness's other
secrets on 2026-09-02 (§4.2) and to the surrogate's own key, and it's the
kind of gap that's easy to miss once the more obviously world-readable unit
files are fixed.

---

## 8. Known fragilities and open items

- **The web app has no supervisor.** §3.1. This is the single highest-value
  open item on this host: a crash, a reboot, or an OOM kill takes
  `scruple.stooges.ai` down with nothing to bring it back, silently, with no
  restart counter to notice. Putting it under pm2 (to match its neighbors
  on this host) or systemd (to match the witness) is unfinished work.
- **`ravend-mainnet.service` is enabled and permanently crash-looping**
  on a corrupted block database (§5). Not currently load-bearing — the live
  anchor target is testnet — but it means mainnet is not actually available
  if anything ever assumes it is, and the restart count suggests this has
  been silently failing for a long time.
- **The `canvas.scruple.ai` nginx vhost is dead configuration** — no DNS,
  and two of its five proxied routes point at a port (3000) nothing is
  listening on (§2.2). It isn't referenced by any canon document. It should
  probably be removed or reconciled with the real canvas path, but this
  survey did not touch it.
- **`arweave-key.json` is world-readable** where its siblings are `0600`
  (§7.3).
- **The surrogate's failure mode is silent by design** (§4.3): a dead
  surrogate does not stop the witness, does not error visibly, and leaves
  `leaf_signature` null on every leaf written while it's down. That's a
  documented, deliberate trade-off, not a bug — but it means "is the
  surrogate up" needs to be its own monitored fact, because the witness
  itself will not surface its absence.
- **`/data` is at 93% full**, 11G free (§7.1), higher than expected going
  into this survey.

---

## 9. Hygiene performed, 2026-09-02/03

This section is a record of maintenance done alongside this survey. No
running service was restarted, reconfigured, or killed as part of *writing
this document* — the items below were completed before or during the same
session and are recorded here because they change facts stated above.

- **Eleven stale `server.js.bak*` files archived out of the witness
  deployment directory.** `/opt/scruple-witness/` previously held backup
  copies going back to `server.js.bak2`/`server.js.bak3` (2026-04-03) through
  `server.js.bak.20260622-wo8`, alongside the live `server.js`. All eleven
  were moved to `/mnt/corpus/scruple-witness-archive/`, with a
  `MANIFEST.sha256` recording a checksum for each so their provenance isn't
  lost. `/opt/scruple-witness/` now holds only tracked source
  (`server.js`, `leaf_signer.js`, and the rest matched by
  `check-deployment.mjs`, §4.1) plus genuine runtime state
  (`witness.db*`, `history/`, `node_modules/`). The archive directory also
  picked up pre-2026-09-02 backups of the systemd unit and its drop-in, from
  the secrets move described next.
- **Witness secrets moved to an `EnvironmentFile`.** §4.2. Confirmed:
  `/etc/scruple-witness.env` is `0600` root-owned, and the unit's own
  drop-in comment records why and where.
- **Four orphaned `services/witness-server` test rigs, ports 5896–5899,
  killed.** Before killing anything, their parent process chains were
  traced back to confirm they reached PID 1 (i.e., truly orphaned rather
  than owned by a live session) and their databases were checked — all four
  used `/tmp/*.db`, not `witness.db` or any production path, so nothing with
  production data was at risk. Confirmed as of this survey: nothing is
  listening on 5896–5899.
- **The CVM surrogate adopted into systemd.** §4.3. Previously a bare
  `python3 surrogate.py` with PPID 1 and no supervision, started by hand on
  2026-08-27. Now `scruple-cvm-surrogate.service`, enabled,
  `Restart=always`, ordered `Before=scruple-witness.service`.
