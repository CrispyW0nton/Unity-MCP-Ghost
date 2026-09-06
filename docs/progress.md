# Unity MCP Ghost Progress

## Course-Ready Reliability milestone

Goal amendment approved on 2026-09-05: the user adopted `docs/course-ready-local-rc-goal.md`. Its local release-candidate acceptance gates now govern completion; all seven local implementation workstreams and their safety requirements remain required. Remote CI, additional environments and real course-project certification remain visible external follow-ups, not passed gates. After the goal service reported no active goal, the replacement objective was successfully created and activated in this chat. No completion or blocked status was fabricated to bypass the earlier active-goal editing limitation.

Status: active; the GAM 215-equivalent fixture matrices have passed locally, but final reliability review, complete-series verification, and real course-project certification remain pending. Passing matrices alone do not certify the release candidate.

Milestone source documents:

- `docs/course-ready-local-rc-goal.md` — user-approved completion contract
- `docs/development-prompt-course-ready-reliability.md`
- `docs/unity-mcp-deep-audit-2026-09-04.md`
- `docs/course-ready-requirements-trace.md` — finite 150-row implementation/evidence map at `3503821`, with all original P0 findings accounted for and eight consolidated remaining-work groups

Current bounded work: explicit repair recovery is committed at `72f69f0`. The existing repair smoke correction is implemented and verified locally: 441/441 Node, 10/10 protocol and 235/235 EditMode; its live mutation run remains a final gate. Review `20260906-014839-2109d572` and the same-finding follow-up are resolved, including the real empty-byte hash, unknown scene/import restoration and active capability preflight. Evidence: `docs/repair-smoke-safety-verification-2026-09-06.md`. The finite trace retains its dated baseline and resolution overlays, not passing-gate claims. Next is public exact-generation compile/validation deadlines and cancellation, then actual Test Runner lifecycle. Durable transaction/queue bounds, full contract parity and the final live matrix remain separately open. Do not reopen completed input work or add domains to compensate for missing proof.

Commits and verified gates:

- `131c201` — `docs(goal): map finite course-ready requirements and evidence`
  - Committed the finite 150-row baseline trace (32 + 42 + 57 + 19 rows), its eight consolidated remaining-work groups and the `72f69f0` resolution overlay. The source tables remain dated baseline evidence, not current pass claims.
  - Documentation-only validation: row counts, exact staged paths and `git diff --cached --check` passed. No source behavior changed after the 395/395 Node and 10/10 protocol runs recorded for `72f69f0`. Local goal remains active; nothing was published. This post-commit ledger travels with the next progress update.
- `72f69f0` — `fix(reliability): make explicit repair recovery truthful`
  - Verified source/apply receipts, exact-generation handler checks, required-test outcomes, current-hash restoration, retained unknown/partial recovery and at-most-once cleanup. Published explicit result contract 2 and client migration; no historical Console count masquerades as zero errors.
  - Review `20260906-011754-a5b8dc88` completed eight lenses and an independent validation batch. All five findings #1/#2/#3/#6/#7 plus generation tests #5 were applied and independently rechecked. The original Not ready receipt is preserved separately from successful follow-up verification; no separate-provider CLI was available.
  - Parent post-fix verification: 133/133 focused integration cases, Node 395/395, protocol 10/10, no failures/skips/cancellations; typecheck/build/lint/format, strict changed-test diagnostics, catalog, release-layout and diff checks passed; audit zero. Node 24.11.1 on Windows. Detailed commands and red/green history: `docs/explicit-repair-verification-2026-09-06.md`.
  - Committed exactly eight owned implementation/test/catalog/documentation files. `npm ci`, live Unity and complete-course/reload/concurrent-Editor gates were not rerun for this TypeScript behavior slice. Actual course projects remain untouched. This post-commit ledger travels with the next progress update.
- `3503821` — `fix(runtime): deliver input in normal gameplay frames`
  - Added independent normal-player-loop and InputAction observations, asynchronous receipts, per-device admission, atomic pointer state and failed-tap release cleanup. Review `20260906-003158-465f58f2` findings #1/#2/#4/#5/#6 are applied; the bounded physical-stall test from #7 remains intentionally for scheduling fidelity.
  - Parent verification: PlayMode 9/9, EditMode 234/234, Node 307/307 and protocol 10/10, zero failures/skips/cancellations; typecheck/build/lint/format/diff and release-layout checks pass, audit zero. Red-first follow-up reproduced all three input defects (6/9 before fixes). Fixture source/scene hashes are unchanged and no Unity process remained.
  - Committed 13 owned files, including polling/support documentation. No project settings or actual course assets changed. Cross-reload input durability, broader lifecycle and final complete-series gates remain open; this is not full course certification. This post-commit ledger entry travels with the next progress update.
- `9b839a7` — `fix(testing): retain version probe ownership through cleanup`
  - Consumed completed review `20260906-000340-84469f2a` and applied its one validated P1 finding. Three real root-first exit regressions failed before atomic Windows Job Object ownership, then passed; supervisor loss remains a failed certification even when kernel cleanup succeeds.
  - Parent verification: 44/44 focused process/runner tests, Node 307/307, protocol 10/10, typecheck/build/lint/format/strict test checking/diff checks passed, audit zero. The compiled version probe verified installed Unity 2022.3.62f1 and left no Unity process running.
  - Committed nine owned implementation/test/docs files. Windows 10+ and PowerShell 7 with Add-Type are explicit runner prerequisites; no MCP execution capability or dependency was added. Final Unity suites, all-runner signal coverage and complete-series gates remain pending. This post-commit ledger entry travels with the next progress update.
- `24360e9` — `fix(validation): require exact compiler and course evidence`
  - Enforced coherent exact-generation compiler receipts, file/code/count expectations for all nine seeded compiler defects, and independent Console assertions for each Marvin Write overload. Compiler observation failures no longer satisfy expected runtime assertion failures.
  - Completed review `20260905-233614-8794ea99`; both independently validated findings were applied. Direct receipt rejection tests cover missing generations and insufficient counts. Final Node 24.11.1 tests passed 290/290 and protocol 10/10; build, typecheck, lint, formatting, strict changed-test typechecking and diff checks passed; audit found zero vulnerabilities.
  - The pre-review-fix live run passed Module 1 23/23, Module 2 43/43 and both cancellation restorations. Parent checks confirmed exact source/scene hashes and observed PageUp/PageDown state changes on the declared fixture driver. These are explicitly not post-review-fix or final complete-series Unity gates.
  - Committed exactly 14 owned implementation/test/evidence files, with no generated Unity data, credentials, course assets or external publication. Remaining local release-candidate gates are unchanged. This post-commit ledger entry travels with the next progress update.
- `81bf257` — `fix(reliability): preserve paired script recovery across callers`
  - Prepared and compensated paired source/metadata changes, retained unverified displaced bytes, preserved later metadata edits, and carried failed recovery receipts through batch/scenario boundaries. Incomplete/unknown scenario recovery now refuses automatic restore/cleanup.
  - Completed eight-lens review `20260905-225422-d12a5216`; three file-grouped follow-ups applied all four independently validated P1 findings. Red/green regressions and fixture-path correction chronology are recorded in `course-ready-verification.md`; no finding was silently waived.
  - Final Windows Unity 2022.3.62f1 EditMode passed 230/230 (40 transaction cases plus six new caller cases), Node 24.11.1 passed 230/230, and protocol passed 9/9. Build, typecheck, lint, format, release-layout and diff checks passed; audit found zero vulnerabilities. No Unity process or owned caller fixture remained.
  - Committed exactly eight owned implementation/test/evidence files; no generated Unity data, credentials, course assets or external publication. Cross-reload ownership, global retention/admission bounds and final integrated course gates remain required. This post-commit ledger entry travels with the next progress update.
- `868c8b4` — `fix(reliability): retain uncertain queue recovery without replay`
  - Added observation-only recovery admission, correlated `OUTCOME_UNKNOWN` receipts, retained non-cached payloads, and protection of unresolved request records from result eviction. Cached outcomes survive expired recovery deadlines; a different transport's live execution owner remains intact.
  - Original crash cases reproduced five failures before the fix. Review finding #2 then reproduced replay after 1,001 newer completions (190/191 tests passed); cleanup was restricted to completed records. Final Windows Unity 2022.3.62f1 EditMode passed 191/191, Node 24.11.1 passed 230/230, and protocol passed 9/9. Typecheck, build, lint, format and diff checks passed; no Unity process remained.
  - Completed five-lens review `20260905-222952-468b6c89`; the independently validated retention finding was fixed, and the active-owner proposal was withdrawn after caller inspection and protected by a characterization test. Review and red/green XML details are in `course-ready-verification.md`.
  - Committed only six owned implementation/test/evidence files. No secrets, generated Unity data, course assets or external publication. Full queue bounds, storage-fault reconciliation and complete-series course verification remain required. This post-commit ledger entry travels with the next progress update.
