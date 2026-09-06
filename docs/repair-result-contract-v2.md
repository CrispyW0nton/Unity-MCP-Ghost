# Explicit repair result contract 2

This migration applies to `repair_apply_edits` in the unreleased Course-Ready local release candidate. It does not change the MCP protocol version or rename the tool. The result payload now identifies these semantics with `data.resultContractVersion: 2`; callers must inspect the returned schema and version instead of inferring success from a message.

## Requests

- For an applied repair, omit `rollbackOnFailure` (the default is `true`) or set it to `true`. A request with `dryRun: false` and `rollbackOnFailure: false` fails before any project read or mutation with `REPAIR_ROLLBACK_REQUIRED`.
- A dry run still accepts either rollback option. It returns the existing `mode: "dry-run"` and `editCount` fields without applying source changes.
- Caller-supplied source paths and edit ranges retain their existing meaning. The handler reads the original byte hash and uses optimistic concurrency for its apply and restore requests.

## Results and failure handling

- Read the MCP `isError` flag and structured envelope `ok`. A rejected producer receipt, compiler/test failure, unverified source, or failed cleanup is an error, even if a previous step succeeded.
- `consoleDiagnosticsChecked: false` and `consoleErrorCount: null` mean that this tool did **not** count Console diagnostics. The old numeric count mixed historical Console entries into repair validation. Do not convert `null` to zero or interpret it as a clean Console. Use `console_mark` and boundary-scoped `console_assert`/`console_wait` for runtime checks.
- Compiler validation uses the requested generation. Repair success also requires a matching final source hash and green required tests when requested. The shared wait/deadline and live Test Runner lifecycle gates must still pass before the complete release candidate is certified.
- Keep `steps`, `applyResult`, `rollback`, `transactionCleanup`, `retainedBackups`, hashes and recovery hints when storing a result. They explain which postconditions were verified and which remain unresolved.
- A missing or incomplete mutation receipt is not permission to retry. An unknown apply, test start or restore outcome requires reconciliation before more mutation or cleanup. Recovery files are retained when safe completion cannot be established. After an uncertain cleanup, the listed backup paths may no longer exist; the result labels that uncertainty.
- When the transport proves a required test request never executed, the handler can take its hash-checked rollback path. A local wait timeout or a lost response alone does not prove the Test Runner stopped.
- Restoration checks current source hashes before replacing bytes. If another editor changed the file, those newer bytes must remain and the tool reports unverified restoration with recovery material retained.

Do not treat `mode: "applied"` alone as success; failed required checks or unsettled execution can leave an applied source pending recovery. Check the envelope and `repairVerified` as well. A successful byte restoration is not evidence that an already-broken baseline compiled cleanly.

## Migration and rollback

Update clients that explicitly disabled rollback, assumed `consoleErrorCount` was always numeric, or handled all repair responses as successes. Preserve unknown-outcome receipts in client logs without automatically replaying requests. The public output schema advertises the contract marker and unchecked-Console fields.

This contract is being integrated into an unreleased candidate; it is not a new published package release. To return to an earlier implementation, first reconcile every pending mutation and preserve recovery backups, then revert the relevant local commits on a clean, user-reviewed checkout. Reverting code does not undo a source mutation in a Unity project. Do not delete `Library/UnityMcpGhost` to resolve a pending repair.

## Verification scope

The disk-backed MCP tests exercise real source, metadata and backup bytes with controlled Unity bridge responses. They are not live compiler, Test Runner or domain-reload certification. The final local RC must also pass its separate Unity and live smoke gates; actual course projects remain untouched and uncertified.
