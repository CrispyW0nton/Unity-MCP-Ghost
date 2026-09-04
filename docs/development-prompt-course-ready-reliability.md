# Development prompt: make Unity MCP Ghost course-ready and production-trustworthy

Copy the prompt below into an implementation task from the repository root.

---

You are the lead engineer for `CrispyW0nton/Unity-MCP-Ghost`. Implement the **Course-Ready Reliability** milestone end-to-end, verify it, and create a clean sequence of local git commits. Do not push or open a pull request unless separately requested.

## Repository and starting state

- Work in `C:\Users\NewAdmin\Documents\GDeveloper\Workspaces\Unity-MCP-Ghost`.
- Read `docs/unity-mcp-deep-audit-2026-09-04.md`, `docs/architecture.md`, `docs/development-plan.md`, and `docs/progress.md` before coding.
- Starting branch at prompt creation: `codex/phase2-parity-tools`, commit `cb79e299fd822ee2bd739e45fa4ddc268fc48317`.
- The working tree already contains user-owned edits in `server/src/mcp/createServer.ts` and `server/src/phase3RepairSmoke.ts` adding/validating `collider_setup` and `rigidbody_setup`. Preserve, integrate, test, and commit them; do not reset, discard, or overwrite them.
- Inspect current status and any repository instructions before every commit. Preserve unrelated user changes.
- Baseline known-good commands are `npm run typecheck`, `npm run build`, and `git diff --check`.

## Objective

Make Ghost truthful, secure-by-default, reload-resilient, testable, and capable of executing the complete Unity loop needed by GAM 215 Modules 1–2:

```text
identify/open project and scene
  → atomically edit C#
  → wait for the exact compile/import generation
  → report only that generation's diagnostics
  → enter normal Play mode
  → inject PageUp/PageDown and other declared test inputs
  → assert Console and visible/runtime state
  → stop
  → repeat parameterized branch/boundary cases
  → restore original source, scene, selection, and play state
  → emit a reproducible evidence bundle
```

The C# constructs to prove are comments, `MonoBehaviour`/`Start`, `print`, strings, ints, floats, signed/zero values, declaration/assignment, `+ - * /`, parentheses, integer and float `Random.Range`, booleans, `if/else`, `!`, `||`, `&&`, `return`, `== != <= < > >=`, and `= ++ -- += -= *= /=`. Project-provided helpers such as `Marvin.Play`, `Marvin.Write`, `Marvin.Draw`, and `Marvin.ShowOrHide` must remain callable without rewriting student code.

Do not claim that an operation succeeded unless its observable postcondition was verified.

## Non-goals and boundaries

- Do not add D2L/LMS uploading. Create evidence files only. Browser/LMS submission requires a separate authorized integration.
- Do not copy code from GPL, no-license, or restricted-license repositories. You may clean-room reimplement documented concepts. Prefer MIT/Apache references listed in the audit.
- Do not add more Phase 4/5 domain tools until the correctness, safety, test, and course-loop gates below pass.
- Do not make arbitrary C# execution or reflection a default capability. If implemented, place it behind an explicit high-risk opt-in and conspicuous non-sandbox warning.
- Do not silently support only the new Unity Input System. Each input call must report the selected backend and fail with a typed `UNSUPPORTED_INPUT_BACKEND` error when it cannot prove delivery.
- Do not certify the real Variablekiller/Conditionalkiller projects unless those downloads are present and the real-project smoke suite passes. Use “GAM 215-equivalent fixture coverage” until then.

## Architectural invariants

1. Maintain one versioned source of truth for operation IDs, request/response schemas, risk metadata, examples, and resource relationships; generate or parity-test TypeScript and C# contracts.
2. Every response has a stable envelope with at least:

   ```json
   {
     "ok": true,
     "data": {},
     "error": null,
     "diagnostics": [],
     "requestId": "uuid",
     "operationId": null,
     "projectId": "stable-project-id",
     "durationMs": 0,
     "confidence": 1.0,
     "warnings": []
   }
   ```

   A bridge payload with `ok:false`, a failed test count, a timeout, a cancellation, or a failed postcondition must become MCP `isError:true` with a stable error code. Preserve structured content.
