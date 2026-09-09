// What a DEPLOYMENT can do — the second half of canon D-7.
//
// `lib/v2/capabilities.ts` answers "which modalities apply to this host and
// this media type". This answers the question one level up: "which REGIONS of
// the dashboard apply to the deployment the client is running inside".
//
// The reason it belongs on the same endpoint is the sentence that endpoint was
// built on: "applicability is not secret, and a client should be able to render
// its UI before the user has signed in". Which regions exist is applicability.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL (scruple-desktop/docs/DESIGN.md, "Decisions already
// settled — do not re-litigate")
// ---------------------------------------------------------------------------
//
//   "One UI, served. The dashboard is one Next application. Web Studio serves
//    it directly; Desktop Studio hosts the same routes in a BrowserWindow."
//
//   "Capability, not code, is what differs. Desktop reports local ComfyUI/Kohya,
//    the vault and the wallet; web reports Modal and RunPod. Same components."
//
// So there is exactly one /studio route, and the shape of what it draws is a
// server answer rather than a fork in the component tree.
//
// ---------------------------------------------------------------------------
// ⚑ ABSENT, NOT EMPTY
// ---------------------------------------------------------------------------
//
// A region that does not apply is not rendered — no node, no heading, no
// placeholder. `reason` is still populated for it HERE, because the API's job
// is to give a complete and honest answer; the dashboard's job is to draw only
// what applies. Those are different jobs and this file does the first one.
//
// That asymmetry is the opposite of `capabilities.ts`, where the unavailable
// modalities are deliberately SHOWN with their reasons. The difference is what
// the two are about: a modality that does not apply is information about the
// user's file ("CAD has no pixels to watermark"), and a region that does not
// apply is information about the software ("this build has no cloud compute").
// The first helps a user decide. The second is chrome for a thing they cannot
// have, and drawing it greyed-out is how a dashboard ends up advertising a
// product the deployment does not contain.
//
// ---------------------------------------------------------------------------
// WHAT THE SERVER KNOWS AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
//
// The server knows the SHAPE of a deployment. It does not know whether ComfyUI
// is installed on someone's laptop, which version, or where its models live —
// only the host process does, over the preload bridge. Every compute entry
// therefore carries `source`:
//
//   'deployment'  the server asserts it: web compute is Modal and RunPod,
//                 because lib/apps/registry.ts says so.
//   'host'        the server asserts only that this deployment ASKS the host;
//                 the values are filled in by window.scruple.profile(), and if
//                 the bridge is absent the region says so rather than guessing.
//
// A dashboard that printed "ComfyUI 0.18.1" because the server told it so would
// be inventing a measurement, which is the failure this whole estate is about.
//
// ---------------------------------------------------------------------------
// ⚑ WO-E5: ONE REGION WHOSE APPLICABILITY IS NOT THE SERVER'S TO KNOW
// ---------------------------------------------------------------------------
//
// Every region above applies because of what the DEPLOYMENT is. `blender` is
// different: whether there is a Blender on the box is a fact about the box, and
// the paragraph above says in as many words that the server does not have it.
//
// So the host announces it, the same way it announces which deployment it is —
// `x-scruple-host-apps: comfyui,blender`, set in scruple-desktop's main process
// on the window's session, measured with `fs.existsSync` at the moment the
// header is built (scruple-desktop/app/ipc-blender.js `installedAppIds()`).
// The server does not guess, does not probe, and does not default:
//
//   announced, contains blender   → the region applies and the HOST fills it
//   announced, does not           → it does not apply. The box has no Blender.
//   not announced at all          → it does not apply, and for a DIFFERENT
//                                   reason: nothing has measured this machine.
//
// The two negatives are one boolean here and two sentences in `reason`, which
// is the same asymmetry `blind` and `declined` hold open one layer down
// (scruple-desktop/docs/HOST-HOOK.md): "never installed" and "not measured"
// have different owners and a UI that read the same for both would send someone
// to the wrong file.
//
// ⚑ AND THE APP IS STILL LISTED. `compute` keeps its Blender entry in all three
// cases, marked unavailable with the reason. STATE.md §0: "a dashboard that
// quietly omitted them would be the failure mode." The REGION is the thing that
// is absent — a panel of readings nobody took — not the fact that this
// deployment is for a local Blender.