- `d3f7e85` — `docs(goal): adopt attainable local course-ready acceptance gates`
  - Committed the user-approved active goal contract and rolling evidence ledger. Local Windows Unity 2022.3.62f1 implementation and safety gates remain mandatory; remote CI, other environments and real course projects remain pending external obligations.
  - Reviewed the complete two-file documentation diff and checked whitespace. No code, tokens, generated Unity data, course assets, push or PR were included. This entry is recorded after the commit and will travel with the next progress update.
- `553c6c3` — `fix(security): authenticate complete durable queue requests`
  - Added bounded v2 exact-request HMAC envelopes on Node/C#, authenticated pending and stale claims before inner parsing, and preserved bearer transports, project/capability checks and semantic deduplication. Legacy packets now require an explicit joint Node/UPM upgrade.
  - Five original tampering regressions failed before the fix; final unit evidence: Node 229/229, Unity EditMode 183/183, protocol 9/9, live queue 8/8 and HTTP/WebSocket security 12/12. Typecheck, build, lint, format and diff checks passed. The invalid-token CLI guard failed without printing the token; the owned fixture Editor was stopped.
  - Completed review `20260905-220909-da48b24a` covered eight lenses; its one actionable architecture-documentation finding was independently validated and resolved. Narrow Unicode/manual-publisher/I/O coverage limits and the separate stale-claim/cancellation lifecycle work remain recorded in the verification map.
  - Committed 21 owned implementation/test/documentation files, no tokens, `Library/`, course assets or external publication. This is not a completed-milestone or real-project certification claim.
- `cd4a487` — `test(reliability): make scenario read retries deterministic`
  - Replaced the flaky 25 ms rename timer with real observed `ENOENT` boundaries; proved recovery after one/five missing reads and failure after six without losing the original file bytes. Production retry policy is unchanged.
  - Focused tests 3/3, full scenario tests 34/34, full Node tests 229/229; typecheck, lint, format and diff checks passed. Completed review `20260905-220909-da48b24a` covered the test harness and found no actionable test-fidelity defect.
  - Only the owned scenario test file was committed; authentication, goal and evidence files remained separate. No push or course-project changes.
- `1a2100a` — `fix(reliability): expire queued work against elapsed drain time`
  - Rechecks each queued action against monotonic time consumed by earlier actions; exact deadline equality expires without execution.
  - Completed review `20260905-191957-ac729e43` identified one missing equality assertion. Deterministic one-tick-before/equal/after tests replaced the wall-clock wait and resolved that finding.
  - Real Unity EditMode verification passed 124/124 with zero skips; fresh Node verification passed 218/218, protocol 9/9, lint, format and `git diff --check`. The initial Unity regression failed before the production fix; exact receipts remain in the verification map.
  - Four owned source/test/evidence paths were committed. The unadopted goal proposal remains excluded; no push, course-project changes or generated Unity files were included. Full HTTP/WebSocket cancellation-before-execution evidence remains outstanding.
- `8659db3` — `fix(reliability): retain repair backups and report unknown edits`
  - Prevented backup completion after unverified restoration, retained per-backup cleanup outcomes, and stopped implicit restoration/cleanup replay. Empty source and BOM/CRLF bytes are verified in disk-backed MCP regressions.
  - Applied both validated findings from completed review `20260905-190113-1f67b101`: truthful retained-versus-unverified backup hints, and pre-dispatch apply identity with unknown current hash after a lost response. Unknown applies stop all further requests pending explicit reconciliation.
  - Parent verification passed 45/45 focused integration tests (37 repair cases), `npm test` 218/218, `npm run test:protocol` 9/9, format, lint, typecheck, build, direct strict TypeScript checking of the integration test, `git diff --check`, and `npm audit --audit-level=high` with zero vulnerabilities. Worker review-fix red evidence was 24/37 passing before the fixes; it remains a failed run, not a passing gate.
  - The four committed paths contain only repair implementation, integration tests and evidence documentation. The separate dispatcher fix and unadopted goal proposal were excluded; no secrets, course assets or Unity generated files were staged. No push or PR was made.
  - Controlled bridge responses do not certify live Unity repair behavior, global backup-pruning lifetime, partial C# transaction compensation, or the complete milestone. Full remaining requirements stay active.
- `6443719` — `docs(reliability): document HTTP lifecycle and remaining proof`
  - Documented the authenticated HTTP endpoint and graceful shutdown boundary; recorded the completed transport/lifecycle review fixes and outstanding P0/live gates.
  - Corrected fixture-complete wording so historical course passes cannot waive remaining milestone requirements. No runtime behavior changed.
  - Parent verification at the unchanged `f553e69` code baseline passed `npm test` 181/181, `npm run test:protocol` 9/9, `npm run release:check` and `git diff --check`. The commit contains only the five reviewed documentation paths; no secrets, course assets, Unity generated files or unrelated changes were staged.
- `f553e69` — `fix(runtime): drain scenario restoration before HTTP shutdown`
  - Applied remaining completed-review findings #1/#2/#7 through an injectable CLI coordinator, actual HTTP handler drains and tracked scenario start/recovery/execution/finalization. SIGINT/SIGTERM remain handled through restoration; no cancellation/replay or arbitrary grace expiry is introduced.
  - Added visible sanitized listener/cleanup failures, retained nonterminal finalization records/leases, and startup/output/partial-registration cleanup. Opt-in HTTP is wired through the CLI; stdio remains default.
  - Worker red evidence: missing drain/fatal APIs failed five initial tests; subsequent startup/output errors were reproduced and fixed. Final focused tests passed 90/90. Parent inspected the complete source/test delta and passed `npm test` 181/181, `npm run test:protocol` 9/9, format, lint, typecheck, build, direct strict test-file type checking and `git diff --check`.
  - Real listener/coordinator/manager tests use temporary source/backup files and a controlled Unity bridge to prove original bytes/editor state, late-start admission, repeated signals, final persistence and leases. They do not claim new live Unity or native Windows OS signal coverage. The built CLI rejected an invalid transport with exit 1 and only `MCP_CLI_STARTUP_FAILED`.
  - An attempted `npm run test:course` without a running Unity fixture failed with MCP request timeout before the baseline read; it is not a passing course gate. The unchanged fixture hash and remaining final live checks are recorded in the verification map.
- `0556c94` — `feat(mcp): bound authenticated Streamable HTTP execution`
  - Added the private loopback MCP HTTP transport, token-file permission validation, constant-time authentication, exact project/editor pins, Origin/host/media restrictions and bounded body/header/connection/result processing. Shared scenario state can be supplied to stateless request servers.
  - Applied completed review `20260905-140723-c9592b15` findings #3/#4/#5/#8 with legacy batch preflight/correlation and per-entry admission, authenticated quota accounting, output deadlines through response finish/close, and standard JSON-RPC error classes. Detached requests are not implicitly cancelled or replayed.
  - Red-first tests reproduced batch failures, quota starvation, protocol-code loss and retained real socket output beyond its deadline. A separate Windows raw-reader test is integration evidence, not a deterministic backpressure reproduction. Its owned child cleanup is idempotent and awaits observed exit.
  - Parent verification: `npm test` 149/149; `npm run test:protocol` 9/9; format, lint, typecheck, build and diff checks passed; `npm audit --audit-level=high` reported zero vulnerabilities. After final test-helper/type-narrowing edits, parent reran all 24 HTTP tests, direct strict TypeScript checking of that test file and owned-file formatting successfully.
  - At this commit, CLI enablement/config and review #1/#2/#7 were pending; `f553e69` subsequently completed that lifecycle slice. Neither commit certifies the full course-readiness milestone.
- `23718cb` — `fix(reliability): preserve durable state on replacement failure`
  - Replaced eight C# durable-state writers' delete/move fallbacks with one flushed, unique-sibling atomic replacement helper. A failed replacement preserves the prior bytes; only replacement I/O receives four bounded attempts, and cleanup failure preserves both errors.
  - Added regressions for Unicode/no-BOM writes, original-byte preservation, unsupported/denied replacement, real Windows reader contention and temporary-file cleanup failure, operation persistence, and request-result recovery without mutation replay.
  - Test-first evidence: the old writer failed five of 118 EditMode cases; after removing the fallback, a broader run exposed real Windows sharing failures. A focused retry regression failed before the bounded retry fix. The final fresh Unity 2022.3.62f1 EditMode run passed 121/121 (`editmode-5b248286-a707-4827-ae08-44a46d16429f-results.xml`).
  - Parent verification also passed `npm test` (139/139), `npm run test:protocol` (9/9; 90 tools/57 direct mappings), and `git diff --check`. These Node results include the still-uncommitted HTTP work and do not certify its unresolved paths.
  - Completed code review `20260905-140723-c9592b15` retained no atomic-writer finding; its seven independently validated HTTP findings were subsequently addressed in `0556c94` and `f553e69`. This commit does not close script-transaction compensation, queue recovery/authentication, or the full milestone.
