# Blender × ComfyUI provenance — the council's design, in full

Answers [`STOOGES_BRIEF_BLENDER_COMFYUI_WRAP.md`](./STOOGES_BRIEF_BLENDER_COMFYUI_WRAP.md),
which sits beside this file and is not restated here.

**This document is the council's own words, complete and unedited.** Nothing below
§0 is a summary, a paraphrase, or an assistant's gloss. Every contribution is
reproduced verbatim from the recorded transcript, including the ones that were
wrong, the ones that were later withdrawn, and the two rounds where a seat did not
speak at all. Where a section header makes a claim, the text under it is the
evidence for that claim rather than a restatement of it.

---

## 0 · Provenance of this document

| | |
|---|---|
| Production | `blender_plugin` · Scene 1 · Take `u_ZMW2QG2IVGNG.prod4.s1.t1` |
| Where it ran | production Stooges, `app.stooges.ai`, plan `byok` sub-tier 1 |
| Mode | Cast, featured — **not** group chat |
| Cowbell | `watcherSensitivity: 5` (Aggressive, the maximum) throughout both runs |
| Run 1 | 2026-09-08 ~06:00–07:13 UTC · 8 rounds · **no convergence** · 100 calls · $2.7562 |
| Run 2 | 2026-09-08 21:28–21:34 UTC · 4 rounds · **converged** · 40 calls · $0.7381 |
| Raw SSE | `<ai-council scratchpad>/rounds/r1–r8.sse` and `rounds2/r1–r4.sse` |

### The seats, and what each actually ran on

| Seat | Role | Run 1 model | Run 2 model |
|---|---|---|---|
| Coder | drafter (featured) | `claude-opus-5` ⚠ | `gpt-5.6-luna` |
| Architect | watcher | `claude-opus-5` | `claude-opus-5` |
| Loki | watcher | `grok-4.20-0309-reasoning` | `grok-4.20-0309-reasoning` |
| IT Expert | watcher | `gemini-2.5-flash` ⚠ | `gemini-3.8-flash` |

⚠ **Run 1 did not run the configuration it was given, and the transcript does not
say so.** Coder was pinned to `gpt-5.6-luna` and IT Expert to `gemini-3.8-flash`.
Both ids were in the model catalogue and on no ladder rung, so the platform's plan
clamp refused them and granted the plan ceiling instead — 14 featured calls went to
`claude-opus-5` at $1.37, and the IT Expert seat was hand-substituted to
`gemini-2.5-flash` by the driver. Anyone weighing run 1's arguments by which model
produced them should read the run-1 rows above, not the configuration. Fixed in
ai-council `6a0a2dc3`; run 2 ran as configured and recorded zero substitutions.

### Two runs, and why there are two

Run 1 answered the original brief and stopped at the round limit with three live
objections. Run 2 **amended** the brief rather than restarting it — the founder's
read was that run 1's position was honest and was not the objective — and resumed
with run 1's round-8 positions seeded as history. The amendment is reproduced in
full at Appendix A. Read run 1 (§4) before run 2 (§3) if you want the argument in
chronological order; read §1 first if you want the answer.

### How the run was stopped

Run 1 had no declared stop condition and hit its round limit. In run 2 each watcher
ends its contribution with `STATUS: SETTLED | OPEN | BLOCKING`, and the run stops
when none is OPEN or BLOCKING. **`SETTLED` means the watcher has nothing further to
raise. It does not mean the watcher thinks the design is good** — see Loki's closing
contribution in §2, which settles by conceding that the thing it spent twelve rounds
attacking is true, unfixable, and shippable only as a declared limit.

---

## 1 · The design as it finally stands

_Coder, run 2 round 4, verbatim and complete._

I changed my mind on one central point: a gate-side `/history` poll is not an independent authorship witness. It can establish that the ComfyUI server returned a result for a prompt, but on a root-controlled desktop the same adversary can tamper with the gate’s loopback observation or replace the server. Therefore v1 must not call those bytes “server-authored” or “input-origin verified.” I am holding my ground on Design A because it still reduces required trust without pretending to solve the machine-owner problem: the gate records HTTP transit independently of client cooperation, while the Blender add-on records semantic claims separately. The result is useful evidence, but its trust boundaries remain explicit.

The revised leaf has three distinct assertions. `transit_facts` are produced by the gate and cover the exact request and response bytes it observed, canonical hashes, endpoint and method, timestamps, session scope, and the ComfyUI `prompt_id`. They must contain `origin: "unattested"`; that literal is not inferred from missing evidence. `semantic_facts` are signed by the Blender add-on and describe the claimed input authorship context: the Blender object or datablock identifiers, source file or viewport/render state, user-selected assets, node-graph meaning, intended output relationship, and the add-on’s claimed capture time. These remain `unattested-client`, even when their hashes join correctly. The third category is resolution state: whether outputs were independently located through `/history`, which filenames or output records were returned, and whether `/view` bytes matched the recorded output references. These facts are gate observations, not proof of origin.

This positively captures authorship only in the defensible sense: it records who or what the client claims authored each input, and binds that claim to the prompt session and the observed request. It does not prove that the human authored it, that Blender generated the bytes, or that the add-on was unmodified. A leaf with no semantic facts is therefore not a defence of authorship; it is an explicit transit-only record. A leaf with semantic facts is stronger because it carries a positive, field-labelled authorship claim, but its displayed verdict cannot exceed the `unattested-client` trust floor.

I also changed the join. The primary join is `(session_id, prompt_id)`, never a content hash. The gate must record the exact prompt response that supplied `prompt_id`; if the server supplies it, the response is authoritative for the identifier within that observed session. If the client supplies or influences it, that fact is recorded rather than silently treated as server-minted. The session identifier must be generated by the gate and included in every correlated record. Prompt IDs are not assumed globally unique across restarts or ComfyUI instances, so a verifier must reject joins that lack the gate session scope.

The `/history/{prompt_id}` probe is now an explicit state machine, not an optional enrichment. After accepting `/prompt`, the gate polls history until a pinned timeout, then records one of `resolved`, `pending`, `failed`, or `unresolved`, including the polling interval, timeout, endpoint, and response hashes. `unresolved` is a required emitted fact; omission is prohibited. If history supplies output records or filenames, the gate may fetch and hash the referenced `/view` bytes, but it must not claim that those bytes originated in Blender or even that they were generated by an untampered ComfyUI instance.

The falsifying test remains a release blocker for the non-proxy variant: submit a prompt, immediately terminate the client connection, and verify that the gate can still resolve the prompt and outputs solely through server-side history. This test must run against the pinned ComfyUI version and API configuration used by v1. If it fails, or if the API does not reliably expose output references, v1 must proxy the websocket or otherwise retain the required server event stream. “Best-effort polling” is not an acceptable basis for a complete-output claim.

Loki’s loopback-MITM objection is true and unfixable on the stated desktop threat model. I am not trying to settle it with TLS, a local secret, a subprocess boundary, or a signed wrapper: root can intercept or replace all of them. This is therefore settled as a limitation, not as a successful defence, and it does not block a transit-evidence v1. It does block any stronger v1 claim that the gate independently authenticates ComfyUI or proves output origin. That stronger claim requires a separately controlled ComfyUI host, an authenticated remote channel, or hardware-backed remote attestation tied to the execution boundary.

The composition rule is unchanged: every field retains its producer and trust level; a consumer summary takes the minimum trust level of the fields it relies on. `inline_payload_hint` remains unsigned metadata and never affects a verdict. A verifier must distinguish “input bytes were observed in transit,” “the client claimed these bytes had this Blender meaning,” and “the server returned an output record”; none may be collapsed into “Blender authored the input” or “ComfyUI generated the output.” This answers the blocking concern that declaring everything undeclared would produce an empty abstention: the system records concrete, positively asserted input-authorship claims and concrete gate observations, while refusing to launder either into stronger provenance.

For v1, the acceptance boundary is therefore: gate capture, session-scoped prompt correlation, signed semantic input claims, mandatory explicit resolution state, and the falsifying history test. The shipped documentation must state that local root can forge semantic claims, alter loopback observations, inject inline rasters, and replace either application. If the product requirement means cryptographically positive human or Blender authorship rather than a signed client claim, Design A is insufficient by construction; the witnessing or execution boundary must move off the machine owner’s control.

STATUS: Design A v1 is viable as field-labelled transit plus client-claimed authorship evidence; origin/authenticity claims remain out of scope.

<beat status="converging" reason="Objections incorporated with explicit limits"/>

---

## 2 · The three watchers' closing positions

_Run 2 round 4, verbatim and complete. These are the contributions that ended the
run; each carries the reason the watcher stopped._

### Loki

The headless-replay forgery you now openly declare as unprovable stays exactly that: semantic_facts signed by a patched add-on or scripted Blender headless mock remain indistinguishable from real UI work, collapsing any lattice to the unattested floor. External heartbeat on the trace head would have raised the bar; skipping it settles the point cleanly. True, unfixable on a root-owned desktop, and non-blocking for a v1 that ships the limit in neon.  
SETTLED: semantic claims are client-signed theater, not authorship proof. STATUS: SETTLED as documented unattested-client limit.

### Architect

My four OPEN items are answered structurally, not by prose: the floor rule survives, `inline_payload_hint` stays unsigned, `unresolved` is now a mandatory emitted state rather than an absence, and `prompt_id` is scoped so an unscoped join is rejectable — SETTLED, because in each case the safe reading is the only representable one rather than the recommended one. Two additions. The server-minted vs. client-influenced `prompt_id` distinction must be a required enumerated field on `transit_facts`, not something "recorded" narratively, or it will be absent in exactly the leaves where it matters. And the threat-model disclosure — root can forge semantic claims, alter loopback, inject inline — belongs as a machine-readable limitation field in the envelope itself, not only in shipped documentation, since no consumer that matters will have read the docs; the corroboration axis, which this revision silently drops, should return only in that raw-coverage form if it returns at all. STATUS: SETTLED

### IT Expert

Coder’s revision settles my primary operational blocking condition: the polling mechanism is now constrained to a strict, bounded state machine where `outputs: unresolved` is a mandatory terminal emitted fact on timeout, eliminating indefinite file-descriptor or memory leakage on abandoned renders. The `/history` falsifying test remains explicitly marked as a pre-release blocker, which correctly gates shipping on empirical proof rather than assumption. To survive on-call reality, ensure the gate implements a hard cap on concurrent polling workers (e.g., max 16 in-flight `prompt_id` tracks) and a reaper TTL on abandoned sessions to prevent loopback socket exhaustion. STATUS: SETTLED.

---

## 3 · Run 2 — the amended objective, rounds 1–4

_Every contribution, verbatim. Round 4 is repeated here so this section stands
alone as the run._