import { APPS } from '@/lib/apps/registry';
import type { SessionBackendId } from '@/lib/apps/session-backends';
import {
  verifiedIsRepresentable,
  type CaptureProfile,
} from '@/lib/leaf/attestationBasis';

export const DEPLOYMENT_PROFILES = ['desktop', 'web'] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

export function isDeploymentProfile(v: unknown): v is DeploymentProfile {
  return typeof v === 'string' && (DEPLOYMENT_PROFILES as readonly string[]).includes(v);
}

/**
 * The regions a dashboard can draw. Adding one here and not handling it in
 * `regionsFor` is a type error, which is the point of the exhaustive record.
 */
export const REGION_IDS = [
  'local-apps',       // apps this machine launches, measured by the host
  'capture-gate',     // the gate in the path between a host and ComfyUI
  'vault',            // a directory of files at a moment, hashed as a unit
  'model-store',      // fingerprints computed from the files on this disk
  'blender',          // ⚑ WO-E5. ONLY when the host announced one — see below
  'cloud-compute',    // Modal / RunPod session backends
  'machine-tiers',    // pick a GPU; only meaningful when someone else runs it
  'billing',          // metered compute someone is charged for
  'projects',         // the project list — both shapes have one
  'attestation',      // what basis this deployment's leaves can carry
] as const;
export type RegionId = (typeof REGION_IDS)[number];

export interface Region {
  region: RegionId;
  applies: boolean;
  /** Populated whether it applies or not. See the note above about why the
   *  API says this and the dashboard does not draw it. */
  reason: string;
}

export interface ComputeEntry {
  id: string;
  name: string;
  backend: SessionBackendId;
  /** Who knows this is true — see the header. */
  source: 'deployment' | 'host';
  available: boolean;
  reason: string;
}

/**
 * The local apps a host may announce. Closed, and validated at the route: an
 * id nobody here knows is REFUSED rather than dropped, for the reason `mime`
 * and `profile` are — a silently ignored input is a wrong answer that looks
 * exactly like a right one.
 */
export const HOST_APP_IDS = ['comfyui', 'kohya', 'blender'] as const;
export type HostAppId = (typeof HOST_APP_IDS)[number];

export function isHostAppId(v: unknown): v is HostAppId {
  return typeof v === 'string' && (HOST_APP_IDS as readonly string[]).includes(v);
}

/** What the host announced about itself, or `null` when it announced nothing.
 *  An empty array is an announcement: "I looked, and there is nothing." */
export type HostAppAnnouncement = readonly HostAppId[] | null;

export interface DeploymentCapabilities {
  profile: DeploymentProfile;
  /** The capture profile a leaf written by this deployment carries. */
  capture_profile: CaptureProfile;
  regions: Region[];
  compute: ComputeEntry[];
  attestation: {
    verified_representable: boolean;
    reason: string;
  };
  /** Facts this answer deliberately does not contain, and who has them. */
  host_facts: 'required' | 'none';
  /** ⚑ WO-E5. What the host said it has, whether this answer used it, and why.
   *  Present on both profiles: a web deployment that was handed an
   *  announcement records that it ignored one rather than ignoring it
   *  silently. */
  host_apps: {
    announced: HostAppId[] | null;
    honoured: boolean;
    reason: string;
  };
}

/** The capture profile each deployment shape writes leaves under. */
const CAPTURE_PROFILE: Record<DeploymentProfile, CaptureProfile> = {
  desktop: 'desktop',
  web: 'server-managed',
};

