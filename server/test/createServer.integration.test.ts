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

  it("runs a bounded repair proposal through apply, compile, and verification", async () => {
    let activeGeneration = 1;
    let changed = false;
    const applyModes: boolean[] = [];
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        const request = params as Record<string, unknown>;
        if (method === "script.read") {
          return {
            ok: true,
            content: "public class Broken { void Run() { int score = 1 } }",
            sha256: changed ? "changed-hash" : "original-hash"
          };
        }
        if (method === "script.validate") {
          return { ok: true, requestedCompileGeneration: request.requestedCompileGeneration ?? activeGeneration };
        }
        if (method === "compile.status_get") {
          const generation = Number(request.requestedCompileGeneration);
          return { ok: generation === 2, status: generation === 2 ? "success" : "failed", generation, observed: true };
        }
        if (method === "compile.diagnostics_get") {
          return Number(request.generation) === 1
            ? { ok: true, diagnostics: [{ generation: 1, severity: "error", code: "CS1002", message: "error CS1002: ; expected", line: 1, column: 50 }] }
            : { ok: true, diagnostics: [] };
        }
        if (method === "script.apply_edits") {
          applyModes.push(request.dryRun === true);
          if (request.dryRun !== true) {
            changed = true;
            activeGeneration = 2;
          }
          return { ok: true, dryRun: request.dryRun, requestedCompileGeneration: request.dryRun ? undefined : 2 };
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
        name: "repair_loop_run",
        arguments: { objective: "repair missing semicolon", scriptPath: "Assets/Broken.cs", maxIterations: 1, compileTimeoutMs: 2000 }
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(applyModes, [true, false]);
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      assert.equal(data.ok, true);
      assert.equal(data.iterationCount, 1);
      assert.equal(data.finalSha256, "changed-hash");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores the original hash when every repair iteration fails", async () => {
    let activeGeneration = 1;
    let sourceChanged = false;
    let restoreWrites = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        const request = params as Record<string, unknown>;
        if (method === "script.read") {
          return {
            ok: true,
            content: "public class Broken { void Run() { int score = 1 } }",
            sha256: sourceChanged ? "changed-hash" : "original-hash"
          };
        }
        if (method === "script.validate") {
          return { ok: true, requestedCompileGeneration: request.requestedCompileGeneration ?? activeGeneration };
        }
        if (method === "compile.status_get") {
          const generation = Number(request.requestedCompileGeneration);
          return { ok: generation === 3, status: generation === 3 ? "success" : "failed", generation, observed: true };
        }
        if (method === "compile.diagnostics_get") {
          return {
            ok: true,
            diagnostics: [{ generation: request.generation, severity: "error", code: "CS1002", message: "error CS1002: ; expected", line: 1, column: 50 }]
          };
        }
        if (method === "script.apply_edits") {
          if (request.dryRun !== true) {
            sourceChanged = true;
            activeGeneration = 2;
          }
          return { ok: true, requestedCompileGeneration: request.dryRun ? undefined : 2 };
        }
        if (method === "script.write") {
          restoreWrites++;
          sourceChanged = false;
          activeGeneration = 3;
          return { ok: true, requestedCompileGeneration: 3 };
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
        name: "repair_loop_run",
        arguments: { objective: "repair then restore", scriptPath: "Assets/Broken.cs", maxIterations: 1, compileTimeoutMs: 2000 }
      });

      assert.equal(result.isError, true);
      assert.equal(restoreWrites, 1);
      const envelope = result.structuredContent as { error: { code: string }; data: { restored: { ok: boolean; restoredSha256: string } } };
      assert.equal(envelope.error.code, "REPAIR_EXHAUSTED");
      assert.equal(envelope.data.restored.ok, true);
      assert.equal(envelope.data.restored.restoredSha256, "original-hash");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits for the requested normal Play mode generation to settle", async () => {
    let reads = 0;
    const fakeUnity = {
      request: async (method: string) => {
        if (method === "play_mode.set") {
          return { ok: true, requestedState: "playing", state: "enteringPlay", transitionGeneration: 9 };
        }
        if (method === "play_mode.get") {
          reads++;
          return { ok: true, state: reads < 2 ? "enteringPlay" : "playing", transitionGeneration: 9, frameCount: 1 };
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
        name: "play_mode_set",
        arguments: { state: "playing", waitForSettled: true, timeoutMs: 2000, saveModifiedScenes: false }
      });

      assert.equal(result.isError, undefined);
      assert.ok(reads >= 2);
      const data = (result.structuredContent as { data: { settledState: { state: string; settled: boolean } } }).data;
      assert.equal(data.settledState.state, "playing");
      assert.equal(data.settledState.settled, true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits from an exact Console boundary until the filter matches", async () => {
    let reads = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        assert.equal(method, "console.query");
        assert.equal((params as { boundary: string }).boundary, "mark-1");
        reads++;
        return { ok: true, matched: reads > 1, count: reads > 1 ? 1 : 0, entries: [], unexpectedErrors: [] };
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "console_wait",
        arguments: { boundary: "mark-1", exact: "Hello", count: 1, timeoutMs: 1000, pollIntervalMs: 25 }
      });

      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as { data: { matched: boolean } }).data.matched, true);
      assert.ok(reads >= 2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports unsupported input backends as typed MCP errors", async () => {
    const fakeUnity = {
      request: async () => ({
        ok: false,
        status: "failed",
        error: { code: "UNSUPPORTED_INPUT_BACKEND", message: "No verified input backend accepted PageUp." }
      })
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "input_simulate",
        arguments: { device: "keyboard", action: "tap", key: "PageUp" }
      });

      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as { error: { code: string } }).error.code, "UNSUPPORTED_INPUT_BACKEND");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