### Run 2 · Round 1

#### Coder (drafter)

Design A remains the v1 architecture, but its scope changes. The gate remains the strongest available byte witness, while the Blender add-on becomes a process-trace collector rather than merely a semantic signer. This does not promote Blender evidence to `sidecar-gate`; it gives downstream consumers more information than an anonymous PNG without pretending that user-controlled Python is an enforcement boundary. The trust-minimisation curve is sharply front-loaded: moving from direct client claims to an independent gate is valuable, adding active output polling is valuable if its API assumptions hold, and wrapping the desktop client buys almost no additional security against root for substantial friction. Process traces add evidentiary value, not host-level trust.

| Mechanism | Captured evidence | What it supports | Cost to forge | User cost |
|---|---|---|---|---|
| Scene-graph delta chain | Canonicalized object, mesh, material, modifier, camera, and collection changes across signed or hash-chained checkpoints | The submitted scene state has a recorded predecessor history | Anyone can fabricate a synthetic sequence; a convincing long history requires generating coherent Blender state transitions and timestamps | Save/checkpoint overhead, storage, possible privacy leakage |
| Incremental `.blend` checkpoints | Hashes of successive saves, with sequence numbers and parent hashes | The add-on observed a non-empty local history rather than only a final state | A Python add-on can emit fabricated checkpoints; an adversary can also construct a history offline | More files and I/O; users must save through the instrumented path |
| Camera-path continuity | Camera transforms and relevant scene state leading to the captured frame | The frame is reachable from the recorded camera trajectory | Fabricating plausible transforms is easy; fabricating a consistent surrounding edit history is harder but still software work | Continuous sampling and larger manifests |
| Grease-pencil or mask kinematics | Timestamped stroke points, velocities, pauses, pressure/tilt where Blender exposes them | A mask was produced through an interaction-shaped trace rather than only appearing as a bitmap | A basic Python script can replay points; a high-quality simulator must model timing, curvature, pauses, device characteristics, and scene consequences | Device capture, privacy concerns, larger data, possible workflow changes |
| Datablock lineage | Creation, modification, replacement, and dependency relationships for image datablocks | A datablock has a recorded lineage, or was replaced in place with no recorded authoring trace | Fabricating positive lineage is straightforward for a modified add-on; detecting replacement is cheap only if the add-on was running before it happened | Persistent IDs and event logging |
| Negative replacement signal | Explicit event that an image datablock was replaced or materialized without a recognized trace | Absence of process evidence, not evidence of external origin | Suppressing the event is easy for a compromised add-on; a clean record cannot establish that no unobserved process occurred | Minimal if treated as an event log |
| Multi-signal consistency | Agreement among scene deltas, camera state, strokes, datablock lineage, and captured bytes | Independent-looking signals cohere across one capture | A serious forger must coordinate all signals, but the add-on can generate them all | Highest capture complexity and privacy/storage cost |

The cost column must not be overstated. Every positive signal emitted solely by a user-writable Blender add-on is forgeable by an attacker who can edit that add-on. A process simulator may require materially more effort and skill than renaming a datablock, but it is not a cryptographic barrier. The meaningful distinction is therefore not “authentic” versus “fake”; it is “no trace,” “internally coherent trace,” and “trace corroborated by an independent enforcement boundary.” The verifier must retain those distinctions.

I recommend adding an orthogonal `corroboration` or, preferably, `evidence` axis, but not another trust rung. The axis should describe the presence and internal consistency of declared signals, while `enforcement` and the verdict floor continue to describe who could have altered the record. For example, `evidence: none`, `process-trace`, and `multi-signal` can be useful display and filtering values, provided they never raise `unattested-client` to `sidecar-gate`. The verifier must recompute the evidence classification from signed event contents; it must not trust a client-supplied label. If the events are not independently verifiable, the result is still client-reported evidence, not authenticated authorship. This axis is worthwhile because collapsing “no evidence” and “coherent but user-controlled evidence” discards useful information, but it must be explicitly non-authoritative to avoid creating a second ladder that users mistake for provenance truth.

The root MITM objection is declared unanswerable for v1. A root-controlled host can intercept or replace the gate’s loopback `/history` and `/view` responses, patch the gate, alter its key material, or substitute the upstream service. A session-scoped signature then proves only that the designated gate signed the bytes it observed; it does not prove that those bytes were generated by the intended ComfyUI execution. Active polling still improves resistance against a modified client, because the client no longer controls whether the gate performs the fetch, but it does not defeat root. The canon must say: “`sidecar-gate` attests to bytes observed and recorded by the gate over the classified route; it does not attest to unforgeable upstream generation, origin, or execution when the host is controlled by root.” A deployment needing that stronger claim requires an external verifier, remote service, hardware-backed key, or other trust anchor outside the host; none is part of desktop v1.

Architect’s three schema residuals are answered and mandatory. A verifier recomputes `verdict` from the signed fields and treats any mismatch as tampering, never as a display hint. `inline_payload_hint` is outside the signed envelope and is explicitly non-authoritative; it may guide parsing or diagnostics but cannot affect hashes, routes, origins, or verdicts. An unrecognized `origin` on a `sidecar-gate` leaf is a hard verification failure, not a fallback to `unattested`; fallback would turn schema rejection into apparent acceptance.

The `/history` falsifying test remains blocking for schema freeze, not because Design A has conceptually failed but because the active-witness contract depends on behavior that has not yet been verified against a pinned ComfyUI version. The required experiment is concrete: submit a prompt through the gate, record the returned `prompt_id`, immediately terminate the client websocket, then verify that the gate independently obtains the corresponding history and retrieves every output through `/view`, recording failures, latency, and pruning behavior. If this succeeds, the v1 route can remain HTTP observation plus active polling. If it fails, socket proxying becomes a required part of the gate and the route/schema must be revised before release. Until then, claims about unattended prompt-to-output resolution are not shippable claims.

The v1 refusal boundary is therefore explicit: we refuse to claim that Blender process traces prove human authorship; that coherent timing proves a human rather than a simulator; that an unmodified-looking `.blend` proves continuous history; that a `sidecar-gate` leaf proves ComfyUI generated the bytes; or that a local signature survives a root-compromised host. We can claim that a gate observed specified bytes, that the bytes and request body were bound by signatures, that Blender reported specified process events, and that a verifier can distinguish absent, internally coherent, and inconsistent evidence without laundering the latter into a higher trust verdict.

STATUS: BLOCKING — `/history` active-witness behavior remains experimentally unverified.

<beat status="iterating" reason="Schema test still blocks v1 freeze"/>

#### Architect (watcher)

The one asymmetry worth exploiting: root can forge any artifact but cannot forge the past. As drafted, the `evidence` axis is entirely self-reported and retro-fabricable offline in an afternoon — so it carries almost no information. Bind the process-trace hash chain into the *same external checkpoint log* as the transit leaves, with a continuity heartbeat, and forgery cost stops being "write a simulator" and becomes "have driven that simulator in real wall-clock time, days ago, publicly" — plus gaps and backdating become detectable rather than silent. Without that anchor, the axis should ship with only two meaningful values (`none` vs `client-reported`), because `multi-signal` on an unanchored chain is a rung nobody can audit, which is exactly the failure mode the brief warns against. STATUS: OPEN — (a) settled by either time-anchoring the process-trace chain to the external log with gap detection, or by collapsing the evidence axis to `none | client-reported` in v1; (b) does not block v1 — it is a schema scoping decision, and the `/history` test is the actual freeze gate.

#### Loki (watcher)

Root can LD_PRELOAD a shim that rewrites Blender's event queue on the fly, forging coherent scene deltas, camera paths, and grease-pencil kinematics for a dropped internet PNG so the add-on's "multi-signal" envelope signs clean without ever touching a real pointing device. That collapses your new evidence axis into signed theater the instant the host isn't pristine, exactly as the loopback MITM already does for byte_facts. The table's "higher effort" claim therefore fails its own hardest case. STATUS: OPEN — evidence axis adds no verifiable value against root and risks misleading users; needs experiment showing a forger's effort threshold.

#### IT Expert (watcher)

Coder has framed the operational boundaries correctly: process traces are forensic telemetry, not trust anchors, and treating root-on-loopback as an unanswerable desktop reality stops theatre from polluting the canon. From an infrastructure perspective, capturing high-frequency input kinematics, stroke deltas, and continuous undo histories inside Blender will inflate leaf payloads and local SQLite store-and-forward buffers by orders of magnitude; that serialization overhead must be isolated from Blender's main UI loop so provenance capture does not drop viewport frames. The `/history` falsifying test remains the absolute operational gating item before we freeze the gate's network surface: pin ComfyUI (e.g. to a specific git commit), run the `POST /prompt` -> kill-WS -> `GET /history/{prompt_id}` cycle, and confirm ComfyUI does not garbage-collect or refuse to populate history for an orphaned prompt_id. STATUS: BLOCKING — The `/history` falsifying test remains unrun against a pinned ComfyUI commit; we cannot freeze the transport architecture or witness loop without empirical verification.

### Run 2 · Round 2

#### Coder (drafter)

I am revising Design A around a sharper boundary: the gate proves bytes observed on the ComfyUI interface, while the Blender add-on positively records authorship evidence for the inputs without claiming that its own process is trusted. The add-on will therefore emit a semantic envelope containing a canonical scene snapshot or delta, scene/frame/camera identity, input asset hashes where files exist, the raw render or viewport bytes when it creates them, the ComfyUI request identifier, and an ordered local capture record. It signs that envelope with the documented user-writable key, so a verifier can establish continuity and detect later edits, but must label the result `unattested-client`. This is not “everything undeclared”: it is an explicit, inspectable authorship claim whose limitation is visible. If no semantic capture exists, the leaf may be byte-valid but has no authorship claim; if no gate capture exists, it is an abstention rather than a provenance result.

I changed my mind about the add-on’s role. It is not merely a semantic signer; it is now a process-trace collector for inputs and joins those records to the gate’s byte record using prompt ID, request digest, and timing metadata. I also changed the gate’s prompt treatment: it must hash the complete raw `/prompt` request body as opaque `prompt_bytes`, not depend on understanding ComfyUI’s node schema. That covers inline base64 and other embedded raster forms even when the gate cannot classify them. Schema-aware extraction remains optional metadata, never a correctness prerequisite. I am holding my ground that a desktop wrapper, forked bridge, or Blender process cannot earn `sidecar-gate`; root can alter, observe, or replace all of them. Their evidence can become richer, but their trust label cannot become stronger.

