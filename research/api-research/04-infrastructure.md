---
name: Infrastructure — stooges.ai + scruple.ai DNS, hosting, OAuth setup
description: GoDaddy DNS records, Oracle Cloud server, Vercel deployment, Google OAuth configuration for stooges.ai and scruple.ai
type: reference
---

## Domain: scruple.ai (registered, owned)
- Dedicated home for Scruple Studio Web (standalone product, not a Stooges feature)
- scruple.ai = "Prove you made it" — witness studio for Replicate/fal.ai/Stability AI
- Conversion CTA on scruple.ai points to stooges.ai and vice versa
- DNS/hosting TBD — same pattern as stooges.ai (Vercel frontend, Oracle backend) likely
- NOT a subdomain of stooges.ai — peer product with independent brand

## Domain: stooges.ai (registered on GoDaddy)

### Cloudflare nameservers (set 2026-04-07)
- amy.ns.cloudflare.com
- keenan.ns.cloudflare.com
(Changed in GoDaddy — awaiting Cloudflare verification)



### DNS Records (GoDaddy)
- `A @ 129.80.23.93 TTL:600` — manually added, points to Oracle Cloud server (this machine)
- Two AWS/Vercel A records (76.223.105.230, 13.248.243.5) — added by Vercel when domain was connected

www.stooges.ai points to same three IPs.

## This server (Oracle Cloud)
- IP: 129.80.23.93
- OS: Ubuntu
- No nginx, no SSL cert on this machine
- Next.js running on port 3000 (dev/API backend)
- Also running: ElectrumX (Ravencoin), IPFS (port 8080)

## Vercel deployment
- Live HTTPS frontend: https://stooges.ai returns 200
- http://stooges.ai redirects to https (Vercel handles SSL termination)
- Vercel is the production frontend; this Oracle server is dev/API backend

## Google OAuth setup
- Had to use **Web application** client type (not Desktop app) — desktop OAuth flow blocked by modern browsers
- Authorized redirect URI: https://stooges.ai/api/auth/callback/google (or similar)
- The A record on GoDaddy was required for Google to accept stooges.ai as a valid domain
- OAuth callback lands on Vercel (HTTPS), not this server directly

## For future OAuth providers (GDrive, OneDrive, GitHub, Box)
- All OAuth redirect URIs must use https://stooges.ai/...
- Web application client type required for all providers
- No localhost or desktop-app OAuth flows in production
