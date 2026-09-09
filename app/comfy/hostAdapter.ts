// THE HOST HOOK, DESKTOP SIDE — Level 1 is free, Level 2 is a declaration and
// an announcement.
//
// WO-D6. docs/DESIGN.md states the shape and this file is the whole of it on
// our side of the seam:
//
//   LEVEL 1  a host points its ComfyUI address at our gate. THAT IS THE ENTIRE
//            INTEGRATION. No file here runs, nothing is registered, and the
//            leaf declares `host_semantics: "blind"` because the SDK's leaf
//            builder defaults to it. Costs the host nothing, costs us nothing,
//            and produces a record that is honest about what it does not know.
//
//   LEVEL 2  the host drops a DECLARATION where the app told it to, and an
//            ANNOUNCEMENT per generation. This file validates the first
//            through `registerHost()` and reads the second in `semanticsFor`.
//
// ---------------------------------------------------------------------------
// WHY A DIRECTORY AND NOT A PORT, A HEADER OR AN RPC
// ---------------------------------------------------------------------------
//
// The SDK's contract is `semanticsFor(observation) -> manifest | null` and it
// takes NO VIEW on transport — deliberately, because transport is the one
// thing that differs between a Blender add-on, a Photoshop UXP panel and a
// ToonBoom script, and a contract that picked one would have to be reopened
// for the second host. This adapter picks a directory because it is the only
// mechanism every one of those can use today without us shipping them a
// library: `open(path, 'w')` exists in every host's scripting runtime, needs
// no port, no auth and no dependency, and survives the host and the app
// starting in either order.
//
// A different adapter may pick something else. That is the point of the level
// being a property of the ADAPTER rather than of the gate.
//
// ---------------------------------------------------------------------------
// THE CORRELATION IS THE PROMPT ID, AND THE HOST CHOOSES IT
// ---------------------------------------------------------------------------
//
// ComfyUI's `server.py` does `prompt_id = str(json_data.get("prompt_id",
// uuid.uuid4()))` — a client MAY supply its own. So a Level-2 host mints an
// id, writes `announce/<id>.json`, and POSTs `/prompt` with that id. The gate
// correlates outputs to prompts by exactly that id already
// (`Correlator.openPrompt`), so the announcement and the observation meet with
// no new plumbing anywhere in the SDK.
//
// ⚑ AND CHOOSING THE ID GRANTS NOTHING. The announcement directory is named by
// the app's environment and is not reachable from a workflow; an id nobody
// announced reads back as `declined`, and an announcement that does not match
// the host's OWN declared schema reads back as `declined` too. The worst a
// wrong id can do is make a leaf say less than it could have.
//
// ---------------------------------------------------------------------------
// A BAD DECLARATION IS A REFUSAL THAT IS RECORDED, NOT A CRASH
// ---------------------------------------------------------------------------
//
// If a host drops a declaration we will not accept — an unversioned evidence
// type, a schema that requires nothing, an `attestation` it tried to grade
// itself with — the answer is NOT to take ComfyUI down, and it is not to
// accept it either. The adapter is refused, the run continues AT LEVEL 1, and
// the refusal is written into the gate's result file with its code. WO-D3's
// rule, one surface over: a refusal is a fact, not a silence.

import fs from 'node:fs';
import path from 'node:path';

import {
  HostRegistrationError,
  registerHost,
  type CaptureObservation,
  type HostAdapter,
  type HostRegistration,
} from './sdk';

/** What a host writes at `<hostDir>/scruple-host.json` to declare itself. */
export const DECLARATION_FILE = 'scruple-host.json';
/** ...and `<hostDir>/announce/<prompt_id>.json` per generation. */
export const ANNOUNCE_DIR = 'announce';

export interface HostRegistrationOutcome {
  hostDir: string;
  /** Present when a declaration was found AND accepted. */
  registered: {
    host: string;
    hostVersion: string;
    adapter: string;
    adapterVersion: string;
    evidenceType: string;
    required: string[];
    /** DERIVED, not declared — what `assuranceForHost` made of the placement
     *  the host claimed. A host declaring `attested-client` with nothing
     *  enforcing it lands on `unattested-client` here, and the leaf is graded
     *  on this rather than on the claim. */
    declaredPlacement: string;
    effectivePlacement: string;
  } | null;
  /** Present when a declaration was found and REFUSED. Never both. */
  refused: { code: string; message: string } | null;
  /** 1 when no adapter is in the path — for any reason, including a refusal. */
  level: 1 | 2;
  reason: string;
}