function desktopCompute(announced: HostAppAnnouncement): ComputeEntry[] {
  const has = (id: HostAppId) => announced !== null && announced.includes(id);
  return [
    {
      id: 'comfyui',
      name: 'ComfyUI',
      backend: 'local',
      source: 'host',
      available: true,
      reason:
        'Launched by the desktop app with the capture gate in front of it, so the ' +
        'binary, the version and the model directory are known rather than reported.',
    },
    {
      id: 'kohya',
      name: 'Kohya',
      backend: 'local',
      source: 'host',
      available: false,
      reason:
        'The legacy training IPC handler has not been rewritten onto the SDK yet. ' +
        'Shown because a local Kohya is what this deployment is FOR; marked ' +
        'unavailable because claiming it before the handler exists would be a lie ' +
        'the UI told on the backend’s behalf.',
    },
    {
      id: 'blender',
      name: 'Blender',
      backend: 'local',
      source: 'host',
      // ⚑ WO-E5. This entry is ALWAYS here — the app is what this deployment
      // is for, and omitting it when the box has none would hide the answer
      // rather than give it. What changes is `available` and, more usefully,
      // the reason, which distinguishes "the host looked and found none" from
      // "nothing has looked".
      available: has('blender'),
      reason: has('blender')
        ? 'Announced by the host on this request. The version comes from the running ' +
          'binary, the addon’s enabled state from the Blender that loaded it, and a ' +
          'bridge’s address from that bridge’s own preferences — all of them readings ' +
          'the host takes, none of them values this answer supplies.'
        : announced !== null
          ? 'The host announced its local apps on this request and no Blender was among ' +
            'them. Listed because a local Blender is what this deployment is FOR; ' +
            'unavailable because this machine has none where the app looks.'
          : 'No host announcement on this request, so nothing has measured this machine. ' +
            'Unavailable is what an UNMEASURED app is here — it is not a claim that no ' +
            'Blender is installed, which is a reading only the host can take.',
    },
  ];
}

function webCompute(): ComputeEntry[] {
  // NOT A SECOND LIST. lib/apps/registry.ts is the studio app catalog the left
  // nav and the app-router pages are already driven from, including its
  // `enabled` flag — which is false for RunPod-hosted apps until RUNPOD_API_KEY
  // is set. A deployment with no RunPod key reporting RunPod would be this
  // function inventing capacity the box does not have.
  return APPS.map((a) => ({
    id: a.id,
    name: a.name,
    backend: a.backend,
    source: 'deployment' as const,
    available: a.enabled,
    reason: a.enabled
      ? `${a.tagline} — spawned on ${a.backend === 'local' ? 'the user’s own machine' : a.backend}.`
      : `${a.name} runs on ${a.backend}, and this deployment has no ${a.backend} credential configured.`,
  }));
}

export function computeFor(
  profile: DeploymentProfile,
  announced: HostAppAnnouncement = null,
): ComputeEntry[] {
  return profile === 'desktop' ? desktopCompute(announced) : webCompute();
}

