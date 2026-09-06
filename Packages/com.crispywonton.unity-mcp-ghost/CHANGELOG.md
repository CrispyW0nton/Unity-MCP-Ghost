# Changelog

## Unreleased - local Course-Ready candidate

- The companion MCP server introduces `repair_apply_edits` result contract 2: mandatory rollback for applied repairs, explicit unchecked Console diagnostics, and retained recovery evidence for unverified outcomes. See `docs/repair-result-contract-v2.md` in the repository for client migration.
- Integrated local verification is still in progress; this supersedes the historical fixture-complete qualification below. Remote CI and real course-project certification remain pending.

## [0.2.0-rc.1] - 2026-09-04

- Added authenticated project-pinned transports, transactional script and batch operations, durable jobs, Play/Console/input control, scenario evidence, GAM 215-equivalent validation, and generated operation-contract parity.
- Narrowed the supported baseline to Unity 2022.3.62f1 on Windows pending observed green cross-platform CI.
- Qualification: **GAM 215-equivalent fixture complete; real course-project certification pending.**
