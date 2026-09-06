# Repair smoke safety — bounded verification

Date: 2026-09-06. Base: `131c2016d940925ca4f36c21325576f3cf79f291`. This is the existing group 8 repair-harness correction from the finite acceptance trace, not full Course-Ready acceptance or live Unity certification.

## Behavior and recovery contract

- The exported production harness calls the real public MCP handlers. Each tool call is sent once with a correlation ID; a text error such as `fetch failed` never authorizes replay.
- Mutation mode requires a local project path and matching running project/editor identity. Immediately before creation, authenticated live health must confirm the same project/editor/path and an explicitly granted destructive capability. The discovery file is not treated as current permission evidence. The harness does not change bridge settings.
- A new run uses a unique C# script directly under `Assets`, with `overwrite:false`. Existing source, metadata, directories and sibling files are preserved; the former fixed scratch folder is not touched.
- A passing intentional-red case requires the expected CS1525 diagnostic from the requested, observed, completed compiler generation; MCP error status; result-contract-v2 verified rollback; settled transaction cleanup; and independent source bytes/hash plus metadata comparison. A green repair, unrelated error, stale generation or mere `rolled-back` label is insufficient.
- Cleanup checks current bytes and sends `script_delete` with `expectedSha256`, verifies source/meta absence, then verifies the deletion's completed compile generation. It never calls recursive folder deletion.
- Unknown scene/import/create/apply/test/restore/delete outcomes and failed cleanup retain receipts, available backup paths and original source/meta evidence. Further scene/Play restoration is deferred when execution or scratch recovery is unresolved; the original Editor snapshot is reported for reconciliation. This is a failed smoke run, not successful restoration.
- The ordinary preflight and known-settled paths retain the existing `RepairSmokeState` restoration behavior. That implementation and its tests are unchanged by this unit.

Before retrying a failed live run, reconcile its exact request/operation IDs and current source/meta bytes. Do not rerun the mutation or delete retained files based only on an error message. Use the independently verified original hashes and retained producer backups for recovery. No automatic retry or global capability grant is an instructed recovery step.

## Evidence

The new tests use an in-memory MCP connection, actual Ghost public handlers and temporary disk-backed source/backup files. Compiler records and bridge responses are controlled fixtures, **not a real Unity compiler or Test Runner**.

Implementation-worker proof-first receipts:

| Command | Observed result |
|---|---|
| `node --import tsx --test server/test/repairSmokeHarness.test.ts` (initial characterization) | 1/1 passed, 894.089 ms, before behavior changes |
| Same command, initial safety regressions | 1 passed / 24 intended failures, 23937.8742 ms |
| `node --import tsx --test --test-name-pattern='preexisting\|destructive capability' server/test/repairSmokeHarness.test.ts` | 5/5 intended failures, 1500.8848 ms |
| `node --import tsx --test --test-name-pattern='recorded validation' server/test/repairSmokeHarness.test.ts` | 1/1 intended failure, 987.0324 ms |
| `node --import tsx --test --test-name-pattern='unknown create\|wrong rollback\|does not restore scenes' server/test/repairSmokeHarness.test.ts` | 2 passed / 1 intended failure, 1383.5453 ms |
| `node --import tsx --test server/test/repairSmokeHarness.test.ts server/test/repairSmokeState.test.ts` | 44/44 passed, 3377.4608 ms; 31 new harness cases and 13 unchanged state cases |

Parent initial integrated verification:

- `node --import tsx --test server/test/repairSmokeHarness.test.ts server/test/repairSmokeState.test.ts server/test/repairApplyEdits.test.ts`: 132/132 passed, 3 suites, no failures/skips/cancellations, 7514.847 ms.
- `npm run typecheck` and `npm run lint`: passed.

Simplification removed unused legacy folder-test scaffolding and repeated fixture reads; production safety checks were unchanged. The parent reran the harness/state tests: 44/44 passed, 3040.4288 ms.

Pre-review-fix parent gates (not final unit evidence): `npm test` passed 426/426, 20 suites, 30754.8992 ms; `npm run test:protocol` passed 10/10, 2 suites, 2874.254 ms. Typecheck, lint, formatting, release/layout/catalog checks passed; `npm audit --audit-level=high` reported zero vulnerabilities. These green controlled fixtures did not catch the producer mismatch below.

Review `20260906-014839-2109d572` completed eight lenses and one fresh independent validator batch. No different-provider CLI was available; same-family review is not cross-model corroboration. The original report is **Not ready** and is preserved, not overwritten by subsequent fixes:

1. The real C# create receipt uses SHA-256(empty bytes), not an empty string. Both harness and test fixture had the wrong assumption.
2. Unknown scene/import outcomes before scratch creation bypassed the restoration guard.
3. Discovery-file capabilities can lag active authorization by five seconds after a setting change.

