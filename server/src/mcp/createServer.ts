import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UnityClient } from "../unity/UnityClient.js";

export interface ToolContext {
  unity: UnityClient;
}

function textResponse(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent
  };
}

function structured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({
    name: "unity-mcp-ghost",
    version: "0.1.0"
  });

  server.tool("ping", "Verify that the Unity MCP Ghost server is alive.", {}, async () => {
    const unityConnected = await context.unity.isConnected();
    const data = {
      ok: true,
      server: "unity-mcp-ghost",
      unityConnected,
      unityEndpoint: context.unity.endpoint
    };

    return textResponse(`Unity MCP Ghost is running. Unity connected: ${unityConnected}.`, data);
  });

  server.tool(
    "unity_get_editor_state",
    "Read Unity editor state, including play mode and compilation status.",
    {},
    async () => {
      const data = await context.unity.request("editor.get_state");
      return textResponse("Unity editor state retrieved.", structured(data));
    }
  );

  server.tool(
    "unity_get_console_logs",
    "Read Unity console logs, optionally filtered by severity.",
    {
      severity: z.enum(["log", "warning", "error", "all"]).default("all"),
      limit: z.number().int().positive().max(1000).default(200)
    },
    async (args) => {
      const data = await context.unity.request("console.get_logs", args);
      return textResponse("Unity console logs retrieved.", structured(data));
    }
  );

  server.tool(
    "unity_get_scene_hierarchy",
    "Read the hierarchy for the active Unity scene.",
    {
      includeInactive: z.boolean().default(true),
      maxDepth: z.number().int().positive().max(64).default(32)
    },
    async (args) => {
      const data = await context.unity.request("scene.get_hierarchy", args);
      return textResponse("Unity scene hierarchy retrieved.", structured(data));
    }
  );

  server.tool(
    "manage_scene",
    "Manage Unity scenes through EditorSceneManager-backed bridge commands.",
    {
      action: z.enum(["save", "save_all", "list_open", "get_setup"]),
      params: z.record(z.string(), z.unknown()).default({})
    },
    async ({ action, params }) => {
      const data = await context.unity.request(`scene.${action}`, params);
      return textResponse(`Scene action '${action}' completed.`, structured(data));
    }
  );

  server.tool(
    "manage_gameobject",
    "Create, inspect, and mutate GameObjects through Unity editor APIs.",
    {
      action: z.enum(["create", "create_primitive", "set_transform", "find", "get", "delete"]),
      params: z.record(z.string(), z.unknown()).default({})
    },
    async ({ action, params }) => {
      const data = await context.unity.request(`gameobject.${action}`, params);
      return textResponse(`GameObject action '${action}' completed.`, structured(data));
    }
  );

  server.tool(
    "batch_execute",
    "Execute multiple Unity bridge commands in a single request.",
    {
      operations: z
        .array(
          z.object({
            method: z.string().min(1),
            params: z.record(z.string(), z.unknown()).default({})
          })
        )
        .min(1)
        .max(100)
    },
    async (args) => {
      const data = await context.unity.request("batch.execute", args);
      return textResponse("Batch execution completed.", structured(data));
    }
  );

  return server;
}
