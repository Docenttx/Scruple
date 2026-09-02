// The component's own file set — ONE list, two consumers.
//
// WO-35 option 2 (public GPU base + dockerStartCmd) needs the component
// delivered over HTTP at pod boot, because there is no image to bake it into.
// That delivery must ship exactly what `Dockerfile.jobapi` COPYs, or the two
// paths run different code while claiming the same placement.
//
// So the list lives here and both read it. `test/v2/training-receipt.test.ts`
// asserts it equals the entrypoint's transitive import closure — the same
// guard that already covers the Dockerfile, pointed at this array too.
//
// NAMED FILES, NOT THE DIRECTORIES THEY LIVE IN, for `lib/ratchet` and
// `lib/leaf`. Dockerfile.jobapi carries the argument and it is a security
// property, not tidiness: `lib/ratchet/` also holds `provisioning.ts` and
// `verify.ts` — the SERVER-SIDE ratchet, which reads the BDK and the
// components table — and `lib/leaf/` holds the registry and the server's
// `componentPreimage`. Shipping either directory whole would put the party
// that ISSUES identities inside the container that merely HOLDS one.
export const COMPONENT_TREES: readonly string[] = [
  'services/scruple-capture',
  'lib/apps/kohya',
  'lib/capture',
];

export const COMPONENT_FILES: readonly string[] = [
  'lib/ratchet/ratchet.ts',
  'lib/leaf/hashes.ts',
  'lib/leaf/canonicalJson.ts',
  'lib/scruple/hash.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

/** Everything the pod receives, trees first. Stable order: the tarball's
 *  digest is quoted in the template's boot script, so member order must not
 *  depend on a filesystem walk. */
export const COMPONENT_PAYLOAD: readonly string[] = [...COMPONENT_TREES, ...COMPONENT_FILES];
