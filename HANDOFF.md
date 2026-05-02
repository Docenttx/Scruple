# Scruple Web — Hand-off

All 30 WOs from `WORK_ORDERS.md` shipped overnight. 24 commits on
`main` from WO-01 scaffold through WO-30 telemetry. Build green
(`npx next build` succeeds), typecheck clean.

## What works without any user setup

```bash
cd /data/scruple-web
AUTH_SECRET=$(openssl rand -base64 32) npm run dev    # → :3001
```

- Dev server boots on `:3001`
- `npm run db:migrate` is idempotent and runs automatically on first
  request via `lib/auth/auth.ts`
- `npm run db:seed` creates a demo user (no password — only useful for
  inspecting iteration grid / receipt page directly via the seeded data)
- Witness server at `:5799` is **already wired and tested**. Lock pipeline
  passes through it. Smoke test in WO-20 verified end-to-end.

## What needs user-provided env / keys

Drop these into `/data/scruple-web/.env.local`:

```bash
# Required to sign in
AUTH_SECRET=<openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:3001
GOOGLE_CLIENT_ID=<from Google Cloud Console — OAuth client>
GOOGLE_CLIENT_SECRET=<from same>
# Add http://localhost:3001/api/auth/callback/google as an authorized
# redirect URI on the Google client.

# Optional — only needed once you want real generation
FAL_KEY=<fal.ai dashboard key>     # alternatively set per-user in /settings
# (ComfyDeploy key is per-user only, set in /settings)

# Already set on witness server, but if you want chain-lock to gate on payment:
LOCK_REQUIRE_PAYMENT=1
```

## Recommended test pass

1. **Sign in** — visit `http://localhost:3001`, get redirected to `/login`,
   click "Continue with Google", land back on `/`.

2. **Create a project** — click `+ New`, name it, submit, land on
   `/projects/[id]`. Sidebar shows the new project.

3. **Activate tracking** — workspace header → "Start tracking". Sidebar
   shows the green dot. Activate a second project → first one
   automatically deactivates.

4. **Manual ingest sanity check** (no provider keys needed):
   ```bash
   # Get the project id from the sidebar URL.
   PROJECT_ID=2
   IMG_B64=$(base64 -w0 < /path/to/any/image.png)
   curl -X POST http://localhost:3001/api/iterations \
     -H "Content-Type: application/json" \
     -H "Cookie: <copy from browser dev tools>" \
     -d "{\"projectId\":$PROJECT_ID,\"provider\":\"manual\",\"providerJobId\":\"test\",\"prompt\":\"test\",\"generationSpec\":{},\"imageBytes\":\"$IMG_B64\",\"imageContentType\":\"image/png\"}"
   ```
   Refresh — iteration card should appear in the grid. While the
   project is **active**, it should appear **without** a refresh (SSE).

5. **Local lock** — workspace → "Finalize Project". Status flips to
   "Finalized". SCR-ID badge appears in the sidebar + header. Toast
   includes "View receipt →" link.

6. **Receipt** — click the receipt link → `/receipt/SCR_XXXXXX` loads
   publicly (sign out, visit it, still works).

7. **Verify** — download project ZIP from a separate API call:
   ```bash
   curl -O -J http://localhost:3001/api/projects/$PROJECT_ID/export \
     -H "Cookie: <session>"
   unzip *.zip
   curl -X POST http://localhost:3001/api/verify \
     -H "Content-Type: application/json" \
     -d @manifest.json
   # → {"valid": true, ...}
   ```

8. **Chain lock** — workspace → "Chain Lock". This calls the witness
   server. Status flips to "Chain Locked". witness_signature populated
   in the receipt page.

9. **Settings** — `/settings`. Add a fake fal.ai key, see the tail-only
   confirmation. Clear it.

10. **Search** — sidebar search box filters by name. Pagination kicks
    in past 50 projects.

## Known limitations (NOT bugs)

- No "Generate image" button in the UI — the providers are wired
  (`/lib/providers/fal.ts`, `/lib/providers/comfydeploy.ts`) and the
  ingest endpoint accepts their output, but there's no in-app form to
  trigger a generation. This is `/api/generate` worth of follow-up work,
  not in the 30 WOs.
- Training capture (Kohya_ss) is deferred to v2 entirely (D-006). The
  `training_runs` and `checkpoints` tables exist but aren't populated.
- RVN/IPFS/Arweave columns on `projects` stay null until the witness
  server's chain modules are wired live (additive, no client change).
- Cost estimation in telemetry is a placeholder (`estimateCostCents`
  returns 1¢ for fal, 0 for everyone else). Refine when actual billing
  data is available.

## Files of interest

| Concern | Where |
|---|---|
| Hash convention (must match desktop) | `lib/scruple/hash.ts` |
| Merkle algorithm (must match desktop) | `lib/scruple/merkle.ts` |
| Witness server client | `lib/scruple/witness.ts` |
| Lock-package manifest format | `lib/scruple/lock-package.ts` |
| At-rest encryption for provider keys | `lib/auth/encryption.ts` |
| Generation provider interface | `lib/providers/types.ts` + `fal.ts` + `comfydeploy.ts` |
| Iteration capture flow | `app/api/iterations/route.ts` |
| Lock pipeline | `app/api/lock/{local,checkpoint,chain}/route.ts` |
| Workspace UI (port of render-workspace.js) | `components/WorkspaceView.tsx` |
| Live iteration updates | `components/IterationGridLive.tsx` + `app/api/iterations/stream/route.ts` |
| Public receipt | `app/receipt/[scrId]/page.tsx` |

## If something breaks

1. Check `cat memory/STATE.md` and `cat memory/WO_LOG.md` for recent
   context.
2. Run `npm run typecheck && npx next build` to localize.
3. Logs: `tail -f /tmp/scruple-web-dev.log` if running detached.
4. Reset DB if needed: `rm data/scruple.db && npm run db:migrate &&
   npm run db:seed`.
5. The witness server is at `/opt/scruple-witness/` — check it's up:
   `systemctl status scruple-witness`.

## Commit history

```
git log --oneline 3ddf798^..  # WO-01 forward
```