- `87d31b9` — `feat(physics): add collider and rigidbody setup tools`
  - Preserved and integrated the pre-existing `collider_setup` and `rigidbody_setup` user work.
  - Passed `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
  - Live KOTOR bridge validation was unavailable because no Unity bridge was listening on port 6400.
- `d2f1f25` — `fix(core): promote Unity failures into truthful MCP results`
  - Added stable response correlation/error fields and promoted bridge soft failures, failed operations, timeouts, cancellations, and failed test counts to MCP `isError:true` while preserving structured data.
  - Passed 5 Node tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `fd5df75` — `fix(core): replace regex JSON-RPC parsing with typed JSON`
  - Replaced regex/manual request parsing with the pinned Unity Newtonsoft package and strict JSON-RPC validation.
  - Added a repository-owned Unity 2022.3 test project and reproducible `npm run test:unity:editmode` runner.
  - Passed 10 Unity EditMode tests, 5 Node tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `d03e640` — `fix(core): scope compile and test outcomes to exact generations`
  - Added persisted compile/import generations, generation-scoped diagnostics, mutation hashes/generation receipts, exact compile polling across reload, truthful script validation, and non-green Unity Test Runner classification with failed-test details.
  - Passed 19 Unity EditMode tests, 7 Node tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - Live headless Unity smoke created a valid script as generation 2, observed a clean completion after domain reload, deleted it as generation 3, observed clean cleanup completion, and verified the temporary file was absent.
- `625f2af` — `docs(audit): record course-ready reliability scope and progress`
  - Added the deep audit, executable milestone prompt, and this commit/gate ledger to the repository.
- `ac32c51` — `docs(audit): normalize report metadata`
  - Normalized the audit timestamp and provenance metadata used by the executable milestone prompt.
- `ddf507c` — `fix(core): make repair loops bounded and restorative`
  - Replaced the proposal-only repair behavior with bounded propose/apply/compile/test/verify iterations and last-known-good restoration.
  - Passed 9 Node tests, 19 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `cfc4468` — `fix(reliability): make script mutations transactional`
  - Added optimistic SHA-256 concurrency, bounded unified dry-run diffs, encoding/newline preservation, flushed sibling writes, retained recovery backups, and byte-identical restore receipts.
  - Live Unity smoke proved create, stale-hash rejection, dry-run, expected-hash write, generation-scoped compile, byte-identical restore, transaction completion, and delete cleanup.
  - Passed 9 Node tests, 25 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `f561f1b` — `fix(reliability): make batches preflighted and reversible`
  - Added full preflight before mutation, exact maximum-risk acceptance, fail-fast required-item behavior, reverse-order file/Undo compensation, and truthful incomplete-rollback reporting.
  - Passed 9 Node tests, 29 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `80b9b4e` — `docs(progress): record core reliability verification`
  - Recorded the transactional script and batch verification evidence in the milestone ledger.
- `01044b0` — `fix(reliability): persist and bound bridge operations`
  - Added persistent request claims/results, deduplication, deadlines, cancellation markers, leases, stale recovery, retention cleanup, bounded dispatcher/queue work, fragmented WebSocket assembly, request/message/concurrency limits, durable operation records, and explicit unknown-outcome semantics.
  - Passed 13 Node tests, 48 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - A live Unity `2022.3.62f1` durable-queue smoke passed all 8 checks. HTTP/WebSocket were not exercised because the test project's bridge auto-start setting was disabled.
- `6577659` — `fix(reliability): bound screenshot comparisons and memory`
  - Rejected dimension mismatches by default, added explicit bilinear resampling, capped encoded images/effective pixels/estimated memory, guarded every texture/render-target allocation with cleanup, and reported dimensions and comparison methods.
  - Passed 13 Node tests, 55 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
- `fed5a3e` — `feat(security): authenticate and pin every Unity editor connection`
  - Added per-project owner-only bearer tokens, HMAC-authenticated durable queue messages, stable project/editor identity, persisted deterministic HTTP/WebSocket ports, loopback-only listeners, Origin rejection, exact project pinning, request/rate/concurrency limits, and default-deny capability classes.
  - Added canonical project/Assets path containment with junction/symlink rejection, truthful destructive/open-world tool annotations, `SECURITY.md`, and a repeatable authenticated security smoke suite.
  - Passed 16 Node tests, 73 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - Live Unity `2022.3.62f1` security validation passed HTTP missing/wrong-token and browser-Origin rejection, exact project/editor mismatch errors, destructive and package/network default-deny, pinned HTTP health, WebSocket missing-token/Origin rejection, fragmented WebSocket health, and oversized WebSocket close code `1009`.
  - Live authenticated durable-queue fallback passed all 8 read-only/dry-run smoke checks. The bridge token ACL was verified as non-inherited and restricted to the current Windows user.
- `0e95a69` — `feat(runtime): control play mode, console boundaries, and test input`
  - Added reload-resilient normal Play mode get/set/step operations, persisted Console clear/mark/wait/assert boundaries, and verified keyboard/pointer simulation through the Unity Input System or a project-scoped deterministic driver.
  - Added a clean-room runtime fixture proving PageUp, PageDown, pointer clicks, and exact one-frame stepping through observable fixture state and Console evidence; unsupported inputs return typed `UNSUPPORTED_INPUT_BACKEND` failures.
  - Passed 19 Node tests, 84 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - Live Unity `2022.3.62f1` runtime smoke passed scene open, Console clear/boundary assertions, normal Play transition across domain reload, verified PageUp/PageDown and pointer delivery, typed unsupported-input rejection, pause, exact frame `19 -> 20`, and clean stop. Project/editor identity remained pinned across reload.
- `df2c115` — `feat(validation): run restorable scenario matrices with evidence bundles`
  - Added project/editor-pinned durable scenario jobs with get/list/cancel/result lifecycle, exact-generation source transactions, normal Play/input/Console/object/screenshot assertions, reload recovery, byte-identical restoration, and resource-backed evidence artifacts.
  - Added deterministic manifest, result, compiler, Console, Markdown, redacted source-diff, and screenshot evidence with bounded artifact handles and no upload behavior.
  - Passed 22 Node tests, 86 Unity EditMode tests, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - Live Unity `2022.3.62f1` scenario smoke passed green, expected compiler-failure, unexpected assertion-failure, expected timeout, and cancellation paths. All five emitted local evidence bundles and restored `Gam215InputDriver.cs` to SHA-256 `faddda91a571d64e4bb14507c1e7224d3b323c2586e98eccf092528f1c376b0f`.
- `6af0e6d` — `test(course): prove GAM 215 module 1 and 2 automation loops`
  - Added a clean-room Marvin-compatible fixture with the exported two- and three-argument `Write` overload families plus `Play`, `Draw`, and `ShowOrHide`, deterministic serialized/visual state, and PageUp/PageDown navigation.
  - Added declarative 23-case Module 1 and 43-case Module 2 matrices covering all requested constructs, compiler and semantic defects, boolean tables, exactly 16 comparison plays, assignment steps, early return, navigation, timeout, and separate per-module cancellation restoration.
  - Fixed Ghost's reload-unsafe variable-length IMGUI command history after the scenario Console boundary correctly detected Ghost's own layout exception.
  - Passed 24 Node tests, 86 Unity EditMode tests, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:course`, and `git diff --check`.
  - Live Unity `2022.3.62f1` course evidence: Module 1 operation `fe63864a-c14a-4b68-8797-ce57580022cd` passed 23/23 with 13 screenshots; Module 2 operation `164d63b4-d697-4da4-9ae1-870a13ea6159` passed 43/43 with 42 screenshots. Separate cancellations `aa2b7bb7-8be5-4ae2-bd7d-dabfb5f605f1` and `0ebcf0c8-afaf-4769-b37f-a9a5f47f53bc` restored cleanly. The baseline source remained SHA-256 `0ff9034f3593c47b17f158f0538127eab5d84aeaadcb58c5716018ef82a99a89`, with zero retained source transactions.
- `c0263d8` — `chore(deps): patch runtime dependencies and clear audit findings`
  - Updated the MCP SDK, `ws`, Zod, `tsx`, and Node type declarations within their compatible release lines and re-locked transitive dependencies.
  - Passed `npm run typecheck`, `npm run build`, 24 Node tests, `npm audit --audit-level=high` with zero vulnerabilities, and `git diff --check`.