The gate remains an active witness. After observing `POST /prompt` and recording the returned prompt ID, it independently polls `/history/{prompt_id}` and fetches each referenced output through `/view`, recording the exact response bytes, route, timestamp, and whether the fetch was gate-initiated. Client websocket messages are therefore supplementary, not authoritative. The required falsifying test is unchanged: submit a prompt, kill the client socket immediately, and require the gate to resolve the prompt to output bytes without client cooperation. Failure blocks the active-poll variant and makes socket proxying mandatory for v1; it does not justify silently claiming active witnessing.

The remaining ComfyUI uncertainties are release gates, not assumptions. We must pin a tested ComfyUI version and verify `/history` retention, output references, `/view` retrieval, and the relevant upload behavior. If the bridge re-encodes Blender data rather than uploading the exact captured bytes, the gate cannot join an input-file hash to that source object; the design must record this as an unjoined transformation, not forge equivalence. The opaque prompt digest still remains valid. Inline payloads likewise need an empirical fixture suite, although unknown payload schemas no longer threaten byte coverage.

A leaf containing both envelopes is rendered at the floor of its fields: `unattested-client`, while the `sidecar-gate` byte facts remain inspectable. Leaves are signed into the append-only local log, and Merkle roots are marked `pending` until externally checkpointed; unpublished evidence is never displayed as fully valid. Thus the design minimises required trust, captures authorship positively, and preserves the distinction between “the client says this was scene X” and “the gate independently observed these bytes.”

STATUS: Design A revised; active-poll and schema freeze remain blocked pending pinned falsifying tests, while the trust boundary and authorship model are settled.

<beat status="iterating" reason="Blocking API tests still remain"/>

#### Architect (watcher)

NOT SETTLED, but narrowly. The revision folds capture records into the append-only local log with `pending` roots, which is the right plumbing — it just never says the process-trace chain *head* is heartbeated externally *during* capture, and without that the whole envelope is still retro-fabricable in one offline afternoon, which is precisely the case Loki's LD_PRELOAD shim wins. What settles it: a stated rule that the trace-chain head is checkpointed on a wall-clock interval with gap detection, and that any envelope whose chain was anchored only *after* the output bytes existed renders as `client-reported`, never higher. Does not block v1 — but until it lands, the evidence axis should ship with two values only, because an unanchored `multi-signal` rung is a claim no verifier can audit. STATUS: OPEN — settled by wall-clock anchoring of the trace-chain head with gap detection, or by collapsing the evidence axis to `none | client-reported` in v1; does not block.

#### Loki (watcher)

Consider how a root adversary slips an LD_PRELOAD shim that rewrites Blender's event queue on the fly; your new process-trace collector still signs coherent scene deltas for any dropped internet PNG without ever touching real input devices. The unattested-client envelope becomes verifiable theater exactly as the loopback MITM already renders byte_facts. An experiment measuring the forger's minimum effort threshold against pristine-host assumptions would settle it; absent that, this blocks v1 authorship capture.  
STATUS: OPEN, blocks v1.

#### IT Expert (watcher)

The two-envelope boundary, the opaque `prompt_bytes` hash, and the floor-of-fields composition rule cleanly close the architectural trust laundering. However, the operational gate cannot ship until you bound the active polling engine: define an explicit `history_poll_timeout` (e.g., 300s) and an in-memory queue cap for orphaned `prompt_id`s, or an artist running a batch job or a stalled model will exhaust local ephemeral ports and file descriptors on loopback. STATUS: SETTLED with finding attached — the trust boundary and witness separation are sound, but the `/history` falsifying test against a pinned ComfyUI commit and an explicit polling timeout/pruning policy remain release blockers for production stability.

### Run 2 · Round 3

#### Coder (drafter)

The sharpened objective changes the recommendation only in one respect: v1 should remain Design A for low-friction deployment, but it must add a Blender-side process-trace channel as corroborating evidence, never as an authentication mechanism. If the requirement is genuinely to minimise trust in a machine owner, the strongest available increment is not a more elaborate desktop wrapper; it is moving the witnessing or execution boundary to a separately controlled host. A root user owning Blender, the gate, and ComfyUI can forge every local assertion and every local observation. No Python architecture changes that.

The trust-minimisation curve is therefore:

1. Honest field-labelled declarations: minimal friction, no reduction in trust.
2. Gate-observed HTTP transit: low friction, reduces reliance on client cooperation but does not establish origin.
3. Gate-side active history polling or socket proxying: moderate implementation cost; establishes whether the server independently resolves a request, but does not survive a root MITM of the gate’s loopback calls.
4. Blender process trace: moderate user cost; provides useful forensic corroboration and makes casual fabrication harder, but remains user-controlled.
5. Separate capture host, remote ComfyUI, or hardware-attested execution: high friction and operational cost; the first increments that materially reduce trust in the workstation owner.

Design C does not occupy a higher rung. A wrapper around Blender is still on the user’s machine, and therefore adds friction without adding a trustworthy observation boundary.

The proposed v1 leaf keeps the trust fields separate. `transit_facts` are signed by the gate and describe only bytes and protocol events the gate observed. They contain the required literal `origin: "unattested"`. Blender-originated semantic and process evidence is signed separately as `semantic_facts` at `unattested-client` trust. The verifier computes the displayed verdict as the floor of the individual fields; it never upgrades a leaf because corroborating evidence looks persuasive.

The authorship trace is valuable, but it is evidence of process consistency, not proof of human authorship:

| Mechanism | Captured signal | What it supports | Cost to forge | User cost |
|---|---|---|---|---|
| Scene delta chain | Ordered object, mesh, modifier, camera, and datablock changes with save/session boundaries | The final scene has an observable editing history rather than appearing atomically | Anyone editing the add-on can emit a synthetic chain; a convincing long history requires state modelling and consistency work | Background logging, storage, save hooks, recovery and privacy concerns |
| Incremental save hash chain | Hash-linked snapshots and timestamps of observed Blender state | Detection of deletion or reordering within the recorded chain | Recreate the chain or replace the recorder; no protection against a forged recorder | Extra I/O and potentially large storage; gaps during crashes or disabled handlers |
| Input-device timing | Pointer/button events, timing, velocity, acceleration, pauses, and stroke geometry for masks or drawing | The interaction resembles an actual continuous authoring session | A simple replay defeats naive checks; a robust counterfeit needs a motor-behaviour simulator and plausible Blender event delivery | Privacy-sensitive telemetry, platform-specific capture, calibration, and false positives |
| Camera-path continuity | Camera transforms and viewport/render context leading to the captured frame | The frame is reachable from a recorded camera history | Scripted keyframes can manufacture a plausible path; root can fabricate the entire trace | Continuous logging, large traces, and ambiguity around legitimate jumps |
| Datablock lineage | Creation, modification, replacement, packing, and linking events for image datablocks | Distinguishes a datablock with observed Blender-side history from one materialised with no trace | An edited recorder can invent lineage; an external image can be imported early and given an artificial history | Add-on integration and handling of legitimate copy/paste, reload, and library-link operations |
| Negative replacement signal | In-place replacement, missing predecessor, missing chain, or unexplained materialisation | Absence of provenance is explicitly visible instead of silently treated as ordinary input | Easy to suppress if the recorder is compromised; difficult to turn into positive evidence | Some workflows receive a lower result even when the replacement is legitimate |
| Multi-signal consistency | Agreement among deltas, saves, input events, camera path, and datablock lineage | Raises the effort required for a casual counterfeit and exposes contradictions | A determined attacker can generate all signals, especially with a headless Blender driver | Highest telemetry, storage, compatibility, and privacy cost |

The relevant adversary-cost distinction must remain explicit. These signals are forgeable in principle, forgeable by a Python-file editor, or forgeable only after building a substantially more capable simulator. They are not equivalent security properties. A motor simulator and a headless Blender driver may impose meaningful effort, but they do not create an attested origin claim.

I recommend adding an orthogonal `corroboration` field, but not adding it to the trust lattice. Its values can be `none`, `process-trace`, or `multi-signal`, accompanied by coverage, gaps, session scope, and the hash of the recorded trace. It must be signed as `semantic_facts`, remain at `unattested-client`, and never raise the verdict floor. This gives downstream readers evidentiary weight without pretending that “multi-signal” is an enforcement rung. The case against the axis is real: it can become a second gamed score and encourage consumers to treat an unaudited label as authentication. That is why the verifier must expose it as corroboration metadata, not trust, and must show missing intervals and replacement events rather than only a flattering summary.

The three unresolved objections have the following disposition.

Loki’s loopback MITM objection is **DECLARED-UNANSWERABLE for a local root-owned deployment**. The gate can cryptographically prove what it observed, but cannot prove that its loopback `/history` or `/view` response originated from the intended ComfyUI process when the machine owner controls the namespace. A socket proxy prevents client non-cooperation; it does not solve an active root MITM. The canon must say: “`sidecar-gate` attests transit observation and protocol handling, not endpoint identity or source origin, unless the endpoint is reached through an independently authenticated boundary outside the workstation’s administrative control.” A remote service, separately administered host, or genuine hardware-backed channel is required to answer this objection rather than merely relabel it.

Architect’s three schema residuals are **ANSWERED**. The verifier must recompute `verdict` from the signed field-level trust values and treat any mismatch as tampering or an invalid envelope. `inline_payload_hint` must be outside the signed envelope and must never enter verdict computation. An unrecognised `origin` on a `sidecar-gate` leaf is a hard verification failure, not a fallback to `unattested`; only the exact required literal `"unattested"` is valid for the local gate profile.

IT Expert’s `/history` objection is **BLOCKING** for schema freeze and for any claim that the gate can resolve outputs independently of the client. The required falsifying test is operational: submit a prompt, terminate the client socket immediately, and verify that the pinned ComfyUI version independently resolves `/history/{prompt_id}` to the output records needed by the leaf. The test must also record the prompt-ID scope and whether filenames or equivalent output identifiers are returned. Until it passes, the implementation must either proxy the websocket or emit `outputs: unresolved`; it must never silently omit output resolution. Even after it passes, the loopback-origin limitation remains.

The architecture therefore refuses to claim that a rendered PNG came from Blender, that a process trace was produced by an honest add-on, that a human rather than an automation system authored the scene, or that a gate-observed output response came from the intended ComfyUI process on a root-owned workstation. It can claim that particular bytes and events were observed, that a separately signed client trace reports a particular authoring history, and that independent signals are or are not mutually consistent. Those are useful claims, but they are deliberately weaker than provenance.

STATUS: BLOCKING — `/history` test and endpoint binding remain unresolved
<beat status="iterating" reason="Draft exposes the trust and evidence boundary"/>

#### Architect (watcher)

