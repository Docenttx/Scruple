# Scruple Desktop Studio — recon against the L2 standard

_2026-09-09. Founder direction: the Electron app becomes **Scruple Desktop
Studio**, the dashboard for all local Scruple work — for applications that have
no locked file history, no input tracking, no provenance of their own. Recon
before a Blender tab is added._

## What is actually there

`research/electron-source/` — 1.5 MB, 84 JS files, `scruple-studio` **v3.0.0**,
Electron entry `main-modular.js`. Dependencies include `@ravenrebels/
ravencoin-jswallet`, `arweave`, `better-sqlite3`, `bip32`, `bip39`, `bs58` — so
this app carries **its own wallet**, not just a witness client.

⚑ The tree is **duplicated**: `lock/merkle.js` and `lock/lock-local-lock.js`
are byte-identical to their copies under `scruple-studio/scruple-studio/`.
Whatever is revived, one of the two has to go first, or every later fix lands
in one copy.

## The one thing worth keeping — the vault model

`lock/lock-local-lock.js` is the part the founder remembered as "filesystem
hashing that should still work," and the memory is right about its value:

    readdirSync(vaultPath)            enumerate a vault directory
    statSync(filePath)                per file
    readFileSync + sha256             hashMethod = 'sha256_full'
    provenance.json hashed separately
    merkle over the set → local lock

That is **a set of files at a moment, hashed wholesale** — and it is exactly
what the sidecar structurally *cannot* do. The capture component observes a
wire; it never sees a directory. For a host with no internal history of its
own, "what was in this folder, and what did it hash to" is the only honest
question available, and this is the code that asks it.

**Keep the model. Do not port the code.** Everything around it is pre-v1.

## What is stale — and it is more than "some"

**1. The endpoints are not v1. They are v0.**
The only server routes in the whole tree are `/api/fiat-chain-lock`,
`/api/testnet-lock` and `/api/v0/add`. Not one `/api/v2/*` route, and not even
the `/api/lock/*` surface the Blender add-on was using before WO-B3. This is
further behind than the add-on was at its worst.

**2. Its Merkle is the sorted-pair construction — again.**
`lock/merkle.js:108`: `const combined = left < right ? left + right : right + left`.
That is byte-for-byte the same construction as `lib/scruple/merkle.ts`, and it
carries the same two defects: **no domain separation**, and **it cannot bind an
index**, because pair order comes from hash value rather than position.

⚑ **This enlarges the cutover.** The council was told there are three
constructions across three files. There are three constructions across **five
files** — the sorted-pair one also lives here, twice, because of the duplicated
tree. WO-C6's plan must enumerate call sites, not just implementations.

**3. There is no MIME anywhere in `lock/`.** Zero occurrences. Instead the
hasher branches on **file extension** — `.toml`, `.json`, `.safetensors` — which
is `guess the type from the name`, the precise practice WO-B2 removed from the
Blender add-on in favour of *declared, never guessed*. Extension-branching is
the same defect wearing a different shape.

**4. `readFileSync` with no size guard**, including on the `.safetensors`
branch. Model files are gigabytes; this reads them whole into memory. It is the
same failure the council spent two rounds on for the gate, and here it has no
counter, no ceiling and no refusal path.

**5. It predates every L2 concept.** No leaf scheme, no attestation basis, no
measurement honesty states, no canonicalization profile, no ratchet or counter,
no component identity, no `declared_uncaptured`. None of these existed when the
fork to web studio happened.

## The wallet is a separate review, and it should happen before revival

**21 files touch private keys, mnemonics, seed phrases or WIF**, and there is a
`wallet/` tree with Ravencoin and ElectrumX clients. An Electron app holding
spending keys is a different security posture from a capture gate holding a
signing key, and it should be assessed on its own terms rather than inherited
because it was already in the box.

## Verdict

Not "stale in places" — **pre-v1 throughout, with one good idea inside it.**
The vault model is genuinely complementary to the sidecar and is the right
primitive for hosts with no history of their own. Extract it; rebuild it on the
current SDK, the current leaf, the current basis; delete the rest rather than
updating it.

That also settles the sequencing the founder asked about: a Blender tab should
not be added to this app as it stands. The app has to reach the floor the
add-on already reached, or the tab would be a regression from the add-on that
exists today.

## Ordered next steps

1. **De-duplicate the tree.** One copy, or every fix lands in the wrong one.
2. **Extract the vault model** as a capture surface on the current SDK — the
   `ObservationSink` contract, declared MIME, a size ceiling with a refusal
   outcome, and the three honesty states.
3. **Fold `lock/merkle.js` into WO-C6's cutover** as two more call sites of the
   construction being retired.
4. **Move the app onto `/api/v2/*`** — witness, receipt, resolve — and onto the
   attestation basis, which on a desktop means `stale`/`passthrough` and never
   `verified`.
5. **Review the wallet separately** before any of it is revived.
6. **Only then, the Blender tab.**
