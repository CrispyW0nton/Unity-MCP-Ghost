# Unity MCP Ghost

Unity MCP Ghost is a Cursor-first Unity automation bridge inspired by the Unreal MCP Ghost architecture: inspect, mutate, validate, repair, test, and document Unity projects through deterministic MCP tools.

This repository currently contains the initial project scaffold:

- `server/` - TypeScript MCP server, tool registry, Unity bridge client, and stdio transport entry point.
- `Packages/com.crispywonton.unity-mcp-ghost/` - Unity UPM editor bridge package skeleton.
- `docs/` - architecture and development notes for the Ghost roadmap.

## Goals

- Expose safe Unity Editor workflows to MCP clients such as Cursor.
- Route Unity state changes through Unity editor APIs rather than direct file edits.
- Wrap mutating operations in Undo groups where possible.
- Return structured JSON for reliable follow-up tool calls.
- Build toward diagnostics, repair loops, tests, screenshots, and knowledge-base guided workflows.

## Early Local Flow

1. Open a Unity project that has `Packages/com.crispywonton.unity-mcp-ghost` installed.
2. Start the Unity bridge from `Window > Unity MCP Ghost`.
3. Run the MCP server from this repo:

```bash
npm install
npm run build
node dist/index.js --transport stdio --unity-host 127.0.0.1 --unity-port 6400
```

## Cursor MCP Config

```json
{
  "mcpServers": {
    "unity-mcp-ghost": {
      "command": "node",
      "args": [
        "C:/Dev/Unity-MCP-Ghost/server/dist/index.js",
        "--transport",
        "stdio",
        "--unity-host",
        "127.0.0.1",
        "--unity-port",
        "6400"
      ]
    }
  }
}
```

## Current Status

This is a brand-new project scaffold. The first implementation target is the Phase 1/2 vertical slice:

- MCP `ping`
- Unity connection health
- editor state
- console logs
- scene hierarchy
- create GameObject
- set transform
- save scene
- screenshot capture