All three findings were validated and applied in one same-file follow-up batch, with a one-line C# health addition and its regression. Narrow identity/diagnostic test gaps were also added. The discretionary CLI re-export refactor was deferred: it proves no current defect, and the production import seam is deliberately characterized.

Follow-up proof-first receipts:

- `node --import tsx --test --test-name-pattern='accepts expected compiler red' server/test/repairSmokeHarness.test.ts`: 1/1 intended failure, 1243.3333 ms, after correcting the fixture to the real producer's empty-byte hash and before fixing the guard.
- `node --import tsx --test --test-name-pattern='active capability after revocation\|health evidence\|mismatched local\|malformed compiler\|composes the main' server/test/repairSmokeHarness.test.ts`: 6 passed / 7 intended failures, 2257.5889 ms, before the follow-up changes.
- `npm run test:unity:editmode`: **234/235**, one intended failure, zero skips, in [the red XML](../test-project/Logs/editmode-578b28c0-ab2e-4cd9-9801-2ad8a90c4fee-results.xml). The parent verified the sole failure: `HealthReflectsActiveCapabilityRevocationWithoutWaitingForIdentityHeartbeat` expected `false` but received `null`.
- After the health producer addition, the same command passed **235/235**, zero failures/skips, in [the green XML](../test-project/Logs/editmode-f30289dd-b560-4eed-938a-b929b7faf9df-results.xml). The parent parsed the new case and aggregate, confirmed both fixture source/scene hashes were unchanged, and observed no remaining Unity process.
- Independent same-fix verification confirmed #1/#3 but reproduced one residual #2 path: the real `UNKNOWN_COMPILE_GENERATION` failed/unobserved response threw before the validation assertion and still allowed restoration. That original verification receipt remains distinct from the follow-up regression/fix below.

- Same-#2 regression: `node --import tsx --test --test-name-pattern='safely for unknown-generation\|safely for failed-unobserved' server/test/repairSmokeHarness.test.ts` failed 2/2 before the fix, 1129.1298 ms. Failed validation envelopes now derive unsettled execution from exact observed/completed generation evidence; known completed compiler failures still restore. Parent source review and the final composition tests verified this path after the independent probe exposed it.

Final parent checks on the complete unit:

| Command | Observed result |
|---|---|
| `node --import tsx --test server/test/repairSmokeHarness.test.ts server/test/repairSmokeState.test.ts server/test/repairApplyEdits.test.ts` | 147/147 passed, 3 suites, 6540.1638 ms |
| `npm test` | 441/441 passed, 20 suites, 30445.8033 ms |
| `npm run test:protocol` | 10/10 passed, 2 suites, 3293.2561 ms; catalog 90 tools / 57 direct mappings |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run format:check` | Passed |
| `npm run release:check` | Passed, including `npm run build`, catalog and release-layout validation |
| `npm audit --audit-level=high` | Zero vulnerabilities |
| `npx tsc --ignoreConfig --noEmit --strict --module nodenext --target ES2022 --esModuleInterop --skipLibCheck --types node server/test/repairSmokeHarness.test.ts` | Passed after correcting test-only union narrowing; the prior direct check failed and is not counted as a pass |
| `git diff --check` | Passed |

All final Node counts have zero failures/skips/cancellations. Environment: Windows, Node 24.11.1. The final C# health code is exactly the code in the 235/235 EditMode run above; subsequent changes were TypeScript-only. `npm ci`, PlayMode, live repair/course/reload/concurrent-project and complete-series gates were not rerun for this incremental unit and are not claimed as passed here.

## Explicit limits and remaining gates

The Node fixtures do not launch Unity. The two real EditMode runs above use only the repository-owned Unity 2022.3.62f1 fixture. The new security test temporarily swaps a cloned in-memory settings object, restores the original in `finally`, and never writes a token or settings file. No actual course project was modified. Live mutation smoke still requires an explicitly scoped grant on the owned fixture and subsequent settings restoration. It remains a required final local gate; neither EditMode results nor historical live smoke substitute for it.

Live health is a point-in-time observation, not a permission reservation. A later revocation must still fail cleanup truthfully and retain recovery. The additive `health.data.capabilities.destructive` field requires the updated Node/UPM pair for this smoke; an older producer without it is rejected before creation.

`script_delete` has a source-hash guard, but no caller-provided metadata-hash guard. The harness checks metadata immediately before dispatch and retains producer receipts, but cannot claim atomic exclusion of a metadata-only write racing inside that producer. Transaction-boundary hardening remains tracked separately in group 3. Public shared waits, actual compiler/import/Test Runner lifecycle and final whole-series gates remain open under the approved goal.
