# Unity MCP Ghost: deep audit and open-source research

Date: 2026-09-04  
Repository: [CrispyW0nton/Unity-MCP-Ghost](https://github.com/CrispyW0nton/Unity-MCP-Ghost)  
Audited snapshot: `codex/phase2-parity-tools` at `cb79e299fd822ee2bd739e45fa4ddc268fc48317`, including the user's uncommitted `collider_setup` and `rigidbody_setup` work

## Executive verdict

Ghost has grown into a broad editor-automation prototype: the audited working tree exposes 74 tools, 9 fixed resources, 7 resource templates, and 2 prompts. It can inspect scenes and assets, mutate common Unity objects, edit C# source, request compilation/tests, run repair helpers, and capture/diff screenshots.

It is **not yet a trustworthy autonomous Unity operator**. Several success/failure paths are wrong, the “durable” parts are largely in-memory or non-transactional, the unauthenticated bridge accepts mutations from any local caller, there are no repository-owned unit/Unity/CI tests, and the 74-tool surface is exposed eagerly. Most importantly for GAM 215 Modules 1–2, Ghost cannot control normal Play mode, send PageUp/PageDown to the Game view, wait for a specific compile generation, assert Console/runtime outcomes, or run and restore a parameterized truth-table/boundary matrix.

The current state is best described as:

| Dimension | Verdict | Reason |
| --- | --- | --- |
| Breadth | Strong prototype | 74 tools cover a useful parity floor plus early semantic/repair/visual work. |
| Correctness | Red | Failed Unity tests and soft bridge failures can be surfaced as success; diagnostics and compile waits can be stale. |
| Safety | Red | No bridge credential/authorization boundary; destructive metadata and batch risk are inaccurate. |
| Reliability | Red | No durable operation state, request deduplication, cancellation, atomic queue claims, or true batch rollback. |
| Scale and context efficiency | Amber/red | Eager schemas, synchronous whole-project scans, little pagination, and a monolithic C# registry. |
| Course authoring | Amber | Source text operations cover the C# constructs, but validation can lie. |
| Course end-to-end execution | Red | No normal Play/Stop, Game-view input, runtime assertions, or scenario-matrix runner. |
| Release readiness | Red | No automated test suite or CI, no tracked license/security policy, stale install docs, and nine current dependency advisories. |

The first release target should therefore be **Course-Ready Reliability**, not another domain-tool expansion.

## Method and boundaries

This audit combined:

- static review of the TypeScript server and Unity C# package;
- live introspection of the built MCP catalog;
- `npm run typecheck`, `npm run build`, `git diff --check`, `npm audit --json`, and `npm outdated --json`;
- complete review of all 25 supplied PDFs and both preview MP4s, used only as evidence of the requested capability surface;
- screening of the first 100 non-curated GitHub results for `unity mcp`, followed by deep reads of 12 current, licensed, architecturally distinct implementations;
- review of the official 2026-07-28 MCP material and Unity's first-party MCP as external benchmarks.

No Unity Editor was launched during this audit. Unity-side compilation, PlayMode behavior, domain reload, path traversal, performance targets, and prior KOTOR smoke claims were not independently reproduced. The Variablekiller and Conditionalkiller project downloads referenced in the course exports were not present locally, so exact Marvin integration cannot be certified until those projects are available. A clean-room fixture can prove equivalent capability but is not a substitute for one final smoke run in the real projects.

## Current architecture and surface

```text
MCP client
   │ stdio only
   ▼
TypeScript server
   │ HTTP first → WebSocket → optional file queue
   ▼
Unity Editor bridge on 127.0.0.1:6400
   │ unbounded main-thread dispatch
   ▼
UnityEditor / AssetDatabase / scene and project files
```

The client transport is stdio-only (`server/src/index.ts:2-20`, `server/src/config.ts:24-27`). The TypeScript-to-Unity hop tries HTTP, then WebSocket, then a queue (`server/src/unity/UnityClient.ts:70-100`). The queue is under `Library/UnityMcpGhost/queue`; HTTP/WS work is forwarded to an editor-update dispatcher.

The architecture document currently says “MCP stdio or Streamable HTTP,” but the implementation rejects non-stdio transports (`docs/architecture.md:5-10` versus `server/src/config.ts:24-27`). This is documentation drift, not an implemented transport.

Current tool groups include editor/console/scene state, GameObjects/transforms/components, assets/scripts/packages, prefabs, testing/operations, semantic scans, repair helpers, screenshots/visual validation, batch execution, and the two uncommitted physics setup tools. The surface is broad enough that the next work should make existing behaviors truthful, safe, and composable.

## Critical findings

### P0 — success can mean failure

1. **Failed Unity tests are recorded as successful operations.** `CommandRegistry.cs:5074-5086` sets operation status to `success` after a completed run even when the failed-test count is nonzero. `repair_apply_edits` only treats status `failed` as failure (`createServer.ts:2375-2377`), so a bad edit can survive a red test run.

2. **Bridge soft failures are wrapped as MCP successes.** The common forwarder uses `successResponse` without promoting `data.ok === false` to an MCP error (`createServer.ts:1089-1098`). Scene, asset, compile-wait, and other domain failures may therefore look successful to the agent.

3. **Compiler diagnostics are not generation-scoped.** `CompileDiagnosticBuffer.cs:62-90` is append-only and clean compilation does not clear old errors. Repair logic counts all returned diagnostics, so a correct repair can be rejected because an earlier compile failed.

4. **Compilation can be “complete” before it starts.** `compile_wait` returns as soon as `isCompiling` and `isUpdating` are false, without first observing a compilation/import generation (`createServer.ts:217-245`). `script_validate` forces an import and immediately reads diagnostics (`CommandRegistry.cs:1604-1615`). Both false-positive validation and false-negative repair are possible.

5. **`batch_execute` is not atomic.** It runs operations sequentially, retains earlier mutations after a later failure, embeds item errors, and returns top-level `ok:true` (`CommandRegistry.cs:1791-1840`). Its current `safe-write` classification is especially misleading because nested method names are arbitrary.

6. **`repair_loop_run` does not run a loop.** `maxIterations` is accepted and echoed, but the implementation performs one diagnostic/proposal pass and does not apply the proposal (`createServer.ts:2430-2456,2587-2608`). The name and documentation overstate behavior.

### P0 — transport and mutation reliability

7. **A timed-out mutation may execute later.** The Node fetch can abort while the Unity main-thread action remains queued (`UnityClient.ts:103-135`; `UnityMcpGhostServer.cs:116-135`). There is no idempotency key, deduplication store, cancellation propagation, or final-status receipt.

8. **The WebSocket reader truncates fragmented/large requests.** The bridge reads into one 64 KiB buffer and does not accumulate until `EndOfMessage` (`UnityMcpGhostServer.cs:139-163`). Large batches or scripts can fail unpredictably.

9. **Operations are not durable.** `OperationStore` is a static dictionary with no persistence, eviction, cancellation, or delete path (`OperationStore.cs:8-68`). State is lost on domain reload—the event it is supposed to survive.

10. **The file queue has no atomic claim/lease/idempotency protocol.** Timeout paths leave files behind; multiple editors/processes can race; stale requests and results have no retention policy.

11. **The dispatcher can monopolize an Editor frame.** `MainThreadDispatcher.cs:26-42` drains its complete queue every update without time/item budget or queue-level backpressure.

12. **Screenshot verification can false-pass or destabilize the Editor.** The diff compares only the overlapping minimum dimensions, so a resolution mismatch can be ignored (`CommandRegistry.cs:3653-3663`). Capture permits 4096×4096 with `superSize=8`, which can request extreme GPU/CPU allocations (`createServer.ts:1323-1328`; `CommandRegistry.cs:1844-1868`).

### P0 — local security boundary

13. **The bridge has no authentication.** It auto-starts on loopback port 6400 with no per-project token, Origin rejection, authorization middleware, body limit, or content-type validation (`UnityMcpGhostBridgeService.cs:20-27`; `UnityMcpGhostServer.cs:30-46,76-115`). Loopback blocks direct remote access, but it does not distinguish the intended MCP server from another local process.

14. **Risk metadata is inaccurate.** Static annotations mark every tool `openWorldHint:false`; `asset_delete`, `script_delete`, and `package_remove` are not marked destructive; `package_add` accepts external sources while claiming it is not open-world; `batch_execute` is labeled safe-write despite arbitrary nested calls (`createServer.ts:50-56,1953-1978,2039-2049,2105-2142,2710-2728`).

15. **JSON-RPC is parsed with regex/manual scanning.** `JsonRpcUtil.cs` does not provide a complete JSON implementation, supports only string IDs, and can mishandle nested/duplicate keys and escapes (`JsonRpcUtil.cs:11-21,70-121,224-294`). This is correctness and security debt at the trust boundary.

16. **Filesystem mutations are not transaction-safe.** Script writes use `File.WriteAllText` rather than atomic replacement, content preconditions, backup, or Unity Undo (`CommandRegistry.cs:1585-1587,4807-4825`). Asset containment is based on an `Assets` prefix instead of canonical path/symlink validation (`CommandRegistry.cs:4745-4753`). Package add passes package IDs, Git URLs, or tarballs directly to Unity Package Manager without a source policy.

### P1 — performance, semantics, and maintainability

- `CommandRegistry.cs` is a roughly 4,800-line command monolith; `createServer.ts` is also a large mixed catalog/router/orchestrator. Feature growth increases review and regression risk.
- Project-semantic tools repeatedly enumerate and read the full `Assets` tree synchronously. `project_index_summary` rebuilds multiple scans per request; call-path analysis is regex-derived and cannot resolve overloads, events, generics, delegates, or virtual dispatch (`CommandRegistry.cs:717-1244,4270-4373`). These are useful heuristics, not a semantic compiler index.
- Results are truncated in places but rarely cursor-paginated. Scene hierarchy has a depth limit but no hard object/result-size cap.
- All 74 tools are eagerly registered, only three expose examples, and no tool declares an `outputSchema`. Large catalogs cost context and make discovery less reliable.
- Resource metadata refers to mismatched/nonexistent forms such as `unity://console/{level}` and `unity://assets?filter=...` while the registered resources use other URI shapes.
- `component_modify` advertises a scalar value schema, while the bridge also expects vector fields; normal MCP callers cannot express the vector form cleanly.
- The custom port typed into the Editor window is not persisted; domain reload returns to 6400. A fixed shared port also makes concurrent-project routing ambiguous.

### P1 — testing, dependency, and distribution posture

- The tracked repository has no unit test files, Unity test assemblies, CI workflow, or portable fixture project. Existing smoke programs require a live external project; the Phase 3 smoke is KOTOR-specific.
- The UPM package claims Unity 2021.3 support, while repository evidence records validation only on 2022.3. Unity 2021.3 and 6000.x remain unproven.
- `npm audit` reported 9 current advisories (4 high, 3 moderate, 2 low), including direct `ws@8.20.0` advisories. Some transitive HTTP advisories may be unreachable while Ghost remains stdio-only, but the lockfile should be updated and re-audited before adding HTTP.
- `@modelcontextprotocol/sdk` is locked to 1.29.0 while 1.30.0 is available; `ws` 8.21.3 is available. Upgrade only with regression tests.
- No tracked `LICENSE`, `SECURITY.md`, changelog, release artifact, or verified installation path exists. The npm package is private and `dist/` is ignored.
- README path examples conflict: one uses root `dist/index.js`, while a Cursor example points at `server/dist/index.js`; the compiler emits to the root `dist/`.

## GAM 215 Modules 1–2 readiness

The supplied learning material teaches ordinary C# constructs, but its operational demand is larger than “edit a script.” The actual loop is:

```text
open project/scene/script
  → edit one small unit
  → save
  → wait for that compile/import generation
  → inspect compiler errors
  → enter Play mode
  → press PageUp/PageDown in Game view
  → inspect Console and visible Marvin state
  → stop
  → change exactly one input
  → repeat every branch/boundary case
  → restore and package evidence
```

### Capability matrix

| Course requirement | Examples in supplied material | Ghost today | Required proof |
| --- | --- | --- | --- |
| C# authoring | comments, class/`Start`, `print`, strings, ints, floats, signed/zero values | Partial pass | Atomic source edit with expected hash and preserved encoding/line endings. |
| Arithmetic/random | `+ - * /`, parentheses, `Random.Range(0,max+1)` | Text-only pass | Compile-generation proof plus runtime value assertion. |
| Boolean logic | `bool`, `if/else`, `!`, `||`, `&&`, `return` | Text-only pass | 2-case NOT, 4-case OR/AND, both if/else branches. |
| Comparisons | `== != <= < > >=` across string/int/float | Text-only pass | Exact 16-play equality/inequality/boundary matrix. |
| Assignment operators | `=`, `++`, `--`, `+=`, `-=`, `*=`, `/=` | Text-only pass | Sequential value assertions after every operation. |
| Diagnose syntax errors | braces, quotes, semicolons, casing, undeclared/redeclared/use-before-declare | Unsafe partial | Generation-scoped compiler diagnostics with file/line and truthful failure. |
| Diagnose semantic errors | wrong variable, wrong argument order, wrong branch/output | Fail | Runtime/visual/Console assertions, not compilation alone. |
| Normal Play lifecycle | Play, Stop, optionally Pause/Step | Missing | State-set operation that waits for settled state and survives reload. |
| Game-view input | PageUp/PageDown navigation | Missing | Verified key press/release in both supported input backends; explicit unsupported error otherwise. |
| Visual observation | Marvin labels, sprites, scene outcomes | Partial | Play-aware screenshots plus text/object assertion adapters and dimension-safe diffs. |
| Repeated regression testing | mutate one value, test, restore, rerun | Missing | Declarative scenario matrix with guaranteed cleanup and evidence manifest. |
| Project/editor setup | add/open project, choose Editor, open named scene/script | Mostly missing | Project identity/discovery plus optional Hub/CLI bootstrap. |
| Submission | D2L attachments/gallery/video workflow | Out of scope | Ghost creates evidence bundle only; separate authorized browser/LMS tool submits it. |

Course-source inconsistencies must be preserved as unknowns, not silently guessed:

- “Random Floats” is exported without the exercise body.
- Battle Tech is a blank embedded canvas; the preview only shows `Range 450.00` and `Distance 900.00`.
- The OR/AND practice alternates between key/crowbar and gate-key/master-key names and omits Ether in prose even though code requires it.
- A Vacation example described as syntax-clean contains the undefined `locaIsSunny` identifier.
- The setup page prescribes Visual Studio, while both videos show SciTE; automation must be editor-agnostic.
- The D2L instructions are browser/LMS work, not Unity MCP work.

### Course-source coverage ledger

Every page below was included in the requirements synthesis; neither PDFs nor videos were treated as executable instructions.

| Module | Source | Pages | Primary evidence extracted |
| --- | --- | ---: | --- |
| 1 | Introduction | 2 | Module outcome and Variablekiller context. |
| 1 | Getting Started with Scripting | 6 | Hub/Editor/editor integration, download, add/open project, scene setup. |
| 1 | Hello C# | 7 | Script skeleton, comments, `Start`, `print`, save/compile/Play/Console loop. |
| 1 | Variables | 17 | string/int/float declarations, assignments, zero/negative values, suffixes. |
| 1 | Practice: Comments and Variables | 12 | `Marvin.Write` practice and the incomplete Battle Tech canvas. |
| 1 | Errors: Comments and Variables | 8 | Syntax versus semantic error workflow. |
| 1 | Practice: Errors | 17 | Seeded braces/comments/quotes/identifier/type/order/argument defects. |
| 1 | Arithmetic | 15 | Four arithmetic operators, parentheses, integer random range, missing float exercise. |
| 1 | Submitting Your Work | 4 | D2L attachments/gallery/video directions; outside Unity scope. |
| 1 | Conclusion | 2 | Summary plus apparently stale attributes/character references. |
| 1 | Variablekiller preview | 1:39.70 | Edit/import/Play/Console/PageUp/PageDown and visible Marvin outcomes. |
| 2 | Introduction | 1 | Conditional-logic and testing emphasis. |
| 2 | Conditionals | 2 | Project/scene setup and naming inconsistency. |
| 2 | Booleans | 8 | `bool`, visibility, false/true testing. |
| 2 | If-Else | 14 | Both branches and visible state changes. |
| 2 | Conditional Logic | 2 | Marvin play/show/draw primitives. |
| 2 | Not Operation | 5 | Unary negation and paired tests. |
| 2 | Or Operation | 5 | Four-case OR truth table. |
| 2 | And Operation | 11 | Four-case AND truth table and early `return`. |
| 2 | Practice: Booleans and Conditionals | 21 | Multi-scene branch/state mutation practice. |
| 2 | Practice: Not Operation | 11 | Equipment-based negation cases. |
| 2 | Practice: Or and And Operations | 28 | OR/AND/NOT cases, gate-key/Ether inconsistencies, game-over flow. |
| 2 | Errors: Booleans and Conditionals | 13 | Semantic isolation and the `locaIsSunny` compile error. |
| 2 | Comparisons | 20 | Equality/inequality and below/equal/above boundary matrix. |
| 2 | Assignment Operators | 10 | `=`, increments/decrements, and compound assignments. |
| 2 | Conclusion | 1 | Module wrap-up. |
| 2 | Conditionalkiller preview | 2:43.40 | Live save/reload/Play, branch changes, page navigation, early game-over. |

## Open-source Unity MCP landscape

The discovery query screened 100 GitHub results. “All” is necessarily a time-bounded discovery claim: repositories can be private, renamed, newly created, poorly indexed, or missing a license. The deep comparison below covers the dominant projects and every materially different pattern found before diminishing returns. Public-but-unlicensed, restricted-license, forks, near-clones, tutorials, narrow adapters, and abandoned proofs were not treated as reusable code donors.

| Project | License posture | Distinctive evidence | What Ghost should learn |
| --- | --- | --- | --- |
| [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) | MIT | Mature FastMCP/C# split, grouped tools, multi-instance/remote modes, pollable jobs, Python and Unity tests; current V10 docs are [here](https://github.com/CoplayDev/unity-mcp/blob/beta/docs/wiki/V10.md). | Tool groups, explicit instance routing, job polling, test matrix. |
| [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) | Apache-2.0 | .NET server, [CLI bootstrap](https://github.com/IvanMurzak/Unity-MCP/blob/main/cli/README.md), attributes, Roslyn/reflection, runtime mode. | Project create/open/wait CLI, extension API, layered escape hatches. |
| [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) | MIT | Project credential, Origin rejection, bounded resources, Play controls, tests, rollback batch; security changes are documented in [v1.5.0](https://github.com/CoderGamester/mcp-unity/releases/tag/1.5.0). | Authenticated bridge, rollback semantics, unsafe-feature toggles. |
| [isuzu-shiranui/UnityMCP](https://github.com/isuzu-shiranui/UnityMCP) | MIT | Direct in-process Streamable HTTP, generated typed schemas, declared destructive/idempotent/main-thread/Undo traits, token permissions. | Typed operation metadata and protocol generation. |
| [FunplayAI/funplay-unity-mcp](https://github.com/FunplayAI/funplay-unity-mcp) | MIT | Core/full profiles, reload broker, Roslyn execution, Undo changelogs, Play/input loop, extensive EditMode tests. | Course loop, mutation receipts, reload continuity, profiles. |
| [Glade-tool/glade-mcp](https://github.com/Glade-tool/glade-mcp) | MIT | Semantic capability search, context/memory, licensed-asset provenance, schema parity CI. | Progressive discovery, project knowledge, provenance. |
| [Vangardo/unity-mcp-efficient](https://github.com/Vangardo/unity-mcp-efficient) | MIT | Six-tool progressive facade, durable SQLite result handles, pagination, receipts, no implicit mutation replay. | Compact catalog, bounded results, durable receipts. |
| [Signal-Loop/UnityCodeMCPServer](https://github.com/Signal-Loop/UnityCodeMCPServer) | MIT | Seven general primitives plus skills, file-backed reload resilience, play/input/screenshot loop. | Small primitives plus workflows; generic execution only behind a high-risk gate. |
| [burakaydinofficial/unity-editor-mcp](https://github.com/burakaydinofficial/unity-editor-mcp) | MIT | Generated versioned protocol catalog, explicit instance per call, path containment, confirmation/audit, deep `SerializedObject` support. | One contract source, project pin, audit log, serializer depth. |
| [killop/puerts-unity-mcp](https://github.com/killop/puerts-unity-mcp) | MIT | Fast JavaScript extension path and runtime/mobile player control through PuerTS. | Optional runtime adapter; do not copy its unauthenticated/wildcard network defaults. |
| [kitwright/unity-mcp](https://github.com/kitwright/unity-mcp) | MIT | Large generated catalog with minimal/core/extended/full profiles and candid local security documentation. | Profile ergonomics and explicit security limitations; young-project evidence only. |
| [AnkleBreaker-Studio/unity-mcp-server](https://github.com/AnkleBreaker-Studio/unity-mcp-server) | Restricted custom license | Tiered discovery, per-agent Undo, identity handshake, request limits, protocol mocks, reload recovery. | Clean-room reimplement concepts only; its license restricts commercial redistribution of derivatives. |

Relevant but not reusable as general OSS code:

- [Unity-Technologies/skills](https://github.com/Unity-Technologies/skills) documents first-party Unity CLI/MCP instance discovery, authentication, project-path targeting, and extension ergonomics, but the implementation is proprietary/not included. Unity's [official MCP setup post](https://unity.com/blog/unity-ai-mcp-how-to-get-started) is a product benchmark, not a code donor.
- [Meta Quest Unity MCP Extensions](https://github.com/meta-quest/Unity-MCP-Extensions) shows domain extensions for XR on top of Unity's official MCP, but uses a restrictive Meta/Oculus license.
- GPL, custom-license, no-license, fork, wrapper, template, and narrow Unity-MCP repositories were screened but excluded from code reuse. Notable examples include `jackwrichards/UnityMCP`, `quazaai/UnityMCPIntegration`, `emeryporter/UnityMCP`, archived `notargs/UnityNaturalMCP`, VRChat/UI adapters, and small proofs.

### Cross-project consensus

Independent implementations converge on ten patterns Ghost lacks or only partially implements:

1. compact progressive discovery rather than an always-eager catalog;
2. explicit editor/project identity on every mutation;
3. loopback plus a per-project cryptographic credential and Origin/path checks;
4. typed, generated operation contracts and safety metadata;
5. request IDs, mutation receipts, Undo/rollback, and no implicit replay;
6. reload-resilient jobs with status/cancel/result and version handshake;
7. bounded responses, pagination, projection, and result handles;
8. specialized safe tools first, generic C#/reflection only as opt-in high risk;
9. real EditMode/PlayMode/protocol/live/reload/multi-editor tests;
10. Play/input/screenshot/assertion loops as a first-class automation primitive.

## MCP protocol posture

The official [2026-07-28 MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [specification changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx) add stateless/discovery-oriented protocol behavior, richer per-request metadata, JSON Schema 2020-12 expectations, caching/subscription concepts, and a standardized direction for long-running tasks. The TypeScript SDK v2 line is still a migration decision, not a reason to replace a working 1.x stack without tests.

Recommended posture:

- immediately update patched 1.x dependencies and add protocol contract tests;
- keep stdio as the secure default;
- design an adapter boundary for legacy sessions and 2026-07-28 stateless clients;
- add Streamable HTTP only after authentication, Origin/DNS-rebinding defense, body limits, project pinning, and explicit remote opt-in exist;
- map build/test/import/scenario jobs to a durable task abstraction while preserving polling compatibility;
- generate input/output schemas and verify full JSON Schema 2020-12 compatibility in CI;
- follow the official [local-server security requirements](https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-).

## Recommended roadmap and commit order

### P0: make existing results truthful

1. Replace manual JSON parsing with a real typed JSON-RPC layer and generated/shared contracts.
2. Centralize result promotion: a bridge `{ok:false}` or failed job must produce MCP `isError:true` and a stable error code.
3. Introduce compile generations: return a generation token from mutation/import, wait until that generation finishes, then return only its diagnostics.
4. Fix test final states, failed counts, cancellation, and operation cleanup.
5. Rename or implement `repair_loop_run`; enforce the iteration budget and verify every applied patch.
6. Make script edits atomic with `expectedSha256`, dry-run diff, backup/restore, encoding/newline preservation, and compile rollback.
7. Make batch execution prevalidated, fail-fast, and rollback-capable; reject unsupported/non-rollbackable mixes unless explicitly accepted.

### P0: close the course execution loop

8. Add normal Play-mode get/set with settled-state waits.
9. Add Console clear/mark/wait/assert with generation/timestamp boundaries.
10. Add Game-view key simulation with explicit PageUp/PageDown tests. Support each declared input backend or return a typed unsupported result—never a false success.
11. Add a declarative `scenario_matrix_run` that snapshots source/play/scene state, applies one case, waits for compile, plays, injects inputs, performs Console/object/UI/screenshot assertions, stops, records evidence, restores in `finally`, and proves restoration.
12. Add `evidence_bundle_create` for manifest, logs, diffs, screenshots, and scenario results. Do not add LMS upload to the Unity MCP.

### P0/P1: secure and survive

13. Generate a per-project token; authenticate HTTP/WS; reject browser origins; validate method/content type/version; cap payloads; canonicalize paths; make package/network/code capabilities default-deny.
14. Add project identity, deterministic instance routing, handshake/capability version, and a persisted custom port.
15. Accumulate WS fragments; serialize sends; deduplicate request IDs; propagate cancellation; add dispatcher budgets/backpressure.
16. Replace the queue/operation dictionary with atomic claim/lease records, durable status/result storage, TTL cleanup, cancellation, and no automatic replay of non-idempotent mutations.
17. Correct screenshot dimension handling and bound effective output pixels/bytes.

### P1: test, simplify, and ship

18. Add TypeScript unit/contract tests, C# EditMode tests, PlayMode tests, mock-bridge tests, reload/concurrency tests, and a minimal Unity fixture project.
19. Add a GAM 215 clean-room harness and matrices for every Module 1–2 operation, then run one final smoke pass in the real Variablekiller/Conditionalkiller projects when they are supplied.
20. Split command handlers by domain and introduce one generated contract/catalog source.
21. Add core/advanced profiles, capability search/call, pagination/projection/result handles, accurate annotations, output schemas, examples, and URI parity tests.
22. Update dependencies and add Windows/macOS/Linux plus supported Unity LTS CI. Add `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, package/release validation, and corrected setup docs.

### P2: resume differentiation

Only after the above gates pass: incremental Roslyn/Unity semantic indexing, attribute extensions, tightly gated C#/reflection escape hatches, optional runtime/player transport, Hub/project bootstrap, and the broader game-system/mobile roadmap.

## Definition of course-ready

Ghost may claim GAM 215 Module 1–2 readiness only when all of the following are automated and green:

- truthful compile generation tests with seeded syntax failures and clean recompilation;
- comments/printing/types/signed and zero values/arithmetic/parentheses/integer and float random-range fixture cases;
- `if/else` both branches; NOT 2 cases; OR and AND 4 cases each; early `return` behavior;
- comparisons: two equality, two inequality, and below/equal/above for each ordered relation—the course's 16-play matrix;
- every assignment operator with intermediate-value assertions;
- PageUp/PageDown navigation in the declared Game-view/input backend;
- semantic defect cases that compile but render/log the wrong outcome;
- dimension-safe visual assertions and Console assertions;
- scenario cleanup that restores byte-identical source and original scene/play state after success, failure, timeout, and cancellation;
- an evidence bundle listing inputs, expected result, observed result, diagnostics, screenshots, durations, and restoration hash;
- final real-project smoke runs against Variablekiller and Conditionalkiller, once those project downloads are supplied.

Until that last condition is met, the honest release language is **“GAM 215-equivalent fixture coverage”**, not “certified against the course projects.”

## Immediate decision

Do not continue expanding Phase 4 tool count yet. Implement the companion development prompt in `docs/development-prompt-course-ready-reliability.md`, commit it in evidence-gated slices, and treat every P0 result-propagation, compilation, security, and course-loop acceptance test as a release blocker.
