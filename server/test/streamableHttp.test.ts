import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createHttpServer, request as httpRequest, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startStreamableHttp, type StreamableHttpOptions } from "../src/transports/streamableHttp.js";
import { ScenarioJobManager, type ScenarioJobRecord, type ScenarioMatrixDefinition } from "../src/scenario/ScenarioJobManager.js";
import { UnityClient } from "../src/unity/UnityClient.js";
import { runMcpCli } from "../src/mcpCli.js";
import type { StreamableHttpService } from "../src/transports/streamableHttp.js";

const token = "a".repeat(64);
const headers = { Authorization: `Bearer ${token}`, "X-Ghost-Project-Id": "project-http", "X-Ghost-Editor-Id": "editor-http" };
let directory: string;
let tokenFile: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "ghost-mcp-http-"));
  tokenFile = join(directory, "bridge-token.txt");
  await writeFile(tokenFile, token);
  if (process.platform === "win32") {
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; $p = $env:GHOST_HTTP_TEST_TOKEN; $u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a = New-Object System.Security.AccessControl.FileSecurity; $a.SetOwner($u); $a.SetAccessRuleProtection($true, $false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($u, "FullControl", "Allow"))); [System.IO.File]::SetAccessControl($p, $a)'
      ],
      { env: { ...process.env, GHOST_HTTP_TEST_TOKEN: tokenFile }, windowsHide: true, timeout: 10000 }
    );
  } else {
    await chmod(tokenFile, 0o600);
  }
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("secured MCP Streamable HTTP", () => {
  for (const stop of ["SIGINT", "SIGTERM", "fatal", "pending-start", "failed-persistence"] as const) {
    it(`coordinates real scenario restoration and durable finalization on ${stop}`, { timeout: 30000 }, async (context) => {
      const project = await mkdtemp(join(directory, "scenario-cli-"));
      const sourcePath = join(project, "Assets", "Fixture.cs");
      await mkdir(join(project, "Assets"));
      const original = Buffer.from("// Original bytes\r\npublic class Fixture {}\r\n");
      await writeFile(sourcePath, original);
      const fake = new ShutdownScenarioUnity(sourcePath, original);
      const signals = new EventEmitter() as EventEmitter & { argv: string[]; exitCode?: number | string };
      signals.argv = [];
      const ready = deferred();
      const handlerEntered = deferred();
      const allowStart = deferred();
      const logs: string[] = [];
      let manager!: ScenarioJobManager;
      let service!: StreamableHttpService;
      let listener!: ReturnType<typeof createHttpServer>;
      let settled = false;
      let jobId = "";
      const running = runMcpCli({
        process: signals,
        readConfig: () => ({
          transport: "streamable-http",
          mcpHost: "127.0.0.1",
          mcpPort: 0,
          unityHost: "127.0.0.1",
          unityPort: 7123,
          unityWebSocketPort: 7123,
          unityProjectPath: project,
          unityProjectId: "project-http",
          unityEditorInstanceId: "editor-http",
          unityTokenFile: tokenFile,
          requestTimeoutMs: 10000,
          toolProfiles: ["all"]
        }),
        createUnity: () => fake as unknown as UnityClient,
        createScenarios: (options) => {
          manager = new ScenarioJobManager(options);
          if (stop === "pending-start") {
            const startJob = manager.start.bind(manager);
            context.mock.method(manager, "start", async (definition: ScenarioMatrixDefinition) => {
              handlerEntered.resolve();
              await allowStart.promise;
              return startJob(definition);
            });
          }
          if (stop === "failed-persistence") {
            const methods = manager as unknown as { save(record: ScenarioJobRecord): Promise<void> };
            const save = methods.save.bind(manager);
            context.mock.method(methods, "save", async (record: ScenarioJobRecord) => {
              if (["success", "failed", "cancelled", "outcomeUnknown"].includes(record.status))
                throw Object.assign(new Error("synthetic ENOSPC"), { code: "ENOSPC" });
              await save(record);
            });
          }
          return manager;
        },
        startHttp: async (options) => {
          service = await startStreamableHttp({ ...options, httpServerFactory: (settings, handler) => (listener = createHttpServer(settings, handler)) });
          return service;
        },
        writeError: (message) => {
          logs.push(message);
          if (message.includes("listening at")) ready.resolve();
        }
      }).then((result) => {
        settled = true;
        return result;
      });
      let request: Promise<unknown> | undefined;
      try {
        await ready.promise;
        request = post(service.url, {
          message: {
            jsonrpc: "2.0",
            id: "scenario",
            method: "tools/call",
            params: {
              name: "scenario_matrix_run",
              arguments: {
                name: "shutdown fixture",
                scenePath: "Assets/Scenario.unity",
                cases: [{ id: "mutate", sourceMutations: [{ path: "Assets/Fixture.cs", content: "public class Changed {}", expectedSha256: hash(original) }] }]
              }
            }
          }
        }).catch(() => undefined);
        if (stop === "pending-start") {
          await handlerEntered.promise;
          signals.emit("SIGTERM");
          await eventually(() => service.stats().closing);
          assert.equal(fake.disposed, 0);
          assert.equal(service.stats().activeRequests, 1);
          allowStart.resolve();
        } else {
          const reply = (await request) as { body: string };
          jobId = String(JSON.parse(reply.body).result.structuredContent.operationId);
        }
        await fake.restoring.promise;
        assert.deepEqual(await readFile(sourcePath), fake.mutated);
        assert.deepEqual(await readFile(fake.backupPath), original);
        if (stop === "fatal") listener.emit("error", new Error("Authorization: Bearer do-not-print-this-secret"));
        else if (stop !== "pending-start") signals.emit(stop === "SIGINT" ? "SIGINT" : "SIGTERM");
        await eventually(() => service.stats().closing);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(fake.disposed, 0, "Unity must remain alive while restoration is held");
        assert.equal(fake.cancelled, 0);
        const jobsRoot = join(project, "Library", "UnityMcpGhost", "scenario-jobs");
        const lease = JSON.parse(await readFile(join(jobsRoot, "active-scenario-lease.json"), "utf8"));
        if (jobId) assert.equal(lease.operationId, jobId);
        jobId = lease.operationId;
        fake.allowRestore.resolve();
        const result = await running;
        assert.equal(result.exitCode, stop === "fatal" || stop === "failed-persistence" ? 1 : 0);
        assert.equal(fake.disposed, 1);
        assert.equal(fake.cancelled, 0);
        assert.equal(fake.applyCount, 1);
        assert.equal(fake.restoreCount, 1);
        assert.equal(fake.callsAfterDispose, 0);
        assert.deepEqual(await readFile(sourcePath), original);
        assert.deepEqual(fake.editor, fake.originalEditor);
        await assert.rejects(access(fake.backupPath), { code: "ENOENT" });
        const persisted = JSON.parse(await readFile(join(jobsRoot, `${jobId}.json`), "utf8"));
        if (stop === "failed-persistence") {
          assert.equal(persisted.status, "running");
          assert.equal(persisted.phase, "restoring-original-state");
          await access(join(jobsRoot, "active-scenario-lease.json"));
          assert.ok(result.failureCodes.includes("MCP_SCENARIO_OUTCOME_UNKNOWN"));
        } else {
          assert.equal(persisted.status, "success");
          assert.equal(persisted.restorationComplete, true);
          await assert.rejects(access(join(jobsRoot, "active-scenario-lease.json")), { code: "ENOENT" });
        }
        if (stop === "pending-start") assert.match(logs.join(""), /1 unfinished request\(s\)/);
        else assert.doesNotMatch(logs.join(""), /unfinished request/);
        assert.doesNotMatch(logs.join(""), /do-not-print-this-secret|Authorization/);
        assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
        await request;
      } finally {
        allowStart.resolve();
        fake.allowRestore.resolve();
        signals.emit("SIGTERM");
        await running;
        await request;
        await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }

  it("negotiates SDK HTTP, exposes the real catalog, and preserves structured soft failures", async () => {
    const service = await startStreamableHttp({
      host: "127.0.0.1",
      port: 0,
      projectId: "project-http",
      editorInstanceId: "editor-http",
      tokenFile,
      createServer: () => createMcpServer({ unity: fakeUnity(), toolProfiles: ["all"] })
    });
    const client = new Client({ name: "http-proof", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers } }));
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "script_write"));
      const result = await client.callTool({ name: "console_read", arguments: {} });
      assert.equal(result.isError, true);
      const content = result.structuredContent;
      assert.ok(content && typeof content === "object" && "error" in content && "requestId" in content);
      assert.ok(content.error && typeof content.error === "object" && "code" in content.error);
      assert.equal(content.error.code, "MOCK_SOFT_FAILURE");
      assert.equal(typeof content.requestId, "string");
    } finally {
      await client.close();
      await service.close();
    }
  });

  it("negotiates supported older generations, returns 202 for initialization notifications and rejects stateless cancellation", async () => {
    const service = await start();
    try {
      for (const version of ["2024-10-07", "2025-03-26", "2025-11-25"]) {
        const initialized = await post(service.url, {
          message: {
            jsonrpc: "2.0",
            id: version,
            method: "initialize",
            params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "legacy-http", version: "1" } }
          }
        });
        assert.equal(initialized.status, 200);
        assert.equal(JSON.parse(initialized.body).result.protocolVersion, version);
        assert.equal(initialized.headers["mcp-session-id"], undefined);
      }
      const notification = await post(service.url, { message: { jsonrpc: "2.0", method: "notifications/initialized" } });
      assert.equal(notification.status, 202);
      assert.equal(notification.body, "");
      const cancellation = await post(service.url, { message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "original" } } });
      assert.equal(cancellation.status, 400);
      assert.match(cancellation.body, /USE_OPERATION_CANCEL/);
      const unknown = await post(service.url, { message: { jsonrpc: "2.0", id: 1, method: "unknown" } });
      assert.equal(JSON.parse(unknown.body).error.code, -32601);
      const largeId = await post(service.url, { message: { jsonrpc: "2.0", id: "x".repeat(129), method: "ping" } });
      assert.equal(largeId.status, 400);
      assert.match(largeId.body, /REQUEST_ID_LIMIT/);
      assert.equal(JSON.parse(largeId.body).id, null);
    } finally {
      await service.close();
    }
  });

  it("preserves older-generation batch correlation and notification semantics through the real SDK", async () => {
    let mutations = 0;
    const service = await start({
      createServer: () => {
        const server = new McpServer({ name: "batch", version: "1" });
        server.registerTool("mutate", { inputSchema: {} }, async () => {
          mutations++;
          return { content: [] };
        });
        return server;
      }
    });
    const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "mutate", arguments: {} } };
    try {
      for (const version of [undefined, "2024-10-07", "2024-11-05", "2025-03-26"]) {
        const batch = await post(service.url, {
          headers: { "MCP-Protocol-Version": version },
          message: [{ jsonrpc: "2.0", id: 1, method: "ping" }, notification, { jsonrpc: "2.0", id: "1", method: "unknown" }]
        });
        assert.equal(batch.status, 200, version);
        const replies = JSON.parse(batch.body);
        assert.deepEqual(
          replies.map((reply: { id: unknown }) => reply.id),
          [1, "1"]
        );
        assert.deepEqual(replies[0].result, {});
        assert.equal(replies[1].error.code, -32601);
      }
      const singleReply = await post(service.url, { message: [notification, { jsonrpc: "2.0", id: "one", method: "ping" }] });
      assert.deepEqual(JSON.parse(singleReply.body), [{ jsonrpc: "2.0", id: "one", result: {} }]);
      const accepted = await post(service.url, { message: [notification, { jsonrpc: "2.0", method: "notifications/initialized" }] });
      assert.equal(accepted.status, 202);
      assert.equal(accepted.body, "");
      const responses = await post(service.url, { message: [{ jsonrpc: "2.0", id: "reply", result: {} }] });
      assert.equal(responses.status, 202);
      assert.equal(responses.body, "");
      assert.equal(mutations, 0, "tools/call without an ID must never invoke a tool handler");
    } finally {
      await service.close();
    }
  });

  it("preflights every batch entry and rejects modern batches without partial mutation", async () => {
    let mutations = 0;
    const service = await start({
      createServer: () => {
        const server = new McpServer({ name: "batch-validation", version: "1" });
        server.registerTool("mutate", { inputSchema: {} }, async () => {
          mutations++;
          return { content: [] };
        });
        return server;
      }
    });
    const mutation = { jsonrpc: "2.0", id: "mutate", method: "tools/call", params: { name: "mutate", arguments: {} } };
    const initialize = {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "batch", version: "1" } }
    };
    const cases: Array<[unknown, string, string?]> = [
      [[], "INVALID_JSONRPC"],
      [[mutation, { jsonrpc: "1.0", id: 2, method: "ping" }], "INVALID_JSONRPC"],
      [[mutation, { jsonrpc: "2.0", id: "response", result: {} }], "INVALID_JSONRPC"],
      [[mutation, { jsonrpc: "2.0", id: "mutate", method: "ping" }], "DUPLICATE_REQUEST_ID"],
      [[mutation, { jsonrpc: "2.0", id: "x".repeat(129), method: "ping" }], "REQUEST_ID_LIMIT"],
      [[mutation, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "mutate" } }], "USE_OPERATION_CANCEL"],
      [[mutation, initialize], "INITIALIZATION_BATCH"],
      [[initialize], "INITIALIZATION_BATCH"],
      [[mutation], "BATCH_UNSUPPORTED", "2025-06-18"],
      [[mutation], "BATCH_UNSUPPORTED", "2025-11-25"]
    ];
    try {
      for (const [message, code, version] of cases) {
        const result = await post(service.url, { message, headers: { "MCP-Protocol-Version": version } });
        assert.equal(result.status, 400, code);
        assert.match(result.body, new RegExp(code));
        assert.equal(JSON.parse(result.body).id, null);
        assert.equal(mutations, 0, code);
      }
    } finally {
      await service.close();
    }
  });

  it("charges every batch element against admission and authenticated rate budgets", async () => {
    const service = await start({ limits: { activeRequests: 2, requestsPerWindow: 4 } });
    const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });
    try {
      const tooMany = await post(service.url, { message: [ping(1), ping(2), ping(3)] });
      assert.equal(tooMany.status, 503);
      assert.match(tooMany.body, /CONCURRENCY_LIMIT/);
      const allowed = await post(service.url, { message: [ping(1), ping(2)] });
      assert.equal(allowed.status, 200);
      const rateLimited = await post(service.url, { message: [ping(1), ping(2)] });
      assert.equal(rateLimited.status, 429);
      assert.match(rateLimited.body, /RATE_LIMIT/);
    } finally {
      await service.close();
    }
  });

  it("retains all batch admissions after timeout until every request handler replies", async () => {
    const entered = deferred();
    const releases = [deferred(), deferred()];
    let calls = 0;
    let completed = 0;
    const signals: AbortSignal[] = [];
    const service = await start({
      limits: { activeRequests: 2, requestTimeoutMs: 200 },
      createServer: () => {
        const server = new McpServer({ name: "batch-late", version: "1" });
        server.registerTool("wait", { inputSchema: {} }, async (_args, extra) => {
          const index = calls++;
          signals.push(extra.signal);
          if (calls === 2) entered.resolve();
          await releases[index].promise;
          completed++;
          return { content: [] };
        });
        return server;
      }
    });
    try {
      const pending = post(service.url, {
        message: [1, 2].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "wait", arguments: {} } }))
      });
      assert.equal(await Promise.race([entered.promise.then(() => "entered"), pending.then((reply) => reply.status)]), "entered");
      const result = await pending;
      assert.equal(result.status, 504);
      assert.equal(JSON.parse(result.body).error.data.outcomeUnknown, true);
      releases[0].resolve();
      await eventually(() => completed === 1);
      assert.equal(service.stats().activeRequests, 2);
      assert.equal(signals[1].aborted, false);
      assert.equal((await post(service.url)).status, 503);
      releases[1].resolve();
      await eventually(() => service.stats().activeRequests === 0);
      assert.equal(calls, 2);
      assert.equal((await post(service.url)).status, 200);
    } finally {
      releases.forEach((release) => release.resolve());
      await service.close();
    }
  });

  it("bounds aggregate batch results and serialization nodes while preserving every response ID", async () => {
    let calls = 0;
    const service = await start({
      limits: { resultBytes: 1200 },
      createServer: () => {
        const server = new McpServer({ name: "batch-results", version: "1" });
        server.registerTool("large", { inputSchema: {} }, async () => {
          calls++;
          return { content: [{ type: "text", text: "x".repeat(800) }] };
        });
        return server;
      }
    });
    try {
      const result = await post(service.url, {
        message: ["a", "b"].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "large", arguments: {} } }))
      });
      assert.equal(result.status, 200);
      assert.ok(Buffer.byteLength(result.body) <= 1200);
      const replies = JSON.parse(result.body);
      assert.deepEqual(
        replies.map((reply: { id: string }) => reply.id),
        ["a", "b"]
      );
      assert.ok(replies.every((reply: { error: { data: { code: string } } }) => reply.error.data.code === "MCP_HTTP_RESULT_TOO_LARGE"));
      assert.equal(calls, 2);
    } finally {
      await service.close();
    }
  });

  it("shares batch node budgets and reserves bounded error bytes before any handler runs", async () => {
    let calls = 0;
    const service = await start({
      limits: { resultBytes: 1024 * 1024 },
      createServer: () => {
        const server = new McpServer({ name: "batch-nodes", version: "1" });
        server.registerTool("nodes", { inputSchema: {} }, async () => {
          calls++;
          return { content: [], structuredContent: { values: Array(60000).fill(0) } };
        });
        return server;
      }
    });
    const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "nodes", arguments: {} } });
    try {
      const single = await post(service.url, { message: message(1) });
      assert.equal(JSON.parse(single.body).result.structuredContent.values.length, 60000);
      const batch = await post(service.url, { message: [message(1), message(2)] });
      assert.equal(batch.status, 200);
      assert.ok(JSON.parse(batch.body).every((reply: { error: { data: { code: string } } }) => reply.error.data.code === "MCP_HTTP_RESULT_TOO_LARGE"));
      assert.equal(calls, 3);
    } finally {
      await service.close();
    }
    const small = await start({
      limits: { resultBytes: 512 },
      createServer: () => {
        throw new Error("Over-budget requests must not create a protocol server");
      }
    });
    try {
      const rejected = await post(small.url, { message: [message(1), message(2)] });
      assert.equal(rejected.status, 413);
      assert.match(rejected.body, /BATCH_RESULT_BUDGET/);
    } finally {
      await small.close();
    }
    const notificationService = await start({ limits: { resultBytes: 512 } });
    try {
      const accepted = await post(notificationService.url, { message: [{ jsonrpc: "2.0", method: "notifications/initialized" }] });
      assert.equal(accepted.status, 202);
    } finally {
      await notificationService.close();
    }
  });

  it("refuses missing, inherited-permission, malformed and oversized credential files without exposing their contents", async () => {
    await assert.rejects(start({ tokenFile: join(directory, "missing.txt") }), /owner-only bridge token/);
    const inherited = join(directory, "inherited.txt");
    await writeFile(inherited, token);
    if (process.platform !== "win32") await chmod(inherited, 0o644);
    await assert.rejects(start({ tokenFile: inherited }), /owner-only bridge token/);
    for (const contents of ["secret-invalid-content", "a".repeat(129)]) {
      // The known-good fixture is restored in finally, even if the fail-closed assertion fails.
      await writeFile(tokenFile, contents);
      try {
        await assert.rejects(start(), (error) => error instanceof Error && /owner-only bridge token/.test(error.message) && !error.message.includes(contents));
      } finally {
        await writeFile(tokenFile, token);
      }
    }
  });

  it("rejects credentials, pins, browser origins, DNS aliases, routing and media ambiguity before dispatch", async () => {
    let created = 0;
    const service = await start({
      createServer: () => {
        created++;
        return createMcpServer({ unity: fakeUnity() });
      }
    });
    try {
      const cases: Array<[Record<string, string | undefined>, number, string, string?, string?]> = [
        [{ Authorization: undefined }, 401, "UNAUTHORIZED"],
        [{ Authorization: "Bearer wrong" }, 401, "UNAUTHORIZED"],
        [{ "X-Ghost-Project-Id": undefined }, 403, "IDENTITY_MISMATCH"],
        [{ "X-Ghost-Project-Id": "other" }, 403, "IDENTITY_MISMATCH"],
        [{ "X-Ghost-Editor-Id": undefined }, 403, "IDENTITY_MISMATCH"],
        [{ "X-Ghost-Editor-Id": "other" }, 403, "IDENTITY_MISMATCH"],
        [{ Origin: "null" }, 403, "ORIGIN_FORBIDDEN"],
        [{ Origin: "http://127.0.0.1" }, 403, "ORIGIN_FORBIDDEN"],
        [{ Host: "localhost:8080" }, 403, "HOST_FORBIDDEN"],
        [{ Host: "attacker.invalid" }, 403, "HOST_FORBIDDEN"],
        [{}, 404, "PATH_NOT_FOUND", "/mcp?x=1"],
        [{}, 404, "PATH_NOT_FOUND", "/mcp/"],
        [{}, 405, "METHOD_NOT_ALLOWED", "/mcp", "GET"],
        [{}, 405, "METHOD_NOT_ALLOWED", "/mcp", "DELETE"],
        [{}, 405, "METHOD_NOT_ALLOWED", "/mcp", "OPTIONS"],
        [{ "Content-Type": "text/plain" }, 415, "CONTENT_TYPE"],
        [{ "Content-Type": "application/json; charset=latin1" }, 415, "CONTENT_TYPE"],
        [{ "Content-Encoding": "gzip" }, 415, "CONTENT_ENCODING"],
        [{ "Mcp-Session-Id": "unexpected" }, 400, "STATELESS_ONLY"],
        [{ "MCP-Protocol-Version": "2026-07-28" }, 400, "UNSUPPORTED_PROTOCOL_VERSION"]
      ];
      for (const [changes, status, code, path, method] of cases) {
        const result = await post(service.url, { headers: changes, path, method });
        assert.equal(result.status, status, code);
        assert.match(result.body, new RegExp(code));
        assert.equal(result.body.includes(token), false);
        assert.equal(result.headers["access-control-allow-origin"], undefined);
      }
      assert.equal(created, 0);
      const duplicate = await raw(
        service.url,
        `POST /mcp HTTP/1.1\r\nHost: ${new URL(service.url).host}\r\nAuthorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\nContent-Length: 0\r\n\r\n`
      );
      assert.match(duplicate, /400/);
      assert.match(duplicate, /DUPLICATE_HEADER/);
      assert.equal(created, 0);
    } finally {
      await service.close();
    }
  });

  it("limits fragmented/chunked and declared bodies, rejects malformed UTF-8/JSON, and bounds slow readers", async () => {
    const service = await start({ limits: { bodyBytes: 512, bodyTimeoutMs: 100, requestTimeoutMs: 1500 } });
    try {
      const valid = await post(service.url, { chunks: [Buffer.from('{"jsonrpc":"2.0",'), Buffer.from('"id":"fragment","method":"ping"}')] });
      assert.equal(valid.status, 200);
      assert.equal(JSON.parse(valid.body).id, "fragment");
      for (const bytes of [Buffer.from('{"broken":'), Buffer.from([0xc3, 0x28]), Buffer.from("[]"), Buffer.from('{"jsonrpc":"1.0","id":1,"method":"ping"}')]) {
        const failed = await post(service.url, { chunks: [bytes] });
        assert.equal(failed.status, 400);
      }
      assert.equal((await post(service.url, { chunks: [Buffer.alloc(300, 32), Buffer.alloc(300, 32)] })).status, 413);
      assert.equal((await post(service.url, { headers: { "Content-Length": "1000" }, chunks: [] })).status, 413);
      const slow = await post(service.url, { chunks: [Buffer.from('{"jsonrpc":')], noEnd: true });
      assert.equal(slow.status, 408);
      assert.match(slow.body, /BODY_TIMEOUT/);
      const tooDeep = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: JSON.parse("[".repeat(70) + "0" + "]".repeat(70)) });
      assert.equal((await post(service.url, { chunks: [Buffer.from(tooDeep)] })).status, 400);
      await eventually(() => service.stats().activeRequests === 0 && service.stats().connections === 0);
    } finally {
      await service.close();
    }
  });

  it("preserves JSON-RPC parse and envelope codes in typed HTTP 400 failures", async () => {
    const service = await start();
    try {
      for (const [body, code] of [
        ["{", -32700],
        ['{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600],
        ["[]", -32600]
      ] as const) {
        const result = await post(service.url, { chunks: [Buffer.from(body)] });
        assert.equal(result.status, 400);
        const error = JSON.parse(result.body).error;
        assert.equal(error.code, code);
        assert.equal(error.data.outcomeUnknown, false);
        assert.equal(error.data.retrySafe, false);
      }
      const denied = await post(service.url, { headers: { Authorization: undefined } });
      assert.equal(JSON.parse(denied.body).error.code, -32000);
      const deep = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: JSON.parse("[".repeat(70) + "0" + "]".repeat(70)) });
      const complexity = await post(service.url, { chunks: [Buffer.from(deep)] });
      assert.equal(complexity.status, 400);
      assert.equal(JSON.parse(complexity.body).error.code, -32000);
      assert.match(complexity.body, /JSON_COMPLEXITY_LIMIT/);
    } finally {
      await service.close();
    }
  });

  it("does not charge missing or wrong credentials against authenticated quota", async () => {
    const service = await start({ limits: { requestsPerWindow: 2 } });
    try {
      for (let index = 0; index < 6; index++) {
        assert.equal((await post(service.url, { headers: { Authorization: index % 2 ? "Bearer wrong" : undefined } })).status, 401);
      }
      assert.equal((await post(service.url)).status, 200);
      assert.equal((await post(service.url)).status, 200);
      assert.equal((await post(service.url)).status, 429);
    } finally {
      await service.close();
    }
  });

  it("destroys pending real socket output at its absolute deadline after handler admission is released", async () => {
    let heldResponse: ServerResponse | undefined;
    let calls = 0;
    let handlerComplete = false;
    let prematureAborts = 0;
    let finished = false;
    let outputCallbackHeld = false;
    const service = await start({
      limits: { resultBytes: 8 * 1024 * 1024, requestTimeoutMs: 300, connections: 1 },
      httpServerFactory: (options, listener) => {
        const server = createHttpServer(options, listener);
        server.on("request", (request, response) => {
          if (request.headers["x-test-backpressure"] === "hold") {
            heldResponse = response;
            response.once("finish", () => {
              finished = true;
            });
            // Route and write the real SDK response, but hold native write completion
            // at the TCP boundary to model backpressure independently of OS buffering.
            const socket = request.socket;
            const write = socket._write.bind(socket);
            const writev = socket._writev?.bind(socket);
            socket._write = (chunk, encoding) =>
              write(chunk, encoding, () => {
                outputCallbackHeld = true;
              });
            if (writev)
              socket._writev = (chunks) =>
                writev(chunks, () => {
                  outputCallbackHeld = true;
                });
          }
        });
        return server;
      },
      createServer: () => {
        const server = new McpServer({ name: "delivery-backpressure", version: "1" });
        server.registerTool("large", { inputSchema: {} }, async (_args, extra) => {
          calls++;
          extra.signal.addEventListener("abort", () => {
            if (!handlerComplete) prematureAborts++;
          });
          handlerComplete = true;
          return { content: [{ type: "text", text: "x".repeat(6 * 1024 * 1024) }] };
        });
        return server;
      }
    });
    const address = new URL(service.url);
    const reader = connect(Number(address.port), "127.0.0.1");
    reader.on("error", () => {});
    reader.pause();
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: "held", method: "tools/call", params: { name: "large", arguments: {} } });
      const head = Object.entries(requestHeaders({ "X-Test-Backpressure": "hold" }))
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      reader.write(`POST /mcp HTTP/1.1\r\nHost: ${address.host}\r\n${head}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      await eventually(() => handlerComplete && service.stats().activeRequests === 0 && outputCallbackHeld);
      assert.equal(heldResponse?.writableEnded, true);
      assert.equal(heldResponse.writableFinished, false);
      assert.ok(heldResponse.socket!.writableLength > 6 * 1024 * 1024);
      assert.equal(service.stats().connections, 1);
      const deadline = Date.now() + 1200;
      while (service.stats().connections && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(service.stats().connections, 0, "queued socket output was not destroyed at the absolute deadline");
      assert.equal(heldResponse.destroyed, true);
      assert.equal(finished, false, "an incomplete response must never be marked delivered");
      assert.equal(prematureAborts, 0);
      assert.equal(calls, 1);
      assert.equal((await post(service.url)).status, 200);
    } finally {
      await service.close();
      reader.destroy();
    }
  });

  it("bounds a real paused raw TCP reader and serves later callers without cancelling or replaying", async () => {
    let calls = 0;
    let dispatchedAt = 0;
    let completed = false;
    let prematureAborts = 0;
    const service = await start({
      limits: { resultBytes: 16 * 1024 * 1024, requestTimeoutMs: 500, connections: 1 },
      createServer: () => {
        const server = new McpServer({ name: "paused-reader", version: "1" });
        server.registerTool("large", { inputSchema: {} }, async (_args, extra) => {
          calls++;
          dispatchedAt = Date.now();
          extra.signal.addEventListener("abort", () => {
            if (!completed) prematureAborts++;
          });
          const content = [{ type: "text" as const, text: "x".repeat(12 * 1024 * 1024) }];
          completed = true;
          return { content };
        });
        return server;
      }
    });
    const address = new URL(service.url);
    let stopReader: (() => Promise<void>) | undefined;
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: "paused", method: "tools/call", params: { name: "large", arguments: {} } });
      const consumed = await post(service.url, { chunks: [Buffer.from(body)] });
      assert.ok(Buffer.byteLength(consumed.body) > 12 * 1024 * 1024, consumed.body.slice(0, 500));
      calls = 0;
      completed = false;
      await eventually(() => service.stats().connections === 0);
      const head = Object.entries(requestHeaders())
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      stopReader = await pausedRaw(
        service.url,
        `POST /mcp HTTP/1.1\r\nHost: ${address.host}\r\n${head}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      await eventually(() => completed && service.stats().activeRequests === 0);
      // Windows may flush this entire response into kernel buffers even though the
      // client never reads. The separate held-write test proves actual backpressure.
      await eventually(() => service.stats().connections === 0);
      assert.ok(Date.now() - dispatchedAt < 2500, "delivery must not retain the connection beyond its absolute deadline");
      assert.equal(prematureAborts, 0);
      assert.equal(calls, 1);
      assert.equal((await post(service.url)).status, 200);
      const stopped = stopReader();
      assert.ok(stopped instanceof Promise, "reader cleanup must expose observed completion");
      assert.equal(stopReader(), stopped, "repeated cleanup must share the same completion");
      await stopped;
    } finally {
      await stopReader?.();
      await service.close();
    }
  });

  it("releases an aborted body and enforces an absolute deadline even for trickled headers", async () => {
    const service = await start({ limits: { bodyTimeoutMs: 120, requestTimeoutMs: 1000 } });
    try {
      const request = httpRequest(service.url, { method: "POST", headers: requestHeaders() });
      request.on("error", () => {});
      request.write('{"jsonrpc":');
      await eventually(() => service.stats().activeRequests === 1);
      request.destroy();
      await eventually(() => service.stats().activeRequests === 0 && service.stats().connections === 0);
      const socket = connect(Number(new URL(service.url).port), "127.0.0.1");
      socket.on("error", () => {});
      const startTime = Date.now();
      const trickle = setInterval(() => socket.write("x"), 30);
      try {
        socket.write("POST /mcp HTTP/1.1\r\nX-Slow: ");
        await new Promise<void>((resolve) => socket.once("close", () => resolve()));
        assert.ok(Date.now() - startTime < 1500);
      } finally {
        clearInterval(trickle);
        socket.destroy();
      }
      await eventually(() => service.stats().connections === 0);
    } finally {
      await service.close();
    }
  });

  it("checks elapsed deadlines after synchronous setup before dispatching a mutation", async () => {
    let called = false;
    const service = await start({
      limits: { requestTimeoutMs: 20 },
      createServer: () => {
        const until = Date.now() + 40;
        while (Date.now() < until) {
          /* Deliberately block the timer to prove the absolute deadline check. */
        }
        const server = new McpServer({ name: "setup", version: "1" });
        server.registerTool("mutate", { inputSchema: {} }, async () => {
          called = true;
          return { content: [] };
        });
        return server;
      }
    });
    try {
      const result = await post(service.url, {
        message: { jsonrpc: "2.0", id: "not-started", method: "tools/call", params: { name: "mutate", arguments: {} } }
      });
      assert.equal(result.status, 504);
      assert.equal(JSON.parse(result.body).error.data.outcomeUnknown, false);
      assert.equal(called, false);
      await eventually(() => service.stats().activeRequests === 0);
    } finally {
      await service.close();
    }
  });

  it("bounds headers, connections, rate and caller-supplied limit overrides", async () => {
    const limited = await start({ limits: { requestsPerWindow: 2, rateWindowMs: 1000, connections: 2, headerBytes: 1024 } });
    try {
      assert.equal((await post(limited.url)).status, 200);
      assert.equal((await post(limited.url)).status, 200);
      assert.equal((await post(limited.url)).status, 429);
      const oversized = await raw(limited.url, `POST /mcp HTTP/1.1\r\nHost: ${new URL(limited.url).host}\r\nX-Large: ${"x".repeat(2048)}\r\n\r\n`);
      assert.match(oversized, /400/);
      await eventually(() => limited.stats().connections === 0);
      const url = new URL(limited.url);
      const sockets = [connect(Number(url.port), "127.0.0.1"), connect(Number(url.port), "127.0.0.1")];
      try {
        await eventually(() => limited.stats().connections === 2);
        const third = connect(Number(url.port), "127.0.0.1");
        third.on("error", () => {});
        await new Promise<void>((resolve) => third.once("close", () => resolve()));
        assert.equal(limited.stats().connections, 2);
      } finally {
        sockets.forEach((socket) => socket.destroy());
      }
    } finally {
      await limited.close();
    }
    await assert.rejects(start({ limits: { bodyBytes: 3 * 1024 * 1024 } }), /Invalid MCP HTTP limit/);
    await assert.rejects(start({ host: "0.0.0.0" as "127.0.0.1" }), /literal loopback/);
  });

  it("returns typed bounded results without leaking or replaying completed handlers", async () => {
    let calls = 0;
    const service = await start({
      limits: { resultBytes: 1024 },
      createServer: () => {
        const server = new McpServer({ name: "large-result", version: "1" });
        server.registerTool("large", { inputSchema: {} }, async () => {
          calls++;
          return { content: [{ type: "text", text: "x".repeat(3000) }] };
        });
        return server;
      }
    });
    try {
      const result = await post(service.url, { message: { jsonrpc: "2.0", id: "large-id", method: "tools/call", params: { name: "large", arguments: {} } } });
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.id, "large-id");
      assert.equal(parsed.error.data.code, "MCP_HTTP_RESULT_TOO_LARGE");
      assert.equal(parsed.error.data.outcomeUnknown, true);
      assert.ok(Buffer.byteLength(result.body) < 1024);
      assert.equal(calls, 1);
      await eventually(() => service.stats().activeRequests === 0);
    } finally {
      await service.close();
    }
  });

  it("keeps timed-out mutations admitted until actual completion, does not cancel or replay, and cannot publish late success", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const service = await start({
      limits: { requestTimeoutMs: 200, activeRequests: 1 },
      createServer: () => {
        const server = new McpServer({ name: "late", version: "1" });
        server.registerTool("late", { inputSchema: {} }, async (_args, extra) => {
          calls++;
          signal = extra.signal;
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "late success" }] };
        });
        return server;
      }
    });
    try {
      const pending = post(service.url, { message: { jsonrpc: "2.0", id: "late-id", method: "tools/call", params: { name: "late", arguments: {} } } });
      await entered.promise;
      const result = await pending;
      assert.equal(result.status, 504);
      assert.equal(JSON.parse(result.body).error.data.outcomeUnknown, true);
      assert.equal(JSON.parse(result.body).id, "late-id");
      assert.equal(signal?.aborted, false);
      assert.equal(service.stats().activeRequests, 1);
      assert.equal((await post(service.url)).status, 503);
      release.resolve();
      await eventually(() => service.stats().activeRequests === 0);
      assert.equal(calls, 1);
      assert.equal(result.body.includes("late success"), false);
      assert.equal((await post(service.url)).status, 200);
    } finally {
      release.resolve();
      await service.close();
    }
  });

  it("treats client disconnect as unknown delivery, not implicit cancellation", async () => {
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    const service = await start({
      createServer: () => {
        const server = new McpServer({ name: "disconnect", version: "1" });
        server.registerTool("wait", { inputSchema: {} }, async (_args, extra) => {
          signal = extra.signal;
          entered.resolve();
          await release.promise;
          return { content: [] };
        });
        return server;
      }
    });
    const request = httpRequest(service.url, { method: "POST", headers: requestHeaders() });
    request.on("error", () => {});
    try {
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "wait", arguments: {} } }));
      await entered.promise;
      request.destroy();
      await eventually(() => service.stats().connections === 0);
      assert.equal(signal?.aborted, false);
      assert.equal(service.stats().activeRequests, 1);
      release.resolve();
      await eventually(() => service.stats().activeRequests === 0);
      assert.deepEqual(await service.close(), { unfinishedRequests: 0, outcomeUnknown: false });
      assert.deepEqual(await service.close(), { unfinishedRequests: 0, outcomeUnknown: false });
    } finally {
      request.destroy();
      release.resolve();
      await service.close();
    }
  });

  it("closes sockets and reports unknown in-flight work on idempotent shutdown", async () => {
    const entered = deferred();
    const release = deferred();
    const service = await start({
      createServer: () => {
        const server = new McpServer({ name: "shutdown", version: "1" });
        server.registerTool("wait", { inputSchema: {} }, async () => {
          entered.resolve();
          await release.promise;
          return { content: [] };
        });
        return server;
      }
    });
    const pending = post(service.url, { message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait", arguments: {} } } }).catch(
      () => undefined
    );
    try {
      await entered.promise;
      const first = service.close();
      assert.equal(first, service.close());
      assert.deepEqual(await first, { unfinishedRequests: 1, outcomeUnknown: true });
      let drained = false;
      const draining = service.drain().then(() => {
        drained = true;
      });
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false, "socket closure must not stand in for handler completion");
      release.resolve();
      await draining;
      assert.equal(service.stats().activeRequests, 0);
    } finally {
      release.resolve();
      await service.close();
    }
  });

  it("exposes the actual post-listen fatal error and closes admission", async () => {
    let listener!: ReturnType<typeof createHttpServer>;
    const service = await start({ httpServerFactory: (options, handler) => (listener = createHttpServer(options, handler)) });
    const failure = new Error("listener failed with a credential that must not be logged");
    try {
      listener.emit("error", failure);
      assert.equal(await service.fatalError, failure);
      assert.equal(service.stats().closing, true);
      await service.close();
      await service.drain();
      assert.equal(service.stats().activeRequests, 0);
    } finally {
      await service.close();
    }
  });

  for (const timing of ["throw", "bind-error"] as const) {
    it(`cleans up partial listener startup on ${timing}`, async (context) => {
      let listener!: ReturnType<typeof createHttpServer>;
      let initialListeners: ReturnType<typeof listener.listeners>;
      const occupied = createHttpServer();
      await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      const address = occupied.address();
      assert.ok(address && typeof address !== "string");
      try {
        await assert.rejects(
          start({
            port: address.port,
            httpServerFactory: (options, handler) => {
              listener = createHttpServer(options, handler);
              initialListeners = listener.listeners("listening");
              if (timing === "throw")
                context.mock.method(listener, "listen", () => {
                  throw new Error("secret listen failure");
                });
              return listener;
            }
          }),
          /MCP HTTP listener could not bind/
        );
        assert.equal(listener.listening, false);
        assert.deepEqual(listener.listeners("listening"), initialListeners!);
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
    });
  }

  it("releases admission and reports protocol cleanup failures without an unhandled rejection", async () => {
    const failure = new Error("secret protocol cleanup failure");
    const service = await start({
      createServer: () => {
        const protocol = new McpServer({ name: "cleanup-failure", version: "1" });
        const close = protocol.close.bind(protocol);
        protocol.close = async () => {
          await close();
          throw failure;
        };
        return protocol;
      }
    });
    try {
      await post(service.url).catch(() => undefined);
      assert.equal(await service.fatalError, failure);
      await service.close();
      await assert.rejects(service.drain(), /MCP_HTTP_DRAIN_FAILED/);
      assert.equal(service.stats().activeRequests, 0);
      assert.equal(service.stats().connections, 0);
    } finally {
      await service.close();
    }
  });

  it("preserves a socket-close failure while actual handler admission can still drain", async (context) => {
    let listener!: ReturnType<typeof createHttpServer>;
    const service = await start({ httpServerFactory: (options, handler) => (listener = createHttpServer(options, handler)) });
    const failure = new Error("secret listener close failure");
    const close = listener.close.bind(listener);
    context.mock.method(listener, "close", (callback?: (error?: Error) => void) => close(() => callback?.(failure)));
    try {
      assert.equal((await post(service.url)).status, 200);
      await assert.rejects(service.close(), (error) => error === failure);
      await service.drain();
      assert.equal(service.stats().activeRequests, 0);
      await eventually(() => service.stats().connections === 0);
    } finally {
      await service.close().catch(() => undefined);
    }
  });

  it("shares scenario orchestration state across independent request servers without disposing Unity", async () => {
    const unity = fakeUnity();
    let disposed = 0;
    unity.dispose = () => {
      disposed++;
    };
    const scenarios = new ScenarioJobManager({ unity, projectPath: directory, projectId: "project-http", editorInstanceId: "editor-http" });
    const operationId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const seen: string[] = [];
    scenarios.get = async (id) => {
      seen.push(`get:${id}`);
      return { ok: true, status: seen.some((item) => item.startsWith("cancel:")) ? "cancelling" : "running" };
    };
    scenarios.cancel = async (id) => {
      seen.push(`cancel:${id}`);
      return { ok: true, status: "cancelling" };
    };
    const service = await start({ createServer: () => createMcpServer({ unity, scenarios, toolProfiles: ["core"] }) });
    try {
      for (const name of ["operation_get", "operation_cancel", "operation_get"]) {
        const result = await post(service.url, {
          message: { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { operationId, kind: "scenario" } } }
        });
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(result.body).result.isError, undefined, result.body);
      }
      assert.deepEqual(seen, [`get:${operationId}`, `cancel:${operationId}`, `get:${operationId}`]);
      assert.equal(disposed, 0);
    } finally {
      await service.close();
    }
    assert.equal(disposed, 0);
  });

  it("crosses SDK client, Ghost tool routing and an actual mock Unity HTTP bridge with request identity intact", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const bridge = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString());
      observed.push(message);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ok: false,
            error: { code: "BRIDGE_DENIED", message: "Fixture bridge denied mutation" },
            projectId: "project-http",
            editorInstanceId: "editor-http"
          }
        })
      );
    });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const address = bridge.address();
    assert.ok(address && typeof address !== "string");
    const unity = new UnityClient({
      host: "127.0.0.1",
      port: address.port,
      projectId: "project-http",
      editorInstanceId: "editor-http",
      tokenFile,
      requestTimeoutMs: 2000
    });
    const service = await start({ createServer: () => createMcpServer({ unity, toolProfiles: ["all"] }) });
    const client = new Client({ name: "http-bridge-proof", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers } }));
      const result = await client.callTool({
        name: "script_write",
        arguments: { path: "Assets/Test.cs", content: "public class Test {}", requestId: "write-public-id", idempotencyKey: "write-public-key" }
      });
      assert.equal(result.isError, true);
      const content = result.structuredContent;
      assert.ok(content && typeof content === "object" && "error" in content && "requestId" in content);
      assert.ok(content.error && typeof content.error === "object" && "code" in content.error);
      assert.equal(content.error.code, "BRIDGE_DENIED");
      assert.equal(content.requestId, "write-public-id");
      assert.equal(observed.length, 1);
      assert.equal(observed[0].id, "write-public-id");
      assert.equal((observed[0].params as Record<string, unknown>).idempotencyKey, "write-public-key");
    } finally {
      await client.close();
      await service.close();
      unity.dispose();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });
});

