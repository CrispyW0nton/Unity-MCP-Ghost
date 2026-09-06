# Public compile/validation waits — bounded verification

Base: `ba19aa2ea0a67fcca460d083cd25770e26ea7a12`, 2026-09-06. This is the existing group 1 public-wait boundary (W1.19/W1.24/W1.25, G6) in the finite acceptance trace. It does not replace the approved goal or certify Test Runner cancellation, transport durability, real compilation/reload, or the complete course loop.

## Required behavior for this slice

- Carry the actual MCP handler cancellation signal to public `compile_wait` and `script_validate` producer calls.
- Bound validation start, status polling, diagnostics and observation sleeps by one total monotonic deadline. Late or uncooperative producer responses cannot advance the sequence or become successful evidence.
- Accept only coherent, observed, completed evidence for the exact compiler generation. Derive the caller's requested token only after matching the producer's `generation`; do not overwrite a mismatched token.
- Preserve typed producer failures and correlation. Send validation start once; stop follow-up work after cancellation, timeout or invalid start. Only explicitly classified transient status-read failures may be retried within the budget.
- Verify diagnostic generation, shape, severity/filter, completeness and counts. A failed or truncated diagnostic read cannot prove a clean compile; whole-generation errors must not be described as zero errors merely because the requested file has none.

The pinned C# producer's `WaitState` supplies `generation` but not `requestedCompileGeneration`. It supplies observed/completed timestamps, `errorCount`, and `diagnosticsTruncated`. Its diagnostics query supplies `generation`, the diagnostic array and `truncated`. Tests must match these actual producer contracts.

## Evidence chronology

Before production edits, the implementation worker ran `node --import tsx --test server/test/publicCompileWaits.test.ts`: **56 tests, 2 passed / 54 intended failures**, zero skips/cancellations, reported 7.45 seconds. The waiting-to-completed and classified transient-read controls passed. SDK cancellation propagation, strict receipts, start/diagnostic failure handling and deadline cases failed. An earlier fake-timer fixture hang was corrected before this complete red run and is not a passing check.

The worker then reproduced three further contradictory-start/diagnostic and unknown-outcome failures (five selected cases: three red, two green) before fixing them. Its final public suite contained 65 cases. The parent strengthened the validation standard: cancellation and hung-producer tests must observe the actual MCP handler finish while the producer promise is still unresolved, not merely observe the SDK client's cancellation rejection.

Parent pre-review verification:

