# Explicit repair recovery verification - 2026-09-06

Scope: the `repair_apply_edits` handler, its result contract, and disk-backed MCP regressions. Baseline `350382131657c903d1c319799eea74a8763b4a3d`; the following results cover the integrated, uncommitted patch after review fixes. The commit ledger in `progress.md` records the resulting commit. This is a bounded unit receipt, not final local-RC certification.

## What this unit establishes

- Positive original/apply receipts and byte hashes are required. A malformed positive apply receipt stops all follow-on calls while preserving available recovery evidence.
- Only matching requested compiler generations are used by this handler. Historical Console diagnostics do not participate in its repair decision.
- Required terminal test failures take the restoration path. A typed transport proof that the test start never executed also permits restoration. Generic or genuinely unknown outcomes retain recovery and do not replay.
- Source restoration is hash-checked and byte-preserving, including empty, BOM and CRLF fixtures. Actual concurrent source/metadata writes are preserved before apply, before rollback reads, and between rollback reads and the producer's restore check.
- Cleanup follows verified repair or restoration and stops at the first failure. Incomplete cleanup and restoration remain errors, with receipts and known backup paths retained.
- Result contract 2 is advertised consistently through the SDK tool list and generated operation catalog. Unchecked Console diagnostics are explicitly `null`, not zero. Applied repairs require rollback; dry-run compatibility remains.

The original source in normal success/restoration fixtures is valid C#. Tests control compiler/Test Runner replies at the bridge boundary; they do not execute a real C# compiler. No-op writes and source-only backup receipts are also covered. Read the [migration guide](repair-result-contract-v2.md) before updating a client.

## Red-first history

1. Before initial implementation, `node --import tsx --test --test-reporter=tap server/test/repairApplyEdits.test.ts` failed 54/54 cases in the parent run. Full output was saved outside the repository at `C:/Users/NewAdmin/AppData/Local/Temp/unity-mcp-explicit-repair-20260906/red-tests.tap`.
2. Worker follow-ups first reproduced partial-transaction failures (3 failed / 1 passed) and missing-success receipts (1 failed / 1 passed), then reached 60/60 focused cases. Parent integration passed 105/105.
3. After the completed review, `node --import tsx --test --test-name-pattern='review:|start-generic-known-flag' server/test/repairApplyEdits.test.ts` ran 28 selected cases: 19 failed / 9 passed, exit 1, 2835.4468 ms. Worker recorded this before its review fixes. The passing cases characterized already-safe concurrency/generation/no-op behavior.
4. Worker focused verification after fixes: `node --import tsx --test server/test/repairApplyEdits.test.ts` passed 88/88, no failures/skips/cancellations, 6181.2035 ms.

## Parent verification after the review fixes

Environment: Windows, Node 24.11.1. These checks used the complete local working tree, not a worker-only copy.

| Command | Result |
|---|---|
| `npm run generate:catalog` | Generated 90 tools / 57 direct bridge mappings; reviewed changes are only the explicit-repair description and schemas. |
| `npm run format:check` | Passed. |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed. |
| `node --import tsx --test server/test/repairApplyEdits.test.ts server/test/createServer.integration.test.ts` | 133/133 passed, 3 suites, no failures/skips/cancellations; 7834.4951 ms. |
| `npm test` | 395/395 passed, 19 suites, no failures/skips/cancellations; 31040.9001 ms. |
| `npm run test:protocol` | 10/10 passed, 2 suites, no failures/skips/cancellations; 3143.9957 ms. Catalog parity passed. |
| `npm run release:check` | Passed; includes `npm run build`, catalog check and release-layout validation. This does not certify a release. |
| `npm audit --audit-level=high` | Passed: zero vulnerabilities reported. |

A TypeScript compiler-API pass including both changed implementation and test files also reported zero syntactic/semantic diagnostics. Final diff checks and commit status are recorded in `progress.md`.

## Review and remaining gates

Review run `20260906-011754-a5b8dc88` completed correctness, testing, maintainability, agent-native, API-contract, reliability, security and local adversarial lenses. No different-provider CLI was installed. One independent validation batch confirmed five findings (#1/#2/#3/#6/#7). The original `Not ready` report remains intact in the private review artifact directory; follow-up verification is separate. Generation-mismatch test detail (#5) was retained in the testing-gap bucket and implemented with the fixes. Shared-engine extraction (#4) is not required to validate this handler; domain decomposition remains a separate required workstream.

The independent follow-up verified all five assigned fixes and the generation-mismatch cases, passed 88/88 focused tests and catalog parity, and confirmed the other 89 catalog entries were unchanged. No new defect attributable to the fixes was found. Its receipt is `followup-verification.json` under the original private review directory; the original report was not overwritten. `git diff --check` passed after these fixes.

Not rerun for this TypeScript-only behavior slice: `npm ci`, Unity EditMode/PlayMode, live bridge/security/repair/scenario, concurrent-Editor/reload and the complete course matrices. Their historical receipts do not count as current passes. Shared public-wait deadline/cancellation behavior, real Test Runner lifecycle, whole-repair request deduplication and live recovery from a compiler-error baseline remain open in the finite acceptance trace. The live repair smoke helper also still needs its expected-error/retry/scratch-ownership correction before mutation smoke can be trusted.

No actual Account, Variablekiller or Conditionalkiller assets were modified or certified. Nothing was pushed, published or submitted to an LMS.
