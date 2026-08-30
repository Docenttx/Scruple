// H-4: the forward-secure per-event key ratchet.
// docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md §4.
//
// THIS BARREL IS COMPONENT-SAFE. It re-exports the key schedule and
// nothing else, so a capture component can `import { Ratchet } from
// '@/lib/ratchet'` without pulling `bdk()` into its module graph.
//
// That matters because §4.1 is explicit that "the component never holds
// BDK", and until WO-6 this file re-exported `./bdk`, which put a
// process-exiting BDK loader one import away from code whose whole
// design property is not having one. Nothing imported the barrel, so the
// split cost nothing — but "nothing imports it yet" is not a boundary.
//
// The server half — BDK custody, submission verification, provisioning —
// is `@/lib/ratchet/server`. Importing it from a component is a mistake
// the import path now has to spell out.

export * from './ratchet';
