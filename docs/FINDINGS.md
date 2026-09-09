# Findings carried forward

_Things that are true about this build and are not visible from a green gate.
Each is written where the next work order will trip over it. WO-D7 folds these
into `docs/STATE.md`; they are kept separately until then so that "the gate
passed" and "here is what the gate does not cover" stay different sentences._

---

## D4-1 — the capture component claims an isolation this desktop does not have

`CaptureComponent.start` hard-codes `declaredPlacement: 'sidecar-gate'` with
`enforcement: 'isolated-namespace'`, and `resolvePlacement()` honours the pair
by comparing the enforcement **string** against the string the placement
requires. It has to: the SDK runs in containers it cannot introspect.

On this desktop the string is not true. The gate is a child of the Electron
main process — same user, same namespaces, same machine, and the measured party
has root on all of it. `app/comfy/namespace.ts` measures exactly that and the
gate records `isolation.enforcementPresent: false` on its own result, beside
the placement the component declares, so the gap is on the record rather than
in an argument.

**What it does NOT change.** The leaf's basis is `stale` and never `verified`,
so nothing downstream is currently reading this placement as a hardware claim.
**What needs a decision:** `declaredPlacement` should come from configuration
rather than a constant, so a desktop deployment can declare
`unattested-client` / `none` and earn it the way `app/vault/run.ts` already
does. That is a change to the SDK's contract affecting every deployment that
already claims `sidecar-gate`, so it was named here rather than taken in a WO
about fingerprints.

## D4-2 — bypassing the gate does not produce an unwitnessed artifact; it produces a blind one

Measured by the `bypass-the-gate` mutation. A generation sent straight at
ComfyUI leaves the HTTP gate with nothing to see — and the **output volume
watcher catches the file anyway and witnesses it**. H-4 §2's two-surface claim,
happening live.

The leaf that results is honest and thinner: the adapter recorded the
observation as `no-graph`, so there is no workflow hash, no correlation and no
model fingerprints on it. That distinction — a record that says it is blind
versus one that is silently thinner — is WO-D6's Level 1 versus Level 2,
arriving early and by accident.

## D4-3 — the fingerprint is a read of the store, not a hook in the loader

`app/comfy/modelSink.ts` hashes the model files when the **artifact** is
observed, which is after ComfyUI loaded the weights rather than during. A swap
performed between the load and the read would be recorded as the post-swap
bytes. The interval is recorded (`readStartedAt` / `readFinishedAt` on the
gate's own result) and deliberately kept **out** of the manifest, because a
timestamp in the manifest would make `model_fingerprints_hash` unrecomputable
by anyone holding the weights.

Closing it needs the host to report what it opened — a Level-2 adapter, which
is WO-D6's registration.

## D4-4 — the gate is an ingress gate, and ComfyUI's outbound network is not on it

Logged by the component itself at startup as an advisory, repeated here because
it is easy to read a green gate as coverage. `comfy_api_nodes/` ships ~25 node
packs that open sessions to external services from inside the ComfyUI process.
Those bytes leave through neither surface. A desktop deployment cannot deny
egress from a container it does not have.

## D4-5 — a renderer-side stub can fake the whole port ledger

Measured by the `fake-bridge` mutation: every ledger assertion stays green
under it. Claiming "one listener, the right pid, loopback only" costs a stub in
the page nothing. The ledger's worth is that it is a reading of
`/proc/net/tcp` **that a real main process took**, and what establishes that is
`reached-main` plus the artifact, the leaf and the fingerprint — never the
ledger on its own. Same shape as WO-D2's finding about `store-exists`.

## D4-6 — Blender is not in this app

Stated because the design names it and nothing here touches it. WO-D4 launches
ComfyUI. Blender is the next series, and the Level-1 hook it will use is the
one this WO put in the path.