class ShutdownScenarioUnity {
  readonly restoring = deferred();
  readonly allowRestore = deferred();
  readonly mutated = Buffer.from("public class Changed {}");
  readonly backupPath: string;
  readonly originalEditor = { scene: "Assets/Original.unity", selected: ["OriginalObject"], play: "paused" };
  editor = structuredClone(this.originalEditor);
  disposed = 0;
  cancelled = 0;
  callsAfterDispose = 0;
  applyCount = 0;
  restoreCount = 0;
  generation = 0;
  constructor(
    readonly sourcePath: string,
    readonly original: Buffer
  ) {
    this.backupPath = `${sourcePath}.backup`;
  }
  dispose(): void {
    this.disposed++;
  }
  async request(method: string, params: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.disposed) {
      this.callsAfterDispose++;
      throw new Error("Unity disposed before restoration completed");
    }
    const values = params as Record<string, unknown>;
    const aborted = () => {
      this.cancelled++;
    };
    options.signal?.addEventListener("abort", aborted);
    try {
      switch (method) {
        case "health":
          return { ok: true, unityVersion: "2022.3.62f1" };
        case "editor.snapshot":
          return {
            ok: true,
            playMode: { state: this.editor.play, transitionGeneration: this.generation },
            dirtyScenes: [],
            fixtureEditor: structuredClone(this.editor)
          };
        case "editor.restore_snapshot":
          this.editor = structuredClone((values.snapshot as { fixtureEditor: ShutdownScenarioUnity["editor"] }).fixtureEditor);
          return { ok: true, restored: true };
        case "scene.open":
          this.editor.scene = String(values.path);
          this.editor.selected = [];
          return { ok: true };
        case "play_mode.set":
          this.editor.play = String(values.state);
          this.generation++;
          return { ok: true, requestedState: this.editor.play, transitionGeneration: this.generation };
        case "play_mode.get":
          return { ok: true, state: this.editor.play, transitionGeneration: this.generation };
        case "console.mark":
          return { ok: true, boundary: "shutdown-case" };
        case "scenario.source_apply":
          this.applyCount++;
          await writeFile(this.backupPath, await readFile(this.sourcePath));
          await writeFile(this.sourcePath, this.mutated);
          return {
            ok: true,
            transactionId: values.transactionId,
            requestedCompileGeneration: ++this.generation,
            receipts: [{ path: "Assets/Fixture.cs", beforeSha256: hash(this.original), afterSha256: hash(this.mutated), backupPath: this.backupPath }]
          };
        case "scenario.source_restore":
          this.restoreCount++;
          this.restoring.resolve();
          await this.allowRestore.promise;
          if (this.disposed) {
            this.callsAfterDispose++;
            throw new Error("Unity disposed during source restoration");
          }
          await writeFile(this.sourcePath, await readFile(this.backupPath));
          return {
            ok: true,
            requestedCompileGeneration: ++this.generation,
            outcomes: [{ ok: true, path: "Assets/Fixture.cs", restoredSha256: hash(this.original) }]
          };
        case "scenario.source_complete":
          await rm(this.backupPath);
          return { ok: true, completed: true };
        case "script.read":
          return { ok: true, sha256: hash(await readFile(this.sourcePath)) };
        case "compile.status_get":
          return { ok: true, status: "success", requestedCompileGeneration: this.generation, diagnostics: [] };
        default:
          throw new Error(`Unexpected fixture request ${method}`);
      }
    } finally {
      options.signal?.removeEventListener("abort", aborted);
    }
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function start(overrides: Partial<StreamableHttpOptions> = {}) {
  return startStreamableHttp({
    host: "127.0.0.1",
    port: 0,
    projectId: "project-http",
    editorInstanceId: "editor-http",
    tokenFile,
    createServer: () => createMcpServer({ unity: fakeUnity(), toolProfiles: ["core"] }),
    ...overrides
  });
}

function requestHeaders(changes: Record<string, string | undefined> = {}): Record<string, string> {
  const result: Record<string, string | undefined> = {
    ...headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...changes
  };
  return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function post(
  url: string,
  options: { headers?: Record<string, string | undefined>; path?: string; method?: string; message?: unknown; chunks?: Buffer[]; noEnd?: boolean } = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: options.method ?? "POST", path: options.path ?? "/mcp", headers: requestHeaders(options.headers) },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          request.destroy();
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers });
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(5000, () => request.destroy(new Error("Test HTTP observation timed out")));
    request.once("error", reject);
    for (const chunk of options.chunks ??
      (options.method && options.method !== "POST" ? [] : [Buffer.from(JSON.stringify(options.message ?? { jsonrpc: "2.0", id: 1, method: "ping" }))]))
      request.write(chunk);
    if (!options.noEnd) request.end();
  });
}

