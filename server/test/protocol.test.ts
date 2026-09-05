import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocketServer } from "ws";
import { createMcpServer } from "../src/mcp/createServer.js";
import { UnityClient } from "../src/unity/UnityClient.js";

describe("MCP catalog and protocol conformance", () => {
  it("publishes a deterministic compact core profile with MCP-compatible schemas and valid examples", async () => {
    const first = await listTools(["core"]);
    const second = await listTools(["core"]);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((tool) => tool.name),
      ["ping", "health", "operation_get", "operation_list", "operation_cancel", "operation_result", "capabilities_search"]
    );

    for (const tool of first) {
      assert.equal(tool.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
      assert.equal(tool.outputSchema?.$schema, "http://json-schema.org/draft-07/schema#");
      assert.equal(tool.outputSchema?.type, "object");
      assert.ok((tool.outputSchema?.required as string[]).includes("requestId"));
      assert.match(String(tool._meta?.["unity-mcp-ghost/operationId"]), /^ghost\.tool\.[a-z0-9_]+\.v1$/);
      assert.ok(Array.isArray(tool._meta?.["unity-mcp-ghost/examples"]));
      assert.ok((tool._meta?.["unity-mcp-ghost/examples"] as unknown[]).length >= 1);
    }
  });

  it("searches disabled profiles with stable pagination and field projection without exposing generic execution", async () => {
    await withClient(["core"], async (client) => {
      const first = await client.callTool({
        name: "capabilities_search",
        arguments: { profiles: ["validation"], query: "script", limit: 3, fields: ["description", "risk", "inputSchema", "outputSchema", "examples"] }
      });
      assert.equal(first.isError, undefined);
      const firstData = dataRecord(first.structuredContent);
      assert.equal(firstData.catalogVersion, 1);
      assert.equal((firstData.items as unknown[]).length, 3);
      assert.equal(firstData.truncated, true);
      assert.equal(typeof firstData.nextCursor, "string");
      for (const item of firstData.items as Array<Record<string, unknown>>) {
        assert.deepEqual(Object.keys(item).sort(), ["description", "examples", "inputSchema", "outputSchema", "name", "operationId", "profile", "risk"].sort());
        assert.equal((item.inputSchema as Record<string, unknown>).$schema, "https://json-schema.org/draft/2020-12/schema");
        assert.equal((item.outputSchema as Record<string, unknown>).$schema, "https://json-schema.org/draft/2020-12/schema");
      }

      const second = await client.callTool({
        name: "capabilities_search",
        arguments: { profiles: ["validation"], query: "script", limit: 3, cursor: firstData.nextCursor, fields: ["risk"] }
      });
      const secondItems = dataRecord(second.structuredContent).items as Array<Record<string, unknown>>;
      assert.notEqual(secondItems[0]?.operationId, (firstData.items as Array<Record<string, unknown>>)[0]?.operationId);

      const invalid = await client.callTool({ name: "capabilities_search", arguments: { cursor: "not-a-cursor" } });
      assert.equal(invalid.isError, true);
      assert.equal(errorRecord(invalid.structuredContent).code, "INVALID_CURSOR");

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(names.includes("operation_call"), false);
      assert.equal(names.includes("script_write"), false);
    });
  });

  it("keeps every related resource URI aligned with an advertised resource or template", async () => {
    await withClient(["all"], async (client) => {
      const [tools, resources, templates] = await Promise.all([client.listTools(), client.listResources(), client.listResourceTemplates()]);
      const advertised = new Set([
        ...resources.resources.map((resource) => resource.uri),
        ...templates.resourceTemplates.map((resource) => resource.uriTemplate)
      ]);
      for (const tool of tools.tools) {
        for (const uri of (tool._meta?.["unity-mcp-ghost/relatedResources"] ?? []) as string[]) {
          assert.ok(advertised.has(uri), `${tool.name} refers to unadvertised resource ${uri}`);
        }
      }
    });
  });

  it("keeps every directly mapped TypeScript operation aligned with the split C# command registry", async () => {
    const registrations = await readFile(
      new URL("../../Packages/com.crispywonton.unity-mcp-ghost/Editor/Bridge/CommandRegistry.Registrations.cs", import.meta.url),
      "utf8"
    );
    const bridgeOperations = [...registrations.matchAll(/Register\("([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(bridgeOperations).size, bridgeOperations.length, "C# command IDs must be unique");

    await withClient(["all"], async (client) => {
      const tools = (await client.listTools()).tools;
      const mapped = tools.flatMap((tool) => (tool._meta?.["unity-mcp-ghost/bridgeOperations"] ?? []) as string[]);
      assert.ok(mapped.length >= 50, "Expected the public catalog to map the direct bridge operations");
      for (const bridgeOperation of mapped) {
        assert.ok(bridgeOperations.includes(bridgeOperation), `TypeScript maps missing C# bridge operation ${bridgeOperation}`);
      }
    });
  });

  it("returns structured output and promotes a mock bridge soft failure", async () => {
    const fakeUnity = {
      endpoint: "ws://127.0.0.1:6400/unity-mcp-ghost/",
      queueEndpoint: undefined,
      isConnected: async () => true,
      request: async (method: string) =>
        method === "console.get_logs" ? { ok: false, error: { code: "MOCK_SOFT_FAILURE", message: "Mock bridge refused the read." } } : { ok: true }
    } as unknown as UnityClient;
    await withClient(
      ["all"],
      async (client) => {
        const ping = await client.callTool({ name: "ping", arguments: {} });
        assert.equal((ping.structuredContent as { ok: boolean }).ok, true);
        assert.equal(typeof (ping.structuredContent as { requestId: unknown }).requestId, "string");

        const failed = await client.callTool({ name: "console_read", arguments: { severity: "all", limit: 10 } });
        assert.equal(failed.isError, true);
        assert.equal(errorRecord(failed.structuredContent).code, "MOCK_SOFT_FAILURE");
      },
      fakeUnity
    );
  });
});

describe("Unity WebSocket protocol adapter", () => {
  it("reassembles a fragmented JSON-RPC response from a mock Unity bridge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unity-mcp-protocol-"));
    const tokenFile = join(directory, "bridge-token.txt");
    await writeFile(tokenFile, "a".repeat(64), "utf8");
    const websocket = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => websocket.once("listening", () => resolve()));
    const websocketAddress = websocket.address();
    if (typeof websocketAddress === "string" || websocketAddress === null) throw new Error("WebSocket test server did not bind.");
    const closedHttpPort = await reserveThenClosePort();

    websocket.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string };
        const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, transport: "fragmented-websocket" } });
        const split = Math.floor(response.length / 2);
        socket.send(response.slice(0, split), { fin: false });
        socket.send(response.slice(split), { fin: true });
      });
    });

    try {
      const client = new UnityClient({
        host: "127.0.0.1",
        port: closedHttpPort,
        webSocketPort: websocketAddress.port,
        requestTimeoutMs: 2000,
        projectId: "unity-project-test",
        editorInstanceId: "editor-test",
        tokenFile
      });
      const result = await client.request<{ ok: boolean; transport: string }>("health", {}, { requestId: "fragmented-response" });
      assert.equal(result.ok, true);
      assert.equal(result.transport, "fragmented-websocket");
    } finally {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function listTools(profiles: Array<"core" | "authoring" | "code" | "runtime" | "validation" | "all">) {
  let result: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  await withClient(profiles, async (client) => {
    result = (await client.listTools()).tools;
  });
  return result;
}

async function withClient(
  profiles: Array<"core" | "authoring" | "code" | "runtime" | "validation" | "all">,
  run: (client: Client) => Promise<void>,
  unity: UnityClient = fakeUnity()
): Promise<void> {
  const server = createMcpServer({ unity, toolProfiles: profiles });
  const client = new Client({ name: "unity-mcp-protocol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function fakeUnity(): UnityClient {
  return {
    endpoint: "ws://127.0.0.1:6400/unity-mcp-ghost/",
    queueEndpoint: undefined,
    isConnected: async () => true,
    request: async () => ({ ok: true })
  } as unknown as UnityClient;
}

function dataRecord(value: unknown): Record<string, unknown> {
  return ((value as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
}

function errorRecord(value: unknown): Record<string, unknown> {
  return ((value as { error?: unknown })?.error ?? {}) as Record<string, unknown>;
}

async function reserveThenClosePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
