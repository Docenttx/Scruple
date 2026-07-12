# WO-04 — Signer process isolation (systemd + dedicated user + Unix socket + rate limits)

**Sprint:** 1
**Estimate:** 6 owner-hours
**Blocking:** WO-03 (refactored daemon exists)
**Blocks:** WO-08 (C2PA leaf emission happens through the isolated daemon)

## Goal

Move the C2PA signer from an in-process Python subprocess spawned by Next.js
into a **dedicated systemd service** running as a dedicated OS user that
Next.js cannot masquerade as. Next.js reaches the signer via a Unix domain
socket. The signer's OCI ambient identity (Instance Principal) is the only
identity that can call Vault `Sign`; the Next.js user cannot.

After this WO, compromise of Next.js does NOT grant access to the C2PA
signing key or the ability to sign arbitrary content.

## What to build

### 1. OS user + install path

- Create `scruple-signer` system user + `scruple-signer` group; no login shell,
  no home directory.
- Install signer files to `/opt/scruple-signer/`:
  - `sign_daemon.py` — new entry point wrapping the existing `sign.py` logic
    behind a Unix-socket request/response loop (JSON in, JSON out; same job
    schema as today's stdin path).
  - `vault_sign.py` from WO-03.
  - `sign.py` — existing signing library, unchanged from WO-03.
  - `requirements.txt` pinning `c2pa`, `oci`, `cryptography`.
- Install the c2pa production cert chain to `/etc/scruple/c2pa-cert-chain.pem`
  (0644 root:root; the signer user has read-only access via ACL).

### 2. systemd unit `scruple-c2pa-signer.service`

```ini
[Unit]
Description=Scruple C2PA Signer (isolated)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=scruple-signer
Group=scruple-signer
WorkingDirectory=/opt/scruple-signer
ExecStart=/usr/bin/python3 /opt/scruple-signer/sign_daemon.py --socket /run/scruple-signer/sign.sock
RuntimeDirectory=scruple-signer
RuntimeDirectoryMode=0750
Restart=on-failure
RestartSec=5s

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
ReadOnlyPaths=/etc/scruple
InaccessiblePaths=/data/scruple-web/services/c2pa-signer/keys
CapabilityBoundingSet=

# Prod environment — NOTE explicit empty SCRUPLE_C2PA_DEV
Environment=SCRUPLE_C2PA_DEV=
Environment=SCRUPLE_C2PA_CERT_CHAIN=/etc/scruple/c2pa-cert-chain.pem
EnvironmentFile=/etc/scruple/c2pa-signer.env

[Install]
WantedBy=multi-user.target
```

`/etc/scruple/c2pa-signer.env` (0640 root:scruple-signer, NOT committed):

```
SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1...
SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://xxx-crypto.kms...
SCRUPLE_C2PA_TA_URL=http://timestamp.digicert.com
SCRUPLE_C2PA_LEAF_INGEST_URL=unix:/run/scruple-signer/log.sock  # WO-08 wires this
```

Socket file `/run/scruple-signer/sign.sock` gets 0660 ownership
`scruple-signer:www-data` (or whichever group Next.js runs as). Next.js can
write to the socket; nothing else can.

### 3. Daemon loop `sign_daemon.py`

Accept newline-delimited JSON on the socket. Each request has the same shape
as today's stdin job spec (`{asset_path, output_path, cert_path?, key_path?,
manifest}`) minus the private-key field which is now ignored. Response is
the same JSON shape as today.

Per-connection rate limit: refuse >20 concurrent connections, refuse further
requests on a connection after 100 signs/second sustained (rolling window).
Backpressure return: HTTP-style JSON `{ok: false, error: "rate_limited",
retry_after_ms: 500}`.

Add `sd_notify("READY=1")` on socket bind + `sd_notify("WATCHDOG=1")` every
30s so systemd knows the daemon is alive.

### 4. Next.js call-site change

In `lib/c2pa/signAsset.ts`, replace the `spawn('python3', [SIGNER_SCRIPT])`
child-process path with a Unix socket connection:

```typescript
import net from 'net';

