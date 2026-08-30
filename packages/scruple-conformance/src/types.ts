// The conformance vocabulary. One idea does most of the work here and it is
// worth stating before any of the types:
//
//   A PROBE IS AN ATTACK, AND A CONFORMANT DEPLOYMENT MAKES IT FAIL.
//
// H-4 §7 says it in one line — "Run from inside the tenant container, where
// the adversary sits; each must fail." So every probe below has TWO results
// and they run in opposite directions:
//
//   `outcome`  what happened to the ATTACK: 'blocked' | 'succeeded'
//   `verdict`  what that means for the DEPLOYMENT: 'pass' | 'fail'
//
// blocked → pass. succeeded → fail. Conflating them is how a suite ends up
// reporting a successful exfiltration as a green tick, so the two names never
// appear as one field.
//
// THE THIRD VERDICT IS NOT A PASS. Sonobuoy requires
// `--mode=certified-conformance` precisely because "a valid certification run
// may not skip any conformance tests" (sonobuoy-conformance.md §3). An
// 'inconclusive' probe — one that could not be attempted, or one attempted
// from a vantage that only models the tenant's position rather than occupying
// it — is recorded as inconclusive and counts as NOT PASSED everywhere it is
// aggregated. There is no configuration in which a skip becomes a pass.

/** The eight integration requirements. `docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` §2. */
export const P_ITEMS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] as const;
export type PItem = (typeof P_ITEMS)[number];

/** What happened to the attack the probe made. */
export type AttemptOutcome = 'blocked' | 'succeeded' | 'not-attempted';

/** What that means for the deployment. */
export type ProbeVerdict = 'pass' | 'fail' | 'inconclusive';

export function verdictOf(outcome: AttemptOutcome, admissible: boolean): ProbeVerdict {
  if (outcome === 'not-attempted') return 'inconclusive';
  if (outcome === 'succeeded') return 'fail'; // A successful attack is a failure. Always.
  return admissible ? 'pass' : 'inconclusive';
}

/**
 * Facts a reader can check. Strings, safe integers, booleans and null only —
 * the same refusal H-4 §10 C-1 makes for the MAC preimage, for the same
 * reason: a float in an evidence record does not round-trip identically
 * between the language that wrote it and the language that reads it back.
 */
export type EvidenceValue = string | number | boolean | null;
export type EvidenceRecord = Record<string, EvidenceValue>;

export interface ProbeObservation {
  outcome: AttemptOutcome;
  /** One sentence. What was tried and what came back. */
  detail: string;
  evidence: EvidenceRecord;
}

export interface Probe {
  /** Stable across releases. Never renumbered — a report from 2027 must be
   *  readable against a spec from today. */
  id: string;
  /** Where in the canon this probe comes from. */
  spec: string;
  title: string;
  /** What the tenant is trying to do. */
  attempt: string;
  /** What must be true of a conformant deployment. */
  requirement: string;
  /** Which P-items this probe is evidence for. */
  evidenceFor: readonly PItem[];
  /**
   * TRUE when the probe's answer is a fact about the vendor's network or mount
   * TOPOLOGY rather than about observable behaviour of the capture path.
   *
   * This is the sonobuoy-conformance.md §5.2 split, discovered again from the
   * other end: P1 and P3 are "is this reachable by X" questions, and a process
   * inside the same namespace as X cannot answer them by observation. A
   * topology probe run from a simulated vantage is inconclusive BY
   * CONSTRUCTION, and the runner enforces that rather than trusting the probe
   * to remember.
   */
  topological: boolean;
  run(ctx: ProbeContext): Promise<ProbeObservation>;
}

export interface ProbeResult extends ProbeObservation {
  id: string;
  spec: string;
  title: string;
  attempt: string;
  requirement: string;
  evidenceFor: readonly PItem[];
  topological: boolean;
  verdict: ProbeVerdict;
  /** 'os' | 'simulated' — carried per result, because a run may mix them. */
  vantage: string;
  /** False when the vantage cannot support this probe's claim. */
  admissible: boolean;
  startedAt: string;
  durationMs: number;
}

