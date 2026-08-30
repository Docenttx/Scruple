// H-4 server side: BDK custody, submission verification, provisioning.
//
// SPLIT FROM `./index` DELIBERATELY (WO-6). `bdk()` reads
// SCRUPLE_BDK_HEX and calls process.exit(1) when it is absent — correct
// for a server that must fail closed, and exactly wrong to have one
// import away from a capture component, which by §4.1 never holds the
// BDK at all. `./index` therefore carries the key schedule alone and
// this module carries everything that needs the root key.
//
// If you are writing component-side code and you reached for this file,
// that is the boundary working.

export * from './ratchet';
export * from './bdk';
export * from './verify';
export * from './provisioning';