async function raw(url: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(url).port), "127.0.0.1", () => socket.write(payload));
    let output = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("Test raw HTTP observation timed out")));
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(output));
  });
}

async function pausedRaw(url: string, payload: string): Promise<() => Promise<void>> {
  const port = Number(new URL(url).port);
  if (process.platform !== "win32") {
    const socket = connect(port, "127.0.0.1");
    const ignoreError = () => {};
    socket.on("error", ignoreError);
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        socket.removeListener("error", ignoreError);
        resolve();
      });
    });
    socket.pause();
    socket.write(payload);
    return () => {
      socket.destroy();
      return closed;
    };
  }
  // Windows loopback can buffer the entire result despite Node pause(). Set a real
  // TCP receive-window bound before connecting, then never call Receive/read.
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$ErrorActionPreference = "Stop"; $s = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp); $s.ReceiveBufferSize = 1024; try { $s.Connect("127.0.0.1", [int]$env:GHOST_HTTP_TEST_PORT); $b = [System.Text.Encoding]::UTF8.GetBytes($env:GHOST_HTTP_TEST_REQUEST); $offset = 0; while ($offset -lt $b.Length) { $offset += $s.Send($b, $offset, $b.Length - $offset, [System.Net.Sockets.SocketFlags]::None) }; [Console]::WriteLine("paused"); [System.Threading.Thread]::Sleep(10000) } finally { $s.Dispose() }'
    ],
    { windowsHide: true, env: { ...process.env, GHOST_HTTP_TEST_PORT: String(port), GHOST_HTTP_TEST_REQUEST: payload } }
  );
  let observedExit = false;
  const onExit = () => {
    observedExit = true;
  };
  // Keep process errors handled after readiness too; setup errors still reject below.
  const ignoreError = () => {};
  child.on("error", ignoreError);
  child.once("exit", onExit);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      child.removeListener("exit", onExit);
      child.removeListener("error", ignoreError);
      resolve();
    });
  });
  let stopPromise: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopPromise ??= (async () => {
      try {
        if (child.pid !== undefined && !observedExit) child.kill();
      } finally {
        // close follows this exact child's exit and the closure of its stdio pipes.
        // Failed spawn has no PID or exit event, but still closes its owned resources.
        await closed;
      }
      assert.ok(child.pid === undefined || observedExit, "reader cleanup must observe the owned child's exit");
    })();
    return stopPromise;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Paused raw reader did not connect")), 5000);
      function cleanup(): void {
        clearTimeout(timer);
        child.removeListener("error", fail);
        child.removeListener("exit", exitedBeforeReady);
        child.stdout.removeListener("data", ready);
      }
      function fail(error: Error): void {
        cleanup();
        reject(error);
      }
      function exitedBeforeReady(code: number | null): void {
        fail(new Error(`Paused raw reader exited: ${code}`));
      }
      function ready(): void {
        cleanup();
        resolve();
      }
      child.once("error", fail);
      child.once("exit", exitedBeforeReady);
      child.stdout.once("data", ready);
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition not observed before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeUnity(): UnityClient {
  return {
    endpoint: "ws://127.0.0.1:6400/unity-mcp-ghost/",
    isConnected: async () => true,
    request: async () => ({ ok: false, error: { code: "MOCK_SOFT_FAILURE", message: "Fixture failure" } })
  } as unknown as UnityClient;
}