- `node --import tsx --test server/test/publicCompileWaits.test.ts server/test/createServer.integration.test.ts server/test/repairApplyEdits.test.ts server/test/repairSmokeHarness.test.ts`: **244/244**, six suites, zero failures/skips/cancellations, 6843.581 ms.
- `npm test`: **506/506**, 22 suites, zero failures/skips/cancellations, 33675.5313 ms.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`: pass.
- `npm run test:protocol`: **10/10**, two suites, zero failures/skips/cancellations, 3051.5934 ms. Catalog parity: 90 tools / 57 direct bridge mappings.
- `npx tsc --ignoreConfig --noEmit --strict --module nodenext --target ES2022 --esModuleInterop --skipLibCheck --types node server/test/publicCompileWaits.test.ts server/test/fixtures/compileEvidence.ts`: pass.

The three-lens simplification pass completed. Applied one duplicate-fixture reuse finding (also reported by quality) and one efficiency finding: compiler diagnostic matching now indexes the already-validated unique sequence instead of scanning every expected item. All field equality, count, scope, truncation and duplicate checks remain. Post-simplification public suite: **65/65**, zero failures/skips/cancellations, 3845.6668 ms. Final review and post-review verification are recorded below when complete.

The tests use the real public MCP route and controlled bridge responses; no live Unity/compiler result may be inferred from them. No C#, Unity transport, Play/Console/input or Test Runner lifecycle change is part of this slice. Transport token-read/fallback deadline races, compile-generation persistence/reload proof and complete integrated course verification remain separate acceptance work.

## Bounded review

Review `20260906-022510-589054d1` completed all eight selected lenses: correctness, testing, maintainability, agent-native, security, API contract, reliability and adversarial. No applicable project standards or learnings corpus were found. No different-provider CLI was installed; this was a local adversarial review, not cross-model corroboration. The full source findings, mechanical reconciliation, hydrated report and independent validator results are retained under:

`C:/Users/NewAdmin/AppData/Local/Temp/compound-engineering-S-1-5-21-3676660937-2505475977-1537855565-1004/ce-code-review/20260906-022510-589054d1`

The original report is **Ready with fixes**, not a post-fix verdict. One independent validation batch confirmed #1 (known-unexecuted validation errors were overwritten as unknown), #5 (missing typed transient-read classifier tests) and #6 (terminal `outcomeUnknown:true` could still be certified). It rejected #3 as an unchanged compatibility action outside the explicit two-tool slice. Two structural preferences were not applied: broad module extraction is later finite contract/domain work; replacing the actual SDK-handler interception with helper-only tests would weaken the cancellation proof. No public capability was removed.

The compatibility `manage_script(action: "validate")` action still returns a raw start receipt; callers needing verified completion must use `script_validate` or follow its generation with `compile_wait`. This remains a visible contract-alignment follow-up. Another fail-closed limitation remains: padded path normalization differs between the TypeScript diagnostic matcher and C# query, which can report `COMPILE_DIAGNOSTICS_INVALID`; do not infer compiler success or automatic path correction from it. Normal project-relative paths with interior spaces and Unicode remain in scope for the final live path gates.

## Applied review fixes and final slice verification

One fix batch was dispatched for #1/#5/#6. Its worker preserved the original implementation and added regression tests, then stopped on an account usage-limit error before changing production. The parent inspected and retained that partial work, completed producer-faithful authorization/path/deadline test cases, and ran the red suite before applying the two narrow production guards. No usage-reset credit was redeemed. This was local parent recovery of the same batch, not a second independent implementation or review.

- Parent review-fix red: `node --import tsx --test server/test/publicCompileWaits.test.ts` — **78 passed / 8 failed**, 86 tests, zero skips/cancellations, 5186.1741 ms. The eight failures were four unknown terminal outcomes and four typed known-unexecuted starts.
- Applied #1: trust explicit `outcomeUnknown:false` on typed `UnityCommandError`, preserving producer errors/IDs without a contradictory reconciliation warning. Unclassified exceptions remain conservative.
- Applied #6: reject terminal `outcomeUnknown:true` before compile evidence can be accepted or validation diagnostics queried.
- Applied #5: all four typed transient-read classifications and negative EXPIRED predicates now have public-route tests. Additional direct evidence checks cover timestamp ordering, duplicate status/scoped diagnostic sequences and the 1000/1001 status limit boundary.
- Already-aborted client input was not counted as handler coverage: the pinned SDK rejects it before dispatch. Existing in-flight SDK cancellation cases still observe the actual server handler with producer responses withheld.

Final parent commands on this complete slice, Windows / Node 24.11.1:

| Command | Result |
| --- | --- |
| `node --import tsx --test server/test/publicCompileWaits.test.ts server/test/createServer.integration.test.ts server/test/repairApplyEdits.test.ts server/test/repairSmokeHarness.test.ts` | 265/265, six suites, zero failed/skipped/cancelled, 7318.9831 ms; public suite includes 86 cases |
| `npm test` | 527/527, 22 suites, zero failed/skipped/cancelled, 34568.0815 ms |
| `npm run test:protocol` | 10/10, two suites, zero failed/skipped/cancelled, 2990.5456 ms |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run format:check` | pass |
| `npm run release:check` | pass, including build, 90-tool/57-mapping catalog parity, package layout and pinned Newtonsoft 3.2.1 |
| `npx tsc --ignoreConfig --noEmit --strict --module nodenext --target ES2022 --esModuleInterop --skipLibCheck --types node server/test/publicCompileWaits.test.ts server/test/fixtures/compileEvidence.ts` | pass |
| `npm audit --audit-level=high` | zero vulnerabilities |
| `git diff --check` | pass |

The parent reviewed the complete implementation and follow-up diff. All three actionable findings are applied; the original review artifact remains unchanged. No second independent post-fix reviewer was available after the worker quota failure, and no live Unity gate was run for this TypeScript-only slice. `npm ci`, Unity EditMode/PlayMode, actual compiler/reload, live repair/scenario/course, concurrent-project and complete-series release acceptance are still required on the final milestone tree.

## Migration and operational checks

No public operation or input schema was removed. Public validation now requires the actual pinned producer's full compile/diagnostic receipt; older or hand-written bridge adapters that omit completion/truncation/count metadata fail explicitly and must be upgraded alongside the server. Whole-generation errors remain errors even when the selected file has no scoped errors. Timeout bounds observation, not a guarantee that Unity stopped already-dispatched work; retain unknown start receipts for reconciliation.

For the next owned live smoke, healthy output is exact generation/observed/completed evidence with correct total/scoped counts and settled handler deadlines. `COMPILE_EVIDENCE_INVALID` or `COMPILE_DIAGNOSTICS_INVALID` requires inspecting that invocation's producer receipt, not loosening assertions or replaying mutations. The local maintainer owns that validation before release. If this slice regresses a supported producer, stop automated mutations and revert its local commit as a reviewed change; do not reset user history or delete recovery material.
