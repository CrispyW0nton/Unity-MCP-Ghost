# Course-Ready Reliability verification map

Status: **incomplete**. This is a working evidence map, not a completion certificate. The full scope in [the development prompt](development-prompt-course-ready-reliability.md) remains authoritative. No requirement is waived by this document.

## Concrete remaining implementation work

1. **Secured MCP-facing Streamable HTTP.** `server/src/index.ts` currently connects only `StdioServerTransport`. The authenticated HTTP/WebSocket connection from Node to Unity is a different transport and does not fulfill the prompt's Streamable HTTP requirement. Preserve stdio as default; add the MCP transport behind authentication, Origin/host validation, bounded requests/concurrency/session lifetime, project pinning, and protocol/security regressions. Do not introduce an unauthenticated endpoint or change Unity handler semantics.
2. **Real PlayMode test coverage.** `Tests/Runtime/RuntimeInputContractPlayModeTests.cs` contains one test of a locally constructed driver whose own implementation assigns the receipt flags. It does not independently exercise Ghost's lifecycle controller, Console boundaries, scenario orchestration, timeout, cancellation, or restoration. The live course/smoke suites provide valuable separate coverage, but are not a substitute for the explicitly requested PlayMode coverage. Add tests at the actual bridge/runtime boundaries and keep the existing live suites.
3. **Executable-verification process cleanup.** The completed runner review flagged that `assertCertifiedUnityEditor` passes cancellation into `execFile`, but does not retain and independently await its owned `-version` child. The suite runner's cleanup proof is not proof that this earlier subprocess and any descendants exited after cancellation. Strengthen that boundary and its real-process tests; the milestone's leak-free timeout/cleanup requirement remains open here.

These are source-observed gaps. Additional requirements must still undergo a complete requirement-by-requirement audit before completion; the list is not an assertion that everything else is finished.

## Standalone runner hardening (review findings applied)

Completed review `20260905-131222-e0e2a692` retained three independently validated findings: cancellation can overwrite the previous aggregate report during publication; failed invocations omit their unique evidence paths; and CLI SIGINT/SIGTERM wiring lacks direct automated coverage. Two file-grouped follow-up batches applied all three findings in commit `1e50fca`. The first finding was reproduced with controlled delayed I/O. The completed review is an implementation-unit review, not certification of the full milestone; its executable-verification cleanup advisory remains listed above.

The standalone EditMode/PlayMode runner now uses a 20-minute work deadline (including executable verification), configurable with `UNITY_TEST_TIMEOUT_MS` from 1 to 3,600,000 milliseconds. SIGINT/SIGTERM handlers request cancellation; the runner awaits bounded owned-process cleanup on every terminal path and keeps cleanup errors visible alongside the original failure. Each run gets unique XML and log paths. Existing aggregate XML is not accepted as current evidence.

Post-review implementation removes aggregate publication entirely, retains cancellation through required cleanup, and attaches unique evidence paths to execution errors. Controlled delayed `mkdir`, `stat`, and XML-read tests prove that cancellation stops observation and late I/O cannot resume the workflow. Underlying OS I/O is not forcibly interrupted; owned-process cleanup remains awaited and can extend elapsed time beyond the work deadline. Twelve CLI tests prove both signal handlers, failure cleanup and preservation of existing listeners without launching Unity. A new partial-registration test first failed, then passed after registration moved inside `try/finally`.

- Strengthened test-first run: 7/21 passed and 14/21 failed before the fixes; the corrected runner passes 21/21, including in the broader run whose unrelated scenario failures are recorded below.
- Post-fix real EditMode run: 111/111; `test-project/Logs/editmode-4f7dd972-f015-447b-840f-1b2be76573aa-results.xml`.
- Post-fix real PlayMode run: 1/1; `test-project/Logs/playmode-8c54510e-9151-43a4-9520-c5b053cfc4b1-results.xml`. Coverage remains the narrow existing driver test.
- Post-fix 2,500 ms real-Editor timeout exited 1 with `UNITY_TEST_TIMEOUT` and both evidence paths; log `unity-editmode-68c076b0-9937-492a-8ad9-f731387c2d32.log`.
- Post-fix CLI cancellation probe emitted Node's SIGTERM event after 2.5 seconds, exited 1 with `UNITY_TEST_CANCELLED`, and exposed both paths; log `unity-editmode-3f44ae9c-cb06-4b39-b2cd-f74dfcffa180.log`. This is handler verification, not native OS signal delivery on Windows.
- After each adverse probe no `Unity.exe` remained. Historical EditMode/PlayMode aggregate hashes stayed `20df24003ca4ac95af383655eedd28fe3c4e5cde6f66d7e63da387278b0da228` and `74744eef29283e075e943a31f413a69436d25adb5de894f022f13c36364a8ae0`.

