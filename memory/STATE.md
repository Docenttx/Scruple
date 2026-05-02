# Scruple Web — Current State
_Last updated: 2026-05-02T06:25:00Z_

## Phase: ALL 30 WOs SHIPPED — ready for browser test pass

23 commits on top of WO-01 scaffold. Build green. Typecheck clean.
SSE + Stripe proxy + Witness client all wired against the live witness
server at :5799 (smoke-tested end-to-end in WO-20: 3 iterations
witnessed, project locked, merkle root + signature returned).

## Routes shipped
| Route | Purpose |
|---|---|
| `/` | Project list (sidebar) + empty workspace |
| `/login` | Google OAuth (when env set) |
| `/projects/new` | Create-project form |
| `/projects/[id]` | Workspace: header + stats + iteration grid + lock buttons |
| `/receipt/[scrId]` | Public provenance receipt |
| `/settings` | Account + provider keys (encrypted) + witness URL |
| `/api/iterations` (POST) | Ingestion endpoint — hash + persist + telemetry |
| `/api/iterations/stream` (SSE) | Live iteration updates while tracking |
| `/api/artifact/[hash]` (GET) | Content-addressed image serving |
| `/api/lock/local` (POST) | Local lock — Merkle, SCR-ID, status flip |
| `/api/lock/checkpoint` (POST) | Soft lock — preserves capture |
| `/api/lock/chain` (POST) | Chain lock via witness server |
| `/api/verify` (POST) | Verify lock-package manifest |
| `/api/projects/[id]/export` (GET) | ZIP export (manifest + merkle + artifacts) |
| `/api/stripe/{config,payment-intent}` | Proxies to witness Stripe |
| `/api/telemetry/spend` (GET) | Monthly per-user spend rollup |
| `/api/auth/[...nextauth]` | NextAuth handlers |

## DB state
- 3 migrations applied: 001_core (6 desktop tables + user_id),
  002_auth (NextAuth: users/accounts/sessions/verification_tokens),
  003_telemetry
- Seed script available: `npm run db:seed` creates demo user
  `demo@scruple.local` + project "Demo — Hero image batch" with 5
  synthetic iterations

## Known gaps for tomorrow's debug pass
- **Google OAuth not wired**: `/login` shows a config notice when
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are unset. To actually
  sign in: register a Google OAuth app with redirect URI
  `http://localhost:3001/api/auth/callback/google`, set env, restart.
- **fal.ai key + ComfyDeploy key**: needed before generation works
  end-to-end. Flows are wired but adapters throw `auth` errors without
  keys. /settings has the input forms.
- **Stripe**: chain-lock will surface witness-server's Stripe error if
  `STRIPE_SECRET_KEY` isn't set on the witness server. Set
  `LOCK_REQUIRE_PAYMENT=0` (default) to bypass payment gating during
  testing.
- **No actual /api/generate**: the pipeline exists, but there's no
  in-app "Generate image" button yet — that's not in the 30 WOs.
  Iteration ingestion can be exercised via direct POST to
  `/api/iterations` with base64 image bytes.

## To boot tomorrow
```
cd /data/scruple-web
AUTH_SECRET=$(openssl rand -base64 32) npm run dev    # → :3001
```

Sign in flow needs Google OAuth env first; see HANDOFF.md.
