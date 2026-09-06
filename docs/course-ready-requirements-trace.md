# Course-Ready local acceptance trace

Baseline: `350382131657c903d1c319799eea74a8763b4a3d`, inspected 2026-09-06. This is the finite implementation/evidence tracker for the active goal, not a new goal, a completion claim or a replacement specification. [The approved local-RC contract](course-ready-local-rc-goal.md) and [the original seven workstreams](development-prompt-course-ready-reliability.md) remain authoritative.

## What exists, and what remains

Ghost has a 90-tool catalog with 57 direct Unity mappings, typed JSON parsing, project-pinned authenticated transports, transactional source primitives, generation-scoped compiler records, normal Play control, Console boundaries, supported Input System/project-driver input, scenario matrices, local evidence bundles and substantial regression coverage. These are implemented capabilities, not a claim that all their safety/lifecycle boundaries are accepted.

The trace contains **150 requirement rows**. A row marked implementation plus direct test means relevant assertions were inspected; it is not a current passing execution. Source-only labels name an evidence boundary, not automatically a product defect. Concrete defects require a focused regression before repair where practical. Additional test ideas outside the frozen behavior do not enlarge this goal.

| Trace | Rows | Coverage |
|---|---:|---|
| [Workstream 1](course-ready-trace/workstream-1.md) | 32 | Truthful envelopes, compile/test/repair, IDs; original P0 1–4, 6, 15 |
| [Workstream 2](course-ready-trace/workstream-2.md) | 42 | Transactions, batch, queue/transport, screenshots, paths; P0 5, 7–12, 16 |
| [Workstreams 3 and 7](course-ready-trace/workstreams-3-and-7.md) | 57 | Security, identity, catalog/contracts, discovery, protocol, release; P0 13–14, package part of 16 |
| [Workstreams 4–6](course-ready-trace/workstreams-4-to-6.md) | 19 | Play/Console/input, scenario/evidence, all Module 1–2 fixture cases |

## Bounded remaining work

Resolution overlay, 2026-09-06: commit `72f69f0` fixes the baseline explicit-repair handler portions of W1.10/W1.16/W1.23/W1.29 (G1/G5/G7), with 88 focused repair cases and parent 395/395 Node tests. See [the bounded verification receipt](explicit-repair-verification-2026-09-06.md). The row tables remain a historical map of `3503821`; this overlay does not certify shared wait semantics, real Test Runner execution or the complete workstream. Group 1's public deadline/cancellation work and the other groups remain required.

These groups consolidate overlapping rows. They are completion work under the existing requirements, not permission to add new domains.

1. **Existing repair and waits:** make `repair_apply_edits` as truthful and recovery-safe as the separately hardened loop; preserve nested failures, use only current compiler diagnostics, retain backups until verified, and handle thrown/unknown outcomes. Propagate cancellation and exact deadlines through public compile, test, Play, Console and input waits. Preserve public operations.
2. **Actual Test Runner lifecycle:** terminate infrastructure errors/timeouts/cancellation truthfully through the supported runner, settle required tests before rollback, preserve failure details, and prove callback-to-MCP behavior. Confirm no-op/import generation and real reload semantics with direct tests.
3. **Durable transaction ownership and batch correctness:** protect unresolved backups across newer writes/reload; complete standalone validation/rollback semantics; preflight every nested item, aggregate failed-item compensation even when optional, and prove fail-fast/import boundaries.
4. **Bounded durable transport:** cancel queued socket work before execution when possible; retain unknown outcomes after races; bound queue admission/housekeeping/storage and response lifetime; close publication/persistence failure paths; reconcile active jobs across reload.
5. **Containment and screenshot ownership:** apply root/link checks to computed storage paths as well as Assets; prove exceptional decode/capture cleanup and existing allocation limits.
6. **Security and contract parity:** fix package-list online lookup bypass and screenshot-cleanup risk drift; validate version/capability handshake; generate or parity-test actual C# schema/risk policies and the stable result envelope. Add named security boundary assertions, not unrelated security features.
7. **Runtime/scenario completion:** compare actual restored scene/selection/play state, retain failed-observation evidence, declare the supported safe capture policy, and add durable bounded input/job/evidence handling plus accurate result pagination. Prove lifecycle/Console/scenario terminal paths including domain reload in the required local test categories.
8. **Release and final evidence:** correct copied client paths and premature qualification; verify implemented protocol/schema conformance, supported local package layout and CI configuration. Run the whole final gate set, then bounded integrated review and handoff.

Sequence update, 2026-09-06: group 1's explicit repair handler is committed at `72f69f0`; the next group 1 slice is public exact-generation compile/validation deadlines and cancellation, followed by actual Test Runner lifecycle. Do not refactor the already-verified input unit or add optional generic execution/build/domain tools to close this trace. Fixes to shared wait/test/transaction dependencies remain separately visible until their own evidence is green.

Group 8 harness resolution overlay, 2026-09-06: the deliberately invalid repair now requires the expected error plus independently verified original hash/restoration. At-most-once calls, unique owned scratch content, active authenticated cleanup-permission preflight and uncertain-outcome restoration deferral replace the old success-only/retry/fixed-folder behavior. [The bounded verification receipt](repair-smoke-safety-verification-2026-09-06.md) records regressions and review follow-up; this is preparation for the still-required final live mutation smoke, not a live pass or full group 8 completion.

## Final gate ledger (all pending on the complete final series)

- Fresh `npm ci`, format:check, lint, typecheck, build, test, test:protocol, test:course, audit --audit-level=high and `git diff --check`.
- Unity EditMode and PlayMode, live bridge/security/runtime/repair/scenario, explicit reload/reconnect and duplicate-request checks, concurrent projects/collisions, package-installed layout, release checks and local CI-workflow validation.
- Every specified Module 1–2 case and both cancellation suites, with actual outcomes, compiler generation/diagnostic identity, source hashes, scene/selection/play restoration and local evidence paths.
- Bounded integrated review; commit list, architectural/contract changes, exact results, remaining risks, migration and rollback handoff.

The latest input-unit receipt (9/9 PlayMode, 234/234 EditMode, 307/307 Node) is recorded in [verification](course-ready-verification.md), not substituted for this final ledger. No tests were executed by the trace itself.

Remote CI, additional environments, publishing and actual Variablekiller/Conditionalkiller/Account certification remain separate pending obligations. The Account project targets Unity 6000.3.2f1 and is untouched; the Windows 2022.3 fixture does not certify it. The release label may be applied only after the local gates pass: **Locally verified Course-Ready release candidate; remote CI and real course-project certification pending.**