Earlier pre-review evidence, retained for chronology:

- Characterization passed fresh-green, nonzero-exit, and missing-result cases. New timeout and cancellation regressions both failed against the extracted old runner, then passed after implementation.
- Eleven runner regressions pass; six existing process/version/NUnit regressions also pass, including real Windows descendant cleanup and unrelated-process preservation. The integrated Node suite passed 99/99 before the behavior-preserving simplification pass; final review/gates are still required.
- A real Unity timeout probe (`$env:UNITY_TEST_TIMEOUT_MS = '2500'; npm run test:unity:editmode`) exited 1 with `UNITY_TEST_TIMEOUT`. Its log is `test-project/Logs/unity-editmode-0287fb4f-9141-475b-b4d3-acf0d049d7b1.log`.
- A real Unity CLI cancellation probe emitted the Node `SIGTERM` event after 2.5 seconds and exited 1 with `UNITY_TEST_CANCELLED`; log `unity-editmode-1bad14e0-d36c-4595-b75a-1b4f0c0b57b5.log`. This proves the handler against a real Editor, not OS-level Unix signal delivery on Windows.
- After each adverse probe no `Unity.exe` remained, and the previous aggregate XML retained SHA-256 `cfefe154b86185673f2229b5654ef21e6ae896ca8ac18bcc4cfc638180ba3f0f`. No failed probe was counted as a passing test run.
- Normal runs then passed EditMode 111/111 (`editmode-8f6dda9b-ce57-494f-831c-8971286de44e-results.xml`) and PlayMode 1/1 (`playmode-ac82cda6-ce65-468a-a572-84bf5882831e-results.xml`). These validate the runner, not expanded PlayMode coverage.

## Current verification receipts

After integrating `b17b8f4` and `1e50fca`, parent verification passed `npm test` at 124/124 (including 29 scenario, 21 runner and 12 CLI cases), `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` and `git diff --check`. The immediately preceding protocol run passed 9/9 with 90 tools/57 direct mappings, and `npm audit --audit-level=high` reported zero vulnerabilities. The actual CLI rejected `Invalid` as a platform with exit 1 before launching Unity. These are local working-tree receipts, not final complete-series Unity certification.

The following earlier checks passed on the integrated tree used for commits `4a205ca` and `6f32c43`. They are retained as historical evidence, not final complete-series certification after the remaining work above.

| Command | Observed result |
| --- | --- |
| `npm ci` | 188 packages installed; audit reported zero vulnerabilities |
| `npm run format:check` | Passed; changed test/helper files also rechecked after edits |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 88/88 passed |
| `npm run test:protocol` | 9/9 passed; 90 tools and 57 direct bridge mappings |
| `npm run test:unity:editmode` | 111/111 passed on Windows Unity 2022.3.62f1 |
| `npm run test:unity:playmode` | 1/1 passed; narrow driver-contract coverage only |
| `npm run test:unity:concurrent` | 31/31 passed, including exact HTTP/WebSocket conflicts |
| `npm run test:unity:concurrent:cancel` | 8/8 passed; SIGTERM after both bridges were ready |
| `npm audit --audit-level=high` | Zero vulnerabilities |
| `npm run release:check` | Passed; versions, catalog, Newtonsoft and layout checked |
| `npm run release:pack` | Passed dry run; 69 intended distribution files |
| `git diff --check` | Passed |

Additional runner-script check passed:

```text
npx tsc --ignoreConfig --noEmit --module nodenext --target ES2022 --esModuleInterop --skipLibCheck --types node server/scripts/runLiveCourse.ts server/scripts/runUnityTests.ts server/scripts/checkRelease.ts
```

Uniquely named Unity evidence for those earlier commits:

- [EditMode XML](../test-project/Logs/editmode-85f2e74f-48c8-4771-a43c-f22e2a196683-results.xml)
- [PlayMode XML](../test-project/Logs/playmode-898af9c3-f261-410c-90cf-b00c6429bc6d-results.xml)
- [Concurrent routing receipt](../test-project/Logs/concurrent-editors-result.json)
- [Concurrent cancellation receipt](../test-project/Logs/concurrent-editors-cancellation-result.json)