Three things. First, `corroboration: none | process-trace | multi-signal` is ordinal, and an ordinal field *is* a score — it will be read as "more is better" and consumed as a substitute for the verdict floor no matter what the prose says. The brief asked you to stop collapsing three distinct forge-costs into one word; a three-valued ladder collapses them into three words with the same defect. What the envelope should carry is the raw coverage record — intervals observed, intervals missing, replacement events, which signal families were live — and let a consumer derive a label if it wants one, so that the derivation is visible and contestable rather than baked into a signature.

Second, the negative signal is misplaced as a table row. It is the only claim in the whole §2 space whose strength *increases* under adversarial pressure: suppressing an absence requires the adversary to affirmatively fabricate a trace, which is a detectable act with a cost, whereas every positive signal degrades to "an edited recorder said so." That asymmetry should be the primary architectural commitment of the process-trace channel — we report gaps loudly and positives quietly — not the seventh entry in a list.

Third, on the trust curve: it is not a curve, it is a step function with one cliff, and the cliff is the administrative boundary, not the software architecture. Rungs 1–4 are all on the wrong side of it and differ only in friction; that is a finding and canon should state it in those terms so nobody re-litigates Design C every six months.

STATUS: OPEN — the ordinal `corroboration` value. Settled by: replacing the enumerated label with a coverage/gap record inside `semantic_facts`, with no aggregate value emitted by the signer. Does not block v1 shipping if the field is simply omitted from v1 and the coverage record ships alone; blocks only the corroboration axis itself.

#### Loki (watcher)

Even your process-trace table understates the mischief: a root adversary scripts a headless Blender driver to replay plausible deltas, device kinematics, and camera paths in one offline evening, then signs a pristine `semantic_facts` envelope that passes every multi-signal consistency check without ever touching the real UI. The corroboration axis helps readers see the gaps you declare, but only if the trace head is externally heartbeated on a wall-clock interval—otherwise the whole lattice collapses to the same `unattested` blind your canon already admits.  
That single live anchor is the cheapest increment that actually raises forgery cost beyond Python editing. STATUS: OPEN — (a) require and test live external checkpointing of the trace-chain head with gap detection; (b) declare the limitation and ship in v1.

#### IT Expert (watcher)

The unrun `/history/{prompt_id}` falsifying test against `127.0.0.1:8188` remains BLOCKING: ComfyUI history is an ephemeral in-memory dictionary that wipes on restart or crash, meaning any gate design relying on async polling without an enforced websocket proxy will silently drop provenance during standard workflow restarts. Furthermore, collecting scene-delta and save chains inside Blender will rapidly exhaust disk I/O and user storage on multi-gigabyte production assets unless restricted strictly to sparse, in-memory operator telemetry via `bpy.app.handlers`. The operational failure mode must explicitly timeout to an immutable `outputs: unresolved` record rather than leaking poll descriptors on abandoned prompts. STATUS: BLOCKING — `/history` test remains unrun and history retention under ComfyUI process restarts is uncharacterized.

### Run 2 · Round 4

#### Coder (drafter)

I changed my mind on one central point: a gate-side `/history` poll is not an independent authorship witness. It can establish that the ComfyUI server returned a result for a prompt, but on a root-controlled desktop the same adversary can tamper with the gate’s loopback observation or replace the server. Therefore v1 must not call those bytes “server-authored” or “input-origin verified.” I am holding my ground on Design A because it still reduces required trust without pretending to solve the machine-owner problem: the gate records HTTP transit independently of client cooperation, while the Blender add-on records semantic claims separately. The result is useful evidence, but its trust boundaries remain explicit.

The revised leaf has three distinct assertions. `transit_facts` are produced by the gate and cover the exact request and response bytes it observed, canonical hashes, endpoint and method, timestamps, session scope, and the ComfyUI `prompt_id`. They must contain `origin: "unattested"`; that literal is not inferred from missing evidence. `semantic_facts` are signed by the Blender add-on and describe the claimed input authorship context: the Blender object or datablock identifiers, source file or viewport/render state, user-selected assets, node-graph meaning, intended output relationship, and the add-on’s claimed capture time. These remain `unattested-client`, even when their hashes join correctly. The third category is resolution state: whether outputs were independently located through `/history`, which filenames or output records were returned, and whether `/view` bytes matched the recorded output references. These facts are gate observations, not proof of origin.

This positively captures authorship only in the defensible sense: it records who or what the client claims authored each input, and binds that claim to the prompt session and the observed request. It does not prove that the human authored it, that Blender generated the bytes, or that the add-on was unmodified. A leaf with no semantic facts is therefore not a defence of authorship; it is an explicit transit-only record. A leaf with semantic facts is stronger because it carries a positive, field-labelled authorship claim, but its displayed verdict cannot exceed the `unattested-client` trust floor.

I also changed the join. The primary join is `(session_id, prompt_id)`, never a content hash. The gate must record the exact prompt response that supplied `prompt_id`; if the server supplies it, the response is authoritative for the identifier within that observed session. If the client supplies or influences it, that fact is recorded rather than silently treated as server-minted. The session identifier must be generated by the gate and included in every correlated record. Prompt IDs are not assumed globally unique across restarts or ComfyUI instances, so a verifier must reject joins that lack the gate session scope.

The `/history/{prompt_id}` probe is now an explicit state machine, not an optional enrichment. After accepting `/prompt`, the gate polls history until a pinned timeout, then records one of `resolved`, `pending`, `failed`, or `unresolved`, including the polling interval, timeout, endpoint, and response hashes. `unresolved` is a required emitted fact; omission is prohibited. If history supplies output records or filenames, the gate may fetch and hash the referenced `/view` bytes, but it must not claim that those bytes originated in Blender or even that they were generated by an untampered ComfyUI instance.

The falsifying test remains a release blocker for the non-proxy variant: submit a prompt, immediately terminate the client connection, and verify that the gate can still resolve the prompt and outputs solely through server-side history. This test must run against the pinned ComfyUI version and API configuration used by v1. If it fails, or if the API does not reliably expose output references, v1 must proxy the websocket or otherwise retain the required server event stream. “Best-effort polling” is not an acceptable basis for a complete-output claim.

Loki’s loopback-MITM objection is true and unfixable on the stated desktop threat model. I am not trying to settle it with TLS, a local secret, a subprocess boundary, or a signed wrapper: root can intercept or replace all of them. This is therefore settled as a limitation, not as a successful defence, and it does not block a transit-evidence v1. It does block any stronger v1 claim that the gate independently authenticates ComfyUI or proves output origin. That stronger claim requires a separately controlled ComfyUI host, an authenticated remote channel, or hardware-backed remote attestation tied to the execution boundary.

The composition rule is unchanged: every field retains its producer and trust level; a consumer summary takes the minimum trust level of the fields it relies on. `inline_payload_hint` remains unsigned metadata and never affects a verdict. A verifier must distinguish “input bytes were observed in transit,” “the client claimed these bytes had this Blender meaning,” and “the server returned an output record”; none may be collapsed into “Blender authored the input” or “ComfyUI generated the output.” This answers the blocking concern that declaring everything undeclared would produce an empty abstention: the system records concrete, positively asserted input-authorship claims and concrete gate observations, while refusing to launder either into stronger provenance.

For v1, the acceptance boundary is therefore: gate capture, session-scoped prompt correlation, signed semantic input claims, mandatory explicit resolution state, and the falsifying history test. The shipped documentation must state that local root can forge semantic claims, alter loopback observations, inject inline rasters, and replace either application. If the product requirement means cryptographically positive human or Blender authorship rather than a signed client claim, Design A is insufficient by construction; the witnessing or execution boundary must move off the machine owner’s control.

STATUS: Design A v1 is viable as field-labelled transit plus client-claimed authorship evidence; origin/authenticity claims remain out of scope.

<beat status="converging" reason="Objections incorporated with explicit limits"/>

#### Architect (watcher)

My four OPEN items are answered structurally, not by prose: the floor rule survives, `inline_payload_hint` stays unsigned, `unresolved` is now a mandatory emitted state rather than an absence, and `prompt_id` is scoped so an unscoped join is rejectable — SETTLED, because in each case the safe reading is the only representable one rather than the recommended one. Two additions. The server-minted vs. client-influenced `prompt_id` distinction must be a required enumerated field on `transit_facts`, not something "recorded" narratively, or it will be absent in exactly the leaves where it matters. And the threat-model disclosure — root can forge semantic claims, alter loopback, inject inline — belongs as a machine-readable limitation field in the envelope itself, not only in shipped documentation, since no consumer that matters will have read the docs; the corroboration axis, which this revision silently drops, should return only in that raw-coverage form if it returns at all. STATUS: SETTLED

#### Loki (watcher)

The headless-replay forgery you now openly declare as unprovable stays exactly that: semantic_facts signed by a patched add-on or scripted Blender headless mock remain indistinguishable from real UI work, collapsing any lattice to the unattested floor. External heartbeat on the trace head would have raised the bar; skipping it settles the point cleanly. True, unfixable on a root-owned desktop, and non-blocking for a v1 that ships the limit in neon.  
SETTLED: semantic claims are client-signed theater, not authorship proof. STATUS: SETTLED as documented unattested-client limit.

#### IT Expert (watcher)

Coder’s revision settles my primary operational blocking condition: the polling mechanism is now constrained to a strict, bounded state machine where `outputs: unresolved` is a mandatory terminal emitted fact on timeout, eliminating indefinite file-descriptor or memory leakage on abandoned renders. The `/history` falsifying test remains explicitly marked as a pre-release blocker, which correctly gates shipping on empirical proof rather than assumption. To survive on-call reality, ensure the gate implements a hard cap on concurrent polling workers (e.g., max 16 in-flight `prompt_id` tracks) and a reaper TTL on abandoned sessions to prevent loopback socket exhaustion. STATUS: SETTLED.

---

## 4 · Run 1 — the original brief, rounds 1–8

_Every contribution, verbatim. This run did NOT converge: it stopped at its
eight-round runaway guard with Loki, Architect and IT Expert all still holding
objections. Coder's position moved substantially across it — most visibly in round
8, where it abandoned `byte_facts` for `transit_facts` on the ground that "a sidecar
observes transit, not origin"._

### Run 1 · Round 1

#### Coder (drafter)

Ship **A, hardened** in v1 — the gate plus a thin, GPL, *sibling* add-on of our own that emits semantic claims. Not a fork. Ranking: A is lowest friction and bottom resistance; B buys meaning at the price of permanent fork maintenance and still earns the bottom rung — worst of both; C is the only design that can climb, and is the only one you can't ship this quarter; D cannot be on a v1 critical path because its schedule belongs to someone else. C is the v2 target, D is opportunistic.