export function deploymentCapabilities(
  profile: DeploymentProfile,
  hostApps: HostAppAnnouncement = null,
): DeploymentCapabilities {
  const desktop = profile === 'desktop';
  // A served deployment has no host, so an announcement made to one is
  // RECORDED AND NOT USED. Ignoring it silently would be the same defect as
  // coercing a typo'd profile: the answer would look identical to one where
  // nothing was announced at all.
  const announced: HostAppAnnouncement = desktop ? hostApps : null;
  const hasApp = (id: HostAppId) => announced !== null && announced.includes(id);
  const compute = computeFor(profile, announced);

  // `enforcement` is 'none' for a server-managed deployment until a placement
  // says otherwise; this reports what a leaf written RIGHT NOW would be able to
  // carry, not the best case some placement could reach.
  const captureProfile = CAPTURE_PROFILE[profile];
  const verified = verifiedIsRepresentable(captureProfile, 'none');

  const regions: Record<RegionId, Region> = {
    'local-apps': {
      region: 'local-apps',
      applies: desktop,
      reason: desktop
        ? 'This deployment launches the creative apps itself, so it knows the binary and the version.'
        : 'A served deployment never launches anything on the user’s machine; it has no binary to measure.',
    },
    'capture-gate': {
      region: 'capture-gate',
      applies: desktop,
      reason: desktop
        ? 'The gate sits between the host and ComfyUI on this machine and is the only route to the tenant.'
        : 'The gate runs beside the workload in the cloud, not in front of anything the browser can see.',
    },
    vault: {
      region: 'vault',
      applies: desktop,
      reason: desktop
        ? 'A directory of files at a moment, hashed as a unit — a server-side gate structurally cannot do this, because a gate observes a wire and never sees a directory.'
        : 'The server sees uploads, not directories. There is no vault to hash from here.',
    },
    'model-store': {
      region: 'model-store',
      applies: desktop,
      reason: desktop
        ? 'Fingerprints computed from the files in the local model store — the only way to answer “was a proprietary LoRA used” rather than “a file with that name was referenced”.'
        : 'Models live in the container the workflow runs in; the fingerprints come off that box, not off this one.',
    },
    // ⚑ WO-E5. THE ONE REGION THAT IS NOT THE SERVER'S TO DECIDE. See the
    // header. `applies` follows the host's announcement and nothing else; the
    // two ways it can be false are one boolean and two different sentences.
    blender: {
      region: 'blender',
      applies: desktop && hasApp('blender'),
      reason: !desktop
        ? 'A served deployment never launches Blender on the user’s machine, so there is no binary to read a version out of and no addon to ask.'
        : hasApp('blender')
          ? 'The host announced a Blender on this machine. What version it is, whether the Scruple addon is enabled and where a bridge is pointed are readings the HOST takes — this answer only says the region has something to draw.'
          : announced !== null
            ? 'The host announced its local apps on this request and Blender was not among them. There is nothing on this machine for the region to report, and a Blender panel here would be chrome for a thing the box does not have.'
            : 'Nothing announced its local apps on this request. The server cannot know whether a Blender is installed and will not draw a region for one it has not been told about — which is a different fact from having been told there is none.',
    },
    'cloud-compute': {
      region: 'cloud-compute',
      applies: !desktop,
      reason: desktop
        ? 'Compute is local here. Rendering a session-backend picker in an app whose whole claim is that it runs on your machine would be advertising something this build does not contain.'
        : `Sessions spawn on ${[...new Set(APPS.filter((a) => a.backend !== 'local').map((a) => a.backend))].join(' and ')}.`,
    },
    'machine-tiers': {
      region: 'machine-tiers',
      applies: !desktop,
      reason: desktop
        ? 'You already picked your GPU when you bought it.'
        : 'A tier decides what is spawned and what it costs per hour.',
    },
    billing: {
      region: 'billing',
      applies: !desktop,
      reason: desktop
        ? 'Nothing here is metered: the compute is the user’s own. Signing is billed against the account, and that lives in Settings on both shapes.'
        : 'Session compute is pre-authorised and captured per hour.',
    },
    projects: {
      region: 'projects',
      applies: true,
      reason: 'A project is a server object. Both shapes read the same rows through the same API.',
    },
    attestation: {
      region: 'attestation',
      applies: true,
      reason: 'What basis a leaf written by this deployment can carry — shown on both shapes because the answer differs between them.',
    },
  };

  return {
    profile,
    capture_profile: captureProfile,
    regions: REGION_IDS.map((id) => regions[id]),
    compute,
    attestation: {
      verified_representable: verified,
      reason: verified
        ? 'A root-chained quote that binds to this emission can be represented here.'
        : desktop
          ? '⛑ `verified` is unreachable on the desktop profile by construction, not by likelihood: the type refuses it, the resolver refuses it, and migration 053 refuses it at the database. On a box where the measured party has root, a PCR attests what booted, not what happened after.'
          : 'This deployment has no placement enforcement configured, so a leaf it writes cannot claim `verified` today.',
    },
    host_facts: desktop ? 'required' : 'none',
    host_apps: {
      announced: hostApps === null ? null : [...hostApps],
      honoured: desktop && hostApps !== null,
      reason: !desktop
        ? hostApps === null
          ? 'A served deployment has no host to have apps, and none was announced.'
          : 'An announcement was made to a served deployment and was NOT used. Recorded rather than dropped: an ignored input that left no trace would make this answer indistinguishable from one where nothing was announced.'
        : hostApps === null
          ? 'Nothing announced its local apps on this request. Regions that depend on a reading of this machine do not apply, because no reading was offered.'
          : 'The host announced its local apps on this request and this answer used them.',
    },
  };
}

/** Only the regions a dashboard may draw. The absent ones are not "hidden" —
 *  they are not in this list at all, and the renderer has nothing to iterate. */
export function applicableRegions(caps: DeploymentCapabilities): Region[] {
  return caps.regions.filter((r) => r.applies);
}