These are ignored local artifacts and will not exist in a fresh clone until the commands run.

## Failures retained, not converted to successes

- Post-review runner integration passed all 21 runner cases but failed the full Node suite at 107/109: two existing scenario tests exhausted the bounded atomic-rename retry with Windows `EPERM`. An isolated scenario rerun passed 25/26 and reproduced the first green-case failure. Diagnosis proved manager-owned reads could hold the replacement destination open: a controlled 200-replacement probe failed 144 times with a concurrent reader and zero times without one. Commit `b17b8f4` adds shared canonical-path coordination for leaf I/O. Three held-read regressions failed before the fix and passed afterward; the parent then verified 29/29 scenario tests and 112/112 integrated Node tests. The earlier failed runs remain failed evidence. External readers still use the unchanged bounded retry policy.
- Windows `taskkill /T` timed out after 15 seconds in an existing regression and after 45 seconds in two concurrent probes. Bounded PowerShell 7/.NET tree termination completed matching probes in about two seconds. Tests also prove that a failed tree cleanup still fails when the root has already exited, and that an unrelated sentinel process remains alive.
- A scenario test observation expired after five seconds while real disk work was still pending. The harness now allows 30 seconds to observe completion and reports the final observed state on expiry. Production scenario, compile, Play and assertion deadlines were not increased. The earlier broad runs failed 3/88 and 1/88 before the subsequent 88/88 pass; their failures were not counted as successful verification.
- One cold concurrent-Editor run stalled at Unity's initial ILPP compiler-worker ping and failed readiness after 420 seconds. Both Editors and the temporary workspace were cleaned successfully, but cancellation did not run. Its [preserved failure receipt](../test-project/Logs/concurrent-editors-cancellation-startup-timeout-20260905T194743Z.json) remains separate from the later passing retry.

## Course and restoration evidence

The latest complete course runs currently predate the final reliability/certification commits:

| Suite | Prior result | Evidence operation |
| --- | --- | --- |
| Module 1 equivalent | 23/23 cases; 13 screenshots | `10e10d60-1875-4448-acd2-3218dc7a3cea` |
| Module 2 equivalent | 43/43 cases; 42 screenshots | `da514195-6d57-4b56-b8f0-61b2f1fc8975` |
| Module 1 cancellation | Restoration passed | `ee6b305a-d350-4773-bce5-79a8ddb7b855` |
| Module 2 cancellation | Restoration passed | `b403be03-7ec7-4e4b-99d6-87a4a83f8cd4` |

Artifacts are under `test-project/Library/UnityMcpGhost/evidence/<operationId>/`. The Module 1 manifest records commit `2b36279a695ce4faf21c236205d56923feb04266`. These results prove prior fixture behavior, not the final branch state. Re-run `npm run test:course:live` and security/runtime/scenario/repair smokes after the remaining implementation work. Verify case counts, expected failures, exact compile generations, declared input backend, source hashes, restored Editor state, zero retained transactions and artifact contents; do not rely on an exit code alone.

The unchanged `StudentExercise.cs` baseline hash is `0ff9034f3593c47b17f158f0538127eab5d84aeaadcb58c5716018ef82a99a89`.

## Completion and external gates

- Re-audit all 16 P0 findings in the deep audit against implementation and regressions, then every architectural invariant and numbered requirement in the full prompt. Test-file existence and aggregate counts alone are insufficient.
- Run the complete final command set on the complete implementation commit series, not only per-file tests or earlier working trees.
- Observe configured remote Node/Unity workflow results only after an authorized publication/run. No push or PR is authorized in this task; configured YAML is not green CI evidence.
- Unity support is currently verified only for Windows 2022.3.62f1. Other versions/platforms remain uncertified. Windows child-process tests require PowerShell 7; the MCP server/package do not.
- The actual Variablekiller and Conditionalkiller projects remain uncertified. Their unavailable-assets exception permits only the exact qualification **“GAM 215-equivalent fixture complete; real course-project certification pending.”** It does not waive any other requirement.
- The separate Account project targets Unity 6000.3.2f1 and is not a substitute for those projects or for the repository fixture. It has not been modified, downgraded, connected to Ghost, or certified by this work.

At final handoff include the full commit list, architecture/threat-model changes, public contract and migration changes, exact verification results, course evidence, unresolved risks and rollback instructions. Existing migration/rollback guidance is in [the release checklist](release-checklist.md); commit/gate history is in [progress](progress.md).