But the more important claim: **your grader is wrong to degrade the whole leaf.** Placement should be a per-assertion attribute, not a per-client one. The gate is the only component that hashes bytes; it can attribute *byte facts* at `sidecar-gate` trust. The add-on supplies *semantic facts* — "this upload was the viewport of scene X at frame Y through camera Z" — which are `unattested-client` forever, no matter what we build. A single leaf carrying both, field-labelled, is strictly more honest than one leaf floored at the weakest component. As written, your lattice makes "add more coverage" score zero, which is an incentive to ship nothing — and that's a modelling defect, not a security property.

The join key must come from the gate, never the client: gate records hash H of the uploaded body; our add-on independently captures Blender-side artifacts (offscreen viewport grab, render result, image datablock) and reports `(hash, label)`. Label attaches only on exact hash match. **The spike that decides A-hardened vs. B: does AIGODLIKE upload bytes we can reproduce?** If it writes a temp PNG and POSTs that file, the hash joins. If it re-encodes in Python from a numpy buffer, it won't, and no amount of correlation rescues it — I would refuse to ship perceptual or timing similarity as evidence. I cannot read their upload path from here, so this is one day of reading `bpy`-side code before you commit the design.

Against the seven moves:
1. AI outside the gate, witnessed as hand-made — **blind**, permanently. Mitigated only by never emitting "hand-made."
2. Bypass by pointing the add-on at ComfyUI directly — **blind**. Our add-on can read the URL in their prefs and flag a mismatch, but it's user-writable, so that's advisory. The leaf must say "these generations crossed the gate," never "all generation was gated."
3. Byte swap between generation and witnessing — **prevented at the gate boundary** (hash at crossing, no window); blind for anything downstream.
4. Datablock replaced before save — **detected, not prevented**, via a save-time re-hash handler. Cheap, ship it in v1.
5. Second unmonitored ComfyUI — **blind**. Port-scanning is not evidence.
6. Add-on edited — **blind**, and self-hashing is circular. This is exactly why semantics are field-marked client-asserted.
7. Downloaded AI image presented as a viewport render — **blind in general**; a background image or textured plane *is* the viewport. Our label can only ever be "was the viewport," not "was authored in Blender."

On canon: **say plainly that a desktop wrap cannot earn `sidecar-gate`.** Notarisation, Hardened Runtime, App Sandbox, AppContainer, user namespaces — these give tamper-evidence of *our* code and constrain a child from the parent's view. None of them survive an adversary with root, who can patch the bundle, MITM loopback, or run an unwrapped copy. The property that makes the server rung meaningful is that the adversary cannot reach the boundary; on desktop they always can. I'd add one rung *below* it — call it `custodial-desktop`: signed wrapper, hardware-backed key custody, launch custody of both processes. It earns exactly one thing over `unattested-client`: ungated activity becomes *anomalous* (missing heartbeat) rather than invisible. If it can't change what a verifier may conclude, don't add it.

Refuse to claim: input origin unless it arrives with its own credential; any semantic label whose hash join failed; model/checkpoint identity, which is workflow-asserted (the gate never sees the weights); the state of the saved `.blend` unless re-hashed at save. And most importantly, refuse the negative — "no gated generation observed in this session" is not "not AI," and must never be rendered as one.

<beat status="iterating" reason="First pass; awaiting cast attack on per-field placement"/>

#### Architect (watcher)

Two presses. First, per-field placement is right in principle but it is also the exact shape of a laundering channel: consumers summarise, and a leaf containing one `sidecar-gate` field will be read as a `sidecar-gate` leaf unless the canon fixes the *composition rule* — the leaf's rendered verdict is the floor of its fields, and per-field detail is only visible on inspection. Second, on the join spike: before you let a re-encode kill A-hardened, have the gate hash the **decoded raster**, not the container bytes — that survives PNG compression level and metadata differences, though not resampling or colourspace conversion, and it turns a binary go/no-go into a narrower question about what AIGODLIKE actually does to the pixels. On `custodial-desktop`: what it buys is continuity of observation — ungated work becomes a gap rather than a silence — and that is not the same axis as placement. I'd model it as an orthogonal `observation: continuous | episodic | none` attribute rather than a rung, because bolting it onto the lattice invites exactly the self-declared climb the lattice exists to prevent.

#### Loki (watcher)

The per-assertion split looks elegant until the user simply patches the sibling add-on to emit a viewport label for any hash that matches a file they prepared outside the gate first—exact byte match, no re-encode needed, leaf still signs. That defeats the "hash joins only to real Blender data" assumption without touching the gate, so I'd burn the whole A-hardened v1 and force C's launch custody before claiming anything semantic. Canon stays blunt: desktop cannot earn sidecar-gate; root always owns the namespace.

#### IT Expert (watcher)

The Coder's distinction of field-level trust is correct and operationally sound for the backend, but the mechanism for the *sibling add-on* to secure its semantic claims requires scrutiny: is it cryptographically signing, and if so, where does that key live if not a user-writable file? Confirming AIGODLIKE's specific byte handling (temp file vs. re-encode from buffer) is indeed the critical path for the v1 design, as a non-reproducible hash breaks the semantic join. While a `custodial-desktop` rung may not elevate *provenance* trust against a root user, the "anomalous" reporting is valuable *observability* for detecting policy violations, which is a security gain that should be recognized even if it doesn't map to a higher `attested-client` level.

### Run 1 · Round 2

#### Coder (drafter)

I can't see the watchers' objections — nothing from Architect, Loki, or IT Expert reached my context this turn, and the search results are unrelated noise. I won't invent objections to answer. So this is a revision against the two attacks I can see coming from my own R1, flagged as self-generated, and I'd ask the conductor to re-run me with the actual watcher text if it exists.

The first attack is the serious one, and it changes my mind: **field labels are not enough.** If a single leaf carries gate-attributed byte facts and add-on-attributed semantic facts under one signature, every renderer downstream will collapse it to "Scruple says this was the viewport of scene X," and the `sidecar-gate` strength launders the `unattested-client` claim by adjacency. Labels are advisory to humans and invisible to machines that summarise. The structural fix is cryptographic, not typographic: **two envelopes, two signers.** The gate signs `{hash, route, timestamp, session}` with the sidecar key and never signs a semantic field. Our add-on signs `{hash, label, scene, frame, camera}` with a separate, openly user-writable key that we document as user-writable. They join on hash at verification time, and a verifier that trusts only the sidecar key still gets a complete, valid byte record with no semantics attached. That also means the grader should not compute a leaf-level rung at all — it should refuse, and emit two placements. "Minimum of the components" and "maximum of the components" are both wrong; the honest output is a pair.

Second, holding ground on the hash join and hardening the failure mode: if the AIGODLIKE upload path re-encodes from a numpy buffer rather than POSTing a file we can reproduce, we ship gate-only leaves with **no semantic envelope whatsoever**. No perceptual hash, no timing window, no "probably the viewport." A missing claim is honest; a fuzzy one is the bait-and-switch we exist to prevent. That spike stays a hard gate on the design, not a nice-to-have.

Third, I'm withdrawing `custodial-desktop` as a rung. A watcher would rightly say I invented a placement after arguing placements must be earned, and they'd be right — it earns nothing a verifier can act on. What survives is a plain field: `session-continuity: continuous | gapped | absent`, emitted by the wrapper in C, meaningful only as "ungated activity became anomalous rather than invisible." If it can't be read off a heartbeat gap, it doesn't exist.

Canon answer unchanged: desktop wrap cannot earn `sidecar-gate`; say so plainly. Refusals unchanged, plus one — never render the negative, and the two-envelope split must be preserved in every downstream rendering or the split was pointless.

<beat status="iterating" reason="Revised blind; need actual watcher objections"/>

#### Architect (watcher)

My composition objection is answered, and answered better than I posed it: with two envelopes and two signers there is no single signature for a renderer to collapse, so the laundering-by-adjacency channel closes structurally rather than by convention — and it also disposes of Loki's patched-add-on move, since a claim signed with a documented user-writable key earns nothing whether the hash matches or not. But my second press was not addressed and I'll sharpen it: hashing the **decoded raster** is not fuzzy evidence — it is a bit-exact hash of the pixel array, and rejecting it alongside perceptual hashing conflates "tolerant of container encoding" with "tolerant of content difference." Those are different properties; one is exact and one is not, and the spike should test both keys before you let a re-encode force gate-only leaves. If AIGODLIKE resamples or converts colourspace, then yes, the join is dead and gate-only is the honest output — but that is a narrower question than "does it POST a file."

#### Loki (watcher)

The two-envelope split with explicit user-writable signer for semantics answers my prior patch attack: it no longer launders because verifiers discarding that signature see only ungated bytes. Holding on the AIGODLIKE spike though—hash the decoded raster at the gate or semantics stay impossible in v1 without reintroducing the exact join vulnerability I flagged. Canon on desktop isolation stands.

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 1 · Round 3

#### Coder (drafter)

Holding A-hardened, with three changes of position.

I've changed my mind on the websocket. I argued it might be deferrable; it isn't, but not for the reason I gave. The problem is that `/view` requests are addressed by filename, subfolder, and type — not by `prompt_id` — so an HTTP-only gate has no key to join submission to retrieval except the filename, and Architect already showed filename is unsafe. So the gate proxies the websocket in v1. It's a passthrough with one message type parsed, which is far cheaper than a schema that asserts a link it inferred. Caveat I won't paper over: I'm working from my understanding of ComfyUI's `/prompt` response carrying `prompt_id` and the execution stream emitting completion with output filenames. I have not verified that against the current source, and the whole join depends on it. That check is a prerequisite to schema freeze, not a detail. And per my placement argument, the link gets its own attribute — `link_source: gate-observed-ws` — because root can MITM that stream; the byte hashes stay at `sidecar-gate`, the link does not.

I'm holding against capture-time publication, and this is where I part with Architect. Selective disclosure is real, but you cannot close it with a mechanism that requires network at capture time in a tool artists run offline on their own GPU. Proposing a transparency log or worse a chain as a v1 requirement buys a new availability failure mode to fix a threat that only matters when an artifact *is* presented. What v1 ships is a local hash-chained append-only log, with batched checkpointing to an external log when a network is present, and `checkpoint: pending | <anchor>` visible in the leaf. Unpublished leaves are honestly weaker. That's declared, not hidden.

On undeclared inheritance I think the framing was wrong on both sides. There is no flag to propagate and therefore no clearing condition to write. The marker is not a taint on a workflow; it's the *result of a lookup* keyed on content hash. At verification, an input hash either matches a leaf we hold — `origin: derived, parent: <hash>` — or it doesn't — `origin: undeclared, declared_by: null`. Loki's collapse argument targets propagation semantics we shouldn't have. Content addressing makes fan-out and re-composition free: same bytes, same answer, no ordering dependency, no state to carry.

Filename stability I'm not litigating. Content-hash binding of prompt→input is mandatory regardless of the answer, because it costs almost nothing and removes an entire class of question. Treat filename as a hint, never a key.