- `3262494` — `refactor(contracts): generate typed operation catalog`
  - Added a deterministic 90-operation catalog with stable IDs, JSON Schema 2020-12 input/output contracts, validated examples, resource relationships, domain profiles, and complete risk/execution metadata. Every MCP tool now advertises an output schema.
  - Added the paginated `capabilities_search` tool and a seven-tool default core profile; authoring, code, runtime, validation, and all-tool surfaces require explicit CLI profile selection.
  - Split the C# command registry registration table by domain and generated a direct bridge-operation parity list consumed by both Node protocol tests and Unity EditMode tests.
  - Added reproducible format, lint, catalog drift, protocol, and PlayMode scripts. Protocol coverage includes deterministic discovery, invalid cursors, resource URI parity, soft failures, and fragmented WebSocket responses.
  - Passed `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, 31 Node tests, 6 focused protocol tests, 87 Unity EditMode tests, `npm audit --audit-level=high` with zero vulnerabilities, and `git diff --check`.
- `d05c727` — `chore(ci): test supported node and unity matrices`
  - Versioned the candidate as `0.2.0-rc.1`, narrowed the UPM support claim to Unity 2022.3, added deterministic client/release validation scripts, and added Node 20/22/24 cross-platform plus Unity 2022.3.62f1 EditMode/PlayMode workflows.
  - Added a package-installed PlayMode assembly and current/oldest-supported MCP generation negotiation coverage.
  - Local Windows gates passed 87/87 Unity EditMode tests, 1/1 Unity PlayMode test, 7 focused protocol tests, release layout validation, package dry-run inspection, and a token-free generated client configuration.
  - GitHub-hosted matrix results are configured but not yet observed because this local task does not push; they are not counted as certified.
- `5b0e8a0` — `docs(release): correct install, security, support, and course readiness`
  - Added MIT licenses, root/UPM changelogs, a reproducible release checklist, secure install/profile guidance, migration and rollback steps, corrected root `dist/index.js` paths, and an explicit supported-version boundary.
  - Preserved the qualification `GAM 215-equivalent fixture complete; real course-project certification pending` and documented the unavailable copyrighted-project gate without weakening local gates.
  - Passed `npm run release:check` and `git diff --check` before commit.
- `1ab18f3` — `test(fixture): keep headless runtime validation active`
  - Made the test project's recurring Unity Test Runner `runInBackground` setting explicit so Play/input validation does not depend on Game-view focus and repeatable EditMode/PlayMode runs leave the tracked fixture clean.
  - Passed 87/87 Unity EditMode tests and 1/1 Unity PlayMode test on Unity `2022.3.62f1` for Windows.
- `c773cd9` — `test(smoke): remove KOTOR-specific baseline assumptions`
  - Made the repair smoke default to the repository fixture, accept truthful caller-default test scope when no semantic match exists, and require visual baseline selection/diff only when a baseline filter is explicitly supplied.
  - Passed formatting, lint, typecheck, all 32 Node tests, the live fixture script validation/repair inspection/screenshot/dry-run flow, and `git diff --check`.
- `348c94e` — `fix(validation): recover source restoration across reload`
  - Made scenario source restoration retry-safe across queue races and Unity domain reload, with durable receipts and byte-identical hash verification.
  - Passed formatting, lint, typecheck, build, Node/protocol tests, Unity EditMode/PlayMode tests, and live scenario recovery checks.
- `f29b88d` — `fix(review): close course-ready reliability gaps`
  - Applied all 23 validated review findings across fail-closed batches, diagnostic/Console truncation, semantic request deduplication, bounded HTTP/WebSocket handshakes, screenshot coverage, live-owner scenario leases, evidence redaction, explicit input backends, generated request contracts, registry/server decomposition, and reproducible live-course CI.
  - Preserved and cataloged the pre-existing `collider_setup` and `rigidbody_setup` work.
  - Passed a fresh `npm ci`; `npm run format:check`; `npm run lint`; `npm run typecheck`; `npm run build`; 40/40 `npm test`; 9/9 `npm run test:protocol`; `npm audit --audit-level=high` with zero vulnerabilities; `npm run release:check`; `npm run release:pack`; and `git diff --check`.
  - Passed 105/105 Unity EditMode tests and 1/1 Unity PlayMode test on Unity `2022.3.62f1` for Windows.
  - Passed the live security, runtime, scenario, and repair smokes. Security proved 12 HTTP/WebSocket authentication, Origin, pinning, default-deny, fragmentation, and size-limit checks. Runtime proved Play/Pause/Step/Stop plus PageUp/PageDown and pointer delivery through `project-test-driver:gam215-fixture`, with typed unsupported-input failure.
  - Final live course evidence passed Module 1 at 23/23 cases with 13 screenshots and Module 2 at 43/43 cases with 42 screenshots. Timeout/cancellation restoration passed, and both suites restored `StudentExercise.cs` to SHA-256 `0ff9034f3593c47b17f158f0538127eab5d84aeaadcb58c5716018ef82a99a89`.
  - GitHub-hosted and self-hosted workflow results remain unobserved because this task does not push. The real Variablekiller and Conditionalkiller assets were unavailable, so the release qualification remains `GAM 215-equivalent fixture complete; real course-project certification pending`.

- `b990da7` — `fix(reliability): preserve scenario receipts and repair editor state`
  - Applied final review findings 1, 2, 4, and 6: distinguish unavailable Console observations from semantic timeouts; persist completion under the scenario lease; keep public results non-ready through cleanup; bound Play polling by the original deadline; and verify repair-smoke scenes, selection, and Play state before reporting restoration.
  - Added complete sensitive C# assignment redaction and explicit client disposal. A failed terminal-record write now retains ownership and exposes `SCENARIO_FINALIZATION_PERSIST_FAILED` instead of releasing an unpersisted operation.
  - Removed the unsafe delete-destination fallback from atomic record writes. A real Windows sharing-lock regression reproduced `EPERM`; bounded replacement retries now preserve the old readable record through 1.95 seconds of backoff and clean only the writer's temporary file on failure.
  - Passed `npm test` (86/86), `npm run test:protocol` (9/9; 90 tools and 57 direct bridge mappings), `npm run build`, `npm run format:check`, `npm run lint`, and `git diff --check` on the integrated working tree. Complete-series live validation is still required after the separate certification-runner commit.
  - Review receipt: completed `ce-code-review` run `20260905-114254-4a95bfe0`; three file-grouped fix batches applied findings 1/2/6 (scenario), 3 (collision evidence), and 4 (repair lifecycle), with no finding silently waived. Finding 3 and the runner hardening are verified locally but not yet committed in this slice.

- `4a205ca` — `fix(testing): verify owned Windows process cleanup`
  - Reproduced Windows `taskkill /T` stalling for 15 seconds in the existing child-cleanup test and for 45 seconds in two concurrent isolated probes. Replaced that test-runner helper with bounded PowerShell 7/.NET tree termination; matching concurrent probes completed in about two seconds.
  - Added regressions proving that cleanup errors survive root exit and that a real descendant is stopped while an unrelated sentinel remains live. The six focused certification tests pass. PowerShell 7 is a Windows test prerequisite, not an MCP runtime dependency.
  - Separated the scenario harness's 30-second observation budget from production operation deadlines after a five-second observation timeout abandoned ongoing disk work. All timeout assertions remain intact; failure diagnostics now include the last observed operation state.
  - Passed a fresh `npm ci`, `npm test` (88/88), `npm run test:protocol` (9/9), formatting, lint, typecheck, build, release layout/package checks, standalone runner-script typecheck, `npm audit --audit-level=high` (zero vulnerabilities), and `git diff --check` on the integrated working tree.
  - Fresh Unity Windows `2022.3.62f1` results passed EditMode 111/111 (`editmode-85f2e74f-48c8-4771-a43c-f22e2a196683-results.xml`) and PlayMode 1/1 (`playmode-898af9c3-f261-410c-90cf-b00c6429bc6d-results.xml`).
  - The next real concurrent cancellation attempt did **not** reach cancellation: both cold Editors stalled at the initial ILPP compiler-worker ping and readiness expired after 420 seconds. The new cleanup path successfully stopped both owned Editors and removed the temporary workspace. The failed gate is preserved at `test-project/Logs/concurrent-editors-cancellation-startup-timeout-20260905T194743Z.json`; cleanup success is not cancellation-suite certification.

- `6f32c43` — `fix(certification): prove exact editor routing and collision outcomes`
  - Committed final review finding 3: a stopped bridge is not a collision receipt. Startup failures now identify the bind stage, exact HTTP/WebSocket transport and configured port, and typed native error without exposing exception messages.
  - Added the concurrent/cancellation certification runners, exact executable-version checks, unique NUnit results with strict aggregate validation, existing-identity protection, shared owned-process cleanup, explicit supported-version metadata, and CI wiring.
  - The fresh retry passed `npm run test:unity:concurrent:cancel` (8/8; SIGTERM after both bridges became ready, complete owned-process/registry/workspace cleanup), completed at `2026-09-05T19:52:16.550Z`. A fresh full `npm run test:unity:concurrent` passed all 31 routing, authentication, forced HTTP collision, forced WebSocket collision, and cleanup checks. The earlier cold-start failure remains preserved as diagnostic evidence.
  - Integrated gates remain Node 88/88, protocol 9/9, EditMode 111/111, PlayMode 1/1, zero dependency advisories, and green format/lint/typecheck/build/release checks. These receipts precede final complete-series course/repair verification and are not a completion certificate.

- `b17b8f4` — `fix(reliability): coordinate scenario reads and atomic replacement`
  - Diagnosed a Windows persistence race: manager-owned status/evidence reads held the destination open while another manager replaced it. A controlled probe failed 144/200 replacements with concurrent reads and 0/200 without them.
  - Added a shared canonical-path leaf-I/O interlock for job, lease and evidence files; Windows path aliases share the lock. Retained bounded external-lock retries, prior-record preservation and idle-lock cleanup.
  - Three held-reader regressions failed before implementation, then passed. Parent verification passed the focused scenario suite at 29/29, integrated `npm test` at 112/112, protocol at 9/9, zero dependency advisories and `git diff --check`. The fix is in-process; external readers remain subject to the bounded retry policy.

- `1e50fca` — `fix(testing): preserve truthful evidence through timeout and cancellation`
  - Added bounded standalone Unity work, fresh per-invocation XML/log paths, cancellation-aware filesystem observation, required cleanup before acceptance, and structured failure evidence. Historical aggregate reports are neither replaced nor reused.
  - Completed review `20260905-131222-e0e2a692`; two file-grouped follow-up batches applied all three validated findings. Runner regressions moved from 7/21 green before fixes to 21/21; a CLI partial-registration leak was independently reproduced and fixed, with all 12 CLI cases passing.
  - Parent gates passed `npm test` 124/124, formatting, lint, typecheck, build and `git diff --check`; immediately preceding protocol/audit checks passed 9/9 and zero vulnerabilities. The actual executable CLI rejected an invalid platform with exit 1 and did not launch Unity.
  - Real runner evidence passed EditMode 111/111 and PlayMode 1/1 before the CLI-only extraction. Controlled real-Editor timeout/cancellation probes failed with the correct codes and unique evidence paths, preserved historical reports and left no Editor running. Exact paths are in `docs/course-ready-verification.md`.
  - The separate `-version` subprocess cleanup advisory remains open; suite-child cleanup and injected verification tests do not certify that earlier process boundary.

- `af77d89` — `docs(reliability): distinguish verified evidence from remaining gates`
  - Recorded the runner/scenario regression evidence, preserved failed-run chronology, corrected implemented transport claims and narrowed support wording to observed versions/platforms.
  - Added the incomplete verification map, unique-evidence and Windows process-cleanup prerequisites, explicit remaining implementation gaps and final external gates.
  - Passed `npm run release:check` (90 operations, 57 direct mappings, pinned Newtonsoft 3.2.1) and `git diff --check`. No credentials, course assets or generated Unity artifacts were committed.
  - Post-commit real Unity runner checks passed EditMode 111/111 and PlayMode 1/1, with fresh unique XML recorded in the verification map, no remaining Editor processes and unchanged fixture/historical-report hashes. The narrow PlayMode coverage gap remains open.

Next required slice:

- Keep `docs/course-ready-verification.md` current as an incomplete evidence map, not a release certificate.
- Fix the reproduced repair-backup retention defect, remaining script-transaction/queue/deadline safety gaps, and stdio generation conformance recorded in the verification map.
- Add broader real PlayMode coverage. Do not treat the existing single driver-contract test or Editor-only Input System receipt tests as full lifecycle/Console/scenario or gameplay-input coverage. Include the new secured HTTP lifecycle in final live integration verification.
- Strengthen the executable-verification subprocess cleanup boundary and its real-process regression coverage.
- Run final complete-series gates after the remaining implementation work, including fresh course and repair live smokes. Do not label the release candidate complete from unit counts or partial cleanup proof.
- Observe the configured remote CI matrices after an authorized push and run the opt-in real-project smoke manifests when the Variablekiller and Conditionalkiller projects are available.

## Phase 1: Foundation

Status: validated against the live KOTOR Unity project on 2026-05-15; remaining work is automation depth and broader Unity-version coverage.

Completed:

- Structured MCP response envelope with diagnostics, confidence, undo group, and duration fields.
- Tool metadata for risk level, mutation status, dry-run support, related resources, and roadmap phase.
- Phase 1 MCP tools: `ping`, `health`, `editor_state_get`, `console_read`, `scene_hierarchy_get`, `gameobject_create`, `transform_set`, `scene_save`, and `screenshot_capture`.
- Compatibility tools: `unity_get_editor_state`, `unity_get_console_logs`, `unity_get_scene_hierarchy`, `manage_scene`, `manage_gameobject`, and `batch_execute`.
- MCP resources for read-heavy context: `unity://capabilities`, `unity://editor/state`, `unity://scenes/active`, `unity://console/errors`, and `unity://semantic/index`.
- MCP prompts for resource-first inspection and dry-run-first repair planning.
- Unity bridge commands for editor state, console log buffer, scene hierarchy/save, GameObject create/transform/find/get/delete, screenshot capture, and batch execution.
- Undo groups for GameObject mutations.
- Dry-run previews for mutating scene, GameObject, screenshot, and batch commands.
- Durable file queue under `Library/UnityMcpGhost/queue` with `pending` and `results` folders.
- TypeScript queue fallback via `--unity-project-path` or `--unity-queue-dir`.
- Bridge window status for endpoint, connected clients, durable queue, last request, recent commands, and last error.
- Editor-load bridge service that starts the local bridge automatically on port `6400` unless disabled from the Ghost window.
- HTTP JSON-RPC hot path, with WebSocket and durable queue fallback.

