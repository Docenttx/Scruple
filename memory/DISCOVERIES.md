# Discoveries — Scruple Web

Categories: COST | PROMPT | SCHEMA | BEHAVIOR | PERF | QUALITY

(empty — populated as WOs execute)
[2026-05-11T22:50:00Z] BEHAVIOR | ravend-mainnet listens on :8766 for RPC (matches config) but ravend-testnet config says rpcport=18766 while actual listen is 18770 | testnet client should use 18770 or align config
[2026-05-11T22:55:00Z] SCHEMA | scruple-witness server's /api/stripe-config + /api/tsd/{balance,fund} both respond 200 from inside-LAN; suitable to proxy through scruple-web's /api/wallet/tsd | confirmed live wiring
[2026-05-11T23:10:00Z] BEHAVIOR | mainnet ravend RPC default = scruple/scruplerpc2026main (per .raven-mainnet/raven.conf); testnet = scruple/scruplerpc2026 | both written into lib/scruple/ravend.ts via raven.conf parser
[2026-05-11T23:20:00Z] QUALITY | ravend wallet.dat is single per-instance; web port needs either multi-wallet (createwallet named "scruple_user_<id>") or non-custodial browser-stored seed. D-012 logged | wallet handler wiring deferred until storage architecture is chosen
