# Changelog

All notable changes to Unity MCP Ghost are documented here. The project follows Semantic Versioning while it remains pre-1.0.

## Unreleased - local Course-Ready candidate

- `repair_apply_edits` result contract 2 makes incomplete/unknown receipts and failed verification explicit, retains recovery evidence, and requires rollback for non-dry-run repairs. Console diagnostics are explicitly unchecked (`consoleDiagnosticsChecked: false`, `consoleErrorCount: null`). See [migration and recovery guidance](docs/repair-result-contract-v2.md).
- The complete local release-candidate verification is still in progress. The historical fixture-complete label below is superseded by this qualification: neither configured CI nor controlled-bridge tests certify the unfinished integrated milestone. Remote CI and real course-project certification remain pending.

## [0.2.0-rc.1] - 2026-09-04

### Added

- Authenticated, project-pinned HTTP, WebSocket, and durable queue transports.
- Transactional script mutation, generation-scoped compilation, truthful result envelopes, and rollback-aware batch execution.
- Normal Play mode, Console boundaries, verified input simulation, restorable scenario matrices, and deterministic evidence bundles.
- A clean-room 66-case GAM 215 Modules 1-2 fixture and live course-loop smoke suite.
- A generated, versioned 90-operation contract catalog with progressive profiles, output schemas, examples, and TypeScript/C# parity tests.

### Changed

- The supported Unity baseline is narrowed to Unity 2022.3.62f1 on Windows until additional operating-system/version CI is observed green.
- The command-line server exposes the compact `core` tool profile by default. Use `--tool-profile` to opt into `authoring`, `code`, `runtime`, `validation`, or `all`.

### Security

- Destructive, package/network, arbitrary-code, and reflection capabilities default to denied.
- Browser origins, missing/wrong tokens, non-loopback hosts, path escapes, oversized messages, and ambiguous project/editor routing are rejected.

### Qualification

- **GAM 215-equivalent fixture complete; real course-project certification pending.** Variablekiller and Conditionalkiller assets are not distributed with this repository.