3. Every mutation accepts/produces a request ID. Non-idempotent mutations are never replayed implicitly after timeout/reconnect.
4. Every mutation declares read-only/destructive, idempotent/non-idempotent, main-thread, Undoable/non-Undoable, dry-run support, permission class, open-world behavior, and expected duration.
5. All project paths are canonicalized after symlink resolution and proved to remain under the selected project root or `Assets` root as appropriate.
6. All payloads, result sets, images, and queues have tested size/time limits, pagination or result handles, and truncation metadata.
7. Every background operation is durable across domain reload and exposes get/list/cancel/result; completed records have a retention/cleanup policy.

## Workstream 1 — truthful result and compile semantics

Replace the regex/manual JSON-RPC parser with a real typed JSON implementation compatible with the supported Unity versions. Prefer Unity's supported Newtonsoft package, pin the resolved version, and add parser/serializer tests for string and numeric IDs, nested/duplicate keys, Unicode and control escapes, malformed JSON, invalid protocol versions, unknown methods, oversized bodies, and round trips.

Create a central result adapter on both sides of the bridge. Remove unconditional `successResponse` wrapping. Add stable error codes and tests proving `{ok:false}` is an MCP error.

Fix test operations so `failed > 0`, aborted runs, infrastructure exceptions, timeout, and cancellation all end in a failed/cancelled state. Include individual failed-test details. Repair workflows must roll back on any non-green required test.

Implement generation-scoped compilation:

- maintain a monotonically increasing compile/import generation outside the stale append-only diagnostic buffer;
- a script mutation returns `requestedCompileGeneration` and the pre-write content hash;
- `compile_wait` waits until that generation is observed and completed, rather than merely sampling `isCompiling === false`;
- diagnostics include generation, timestamp, assembly, severity, message, file, line, and column;
- a clean generation returns no historical errors;
- timeout/cancel is an MCP error;
- `script_validate` is implemented on top of this path and returns `ok:false` for compiler errors.

Make `repair_loop_run` match its name: respect `maxIterations`, propose/apply/compile/test/verify each iteration, stop on success or explicit terminal failure, and always restore the last known-good state if no iteration passes. Alternatively rename it to a proposal-only tool and add a separately named real loop; do not keep the current misleading contract.

Commit when green as:

`fix(core): make bridge, compile, test, and repair results truthful`

## Workstream 2 — transactional mutation and durable transport

Make script create/write/edit/delete transactional:

- require optional `expectedSha256` for optimistic concurrency; return current hash on mismatch;
- provide `dryRun` with a unified diff;
- preserve BOM/encoding and newline convention;
- write to a sibling temporary file, flush, then atomically replace where the platform permits;
- keep a bounded backup until compilation and required tests succeed;
- restore byte-identical source on failure/cancel/timeout;
- refresh/import once after the complete transaction;
- include before/after/restored hashes in the receipt.

Redesign `batch_execute`:

- resolve and validate every operation before the first mutation;
- reject destructive, external, non-Undoable, or non-rollbackable mixed batches unless the caller explicitly accepts the exact risk class;
- default to fail-fast;
- create a Unity Undo group where supported;
- register compensating actions/file backups for non-Undo file operations;
- roll back completed items in reverse order after failure;
- return per-item and top-level rollback outcomes;
- never return top-level success when any required item failed or rollback is incomplete.

Harden HTTP/WebSocket/queue execution:

- accumulate WebSocket frames until `EndOfMessage`, enforce byte limits, and serialize sends;
- propagate deadlines/cancellation to the Unity queue before execution when possible;
- add request deduplication and an explicit `outcomeUnknown` state if cancellation races with mutation;
- use atomic queue claims, owner/lease timestamps, idempotency metadata, stale recovery, result TTL, and cleanup;
- persist operation state/results outside the AppDomain;
- add dispatcher item/time budgets and backpressure;
- make all timeout/cleanup paths leak-free.

Correct screenshot validation:

- reject or explicitly resample dimension mismatches; never compare only the overlapping region silently;
- cap effective width × height × superSize and estimated GPU/CPU bytes;
- release textures/render targets on every path;
- include dimensions and comparison method in the report.

Commit when green as:

