# MCP Book Guidance Applied to Ghost

This note captures implementation guidance distilled from two local reference books:

- Kevin Lowe, `Mastering Model Context Protocol: Advanced Techniques for AI Integration`
- Naveen Krishnan, `Model Context Protocol for LLMs`

The books reinforce the same direction for Unity MCP Ghost: a strong MCP server is not just a bag of callable tools. It should expose context, capabilities, security posture, and workflow guidance in ways that let clients orchestrate intelligently.

## Applied Design Rules

1. Prefer resources for read-heavy context.
   Unity state that agents need repeatedly should be available as `unity://` resources. This reduces tool noise and lets clients browse context progressively.

2. Make capability discovery explicit.
   Clients should not infer risk, dry-run support, or phase from tool names. Ghost exposes `unity://capabilities` so agents can choose tools based on metadata.

3. Treat metadata as operational context.
   Tool responses include confidence, diagnostics, duration, and undo group fields. Tool registrations include risk level, mutating status, dry-run support, related resources, and phase.

4. Use progressive disclosure.
   Ghost should expose a compact core catalog by default, with specialized Unity domains added through lazy categories or resources as the project matures.

5. Design tools for composability.
   Tools should be small enough to combine, while `batch_execute` provides operation fusion for repetitive editor changes.

6. Handle uncertainty gracefully.
   Failed bridge requests should return structured diagnostics instead of raw crashes whenever possible. Repair workflows should stop when confidence falls.

7. Put security and consent into the tool model.
   Risk levels are part of the public tool metadata. Destructive, code-executing, package, build, and runtime tools must remain opt-in as they arrive.

8. Optimize for workflow intelligence, not just latency.
   Fast calls matter, but the real win is helping agents pick the right context, avoid unnecessary calls, batch repetitive work, and preserve state across reloads.

## Current Code Changes

- `unity://capabilities` exposes the registered tool catalog, risk levels, dry-run support, related resources, and operating principles.
- `unity://editor/state`, `unity://scenes/active`, and `unity://console/errors` expose read-only Unity state.
- `ghost_inspect_project` guides resource-first project inspection.
- `ghost_repair_loop_plan` guides dry-run-first validate/repair/test planning.
- Tool metadata now supports the risk and discoverability model that later authorization and lazy-loading layers can build on.

## Next MCP-Centric Improvements

- Add resource templates for `unity://gameobject/{instanceId}` and `unity://component/{instanceId}/{type}`.
- Add progress notifications for long-running commands such as tests, builds, semantic indexing, and repair loops.
- Add roots support so Ghost can understand the Unity project boundary and avoid unsafe filesystem assumptions.
- Add explicit client/session context to bridge requests for audit logs and durable queue ownership.
- Split tool registration into lazy categories once the catalog grows beyond the Phase 1/2 surface.
- Add policy gates for destructive, code-write, package, build-system, and runtime tools.