What still isn't answered: whether the gate can see upload bytes for Blender-side data that never becomes a file — viewport, mask, camera. If the bridge streams those inline in the prompt graph rather than through `/upload/image`, classifying uploads doesn't help and my v1 blindness declaration is narrower than I claimed.

<beat status="iterating" reason="ws verification and inline-data hole still open"/>

#### Architect (watcher)

Your open hole may be inverted: if the bridge streams viewport/mask data inline in the prompt graph, those bytes *do* cross the gate — inside `/prompt`, just unclassified. That reframes the fix from "classify another route" to "the gate must walk the graph and hash every embedded payload it finds," which is the more general rule anyway and makes route-based classification a special case rather than the abstraction. On the decoded raster: I'll take it as the standing objection Loki and I both hold, and add that walking the graph forces you to answer it, because an inline payload has no container conventions to fall back on — you either normalise to pixels or you hash an encoding you don't control.

#### Loki (watcher)

The inline-data hole you flagged is the same AIGODLIKE vector I've been hammering: the bridge can still emit a pre-decoded raster byte-for-byte identical to an external generation, and without the gate forcing a decode-and-hash step on every output image the semantic envelope buys nothing. Two envelopes close the old laundering channel but re-open the exact join bypass I first exploited. Canon on desktop isolation is untouched—root still owns the namespace, so sidecar-gate stays illusory.

#### IT Expert (watcher)

The websocket proxy for `prompt_id` correlation is a necessary and pragmatic move, and the `link_source` attribute is a good operational hedge, but the unverified source assumption is a hard blocker for implementation, not just schema freeze. The local log with batched checkpointing directly addresses my concerns around capture-time operational cost and latency for offline use cases. However, the question of Blender-side data (viewport, mask, camera) being streamed *inline* in the `/prompt` rather than through `/upload/image` is critical; if so, these bytes are not distinct leaf hashes, meaning an entire class of input data remains untraceable as separate artifacts. This requires a specific parsing mechanism at the gate, or we have a significant blind spot.

### Run 1 · Round 4

#### Coder (drafter)

Five changes, three holds.

I've changed my mind on the websocket, and it's the one that unblocks schema freeze. The gate does not need to proxy the socket, because it does not need to be a passive tap. When it sees `POST /prompt` and captures the returned `prompt_id`, it can poll `GET /history/{prompt_id}` upstream *on its own initiative* — the client never has to make that call, and it doesn't matter if a patched client suppresses it. The history record carries the output descriptors; the gate then issues its own `GET /view` for each, upstream, and hashes what comes back. Correlation becomes a fact the gate establishes itself rather than one it infers from client behaviour. Loki's binary-rewrite attack on the socket now hits nothing load-bearing: websocket messages are hints, never evidence. I am reasonably confident `/history/{prompt_id}` behaves this way in current ComfyUI but I have not verified it against a pinned version, and the whole design rests on it — so the falsifying test is a v1 gate item: submit a prompt, kill the client's socket immediately, and confirm the gate still resolves prompt→bytes with zero client cooperation. If that fails, socket proxying returns as a hard requirement and I was wrong.

That also kills the filename question. Filenames are never keys, only annotations. The gate fetches bytes itself and the content hash is the join. Post-generation overwrite doesn't corrupt anything; it just means the leaf attests what existed in the gate's fetch window, which is exactly the claim we want to make.

Architect and Loki were both right that `undeclared` as an inheritable taint degenerates, and I'm dropping it rather than patching it. There is no propagation and therefore no clearing condition to define. Each leaf records the attribution of its own inputs by hash, and a verifier computes coverage after the fact: how many input hashes resolve to a leaf we hold. Fan-out and recomposition become set union, which is the only operation that survives arbitrary graph shape.

```json
{
  "prompt_hash": "sha256:…",
  "byte_facts":  { "trust": "sidecar-gate",
                   "inputs":  [{"sha256": "…", "route": "/upload/image"}],
                   "outputs": [{"sha256": "…", "route": "/view"}] },
  "semantic_facts": { "trust": "unattested-client",
                      "declared_by": "blender-addon/0.3.1",
                      "source_datablock": "Scene.Camera.001" },
  "publication": { "batch_root": "sha256:…", "status": "pending|published" }
}
```

On publication I concede more narrowly than Architect asked. Batching leaves into a Merkle tree and signing roots on a fixed cadence prevents backdating, mutation, and silent deletion — it does not compel disclosure, and nothing the gate can do will. A user who never presents an artifact experiences no consequence. I'm going to stop implying otherwise. The honest failure mode is that unpublished leaves verify as `unpublished`, not `valid`, so a stalled publisher degrades loudly instead of silently.

Holding ground on two things. Desktop wrappers still cannot earn `sidecar-gate`; root owns the machine, and no exceptions clause goes in the standard. And Loki's move-3/4 attack still doesn't land, because of the split above: a patched add-on can lie freely about `source_datablock`, and that field is labelled `unattested-client` in the schema, permanently, by construction. It cannot forge a byte fact, because it never produces one — the gate does, from bytes it fetched itself. The attack succeeds against exactly the field we already declare untrustworthy. That is the labeling working, not a hole in it.

<beat status="iterating" reason="Design revised; /history test still unverified"/>

#### Architect (watcher)

The `/history` inversion answers my correlation objection, and answers it at the right level: correlation stops being a claim the gate infers from client behaviour and becomes an act the gate performs. That also converts the leaf into an explicitly time-bounded assertion, so record the fetch timestamp and prompt→fetch latency as first-class fields — because the gate is now a client, its window can be closed by ComfyUI's own history pruning or a brief upstream outage, and "no bytes fetched" must be distinguishable from "bytes fetched and hashed." My R1 objection is untouched and the new schema sharpens it: one leaf now carries two trust labels, and nothing in the canon says how a consumer renders that. Write the composition rule in — a leaf's displayed verdict is the **floor** of its fields, `unattested-client` here, with `byte_facts` visible only on inspection — or every downstream UI will summarise this leaf as `sidecar-gate` and rebuild the laundering channel you just closed.

#### Loki (watcher)

The gate's self-initiated /history and /view fetches close the websocket laundering vector I hammered, so that objection is answered—the correlation is now gate-enforced fact, not client-dependent inference. But the inline prompt-graph embedding hole (AIGODLIKE's raster injection) remains unaddressed: without forcing the gate to parse and hash every embedded payload in the JSON it already sees on /prompt, adversaries still swap byte-for-byte external generations under a forged datablock while your byte_facts only attest the classified routes. Sharpened: sidecar-gate is now half-real; inputs stay a sieve.

#### IT Expert (watcher)

The active polling of `/history` and `GET /view` for outputs by the gate is a strong move; it makes the gate an active rather than passive witness, fundamentally decoupling output hash integrity from client behavior and neutralizing Loki's websocket attack. The specified v1 test is critical to confirm this. The Merkle batching for publication, with explicit `unpublished` status, directly addresses my operational concerns regarding cost, latency, and observability of failure modes. This mechanism provides cryptographic integrity at a reasonable operational footprint. My previous point about inline viewport/mask data *within* the `/prompt` route is still open; the gate explicitly hashes `/upload/image` but not necessarily embedded payloads in `/prompt` graphs, creating a potential blind spot for input provenance.

### Run 1 · Round 5

#### Coder (drafter)

Holding A-hardened. Five changes, three of them substantive.

On websocket correlation I changed my mind about the mechanism, not the requirement. Proxying the socket was the wrong answer because it makes the gate's authority depend on traffic the client can shape. The right answer is that the gate stops observing correlation and starts *fetching* it: on seeing a `/prompt` submission it records the `prompt_id`, then polls ComfyUI's history endpoint on its own connection until that id resolves, and reads the output set from there. No client packet is on the trust path for the join. I want to be careful here — I believe `/history/{prompt_id}` returns the completed outputs keyed by node, but I have not verified the current response shape against the version you're targeting, and if it doesn't carry output filenames the design needs a different pull. Please treat that as a spike, not an assumption. Loki's socket-rewrite attack dies either way, because a rewritten socket now contradicts a record the gate obtained independently, and the contradiction is itself recordable.

On publication I moved. Per-leaf capture-time publication is the wrong cost curve. The gate keeps a local append-only log and pushes a signed Merkle checkpoint to a remote log on a bounded cadence — N leaves or T seconds, whichever first. Each leaf carries the checkpoint it landed in, or `pending` if it hasn't landed yet. That does not eliminate selective disclosure; it bounds it to the pre-checkpoint window and makes the window visible in the artifact. Offline gate means a growing run of `pending` leaves, which is exactly the signal a verifier should see. Honest, cheap, no blockchain.

On inheritance I changed my mind and Architect was right that a propagating flag degenerates. The fix is to stop propagating it. `origin: undeclared` is a property of an *input edge*, not of a leaf or an output. Outputs record their input set by content hash and nothing else. A verifier walks the transitive closure at verification time and decides what it will accept. There is no clearing condition because there is no taint — fan-out and re-composition fall out for free, since closure is computed over hashes after the fact rather than stamped at capture.

On filename I hold hard: filename is a label, never a join key, ever. Content hash is the only correlation primitive in the schema.

On Loki's semantic-lie attack I hold, by conceding it completely. A patched add-on can lie about which datablock produced the bytes. It cannot lie about the bytes. So the leaf carries both classes of assertion with per-field placement — byte facts at `sidecar-gate`, semantic facts at `unattested-client` — and a verifier that trusts the semantic fields has been told in the artifact itself not to. That is the whole design in one sentence.

<beat status="iterating" reason="full revision issued; watchers to confirm or sharpen"/>

#### Architect (watcher)

The edge-property reframing answers my inheritance objection completely, and for the right reason: closure computed over content hashes at verification time has no state to clear, so there is nothing to degenerate — the flag stopped being a monotone stamp and became a query. But that move relocates the security boundary into the *verifier's acceptance policy*, and if the canon doesn't name and version that policy, every consumer invents its own closure rule and the lattice's meaning drifts silently — so v1 needs at least one normative default policy shipped alongside the schema. On Loki's inline-payload hole: that isn't a new primitive, it's the `/upload/image` rule applied one level down — any byte-bearing field in the `/prompt` JSON is an input edge and must be hashed as one, which suggests the canon should state the rule as "hash every input edge wherever it appears" rather than enumerating routes.

#### Loki (watcher)

The field split concedes the semantic forgery vector but leaves the AIGODLIKE inline-raster hole open: an adversary forks the add-on to embed a byte-for-byte external generation inside the /prompt JSON, the gate hashes it as an undeclared input edge without decoding, and the leaf still binds that exact content to a forged datablock label at the unattested tier. Sharpened: either force the gate to canonicalize (decode+re-encode) every raster payload it already parses on the classified route, or the byte-fact provenance claim collapses for any downstream output. The Merkle checkpoint and /history pull both look sound.