Game-development fit:

- The implemented commands target everyday Unity game development workflows: inspect editor state, read diagnostics, inspect scene hierarchy, create and place objects, save scenes, capture visual state, and batch repetitive scene edits.
- The implementation avoids generic filesystem powers where Unity APIs are safer and more game-aware.
- Mutating commands are undoable or dry-run previewable so agents can iterate without trashing a scene.

Remaining before Phase 1 can be called complete:

- Validate Unity C# compilation inside Unity 2021.3, 2022.3, and Unity 6.
- Add automated EditMode smoke tests for bridge commands.
- Improve screenshot completion reporting after Unity finishes writing the PNG.
- Add a release checklist for v0.1.0.

## Phase 2: Parity Floor

Status: Phase 2 parity floor implemented and validated against the live KOTOR Unity project; remaining work is hardening and broader Unity-version coverage.

Completed in Slice 1:

- Component tools:
  - `component_add`
  - `component_get`
  - `component_modify`
  - `component_remove`
  - `manage_component`
- Asset tools:
  - `asset_find`
  - `asset_create_folder`
  - `asset_refresh`
  - `manage_asset`
- Prefab tools:
  - `prefab_create`
  - `prefab_instantiate`
  - `manage_prefab`

Completed in Slice 2:

- Scene lifecycle tools:
  - `scene_create`
  - `scene_open`
  - `scene_set_active`
  - `scene_unload`
- Hierarchy editing tools:
  - `gameobject_duplicate`
  - `gameobject_set_parent`
- Expanded compatibility tools:
  - `manage_scene` now routes create/open/set-active/unload actions.
  - `manage_gameobject` now routes duplicate and set-parent actions.

Completed in Slice 3:

- Conservative AssetDatabase mutation tools:
  - `asset_move`
  - `asset_copy`
  - `asset_delete`
  - `manage_asset` now routes move/copy/delete actions.
- C# script asset tools constrained to `.cs` files under `Assets/`:
  - `script_read`
  - `script_create`
  - `script_write`
  - `script_delete`
  - `manage_script`
- Improved JSON string parsing in the Unity bridge so script content with escaped newlines and quotes can round-trip more safely.

Game-development fit:

- Component tools let agents assemble real gameplay objects with colliders, rigidbodies, audio sources, renderers, cameras, and project MonoBehaviours through Unity APIs.
- Asset tools let agents locate sprites, models, materials, scenes, scripts, audio clips, prefabs, and folders through `AssetDatabase` instead of guessing paths.
- Prefab tools let agents convert scene prototypes into reusable game content and instantiate existing prefab assets back into scenes.
- Scene lifecycle tools let agents create test scenes, open level scenes, work additively, and set the active authoring target without manual editor clicks.
- Hierarchy editing tools let agents organize gameplay objects under managers, spawn points, level roots, cameras, UI canvases, and prefab containers.
- Mutating component, asset, and prefab operations support dry-run previews where Unity supports meaningful previews.
- Scene-object mutations use Unity Undo where possible.
- Asset and script tools use `AssetDatabase` and project-relative `Assets/` constraints instead of unrestricted filesystem access.

Slice 3 validation on KOTOR Unity project:

- Dry-run `asset.move`, `asset.copy`, and `asset.delete` passed using `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- Read-only `script.read` passed on `ModuleSpawnPipeline.cs` with a 30k-character script payload.
- Dry-run `script.create`, `script.write`, and `script.delete` passed without changing KOTOR project assets.

Completed in Slice 4:

- Long-running operation registry:
  - `operation_get`
  - `operation_list`
- Unity Package Manager tools:
  - `package_list`
  - `package_search`
  - `package_add`
  - `package_remove`
  - `manage_package`
- Unity Test Runner hook:
  - `tests_run`

Game-development fit:

- Package tools let agents inspect and configure game-development packages such as Cinemachine, Input System, Addressables, AR Foundation, Unity IAP, and platform service packages through Unity Package Manager rather than editing manifests by hand.
- Test execution returns an operation id so long-running EditMode/PlayMode suites can be polled safely instead of blocking the editor or MCP client.
- Mutating package actions support dry-run previews, which is important when working in production-scale projects like the KOTOR port.

Slice 4 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- `package.list` completed successfully and reported 50 registered packages.
- Dry-run `package.add` passed for `com.unity.cinemachine`.
- Dry-run `package.remove` passed for `com.unity.cinemachine`.
- Dry-run `tests.run` passed for an EditMode filter without launching the full KOTOR test suite.

Completed in Slice 5:

- LSP-style ranged script edit tool:
  - `script_apply_edits`
  - `manage_script` now routes `apply_edits`.
- MCP resource templates and state resources:
  - `unity://packages`
  - `unity://operations`
  - `unity://gameobject/{instanceId}`
  - `unity://component/{instanceId}/{type}`
  - `unity://assets/{filter}`
  - `unity://operation/{operationId}`
  - `unity://tests/{mode}`