`fix(reliability): add transactional mutations and durable operation receipts`

## Workstream 3 — project identity and secure local bridge

Generate a cryptographically random per-project bridge token under `Library/UnityMcpGhost` with user-only filesystem permissions where supported. Pass it to the MCP server through generated client configuration without logging it. Authenticate HTTP and WebSocket requests using constant-time comparison.

Also implement:

- loopback binding by default;
- explicit remote opt-in only after authentication/TLS or documented secure tunneling;
- browser `Origin` rejection and no permissive CORS;
- method and content-type validation;
- body/message/rate/concurrency limits;
- exact project pin and stable project/editor instance identity;
- deterministic per-project port or discovery registry with heartbeat and version/capability handshake;
- persisted custom port/settings across reload;
- no silent fallback to another open Editor;
- package-source allowlist/confirmation and external-network risk metadata;
- startup flags that default-deny destructive, package/network, arbitrary-code, and reflection capabilities.

Fix tool annotations. Deletes/package removal are destructive; package add and remote import are open-world; batch risk is the maximum nested risk; read-only/idempotent hints must be truthful.

Add `SECURITY.md` with threat model, local-process trust boundary, credential storage, remote-mode warning, unsafe capabilities, supported versions, and vulnerability reporting.

Commit when green as:

`feat(security): authenticate and pin every Unity editor connection`

## Workstream 4 — normal Play mode, Console boundaries, and input

Add these MCP operations with input/output schemas, examples, risk metadata, and tests:

### `play_mode_get`

Return `stopped | enteringPlay | playing | paused | exitingPlay`, active scene, project/editor identity, and transition generation.

### `play_mode_set`

Input:

```json
{
  "state": "playing | paused | stopped",
  "waitForSettled": true,
  "timeoutMs": 30000,
  "saveModifiedScenes": false
}
```

Do not save modified scenes implicitly. If unsaved scenes prevent a safe transition, return a typed conflict with the scene list. Survive domain reload/reconnect and verify the requested settled state.

### `play_mode_step`

Step exactly one frame while paused, then verify the frame/time change.

### `console_clear`, `console_mark`, `console_wait`, `console_assert`

Marks create a boundary token. Wait/assert filters include boundary/generation, severity, exact/contains/regex message, file, line, count, timeout, and whether unexpected errors fail the operation. Return only entries after the boundary unless requested otherwise.

### `input_simulate`

Support at minimum keyboard tap/press/release and UI pointer click. Return backend, focus target, press/release frames, and delivery evidence.

Required keys include `PageUp` and `PageDown`. Build a layered backend:

1. Unity Input System event injection when the package/device is active;
2. verified Game-view Editor event path when it genuinely reaches the target;
3. a project-scoped test-driver interface for deterministic fixtures/course helpers;
4. an explicitly opt-in OS-native backend only if necessary, narrowly scoped, guarded, and platform-tested.

Never claim legacy Input Manager delivery without an integration test proving the observed navigation/state change. Return `UNSUPPORTED_INPUT_BACKEND` when no verified backend applies.

Commit when green as:

`feat(runtime): control play mode, console boundaries, and test input`

## Workstream 5 — declarative scenario matrices and evidence

Add `scenario_matrix_run` as a durable, cancellable orchestration job. Its schema must support:

- selected project/editor and scene;
- original-state capture policy;
- source mutation(s) with expected hashes;
- compile timeout and zero-error requirement;
- play-mode transition;
- ordered input events;
- Console assertions;
- GameObject/component/property/text/UI assertions;
- screenshot capture/diff assertions with tolerances;
- per-case expected result and timeout;
- fail-fast or collect-all mode;
- required cleanup/restoration.

For each case:

1. record exact starting hashes, scene, selection, play state, Console boundary, and relevant object state;
2. apply only that case's mutation;
3. wait for its compilation generation;
4. fail immediately on unexpected diagnostics;
5. enter Play mode and wait for settled state;
6. execute inputs/assertions;
7. stop Play mode;
8. restore source and editor state in `finally`;
9. wait for restoration compilation and prove byte-identical hashes;
10. persist a compact receipt and externalize large logs/images behind resource/result handles.

