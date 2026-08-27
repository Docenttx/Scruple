# Witness server

The Node service that seals witness leaves. Runs at `:5799`, deployed to
`/opt/scruple-witness/`, managed by systemd as `scruple-witness`.

**Until 2026-08-26 this code was not in version control.** It was edited
in place on the box under a convention of saving `server.js.bak.<unix_ts>`
beside each change. Eleven such files existed; they are preserved under
`history/` because they were the only record of how this service evolved.

## Why it was brought in (H-3)

Standard §3 says a baseline covers "the code, configuration, and attested
compute environment" of an integration, and §4 says silent modification
must be cryptographically impossible.

The witness server computes everyone else's baseline. It could not be
measured itself, which made the component that decides what counts as
unmodified the one component nothing could check. That is circular, and
§3 does not allow it.

See `../../docs/canon/L2_FLOOR.md` for where this sits in the wider
harmonization.

## Measuring it

```
node tamper-surface.mjs              # hash the tracked source
node tamper-surface.mjs --json       # machine-readable
node check-deployment.mjs            # does /opt match this source?
node --test tests/                   # 8 tests
```

`check-deployment.mjs` exits 0 on match, 1 on drift, 2 if it cannot tell.
**Run it before trusting a baseline.** Putting code in git does not make
a deployment track it, and this directory has a long history of being
edited in place.

### What the tamper-surface hash covers

Six files, by content, listed explicitly in `tamper-surface.mjs`. It is a
list rather than a directory walk on purpose: adding a file should change
the hash for a reason someone can name, not because a glob widened.

### What it does not cover

`node_modules` (pinned by `package-lock.json`, not hashed), the Node
runtime, the OS, the systemd unit, its environment, or the machine. **A
matching hash means the source is what we think it is. It does not mean
the server is trustworthy.** Do not let it be read as the stronger claim.

## Secrets

Everything comes from the environment; nothing is hardcoded. Three things
about that are worth knowing:

1. `SCRUPLE_WITNESS_SECRET` used to fall back to the literal
   `'dev-secret-replace-in-production'` when unset — silently. A leaf
   sealed with a constant published in the source is forgeable by anyone
   who has read it, and the seal still verifies perfectly, against a key
   everybody has. It now **fails closed**: no secret, no start. Set
   `SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1` to accept a forgeable seal
   deliberately, in development.

2. The deployed unit passes secrets with `Environment=` directly in the
   unit file, which `systemctl show scruple-witness` will print **to any
   unprivileged user on the host**. They belong in an `EnvironmentFile`
   owned by root with mode 0600.

3. `/opt/scruple-witness/arweave-key.json` is a live wallet key with mode
   0664 — world-readable on a shared host. It is `.gitignore`d here and
   its permissions want fixing where it lives.

## What is deliberately not committed

`node_modules/`, `witness.db*` (the actual signed leaves),
`arweave-key.json`, `arlocal-data/`. See `.gitignore`.

## The assurance gap this does not close

This service seals leaves with a **symmetric HMAC**, on the same host as
the web application. The C2PA signer, by contrast, uses an ECDSA key in a
PKCS#11 HSM inside an attested SEV-SNP CVM. Tracking the code makes it
measurable; it does not make the seal any stronger. Moving leaf signing
into the attested signer is **H-1**, and it is the load-bearing item.
