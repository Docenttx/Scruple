# WO-D1 — it runs, headlessly, and we can see it

_2026-09-09. Gate: `bash scripts/d1-gate.sh` (needs the scratch app on `:3902`)._

## What was built

| file | what it is |
|---|---|
| `package.json` | the app root. `main: app/main-modular.js`, so `electron .` works from the repo. |
| `app/main-modular.js` | the shell: one `BrowserWindow` at `$SCRUPLE_APP_URL`, nothing bundled. |
| `app/preload.js` | the host↔page bridge — `window.scruple.ping()` and nothing else yet. |
| `app/ipc-ping.js` | the main-process half of the seam. |
| `app/probe.js` | `--probe=ping`: the scripted round trip, written to a JSON report. |
| `scripts/d1-ipc-ping.mjs` | the gate — launches the real app under xvfb, asserts on the report. |
| `scripts/d1-gate.sh` | gate + its three controls, one command. |

`app-legacy/` is untouched. Nothing in it is required, loaded or imported by the
running app; `index-final.html` and `renderer/` are not on the path to being
loaded, because the UI is served (docs/DESIGN.md, "Not bundled").

## Versions actually observed

Read out of the running binary **through the IPC reply** — not from
`package.json`, and not from `electron -v`:

```
electron  38.8.6
chromium  140.0.7339.249
node      22.22.0        (Electron's, not the host's v20.20.2)
v8        14.0.365.10-electron.0

renderer UA
  Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko)
  scruple-desktop-studio/3.1.0-dev Chrome/140.0.7339.249 Electron/38.8.6 Safari/537.36
```

The page loaded was `http://127.0.0.1:3902/login` — `/` 307s there — HTTP 200,
10,595 chars of server-rendered body, title `Scruple Web`.

`app.disableHardwareAcceleration()` is set: llvmpipe has no usable GPU path here
and Chromium's GPU process crash-loops looking for one. Software compositing is
all we need, since nothing gates on pixels.

## The gate, and its controls

Observable: a JSON report on disk whose `ping.serverNonce` equals a nonce minted
in the main process, whose `ping.echo` equals a nonce minted by the **harness**,
and a process that exited 0.

| run | result | why it means something |
|---|---|---|
| **gate** | PASS, exit 0 | 14 app checks + 8 harness checks, all green |
| **control A** — dead port `:39027` | FAIL, exit 4 | `ERR_CONNECTION_REFUSED`; a run that cannot load its page must not report success. Plain `electron .` exits **3** rather than sitting there looking alive. |
| **control B** — preload deleted | FAIL, exit 4 | every ping check goes red while `page-came-from-app-url` and `http-status-200` stay green. The ping assertions are not vacuous, and they are not just re-testing the page load. |
| **control C** — preload fakes the reply in the renderer | FAIL, exit 4 | exactly two checks go red: `ping-carries-server-nonce` and `ping-from-this-main`. Worth reading closely — `ping-echoes-client-nonce` **passes** for the fake, because a renderer-local stub can echo. The echo alone is not evidence; the server nonce is. |

Port 1 was tried first for control A and rejected: Chromium refuses it with
`ERR_UNSAFE_PORT` before opening a socket, which would have proved nothing about
the app. `scripts/d1-gate.sh` checks its dead port is genuinely dead before using it.

## Not done here

- No screenshot, by design — blank under llvmpipe (docs/DESIGN.md).
- The window loads `/login` because that is where the scratch app sends an
  unauthenticated client. Signing in, and rendering from
  `GET /api/v2/capabilities`, is WO-D5. `/api/v2/capabilities` requires a `host`
  query parameter and rejects a bare `GET` with `invalid_body` — worth knowing
  before WO-D5 starts.
- One IPC method. The lock / project / settings / training / wallet handlers in
  `app-legacy/ipc/` are still legacy and still unrewritten.