Add `evidence_bundle_create` to materialize a deterministic directory or ZIP containing:

- `manifest.json` with version, commit, Unity version, project ID, scenario IDs, timestamps, inputs, expected/observed outcomes, durations, and restoration hashes;
- source diffs (no secrets);
- generation-scoped compiler and Console logs;
- screenshots/diffs;
- machine-readable scenario results;
- a concise Markdown summary.

Do not upload the bundle anywhere.

Commit when green as:

`feat(validation): run restorable scenario matrices with evidence bundles`

## Workstream 6 — GAM 215-equivalent clean-room fixture

Create a minimal repository-owned Unity test project or package fixture without copying copyrighted course assets. It should include a `Marvin`-compatible test harness exposing the required `Play`, `Write`, `Draw`, and `ShowOrHide` call shapes, visible TMP/UI or deterministic state, and PageUp/PageDown scene/page navigation.

Automate these suites through `scenario_matrix_run`:

### Module 1

- valid script skeleton, comments, `Start`, and two Console prints;
- string/int/float declaration, assignment, printing, zero, negative, and `f` suffix;
- `Marvin.Write` overloads for string/int/float;
- `+`, `-`, `*`, `/`, variable-to-variable assignment, and parentheses;
- `Random.Range(int,int)` including inclusive-max via `max + 1`;
- `Random.Range(float,float)` as inferred language coverage, clearly labeled because the exported course exercise is missing;
- seeded syntax failures: malformed comments/braces/quotes/semicolon, missing/wrong-case `Start`, undeclared/unassigned/redeclared/use-before-declaration/case-mismatch identifiers;
- seeded semantic failures: quoted variable name, wrong variable/type, wrong Marvin argument order, wrong label/value.

### Module 2

- boolean visibility: false and true for each sample;
- `if/else`: both branches;
- unary NOT: two cases;
- OR: all four truth-table cases;
- AND: all four truth-table cases;
- `return` proving later scenes do not execute;
- comparisons: two equality, two inequality, and below/equal/above for `<=`, `<`, `>`, and `>=`—16 total course cases;
- assignment flow with an assertion after `=`, `++`, `--`, `+=`, `-=`, `*=`, and `/=`;
- a paired semantic regression demonstrating why changing two booleans at once can conceal the wrong variable wiring;
- PageUp/PageDown navigation with observed page/state changes;
- visual and Console expectations for every case.

Every suite must prove restoration after green, red, timeout, and cancellation paths. The source file must be byte-identical after the run.

If the actual Variablekiller and Conditionalkiller projects become available, add opt-in, non-destructive smoke manifests that discover their real paths/names and run the same loop without committing those course assets. Record discrepancies rather than changing the course projects silently.

Commit when green as:

`test(course): prove GAM 215 module 1 and 2 automation loops`

## Workstream 7 — maintainability, discovery, protocol, and release

Split the TypeScript server and C# registry by domain. Keep registration deterministic. Introduce contract-generation/parity tests so handler, schema, documentation, and risk metadata cannot drift.

Add progressive discovery:

- a compact core profile;
- opt-in domain profiles;
- `capabilities_search` with stable operation IDs and examples;
- `operation_call` and `operation_batch` only if they preserve full validation/risk gates;
- durable result handles, pagination, field projection, and truncation metadata.

Do not hide risk behind a generic call. The exact resolved command and risk must be visible before execution.

Add `outputSchema` to every tool, repair resource URI mismatches, and provide at least one valid example for every public operation. Add catalog snapshot/parity tests.

Dependency and MCP work:

- update patched 1.x dependencies first (`ws`, MCP SDK, Zod, toolchain), re-lock, and require `npm audit` to have no known high/critical vulnerabilities or document a narrowly justified unreachable exception;
- add conformance tests for the implemented MCP generation, full JSON Schema 2020-12 payloads, structured outputs, deterministic discovery, and old/new compatible clients;
- preserve stdio as default;
- place Streamable HTTP behind the completed security boundary;
- isolate transport/protocol adapters so MCP 2026-07-28 stateless discovery/caching/subscription/task support can be added without rewriting Unity handlers;
- use durable task semantics for build/test/import/scenario jobs, with current polling as compatibility fallback.

