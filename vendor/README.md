# vendor/

`scruple-web` is a **symlink** to the server repo, not a copy.

The Blender addon vendored `scruple_host_sdk` by copying it into its zip, for a
reason that does not apply here: a Blender addon cannot `pip install`, so `cp -r`
had to be a valid install. Electron has no such constraint, and a copy would
acquire the one property the addon's own gap report flagged — two
implementations of one contract, with ours the untested twin.

So the desktop repo POINTS at the SDK. `app/vault/sdk.ts` is the only file that
names a path through here; everything else imports from that barrel. What that
buys, concretely:

  * `services/scruple-capture/src/submitter.ts` — the `ObservationSink` every
    surface emits into — is the one the ComfyUI component ships, not a rewrite.
  * `lib/ratchet/ratchet.ts` is the one whose vectors the server checks against
    the Python half.
  * `lib/leaf/attestationBasis.ts` decides the basis. A desktop surface CANNOT
    emit `verified`; that is enforced in the type, the resolver and the wire
    validator, and none of the three is ours to weaken.

The link is followed at runtime (Node resolves realpaths), so relative imports
inside the server repo continue to resolve inside the server repo. Nothing in
this repo writes through it.