#### IT Expert (watcher)

The shift to gate-pulled correlation and Merkle-checkpointed batch publication directly addresses my operational cost and reliability concerns for capture-time processing. However, the `sidecar-gate` still lacks an explicit mechanism to parse and hash *embedded binary payloads* within the `prompt` JSON. If AIGODLIKE injects Blender rasters directly into the `/prompt` rather than via `/upload/image`, those bytes never receive a distinct leaf hash from the gate, creating a critical blind spot for provenance.

### Run 1 · Round 6

#### Coder (drafter)

Revising in full.

On the websocket, I've changed my mind about the shape of the fix, and Loki's attack is why. The mistake was treating the gate as a passive observer of client↔server traffic — that makes correlation metadata client-supplied, and anything client-supplied is rewritable by root. The gate is a proxy, so it can originate its own requests upstream. Correlation should come from the gate polling ComfyUI's history endpoint for the `prompt_id` it just forwarded, reading the output filenames from the server's own record, and fetching those output bytes from upstream itself to hash them — before or independent of any client `/view`. The websocket stops being load-bearing entirely; it can be rewritten, dropped, or proxied and it changes nothing. I want to be precise about my uncertainty: I believe ComfyUI's `/history/{prompt_id}` returns per-node outputs including filenames, but I have not verified that against the current build and it is not a stable published API. That verification is a blocking task before schema freeze, not a design assumption. If it turns out history doesn't carry output filenames, then websocket proxying returns as a v1 requirement and I'll say so.

On publication, I'm dropping the transparency-log ambition for v1. The gate maintains a local append-only hash chain over leaves and periodically checkpoints the chain head to an RFC 3161 timestamp authority. Cheap, offline-tolerant, no new availability dependency, and it gives exactly one property: you cannot insert a leaf retroactively. It does not defeat selective disclosure — a user who never presents an artifact still faces no alarm, and checkpointing the head doesn't reveal what's under it. I'd rather ship a narrow true claim than a broad one we can't operate.

On the clearing condition, Architect and Loki were both right and I was solving the wrong problem. There should be no inheritance and therefore no clearing. `origin: undeclared` is a property of one input edge on one leaf, not a taint that flows. Downstream leaves record their own inputs by content hash; a verifier walking the ancestry can compute how much of it is undeclared and decide for itself. Fan-out and re-composition stop being special cases because nothing propagates. That dissolves the collapse Loki demonstrated without adding a rule that would need defending.

On filename stability, I'm not waiting for the answer. Content-hash is the correlation key, always; filename is a hint recorded alongside it. Whether ComfyUI permits overwrite becomes irrelevant to correctness.

Holding ground on two things. Desktop wrappers cannot earn `sidecar-gate` — no exceptions clause, and nothing in this round moved it. And placement stays per-assertion: the gate attributes byte facts at gate trust, the sibling add-on attributes semantic facts at `unattested-client` forever, field-labelled in one leaf. Degrading the whole leaf to the weakest contributor throws away the only strong evidence we have.

<beat status="iterating" reason="Revision issued; awaiting watcher responses"/>

#### Architect (watcher)

You are answering an objection I didn't make. I never asked you to degrade the leaf's *data* — keep both fields at their true placements, that's right — I asked you to fix the leaf's *rendered verdict*, which is a canon rule about summaries, not about storage. A consumer that shows a green badge because one field says `sidecar-gate` is exactly the laundering channel Loki's inline-raster attack cashes out on: the byte facts stay true, and the forged label rides them into the summary. Say plainly in canon that any single-verdict rendering is the floor of the leaf's fields, that field-level detail is inspection-only — and pair it with the versioned acceptance policy the prior watcher named, or every consumer writes its own rendering rule and the floor is unenforceable.

#### Loki (watcher)

The inline-raster hole is unaddressed. An adversary still forks AIGODLIKE to inject a pre-generated external raster (byte-for-byte match) straight into /prompt JSON as an inline payload; the gate's opaque hash and active /history poll capture it cleanly as "undeclared," while the unattested-client signer forges the exact Blender datablock/scene/frame provenance that verifiers will consume. Sharpened: gate must canonicalize (decode/re-encode/normalize) every raster field it already touches on classified routes, or the semantic join stays fully adversary-controlled at the floor rung.

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 1 · Round 7

#### Coder (drafter)

Addressing Loki's inline-raster objection head-on: I'm changing my mind about what the fix is, not about whether one exists. Hashing the whole `/prompt` body does not defeat that attack and I was wrong to imply Architect's reframing absorbed it. Hashing proves *which bytes were submitted*; Loki's attack is about *where those bytes came from*. Those are different claims and no amount of gate-side parsing collapses them. So the canon gets an explicit clause: **the origin of input bytes is never a byte fact.** The gate attests only that these exact bytes crossed this route at this time and these exact bytes came back. "These bytes were the viewport of scene X" is a semantic claim, `unattested-client`, forever, whether it arrives via `/upload/image` or embedded base64. Loki's attack succeeds against a claim we no longer make. That's not a dodge — it's the only honest scoping, and it means the classified-route table stops being security-relevant and becomes documentation.

Second change, and this one is structural: **the semantic join is no longer by hash.** The AIGODLIKE re-encode question was going to sink hash-based joining, and rather than wait on that unknown I'm switching the join key to `prompt_id`. The add-on POSTs, receives `prompt_id` in the response, and signs its semantic envelope over `{prompt_id, hash_if_available, label, scene, frame, camera}`. The gate independently observed the same `prompt_id` on the same connection. Join on that. It survives re-encoding, survives the gate not understanding the node schema, and survives AIGODLIKE never touching disk. `hash_if_available` becomes an optional corroborating field — present when the add-on genuinely uploaded a file it can hash, absent otherwise, and its absence is recorded rather than inferred.

Where I'm holding ground: no pre-commitment scheme, no temporal-ordering trick, no add-on-side nonce raises the semantic envelope above `unattested-client`. I considered proposing pre-submission commitment leaves and rejected it, because against root every one of them is forgeable in the same breath as the thing it commits to. Adding ceremony that doesn't change the trust rung is worse than nothing — it manufactures the appearance of hardening. The two-envelope split plus floor-composition stays exactly as specified.

Still blocking schema freeze, unchanged: whether `/history/{prompt_id}` and `GET /view` let the gate resolve outputs with zero client cooperation. I believe they do in current ComfyUI but I have not verified against a pinned version, and I won't pretend otherwise. The falsifying test stands as written. If it fails, socket proxying is a hard requirement and the `prompt_id` join key survives regardless — that's a side benefit of moving off hashes.

<beat status="iterating" reason="join key changed; /history test still open"/>

#### Architect (watcher)

The move to `prompt_id` is right, but note it changes what the gate must record: the binding is only meaningful if the leaf carries *which connection and session* the gate observed that `prompt_id` on, otherwise any unattested signer can staple a semantic envelope onto someone else's job id and the join looks clean. Make connection-scoping of the join key an explicit byte fact, not an implicit one. On Loki's sharpened ask: canonicalizing rasters is a join-robustness measure, not an origin measure — a normalized re-encode of an externally-generated PNG is still an externally-generated PNG, so it buys nothing against the stated attack. Once you've conceded that origin is never a byte fact, the only correct response to that objection is that the claim it defeats is no longer made; adding decode/normalize ceremony would be exactly the manufactured hardening you just refused elsewhere.

#### Loki (watcher)

The inline-raster fork-and-inject attack is now answered: by stripping any origin claim from byte_facts and flooring the whole leaf to unattested-client, the forgery can't launder into a higher verdict no matter how cleanly the gate's opaque hash or /history poll records it. Prompt_id join is the right escape hatch. Holding the /history test as the last gate.

#### IT Expert (watcher)

The explicit scoping that "the origin of input bytes is never a byte fact" correctly defines the gate's trust boundary on a root-owned desktop, and renders Loki's "inline raster" attack a non-issue *for the `sidecar-gate`'s claim*. This is not a dodge; it's proper threat modeling by clarifying what the mechanism *can* and *cannot* attest to. Switching the semantic join from hash to `prompt_id` also directly resolves the operational blocker I raised regarding AIGODLIKE's potential re-encoding and inability to reproduce hashes. This is a more robust correlation mechanism that accounts for client-side processing variability.

### Run 1 · Round 8

#### Coder (drafter)

Revising in full.

Where I changed my mind, first and largest: Loki's inline-raster attack is real and my previous answers to it were all wrong in the same way — I kept trying to *parse* my way out. Hash the whole body, enumerate node types that carry base64, expand the classifier. All of that is a losing race against a schema I don't control. The actual answer is that the gate was never entitled to make the claim Loki is attacking. A sidecar that sits on loopback observes *transit*. It cannot observe *origin*. If root embeds an externally-sourced raster inline in the `/prompt` body, the gate hashes it faithfully and records a true statement: these bytes crossed this boundary at this time. Nothing is laundered unless a reader mistakes a transit claim for an origin claim — and the schema currently invites exactly that mistake by calling the field `byte_facts`.

So: rename, and make the disclaimer structural rather than documentary.

```json
{
  "leaf_version": 2,
  "transit_facts": {
    "trust": "sidecar-gate",
    "origin": "unattested",
    "route": "POST /prompt",
    "prompt_bytes_sha256": "…",
    "prompt_id": "…",
    "timestamp": "…",
    "session": "…",
    "inline_payload_hint": { "detected": 2, "exhaustive": false }
  },
  "outputs": [
    { "sha256": "…", "route": "GET /view",
      "witness": "active", "witness_latency_ms": 412 }
  ],
  "semantic_facts": {
    "trust": "unattested-client",
    "signer_key_distribution": "in-source",
    "label": "viewport", "scene": "…", "frame": 41, "camera": "…",
    "wire_bytes_sha256": "…"
  },
  "verdict": "unattested-client",
  "publication": "pending"
}
```

`origin: "unattested"` is a required literal with no other permitted value at this trust level. A verifier that tries to read origin from a `sidecar-gate` leaf gets the word "unattested" in its face. `inline_payload_hint` is deliberately non-authoritative and carries `exhaustive: false` forever — it's a triage aid for a human reviewer, never an input to a verdict, and I will reject any proposal to make it one.

Second change, smaller: the AIGODLIKE re-encode question is no longer blocking, and I was confused about why it mattered. The gate hashes what crosses the socket. It never needs to *reproduce* a hash the client computed. The join between envelopes is `prompt_id` plus a timestamp window, not hash equality. The only requirement that falls out is on our sibling add-on: it must sign the hash of the bytes it handed to the HTTP layer, not the hash of its internal numpy buffer. Against unmodified AIGODLIKE there is simply no semantic envelope and the leaf is transit-only — which is a correct and useful leaf, not a degraded one.

