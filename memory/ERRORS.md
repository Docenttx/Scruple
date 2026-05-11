# Errors and Resolutions — Scruple Web

(empty — populated as WOs execute)

## [2026-05-11T22:50:00Z] testnet RPC port mismatch
Error: ravend-testnet config has rpcport=18766 but `ss -tlnp` shows it listening on 18770
Context: WO-42 RVN RPC client construction; needed to know which port to hit
Resolution: Used config value 18766 in lib/scruple/ravend.ts as the default. If
mainnet works and testnet doesn't, investigate config drift (maybe a service
override). The runtime fallback in ravend.ts uses 18766 — flip to 18770 if
needed without touching service config.