Game-development fit:

- Ranged script edits let agents make small targeted C# changes without replacing entire scripts, which is safer for gameplay code, import pipelines, and large systems like the KOTOR module loader.
- Resource templates let MCP clients browse Unity state as context before choosing tools, keeping read-heavy inspection cheaper and less risky than tool-first workflows.

Slice 5 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- Dry-run `script.apply_edits` passed against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`, reporting original and updated byte counts without changing the file.
- `package.list` still completed successfully and reported 50 registered packages after the resource-template changes.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Remaining Phase 2 hardening:

- Validate the same bridge against Unity `2021.3` and Unity `6000.x`.
- Add automated MCP-level resource-template tests.
- Add EditMode tests for bridge command handlers.

## Live Test Project: KOTOR Unity Port

Path: `C:\Users\NewAdmin\Documents\KaiGenInteractive\Kotor-Unity`

Purpose:

- Use the active KOTOR Unity port as the real-world validation project for Ghost.
- Keep validation game-development focused: imported KOTOR assets, prefabs, scenes, module content, materials, and diagnostics.
- Prefer read-only and `dryRun` checks unless an explicit test mutation is planned.

Setup completed:

- Repointed KOTOR Unity package manifest from the old `Unity-MCP` package path to this active `Unity-MCP-Ghost` repo.
- Repointed `Packages/packages-lock.json` to the same active package path.
- Added `npm run smoke` in Ghost to run a repeatable read-only/dry-run bridge validation suite.
- Patched a KOTOR compile blocker in `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` by initializing two `GameObject root` locals to `null`.

Validation completed on 2026-05-15:

- Unity exited Safe Mode and compiled the Ghost bridge in Unity `2022.3.62f1`.
- `npm run build` passes for the TypeScript MCP server.
- Durable queue smoke test passed through `C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity/Library/UnityMcpGhost/queue`.
- Direct HTTP bridge smoke test passed on `http://127.0.0.1:6400/unity-mcp-ghost/`.
- Smoke covered `health`, `editor.get_state`, `scene.get_hierarchy`, `console.get_logs`, `asset.find` for prefabs/materials, and dry-run `gameobject.create` plus `asset.create_folder`.
- Active scene during validation: `Assets/Scenes/GameplayTest.unity`, with three root objects detected.
- Console error smoke returned zero Ghost-captured errors.
- Existing KOTOR warnings remain in scripts such as `CharacterCreationLayoutModels.cs`, `MCPKotorMainMenuBootstrap.cs`, `VmDispatcher.cs`, and `WAVObject.cs`; these are not Ghost bridge blockers.

Direct smoke command:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000
```

Durable-queue smoke command:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 20000
```

## Phase 3: Ghost Moat

Status: in progress, diagnostics, semantic project understanding, screenshot validation, and the first repair-loop visual triage layer are implemented.

Completed in Slice 1:

- Structured console diagnostics:
  - `console_diagnostics_get`
- Script validation entry point:
  - `script_validate`
  - `manage_script` now routes `validate`.

Game-development fit:

- Diagnostics are the first building block for the promised validate -> repair -> test workflow.
- `script_validate` imports a C# script through Unity and returns bridge-session diagnostics without guessing from raw files alone.
- Structured diagnostics include severity, message, stack trace, and parsed `Assets/...cs(line,column)` locations when Unity provides them.

Slice 1 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- `script.validate` passed against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `console.diagnostics_get` returned zero diagnostics for that script after the earlier KOTOR compile fix.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Completed in Slice 2:

- Polling-aware compile/update wait:
  - Unity bridge command `compile.wait`
  - MCP tool `compile_wait`
- First repair-loop orchestrator scaffold:
  - `repair_loop_run`

Game-development fit:

- `compile_wait` gives agents a reliable way to wait for Unity to finish script compilation and asset refreshes before making follow-up gameplay edits.
- `repair_loop_run` now sequences the Phase 3 loop's read-only half: editor state -> optional script validation -> compile wait -> structured console diagnostics -> scoped test dry-run or test execution.
- The current repair loop deliberately stops before patching. It points agents toward `script_apply_edits` with `dryRun=true` so repair work stays reviewable and Unity-aware while the full patch-generation layer is still being built.

Slice 2 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- Direct `compile.wait` completed successfully after Unity finished updating.
- MCP-level `compile_wait` completed through stdio against the open KOTOR project.
- MCP-level `repair_loop_run` completed a five-step diagnostic pass against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `console_diagnostics_get` returned zero diagnostics for the scoped KOTOR script during the repair-loop pass.

Completed in Slice 3:

- Deterministic patch proposal planner:
  - `patch_propose`
- `repair_loop_run` now attaches patch proposals when diagnostics are present.

Game-development fit:

- `patch_propose` is intentionally conservative: it does not call a model, does not mutate files, and only emits ranged edits for localized compiler diagnostics such as missing semicolons or braces.
- For Unity/gameplay-specific diagnostics such as missing types, unknown symbols, or missing members, it recommends project-aware checks first: asmdefs, package availability, Inspector-wired fields, and component/API mismatches.
- Optional `previewDryRuns` routes proposed edits through `script.apply_edits` with `dryRun=true`, so agents can verify byte-count and range effects before touching gameplay scripts.

Slice 3 validation on KOTOR Unity project:

- MCP-level `patch_propose` converted a synthetic `CS1002` diagnostic for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` into one ranged edit proposal.
- `previewDryRuns=true` successfully routed that proposal through Unity `script.apply_edits` with `dryRun=true` without modifying the KOTOR project.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Completed in Slice 4:

- Explicit repair application tool:
  - `repair_apply_edits`
- `repair_loop_run` now points accepted edits through `repair_apply_edits` instead of raw script editing.

Game-development fit:

- `repair_apply_edits` backs up the original C# script content, dry-runs ranged edits first, applies only when `dryRun=false`, waits for Unity compile/update, revalidates scoped diagnostics, and can restore the original file if compile/diagnostic/test checks fail.
- The tool is built for gameplay code safety: it works on explicit ranged edits, keeps the script path scoped under Unity's `Assets/`, and treats test execution as an optional validation gate for risky changes.
- This is the first closed-loop repair slice that can move from preview to apply to validation while still protecting project code with rollback.

Slice 4 validation on KOTOR Unity project:

- MCP-level `repair_apply_edits` completed a dry-run preview against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- The dry-run path read the original script, produced a backup metadata step, and routed the proposed ranged edit through Unity `script.apply_edits` with `dryRun=true`.
- The KOTOR project was not mutated during this validation.

Completed in Slice 5:

- Repeatable Phase 3 repair smoke command:
  - `npm run phase3:repair-smoke`
  - Optional `--allow-mutation` scratch-script rollback mode

Game-development fit:

- The default smoke keeps production gameplay code safe by validating `repair_apply_edits` in dry-run mode against the target project script.
- The explicit mutation mode creates a controlled scratch C# script under `Assets/UnityMcpGhostScratch`, introduces a compiler error through `repair_apply_edits`, verifies rollback restored the original content, then deletes the scratch asset and folder.
- This gives Ghost a repeatable confidence check for the repair loop's most important promise: a failed automated code repair should not leave the Unity project broken.

Slice 5 validation on KOTOR Unity project:

- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 30000` passed in dry-run mode.
- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 60000 --allow-mutation` passed in scratch mutation rollback mode.
- The scratch rollback path reported `mode: rolled-back`, `scopedErrorCount: 1`, verified the restored file content matched the original, deleted `Assets/UnityMcpGhostScratch/GhostRepairScratch.cs`, deleted `Assets/UnityMcpGhostScratch`, and waited for compile after cleanup.

Completed in Slice 6:

- Unity compiler-pipeline diagnostic buffer:
  - Unity bridge command `compile.diagnostics_get`
  - MCP tool `compile_diagnostics_get`
- `patch_propose`, `repair_loop_run`, and `repair_apply_edits` now prefer compiler-pipeline diagnostics and fall back to console-derived diagnostics.

Game-development fit:

- Compiler diagnostics now come from `UnityEditor.Compilation.CompilationPipeline.assemblyCompilationFinished`, giving Ghost a more precise source for C# file, line, column, severity, compiler code, and assembly path.
- This improves gameplay-script repair loops because compile errors can be scoped to the script being edited instead of inferred only from generic console text.
- Console diagnostics remain as fallback for runtime exceptions, Unity API errors, and non-compiler failures.

Slice 6 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- MCP-level `compile_diagnostics_get` returned `source: compilation-pipeline` and zero scoped diagnostics for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 60000 --allow-mutation` passed with compiler diagnostics active.
- The scratch rollback step reported `mode: rolled-back`, `scopedErrorCount: 2`, verified rollback content, cleaned up the scratch asset/folder, and waited for compile after cleanup.

