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

  it("waits for the exact compile generation instead of idle editor state", async () => {
    const observedRequests: Array<{ method: string; params: unknown }> = [];
    let reads = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        observedRequests.push({ method, params });
        reads++;
        return reads === 1
          ? { ok: true, status: "waiting", generation: 7, observed: false, diagnostics: [] }
          : { ok: true, status: "success", generation: 7, observed: true, diagnostics: [] };
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "compile_wait",
        arguments: { requestedCompileGeneration: 7, timeoutMs: 2000 }
      });

      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as Record<string, unknown>).ok, true);
      assert.ok(observedRequests.length >= 2);
      assert.ok(observedRequests.every((request) => request.method === "compile.status_get"));
      assert.ok(
        observedRequests.every(
          (request) => (request.params as { requestedCompileGeneration?: number }).requestedCompileGeneration === 7
        )
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports compiler diagnostics from only the validation generation", async () => {
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        if (method === "script.validate") {
          return { ok: true, path: "Assets/Broken.cs", requestedCompileGeneration: 12 };
        }
        if (method === "compile.status_get") {
          return { ok: false, status: "failed", generation: 12, observed: true, diagnostics: [] };
        }
        if (method === "compile.diagnostics_get") {
          assert.equal((params as { generation?: number }).generation, 12);
          return {
            ok: true,
            generation: 12,
            diagnostics: [{ generation: 12, severity: "error", code: "CS1002", message: "; expected" }]
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "script_validate",
        arguments: { path: "Assets/Broken.cs", timeoutMs: 2000 }
      });

      assert.equal(result.isError, true);
      const envelope = result.structuredContent as Record<string, unknown>;
      assert.equal((envelope.error as { code: string }).code, "SCRIPT_COMPILER_ERRORS");
      assert.equal(((envelope.data as { diagnostics: unknown[] }).diagnostics as unknown[]).length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