Testing and CI:

- TypeScript unit tests for config, envelopes, schemas, routing, connection races, deadlines, fallback, deduplication, pagination, and tool catalog;
- protocol tests using a mock Unity bridge, including fragmented WebSocket messages and soft failures;
- Unity EditMode tests for contracts, path containment, serialization, handlers, Undo/rollback, diagnostic generations, operation persistence, and screenshots;
- Unity PlayMode tests for lifecycle, input, Console boundaries, fixture scenarios, timeout/cancel/restoration;
- live bridge smoke tests, domain reload/reconnect, concurrent editor projects, batch mode, and package-installed layout;
- supported Unity LTS matrix on Windows/macOS/Linux where runners permit. At minimum prove every advertised Unity version or narrow the advertised range.

Add/repair `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, UPM metadata, release packaging, install documentation, root `dist/index.js` paths, generated client configuration, and CI badges only after they are real.

Commit in reviewable slices such as:

- `refactor(contracts): generate typed operation catalog`
- `feat(mcp): add profiles, output schemas, pagination, and protocol tests`
- `chore(deps): patch runtime dependencies and clear audit findings`
- `chore(ci): test supported node and unity matrices`
- `docs(release): correct install, security, support, and course readiness`

## Required verification gates

Run and report exact commands and results. Add scripts so a fresh contributor can reproduce them.

Minimum gates:

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:protocol
npm run test:course
npm audit --audit-level=high
git diff --check
```

Also run Unity EditMode/PlayMode/live smoke commands defined by the project. If a Unity installation/version is unavailable, do not mark those gates passed; document the exact missing runner and leave the milestone incomplete.

Add adversarial tests for:

- historical diagnostics versus a clean new generation;
- failed tests reported as MCP errors;
- bridge `{ok:false}` promotion;
- compile not yet started;
- timeout followed by late mutation;
- duplicate request after reconnect;
- fragmented/oversized WebSocket input;
- batch failure after partial mutation and rollback failure;
- cancellation during compile/play/assertion;
- domain reload during operation;
- two open projects with the same default port;
- browser Origin and wrong/missing token;
- `Assets/../`, symlink/junction escape, Unicode path, and spaces;
- external package source when disabled;
- screenshot dimension mismatch and effective-pixel limit;
- scenario restoration on every terminal path.

## Commit discipline

- Before each commit: inspect `git status`, review the complete diff, run the proportional tests, and confirm no generated secrets, Unity `Library/`, course assets, or unrelated files are staged.
- Use small value-oriented commits in the workstream order above. Do not combine unrelated refactors with behavior changes.
- Do not rewrite or squash user history.
- After every commit, record the commit hash and gates in `docs/progress.md`.
- Final verification must run on the complete commit series, not just per-file tests.

## Definition of done

This milestone is complete only when:

1. all known P0 correctness and safety findings from the audit have regression tests and are fixed;
2. every mutation has truthful errors, receipt/idempotency semantics, project identity, and an authorization boundary;
3. compile/test/play/input/assert/restore works as one durable orchestration loop;
4. the clean-room GAM 215-equivalent suite passes every Module 1–2 matrix listed above;
5. PageUp/PageDown delivery is proven against the declared input backend;
6. success, failure, timeout, cancellation, and domain reload all restore original source/editor state;
7. the evidence bundle proves what ran and what was observed;
8. TypeScript, protocol, EditMode, PlayMode, bridge, reload, concurrent-project, and supported-version CI are green;
9. high/critical dependency advisories are cleared or a reviewed unreachable exception is documented;
10. docs and tool metadata match the implementation;
11. one final non-destructive smoke pass succeeds in the actual Variablekiller and Conditionalkiller projects when those assets are available.

If condition 11 cannot run because the projects are unavailable, finish and label the release candidate **“GAM 215-equivalent fixture complete; real course-project certification pending.”** Do not weaken or silently waive any other gate.

At handoff, provide:

- commit list and purpose;
- changed architecture and threat model;
- tool/contract additions and breaking changes;
- exact test/audit results;
- course matrix with pass/fail/evidence links;
- unresolved risks and unavailable external gates;
- migration/rollback instructions.

---
