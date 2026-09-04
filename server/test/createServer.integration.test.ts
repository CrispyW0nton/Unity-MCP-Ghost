import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import type { UnityClient } from "../src/unity/UnityClient.js";

describe("MCP result adaptation", () => {
  it("reports a Unity bridge soft failure as an MCP tool error", async () => {
    const fakeUnity = {
      request: async () => ({
        ok: false,
        error: {
          code: "UNITY_CONSOLE_READ_FAILED",
          message: "The Unity bridge rejected the request."
        }
      })
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const result = await client.callTool({
        name: "console_read",
        arguments: { severity: "all", limit: 10 }
      });

      assert.equal(result.isError, true);
      assert.deepEqual((result.structuredContent as Record<string, unknown>).error, {
        code: "UNITY_CONSOLE_READ_FAILED",
        message: "The Unity bridge rejected the request."
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
