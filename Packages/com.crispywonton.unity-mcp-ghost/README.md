# Unity MCP Ghost Editor Bridge

This package provides the Unity-side editor bridge for Unity MCP Ghost.

Open the bridge window from:

```text
Window > Unity MCP Ghost
```

The bridge is editor-only and is intended to listen on localhost. It executes Unity API commands on the editor main thread and returns JSON-RPC responses to the external MCP server.

## Status

This package is currently a Phase 1 scaffold. It includes:

- Editor window.
- Bridge configuration.
- Main-thread dispatcher.
- Command registry.
- Basic `ping`, `editor.get_state`, `console.get_logs`, and `scene.get_hierarchy` commands.