/**
 * Read and validate a host's self-declaration.
 *
 * Returns an outcome in every case and throws in none: a missing directory is
 * Level 1 ("no host declared itself"), a malformed declaration is Level 1 with
 * a recorded refusal, and only a declaration that passes `registerHost()`
 * produces an adapter.
 */
export function openHostDeclaration(hostDir: string | null): {
  outcome: HostRegistrationOutcome;
  adapter: HostAdapter | null;
} {
  const dir = hostDir ?? '';
  const none = (reason: string, refused: HostRegistrationOutcome['refused'] = null) => ({
    outcome: { hostDir: dir, registered: null, refused, level: 1 as const, reason },
    adapter: null,
  });

  if (!dir) return none('no host directory is configured — Level 1 by construction');
  const declPath = path.join(dir, DECLARATION_FILE);
  if (!fs.existsSync(declPath)) {
    return none(`no ${DECLARATION_FILE} in ${dir} — no host declared itself`);
  }

  let declared: HostRegistration;
  try {
    declared = JSON.parse(fs.readFileSync(declPath, 'utf8')) as HostRegistration;
  } catch (e) {
    return none(`${DECLARATION_FILE} is not JSON`, {
      code: 'declaration_unparseable',
      message: String((e as Error).message ?? e),
    });
  }

  let entry;
  try {
    entry = registerHost(declared);
  } catch (e) {
    // REFUSED, AND THE RUN CONTINUES AT LEVEL 1. See the header: a
    // third-party add-on with a bad manifest must not be able to stop a
    // tenant's ComfyUI, and must not be able to get its meaning onto a leaf
    // either. Both halves matter and this is the only outcome that has both.
    const code = e instanceof HostRegistrationError ? e.code : 'declaration_refused';
    return none(`host declaration refused (${code})`, {
      code,
      message: String((e as Error).message ?? e),
    });
  }

  const reg = entry.registration;
  const announceDir = path.join(dir, ANNOUNCE_DIR);

  const adapter: HostAdapter = {
    registration: reg,
    /**
     * THE WHOLE OF WHAT A HOST IMPLEMENTS. A pure read, keyed by the
     * correlation the gate already has.
     *
     * It does not: touch the inner sink (it is never handed one), open a
     * socket, decide a MIME, compute a MAC or spend a counter. It cannot —
     * `hostAdapterSink` holds the composition — and that structural inability
     * is what CANON_SKELETON.md §5's adapter rule asks for.
     */
    async semanticsFor(o: CaptureObservation): Promise<Record<string, unknown> | null> {
      if (!o.correlationId) return null;
      // Basename only. A correlation id is attacker-influenced (the host
      // chooses it) and `announce/../../etc/passwd.json` is a path this must
      // not be able to name.
      const safe = path.basename(String(o.correlationId));
      const p = path.join(announceDir, `${safe}.json`);
      if (!fs.existsSync(p)) return null;
      const doc = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      // Returned verbatim. Filling a missing field with a plausible default
      // is the defect this whole series refuses; the SDK checks the document
      // against the host's OWN declared schema and records `declined` if it
      // is short, which is the honest outcome rather than a repaired one.
      return doc;
    },
  };

  return {
    outcome: {
      hostDir: dir,
      registered: {
        host: reg.host,
        hostVersion: reg.hostVersion,
        adapter: reg.adapter,
        adapterVersion: reg.adapterVersion,
        evidenceType: reg.evidenceType,
        required: [...reg.schema.required],
        declaredPlacement: entry.assurance.resolution.declared,
        effectivePlacement: entry.assurance.resolution.effective,
      },
      refused: null,
      level: 2,
      reason: `${reg.host}@${reg.hostVersion} registered adapter ${reg.adapter}@${reg.adapterVersion}`,
    },
    adapter,
  };
}