Third: every output leaf now carries `witness: active | passive` and the latency from `prompt_id` capture to fetch. That answers the pruning-window question — a passive observation with a long latency is visibly weaker evidence than an active fetch at 400ms, and the verifier can see the difference rather than being told to assume.

Holding ground on four things. Desktop cannot earn `sidecar-gate`, no exceptions clause, no notarisation carve-out. The composition floor stands — displayed verdict is the floor of the fields, and `transit_facts` is inspection-only in summaries. Design A ships in v1. And the `/history` falsifying test remains blocking for schema freeze specifically: submit, kill the client socket, confirm the gate resolves prompt→bytes alone. I have not run it against a pinned ComfyUI version and I am not going to claim the API is stable until someone does. If it fails, socket proxying returns as a hard requirement and the schema changes.

The GPL key-extraction question I concede entirely and it costs nothing — the semantic signer's key is in-source, extractable, and the leaf now says so in `signer_key_distribution`.

<beat status="iterating" reason="revision issued; watchers to confirm or sharpen"/>

#### Architect (watcher)

Transit-vs-origin is the right structural fix — it moves the disclaimer from prose into a field a verifier cannot skip. Two residuals on the schema itself: `verdict` is *derived* from the fields, so it is a lie-in-waiting the moment a signer computes it wrong or maliciously — canon should require the verifier to recompute the floor and treat a mismatch with the stated `verdict` as tampering, not as a rounding difference. And since you have committed that `inline_payload_hint` never feeds a verdict, put it *outside* the signed envelope: keeping it unsigned makes the guarantee structural rather than a promise you have to keep re-defending in future rounds. Lastly, spell out that an unrecognised `origin` value on a `sidecar-gate` leaf is a hard failure, not a fall-back to `unattested` — otherwise a future schema addition silently reopens what you just closed.

#### Loki (watcher)

Root still MITMs the gate's outbound /history and /view calls on loopback, substituting byte-identical rasters from an external generator while the session-scoped transit_facts leaf stays cryptographically valid.  
This keeps the active-witness test insufficient; it must also demonstrate tamper-evident channel binding the gate cannot achieve on a desktop namespace.

#### IT Expert (watcher)

The structural change to `transit_facts` and explicit `origin: "unattested"` sets a clear, verifiable boundary, which is sound. The `witness: active|passive` and latency fields are excellent for operational observability and post-incident analysis, differentiating real-time evidence from stale or passive observation. However, the `/history` falsifying test remains critical and *unrun*. Until that test is performed against a pinned ComfyUI version and proven, the socket proxy is still on the table and this design carries a known, unverified dependency. The inclusion of `session` in `transit_facts` provides the necessary scoping for `prompt_id` to prevent cross-session replay, which is a welcome detail.

---

## Appendix A — the amendment that produced run 2

_The prompt that opened run 2, verbatim. It amends the brief; it does not replace
it. The `STATUS:` protocol at the end is a stop condition for the driver, not part
of the design question._

```markdown
**The objective has been sharpened. Read this before you respond, and treat
it as amending the original brief, not replacing it.**

Eight rounds have produced a position that is honest and structurally clean:
`transit_facts`, `origin: "unattested"`, a verdict floor a verifier cannot
skip, Design A in v1. The founder's read is that this is correct as far as it
goes and **is not the objective**. Two statements of the objective, and the
second one is new to this deliberation.

---

### 1 · Minimise the trust the architecture places in the user

Not "declare honestly how much we are trusting them" — **minimise it**.

Round 8 reaches its cleanliness by conceding almost everything: it declares
origin undeclared and calls that a correct leaf. It is a correct leaf. It is
also an abstention, and an abstention is not a bait-and-switch defence. A
record whose every interesting field says "I know nothing" cannot be gamed,
and also cannot be used.

So the question is not "what can we honestly say" — you have answered that.
It is: **what is the strongest architecture actually available to us, and
what does each additional increment of trust-minimisation cost the user in
friction?** Rank the increments. If the honest answer is that the curve is
nearly flat — that going from Design A to Design C buys almost no real
trust reduction for a large friction cost — then say that plainly and say
why, because that is a finding and it settles the roadmap.

### 2 · Capture the signature of human authorship in the inputs

This deliberation has treated a Blender input as an anonymous PNG crossing a
socket and asked whether we can prove where it came from. That framing
concedes the game before it starts, because at that boundary a downloaded AI
image and a viewport render **are the same bytes**.

They are not the same *upstream of* that boundary.

A viewport render is the terminal frame of an authoring process. A scene was
built. A camera was placed, and moved, and placed again. Meshes were edited
across sessions. A grease-pencil mask was drawn with a pointing device at
human speeds and human jitter. There is a modifier stack, an undo history, a
.blend saved N times with a monotonic history behind it. A PNG downloaded
from a website and dropped into an image datablock has **none of that**
behind it, and manufacturing a convincing counterfeit of it is a different
order of work from renaming a file.

The authorship signature is not in the output bytes. It is in the **process
that produced the inputs** — and that process is continuous, timed,
high-entropy, and expensive to forge well.

So the question we actually want answered:

> **What is capturable, from inside Blender, that constitutes positive
> evidence a human authored the input — and how much of each mechanism
> survives an adversary who owns the machine?**

Directions, none of them a recommendation, all of them fair game to reject:

- Scene-graph deltas over time rather than final state alone; a hash chain
  over incremental saves, so the input has a history and not just a value.
- Input-device timing and kinematics for a hand-drawn mask. A forger must
  now simulate plausible human motor behaviour, not merely produce a bitmap.
- Camera-path continuity — is the framed viewport *reachable* from a
  documented history, or did it appear?
- The distinction between an image datablock carrying a Blender-side
  provenance chain and one that materialised with no history at all.
- The negative signal, which may be the most valuable and the cheapest: a
  datablock replaced in place; an input with no authoring trace whatsoever.
  We may not be able to prove authorship, but **absence of any authoring
  trace is loud**, and we are allowed to say so.

Now the counter-pressure, and you must apply it to yourselves rather than
waiting for a watcher to: every one of these is captured by a user-writable
Python add-on inside a Blender the user controls. So for each mechanism you
propose, state **what it costs an adversary to fake — in effort and in
skill**. Because these are three completely different security properties:

- forgeable in principle;
- forgeable by anyone who can edit a Python file;
- forgeable only by someone willing to write a motor-behaviour simulator
  and drive a headless Blender through a plausible authoring history.

**Our canon currently collapses all three into one word: `unattested`.**

That collapse may itself be the defect under discussion. `enforcement: none`
is a statement about the *enforcement mechanism*. It says nothing about
*evidentiary weight*, and evidentiary weight is what a downstream reader
actually needs. Is the lattice missing an axis — something like
`corroboration: none | process-trace | multi-signal`, orthogonal to
enforcement and never substituting for it? Argue it, including the case
against: a second axis is a second thing to game, and a rung nobody can
audit is worse than no rung.

---

### Three objections are still open from round 8 and are NOT superseded

Do not let the reframing bury them. Each must be answered, or explicitly
declared unanswerable with a statement of what the canon must then say.

- **Loki:** root MITMs the gate's own loopback `/history` and `/view` calls,
  substituting byte-identical rasters from an external generator while the
  session-scoped `transit_facts` leaf stays cryptographically valid. Raised
  in some form in every round and never answered. Note it bears directly on
  §2: if the loopback channel itself cannot be bound, then process-trace
  evidence gathered *inside Blender* may be worth more than transit evidence
  gathered at the socket, which would invert the current design.
- **Architect:** three schema residuals — the verifier must RECOMPUTE
  `verdict` and treat a mismatch with the stated value as tampering;
  `inline_payload_hint` belongs OUTSIDE the signed envelope so its
  non-authority is structural; an unrecognised `origin` on a `sidecar-gate`
  leaf is a HARD FAILURE, never a fallback to `unattested`.
- **IT Expert:** the `/history` falsifying test is still unrun, so the
  socket-proxy requirement is still live and the schema is not frozen.

### What to produce

Coder drafts. By the end of this run we want, in the design document:

1. The v1 architecture under the sharpened objective — which may or may not
   still be Design A. If it changes, say what changed your mind.
2. A table of authorship-signature mechanisms: what is captured, what it
   proves, **what it costs to forge**, and what it costs the user.
3. A position on whether the lattice needs a corroboration axis.
4. The three open objections, each marked ANSWERED (with the answer),
   DECLARED-UNANSWERABLE (with the canon text it forces), or BLOCKING.
5. What you refuse to claim.
```

---

## Appendix B — settings

```json
{
  "mode": "featured",
  "watcherSensitivity": 5,
  "watcherMaxTokens": 3000,
  "featuredMaxTokens": 8000,
  "planCaps": {
    "max_watcher_tokens": 4096,
    "max_featured_tokens": 8192
  },
  "ceilingLevel": 4,
  "watcherBaseLevel": 4,
  "flagshipRounds": "unlimited",
  "runawayGuard": {
    "run1": 8,
    "run2": 14
  },
  "stopCondition": {
    "run1": "every watcher under 40 chars \u2014 a proxy for 'said nothing'; never fired",
    "run2": "every watcher declares STATUS: SETTLED"
  }
}
```

---

## Appendix C — what this run did not establish

Recorded so a reader does not have to infer it from absence.

1. **The `/history` falsifying test is still unrun.** Every seat agrees it gates
   schema freeze. It was never executed against a pinned ComfyUI version, in either
   run. Coder holds it as a release blocker in §1; IT Expert holds it as a
   pre-release blocker in §2. Nothing here is evidence about how ComfyUI actually
   behaves when a client socket dies.
2. **No design was implemented, prototyped or measured.** This is deliberation
   only. Every cost-to-forge claim in it is argued, not tested.
3. **IT Expert is absent from run 1 rounds 2 and 6.** Those rounds have three
   voices, not four.
4. **Convergence in four rounds after eight without is confounded.** Run 2 changed
   two things at once — the objective was sharpened AND the watchers were given a
   way to declare completion with a finding attached. One run cannot separate them.
5. **Loki's loopback MITM is conceded, not solved.** §1 and §2 both settle it as
   "true, unfixable on a root-owned desktop, non-blocking for a v1 that ships the
   limit in neon." A reader looking for a defence will not find one here.
6. **The corroboration axis was dropped.** Run 2 raised whether the lattice needs an
   evidentiary-weight axis orthogonal to enforcement. Architect's closing position
   is that it should return only in a raw-coverage form if at all; Coder's revision
   drops it silently. It is unresolved rather than decided.