Completed in Slice 7:

- First semantic project-understanding tools:
  - `asset_references_trace`
  - `prefab_references_trace`
- Unity bridge commands:
  - `semantic.asset_references_trace`
  - `prefab.references_trace`

Game-development fit:

- These tools trace reverse references by Unity GUID across serialized project assets, giving agents a safer answer to "what will break if I edit, move, or delete this asset?"
- `prefab_references_trace` focuses the scan on `.prefab` and `.unity` files for scene/prefab impact analysis before gameplay refactors.
- `asset_references_trace` scans broader Unity serialized assets such as prefabs, scenes, materials, animator controllers, ScriptableObjects, animation clips, asmdefs, and shader graphs.
- This is the first gdep-style semantic layer slice and directly supports KOTOR asset-porting work by exposing which imported prefabs point at generated materials, models, scripts, and other assets.

Slice 7 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `prefab_references_trace` against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` scanned 36 prefab/scene files and returned zero back-references.
- `asset_references_trace` against the same script scanned 216 serialized asset files and returned zero back-references.
- `asset_references_trace` against imported KOTOR Malak menu materials found prefab back-references such as `Assets/KotorImported/MainMenu/Prefabs/MalakMenuModel_DirectMdlCandidate006N.prefab`.

Completed in Slice 8:

- UnityEvent semantic binding discovery:
  - `unity_event_bindings_find`
  - Unity bridge command `semantic.unity_event_bindings_find`

Game-development fit:

- The tool scans serialized Unity scenes, prefabs, and assets for persistent UnityEvent method bindings, which normal code search cannot reliably see.
- Results include asset path, event property, method name, target assembly type, target object reference, mode, and source line so agents can avoid breaking Inspector-wired UI, trigger, animation, and timeline callbacks during refactors.
- Filters support `methodName`, `targetType`, `assetPath`, extension sets, and result limits.

Slice 8 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `unity_event_bindings_find` scanned 202 serialized `.prefab`, `.unity`, and `.asset` files.
- The KOTOR project currently has many UnityEvent containers but no persistent `m_MethodName` entries, so the tool correctly returned zero bindings for the current asset set.

Completed in Slice 9:

- Animator graph analysis:
  - `animator_analyze`
  - Unity bridge command `semantic.animator_analyze`

Game-development fit:

- `animator_analyze` reads serialized `.controller` and `.overrideController` assets and returns parameters, state machines, states, transitions, transition conditions, file IDs, motions, and summary counts.
- This gives agents structured context before changing animation states, blend logic, controller parameters, or gameplay scripts that drive Animator parameters.
- The tool is read-only and works directly on Unity's serialized controller YAML, which is useful for asset-import pipelines and large game projects where opening Animator windows manually is slow.

Slice 9 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `asset_find` found `Assets/KotorImported/MainMenu/Animations/MalakMenu_006J.controller`.
- `animator_analyze` ran against `MalakMenu_006J.controller` and returned `source: animator-controller-yaml-scan` with a valid target summary.
- The imported Malak controller currently has empty `m_AnimatorParameters` and `m_AnimatorLayers`, so the analyzer correctly returned zero parameters, state machines, states, and transitions.

Completed in Slice 10:

- Asset hygiene semantic tools:
  - `meta_integrity_check`
  - `unused_assets_find`
  - Unity bridge commands `semantic.meta_integrity_check` and `semantic.unused_assets_find`

Game-development fit:

- `meta_integrity_check` scans Unity assets and `.meta` files for missing metadata, missing GUIDs, duplicate GUIDs, and orphan metadata.
- `unused_assets_find` builds a GUID reference set from serialized Unity assets, then reports conservative unused candidates with file size, type, extension, and a review-before-delete risk label.
- The unused-asset tool intentionally skips scripts by default plus Resources, StreamingAssets, Editor, and Gizmos paths because those can be referenced dynamically in real Unity games.

Slice 10 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `meta_integrity_check` scanned 2,195 assets and returned zero metadata/GUID issues.
- `unused_assets_find` returned conservative candidates from extracted/imported KOTOR assets; first sampled candidate was `Assets/ExtractedAssets/Textures/bluefill.png`.
- A temporary scratch fixture verified that a referenced `.asset` is found by `asset_references_trace` and excluded from `unused_assets_find`, then the scratch assets were deleted.

Completed in Slice 11:

- C# source impact-analysis tools:
  - `class_impact_analyze`
  - `call_path_find`
  - Unity bridge commands `semantic.class_impact_analyze` and `semantic.call_path_find`

Game-development fit:

- `class_impact_analyze` reports direct C# script references, serialized Unity asset references by GUID, and suggested test scripts before risky class or method refactors.
- `call_path_find` builds a lightweight method call graph across Unity C# scripts and returns an explainable path between methods when one is found.
- Both tools are deterministic read-only scans today, with response shapes that can later be backed by Roslyn without changing the MCP surface.

Slice 11 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `class_impact_analyze` for `ModuleSpawnPipeline.HydrateModule` found the direct call in `Assets/Scripts/KotOR/Modules/FirstPlayableModuleLoader.cs` line 173.
- `call_path_find` found the KOTOR module-loading path `FirstPlayableModuleLoader.LoadModule -> FirstPlayableModuleLoader.LoadModuleRoutine -> ModuleSpawnPipeline.HydrateModule`.
- The call graph indexed 2,195 methods across the KOTOR project's C# scripts.

Completed in Slice 12:

- Unity-specific lint rules:
  - `lint_unity_run`
  - Unity bridge command `semantic.lint_unity_run`

Game-development fit:

- Script lint rules detect component and scene-wide lookups in hot Unity update loops, string-based coroutines, `SendMessage`, and `Resources.Load` usage.
- Asset lint rules surface metadata/GUID integrity issues and conservative unused-asset candidates using the same GUID scan foundation as the semantic asset tools.
- Diagnostics include rule id, severity, path, line, message, recommendation, and source snippet so agents can decide whether to refactor, warn, or route to review.

Slice 12 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- Project lint sample scanned 221 C# scripts and found `UNI-ASSET-LOAD-001` `Resources.Load` usage in `Assets/Scripts/KotOR/Audio/KotorAudioManager.cs`, one `UNI-MSG-001` `SendMessage`, and conservative `UNI-ASSET-002` unused asset candidates.
- Focused lint for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` returned zero diagnostics.
- A temporary scratch script verified `UNI-PERF-001` for `GetComponent` and `UNI-PERF-002` for `GameObject.Find` inside `Update`, then the scratch script/folder were deleted and Unity compiled cleanly.

Completed in Slice 13:

- Semantic project index summary:
  - `project_index_summary`
  - MCP resource `unity://semantic/index`
  - Unity bridge command `semantic.project_index_summary`

Game-development fit:

- Gives agents a first-pass map of a Unity game project: scenes, prefabs, scripts, models, materials, textures, audio, animation, UI, tests, Resources usage, and top content folders.
- Adds script semantics for MonoBehaviour count, ScriptableObject count, type declarations, test scripts, UI hints, `Resources.Load`, `SendMessage`, and hot-loop lookup signals.
- Adds serialized Unity context for GUID reference density and UnityEvent binding counts, plus sampled meta/unused-asset diagnostics for refactor triage.
- Exposes recommended next tools (`lint_unity_run`, `unity_event_bindings_find`, `prefab_references_trace`, `class_impact_analyze`, `unused_assets_find`) so the MCP steers agents toward game-development-safe inspection paths.

Slice 13 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- Direct bridge validation returned `semantic-project-index-summary` for `Assets/MCPGhostTests/MainMenuRecreation/MCP_Kotor_MainMenu_Recreation.unity`.
- KOTOR index sample reported 2,196 project assets, 221 scripts, 100 MonoBehaviours, 26 prefabs, 10 scenes, and 5 `Resources.Load` lines.
- Top content folders were `KotorImported`, `Scripts`, `ExtractedAssets`, `MCPGhostTests`, and `StreamingAssets`, which matches the active KOTOR asset-porting workflow.
- MCP-level validation confirmed both `project_index_summary` and `unity://semantic/index` return the same semantic summary.
- `npm run build`, `git diff --check`, `npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000`, and `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 30000` passed.

Completed in Slice 14:

- Semantic test-scope suggestion:
  - `test_scope_suggest`
  - Unity bridge command `semantic.test_scope_suggest`

Game-development fit:

- Gives repair loops a focused validation plan for a changed gameplay script instead of defaulting to either no tests or an expensive full-suite run.
- Combines C# symbol references, serialized prefab/scene/asset references, and Unity test script discovery to estimate risk and suggest relevant EditMode/PlayMode filters.
- Always recommends script validation, Unity-specific lint, compile wait, and dry-run test execution before broader or mutating work.
- Adds manual check guidance for UnityEvent bindings, prefab references, and screenshot validation when a script can affect visible scene behavior.