const SIGNER_SOCKET = process.env.SCRUPLE_SIGNER_SOCKET ?? '/run/scruple-signer/sign.sock';

async function signViaDaemon(job: SignJob): Promise<SignResult> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SIGNER_SOCKET);
    let buf = '';
    sock.on('data', (d) => buf += d.toString());
    sock.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    sock.on('error', reject);
    sock.setTimeout(30_000, () => sock.destroy(new Error('signer timeout')));
    sock.write(JSON.stringify(job) + '\n');
    sock.end();
  });
}
```

Timeout returns a clean error to `/api/scruple/c2pa/sign`; the API route
becomes responsible for surfacing that as 503.

Remove all `spawn(PYTHON_BIN, ...)` code from `lib/c2pa/signAsset.ts` and the
`SIGNER_DIR / SIGNER_SCRIPT / PYTHON_BIN` constants that supported it.

### 5. VCN / networking

Reference WO-01's security list: only egress to
`vault.<region>.oci.oraclecloud.com` and `kms.<region>.oci.oraclecloud.com`.
Add the TSA URL host (`timestamp.digicert.com`) to the allow-list if TA is
enabled. No general internet egress from the signer subnet.

### 6. Route-level rate limiting on `/api/scruple/c2pa/sign`

Add a rate limiter (reuse whatever pattern the rest of the app uses — if
none exists, use `@upstash/ratelimit` or a simple sliding-window in memory
keyed by userId). Default: 60 signs / minute per user, 600 / hour. Log 429
responses. This backs L2 checklist item #6.

## What NOT to build

- No fallback to in-process signing if the daemon is unreachable. Return 503,
  page an operator.
- No shared filesystem between Next.js and the signer beyond the socket file
  and the read-only cert chain. The signer's home dir + working dir are
  inaccessible to Next.js.
- No API key or password authenticating Next.js → daemon. Socket permissions
  are the authorization. If Next.js can open the socket, it's authorized.
- No signer-side logging of the C2PA private-key material (nothing to log —
  Vault returns the signature).
- No support for a "dev bypass" flag in the systemd unit. Dev testing is
  separate — run `sign_daemon.py` under a dev user with `SCRUPLE_C2PA_DEV=1`,
  NOT this unit.

## Deliverables

- `deploy/systemd/scruple-c2pa-signer.service` committed
- `deploy/scripts/install-signer.sh` — creates user, installs files, enables
  service (idempotent; safe to re-run)
- `/opt/scruple-signer/sign_daemon.py` (source in `services/c2pa-signer/`)
- Updated `lib/c2pa/signAsset.ts` calling the Unix socket
- Rate limiter on `/api/scruple/c2pa/sign` route
- Deployment note in `docs/deploy/README.md` covering signer install steps

## Acceptance criteria

- [ ] `systemctl status scruple-c2pa-signer` shows `active (running)` under
      user `scruple-signer`.
- [ ] `ls -l /run/scruple-signer/sign.sock` shows `srw-rw---- scruple-signer
      www-data`.
- [ ] Signing a test asset via `/api/scruple/c2pa/sign` succeeds via the
      socket path (no `spawn` in the code path — verified by grep).
- [ ] `sudo -u www-data cat /etc/scruple/c2pa-signer.env` fails permission
      denied (only signer user + root can read).
- [ ] `sudo -u www-data /usr/bin/oci kms crypto sign ...` fails
      NotAuthorizedOrNotFound (only signer instance principal can Sign).
- [ ] Killing the daemon and restarting via `systemctl restart` recovers
      cleanly; in-flight signs return 503 during the ~5s window.
- [ ] Rate limiter returns 429 after 60 signs/minute for a test user.
- [ ] `SystemCallFilter` blocks a benign `mount` attempt in the daemon
      process (test by adding a debug `os.system("mount ...")` in a scratch
      branch and confirming journalctl shows the syscall filter).

## Related

- Canonical design §5.3 (Isolation)
- Canonical design §11 checklist items #4, #6
- WO-01 — VCN egress rules apply here
- WO-03 — provides the daemon logic wrapped by this WO
- WO-08 — daemon emits a sign leaf to the log-ingest socket set here