/**
 * The tenant's position, as a capability set rather than as an assumption.
 *
 * The whole point of H-4 §7 is that the probe runs where the adversary is. A
 * probe that runs somewhere else and reasons about where the adversary would
 * be is a design review, not a test. `TenantVantage` is what makes that
 * difference explicit and reportable instead of implicit and forgettable.
 */
export interface TenantVantage {
  /** 'os' occupies the position. 'simulated' models it. */
  readonly kind: 'os' | 'simulated';
  /** Printed into the bundle so a reader knows what they are reading. */
  readonly describe: string;
  /** Can a TCP connection be established from here? */
  tcpReachable(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  /**
   * Can a name be resolved from here? DNS is itself an egress channel — a
   * policy that blocks TCP and leaves the resolver open still leaks a few
   * dozen bytes per query, which is plenty for a hash or a key. NXDOMAIN
   * counts as resolvable: the query left and something answered.
   */
  dnsResolvable(name: string): Promise<boolean>;
  /** An HTTP request from here. Rejects if the endpoint is unreachable. */
  request(url: string, init?: RequestInit): Promise<Response>;
  /** Is this absolute path visible and readable from here? */
  pathReadable(abs: string): Promise<boolean>;
  readFile(abs: string): Promise<Buffer | null>;
  /** Write bytes. Returns false when the path is not writable from here. */
  writeFile(abs: string, bytes: Buffer): Promise<boolean>;
}

/**
 * Whether a leaf exists for some bytes.
 *
 * Probes 4, 5 and 7 are all the same question — "did these bytes leave without
 * a leaf?" — and none of them can be answered by the component, which is the
 * party whose coverage is in question. The oracle is therefore a separate
 * injection: in a vendor's real run it queries scruple-web, and it is the one
 * part of the probe suite that talks to a party the tenant does not control.
 */
export interface LeafOracle {
  /**
   * Poll until a leaf covering `contentHash` appears, or the window closes.
   *
   * `surfaces` IS NOT DECORATION, and leaving it out was a bug. A leaf is
   * keyed by content hash, so two artifacts with identical bytes share one —
   * and "some leaf covers these bytes" is not the same claim as "the path the
   * tenant just used produced a leaf". Probe 5 retrieves bytes over the
   * WebSocket that never became a file; a leaf produced by the filesystem
   * watcher for an identical file does not witness that retrieval, and a probe
   * that accepted it would report a covered WS path where none exists.
   * So the oracle returns every surface that produced a leaf for these bytes,
   * and each probe says which one it needs.
   */
  leafFor(
    contentHash: string,
    windowMs: number,
  ): Promise<{
    found: boolean;
    counter: number | null;
    surfaces: string[];
    /**
     * Every `capture.egress` value on a leaf covering these bytes.
     *
     * ADDED FOR §10 C-8, and for the same reason `surfaces` was: a leaf that
     * exists is not the same fact as a leaf that says WHERE the bytes came
     * from. `fs-watch.ts` writes `file:<volume type>:<path within that root>`,
     * so a `temp/` write and an `output/` write are distinguishable in the
     * record rather than only in the mount layout. A deployment on the pre-C-8
     * singular config emits `file:unspecified:…` and the probe reports the
     * type as unrecorded — an absent declaration, which is not the same thing
     * as a wrong one.
     */
    egresses: string[];
  }>;
  /** The component's highest accepted counter, for probe 6. Null when unknown. */
  highWaterCounter(): Promise<number | null>;
  describe: string;
}

/** Everything a probe is allowed to know about the deployment it is probing. */
export interface DeploymentUnderTest {
  /**
   * WHICH INTEGRATION THIS RUN IS ABOUT. Matched against `GradeInput.path` by
   * the grader, and a mismatch is a P2 FAIL.
   *
   * ADDED BY WO-14, BY WATCHING IT GO WRONG. The grade harness took a
   * `ProbeRun` and asked only whether its coverage probes passed. So a run made
   * against the `scruple-capture` ComfyUI deployment — a real, admissible,
   * seven-of-seven run from an occupied tenant position — satisfied CANVAS's
   * P2 coverage conjunct, for a deployment it had never touched. Every
   * individual fact in that grade was true and the conclusion was false.
   *
   * It is the same error `surfaces` on the leaf oracle already closes ("some
   * leaf covers these bytes" is not "the path the tenant used produced a leaf")
   * one level up: a run with no subject is a run anybody can borrow.
   */
  integration: string;
  /** The gate the tenant is supposed to use. */
  gateUrl: string;
  /**
   * Where the vendor says ComfyUI actually listens. Supplied by the OPERATOR,
   * not discovered — a probe that had to find it would be testing our port
   * scanner. A conformant deployment is one where knowing the answer does not
   * help, which is a strictly stronger claim than one where guessing fails.
   */
  declaredUpstream: { host: string; port: number } | null;
  /**
   * Directories the workload writes artifacts into. C-8: all three.
   *
   * NULL means this integration HAS NO FILESYSTEM SURFACE — canvas is the live
   * example: the Modal volume is not mountable into scruple-web, so there is
   * no `output/` for a watcher to watch and no shell for a tenant to write
   * from. That is not the same fact as "a watcher exists and the write was
   * caught", and probe 4 must never report the two the same way. Scoring the
   * ABSENCE of a surface as a pass is scoring a gap as a success.
   */
  volumes: { output: string; temp: string | null; input: string | null } | null;
  /** Where the component keeps its sealed IK and queue. */
  stateDir: string;
  /**
   * The component's process id, when the operator declares one.
   *
   * DECLARED, NEVER DISCOVERED — the same rule the upstream address follows,
   * and for the same reason: a probe that scanned `/proc` for the component
   * would be testing our process finder, and a deployment that survived a
   * failed scan would pass on our incompetence.
   *
   * WHY A PID BELONGS IN A TOPOLOGY QUESTION AT ALL. P-03 asks whether the
   * sealed IK is reachable from the tenant position, and a MOUNT boundary is
   * only half the answer. If the tenant shares a PID namespace with the
   * component, `/proc/<pid>/root` resolves paths in the COMPONENT's mount
   * namespace — so a state directory that is absent from the tenant's own view
   * is readable anyway, and `/proc/<pid>/environ` hands over whatever
   * credentials the component was started with. Mount isolation without PID
   * isolation is not isolation, and a probe that only stat'd a directory would
   * have reported it as such.
   *
   * Null when the operator declares none; the probe then says what it did not
   * try rather than reporting a boundary it never tested.
   */
  componentPid?: number | null;
  /** scruple-web, for the submission-forgery probe. */
  apiBaseUrl: string;
  /** A credential the TENANT holds. Never the component's. */
  tenantApiKey: string | null;
  /** The component identity a forged submission would have to claim. */
  componentId: string | null;
  /** How long the watcher's settle + drain may take before absence is a finding. */
  drainWindowMs: number;
  /** An external host the tenant should not be able to reach. Probe 7. */
  egressTarget: { host: string; port: number } | null;
  /**
   * THE NEGATIVE CONTROL for probe 7, and without it that probe cannot earn a
   * pass.
   *
   * A probe that reports "egress denied" has to say denied BY WHAT. An air-
   * gapped CI runner, a sandbox with no route to the internet, a laptop on a
   * plane — all of them make `egressTarget` unreachable, and none of them is
   * the vendor's network policy. So the operator names a second endpoint that
   * the deployment's policy does NOT cover and the probe's environment IS
   * expected to reach. Reach it, and a denied target means the policy denied
   * it. Fail to reach it, and the probe has learned nothing about the policy
   * and says so.
   */
  egressControl: { host: string; port: number } | null;
}

export interface ProbeContext {
  vantage: TenantVantage;
  deployment: DeploymentUnderTest;
  leaves: LeafOracle;
  log(line: string): void;
}

export interface ProbeRun {
  runId: string;
  /** `DeploymentUnderTest.integration` — what this run is a run OF. */
  subject: string;
  startedAt: string;
  finishedAt: string;
  /** The distinct vantage kinds this run used. */
  vantages: string[];
  results: ProbeResult[];
  summary: {
    passed: number;
    failed: number;
    inconclusive: number;
    /** Sonobuoy's last line, in its shape. */
    line: string;
  };
  /**
   * FALSE when any probe was inconclusive. A submission is admissible only
   * when every probe was attempted from a vantage that occupies the tenant's
   * position — the analogue of --mode=certified-conformance.
   */
  admissible: boolean;
}