Slice 14 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge after an initial helper-scope error was caught in the Editor log and corrected.
- Direct bridge validation for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` and `HydrateModule` returned `semantic-test-scope-scan`.
- The KOTOR sample reported low risk, 2 script references, 0 serialized prefab/scene references, 10 suggested test candidates, and a validation plan of `script_validate`, `lint_unity_run`, `compile_wait`, and filtered `tests_run`.
- MCP-level validation confirmed the `test_scope_suggest` tool returns structured content through stdio.

Completed in Slice 15:

- Repair-loop semantic validation planning:
  - `repair_loop_run` now calls `semantic.test_scope_suggest` when a `scriptPath` is provided and `useSemanticTestScope` is enabled.
  - The loop returns `semanticTestScope` and `plannedTestScope` in structured content.
  - The dry-run or live `tests_run` pass uses the semantic filter unless the caller explicitly supplies `testFilter`.
  - `compile_wait` now tolerates transient bridge disconnects while Unity is compiling or reloading after `script.validate`.
  - `phase3:repair-smoke` now verifies semantic test-scope planning and retries transient Unity reload disconnects.

Game-development fit:

- Repair loops now choose validation based on gameplay-script impact instead of relying on a generic test mode/filter.
- Unity's domain reload after script validation is treated as expected editor behavior, not as a failed repair loop.
- The structured `plannedTestScope` makes it clear which EditMode/PlayMode test pass the agent intends to run before it mutates or executes broader validation.

Slice 15 validation on KOTOR Unity project:

- `repair_loop_run` for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` completed through MCP stdio and returned step order: `editor_state`, `script_validate`, `compile_wait`, `test_scope_suggest`, compiler diagnostics, console diagnostics, and `tests_run_dry_run`.
- The loop selected `plannedTestScope: { mode: "editmode", filter: "ParityTestRunner", source: "semantic-test-scope" }`.
- `npm run build`, `git diff --check`, `npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000`, and `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 90000` passed.

Completed in Slice 16:

- Visual repair validation hooks:
  - Unity bridge command `screenshot.diff`
  - MCP tool `screenshot_diff`
  - `screenshot.capture` now renders synchronously from `Main Camera`, Scene view, or the first available Unity camera instead of relying only on Unity's async `ScreenCapture.CaptureScreenshot`.
  - `repair_loop_run` now supports `captureScreenshot`, `screenshotBaselinePath`, `screenshotThreshold`, and `screenshotWaitMs`.
  - `repair_loop_run` returns `screenshotValidation` with capture metadata and optional sampled pixel diff results.
  - `phase3:repair-smoke` now verifies repair-loop screenshot capture.

Game-development fit:

- Scene-facing gameplay changes can now validate visible state after script validation and focused test planning.
- Pixel diff support gives agents a deterministic way to compare menu, camera, imported level, and UI screenshots without hand-inspecting PNGs first.
- Synchronous camera rendering fixes the earlier screenshot TODO where Unity returned a path before a useful PNG existed.

Slice 16 validation on KOTOR Unity project:

- Direct bridge validation captured two real `640x360` PNGs from `Main Camera` in the KOTOR main-menu recreation scene.
- `screenshot.diff` compared the two captures with 5,000 sampled pixels and returned `differentRatio: 0`, `meanAbsoluteDifference: 0`, and `withinThreshold: true`.
- `repair_loop_run` with `captureScreenshot: true` returned `screenshotValidation.capture.bytes: 354502`, `wait.exists: true`, and included the `screenshot_capture` step after semantic test planning.

Completed in Slice 17:

- Screenshot baseline discovery:
  - Unity bridge command `screenshot.baselines_list`
  - MCP tool `screenshot_baselines_list`
  - MCP resources `unity://screenshots/baselines` and `unity://screenshots/baselines/{filter}`
  - `screenshot.capture` now writes a JSON sidecar beside each PNG with label, timestamp, camera, active scene, dimensions, byte count, and capture mode.

Game-development fit:

- Agents can now browse recent visual baselines before running a repair-loop screenshot diff, instead of requiring the user to paste an absolute PNG path.
- Baselines are filterable by label, scene, camera, filename, or sidecar metadata, which fits repeated validation of KOTOR menus, imported modules, UI screens, and camera states.
- Older screenshots without sidecars are still discoverable; Ghost reads PNG dimensions from the file header and infers labels from filenames.

Slice 17 validation on KOTOR Unity project:

- `screenshot.baselines_list` filtered by `repair-loop` found prior repair-loop captures and read dimensions from existing PNG files.
- MCP `screenshot_capture` created a fresh `kotor-main-menu-baseline` PNG plus sidecar metadata in `Library/UnityMcpGhost/screenshots`.
- MCP `screenshot_baselines_list` and `unity://screenshots/baselines/kotor-main-menu-baseline` both returned the fresh baseline with `640x360`, `Main Camera`, and active scene `Assets/MCPGhostTests/MainMenuRecreation/MCP_Kotor_MainMenu_Recreation.unity`.

Completed in Slice 18:

- Automatic screenshot baseline selection in repair loops:
  - `repair_loop_run` now accepts `screenshotBaselineFilter`.
  - `repair_loop_run` also accepts `screenshotMode`, `screenshotWidth`, and `screenshotHeight` so captures can match baseline resolution and camera mode.
  - When a filter is supplied, the loop calls `screenshot.baselines_list`, selects the newest matching baseline, captures a fresh screenshot, and runs `screenshot.diff`.
  - `screenshotValidation` now includes `selectedBaseline`, `baselineList`, capture metadata, wait status, and diff results.

Game-development fit:

- Agents can ask for a scene-facing validation by label, such as `kotor-main-menu-baseline`, without copying absolute paths.
- Matching screenshot dimensions avoids false visual diffs caused by aspect/resolution changes rather than actual scene regressions.
- This closes the current validate -> repair -> test -> visual-check loop for KOTOR UI/menu/camera work.

Slice 18 validation on KOTOR Unity project:

- Direct MCP `repair_loop_run` selected `kotor-main-menu-baseline-20260517-034301.png`, captured a new `640x360` repair-loop screenshot, and ran `screenshot.diff`.
- The diff returned `differentRatio: 0`, `meanAbsoluteDifference: 0`, and `withinThreshold: true`.
- `npm run build`, `git diff --check`, `npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000`, and `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 90000` passed.

Completed in Slice 19:

- Screenshot baseline hygiene:
  - Unity bridge command `screenshot.baselines_cleanup`
  - MCP tool `screenshot_baselines_cleanup`
  - Cleanup is dry-run by default and supports `filter`, `olderThanDays`, `minBytes`, `keepNewest`, `limit`, `protectedLabels`, `includeUnlabeled`, and `allowDeleteBaselines`.
  - Labels containing `baseline` are protected by default unless `allowDeleteBaselines=true`.
  - Screenshot filenames now include milliseconds to prevent rapid same-label capture collisions.

Game-development fit:

- Repair loops can generate many visual artifacts while iterating on scenes, UI, menus, and imported KOTOR modules; cleanup lets agents manage that history safely.
- Named baselines remain protected from routine cleanup, preserving visual references for repeated regression checks.
- Empty or tiny historical screenshot files can be surfaced and pruned without touching validated baselines.

Slice 19 validation on KOTOR Unity project:

- Dry-run cleanup filtered by `repair-loop` planned excess captures with `reasons: "beyond-keep-newest"` and deleted nothing.
- Dry-run cleanup filtered by `kotor-main-menu-baseline` planned zero deletions because named baselines are protected by default.
- A controlled `ghost-cleanup-test` capture was deleted with `dryRun=false`; follow-up baseline listing returned zero matching captures.

Completed in Slice 20:

- Visual validation triage:
  - MCP tool `visual_validation_report`
  - MCP resource `unity://visual/validation/latest`
  - MCP resource template `unity://visual/validation/{filter}`
  - The report composes existing Unity screenshot commands to summarize the latest capture, selected baseline, sampled diff result, and screenshot cleanup dry-run recommendations.
  - Baseline selection prefers an explicit filter, then labeled baselines, then the previous matching capture as a fallback.

Game-development fit:

- Agents can now inspect the visual state of a repair loop as one game-dev oriented report instead of manually chaining baseline listing, diffing, and cleanup planning.
- The report is tuned for scenes, menus, cameras, UI, and imported KOTOR module validation where visual drift is a real gameplay/content regression signal.
- Cleanup advice remains dry-run based, so named visual baselines are preserved unless the user explicitly approves pruning.

Slice 20 validation on KOTOR Unity project:

- Direct MCP `visual_validation_report` selected `kotor-main-menu-baseline-20260517-034301.png` as the baseline for the latest `repair-loop-20260517-042931-959.png` capture.
- The report ran `screenshot.diff` and returned `withinThreshold: true` with `differentRatio: 0`.
- `unity://visual/validation/latest` resolved through MCP resources and selected the same KOTOR baseline by label.
- `npm run build`, `git diff --check`, `npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000`, and `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 90000` passed.

Next Phase 3 targets:

- Add automated assertions for `phase3:repair-smoke` in CI once a Unity test environment is available.
- Start the Phase 4 game-system coverage kickoff with the smallest high-value domain tools for KOTOR scene work.
