import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { UnityClient, UnityRequestTimeoutError } from "../src/unity/UnityClient.js";

describe("UnityClient durable request semantics", () => {
  const token = "a".repeat(64);
  let tokenDirectory = "";
  let tokenFile = "";

  before(async () => {
    tokenDirectory = await mkdtemp(join(tmpdir(), "unity-mcp-token-"));
    tokenFile = join(tokenDirectory, "bridge-token.txt");
    await writeFile(tokenFile, token, "utf8");
  });

  after(async () => {
    await rm(tokenDirectory, { recursive: true, force: true });
  });

  it("sends correlation, deadline, and idempotency metadata", async () => {
    let observed: Record<string, unknown> = {};
    let authorization = "";
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: observed.id, result: { ok: true } }));
    });
    const port = await listen(server);
    try {
      const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 1000, ...secureOptions(tokenFile) });
      const result = await client.request<Record<string, unknown>>("health", {}, { requestId: "request-123" });

      assert.equal(observed.id, "request-123");
      assert.equal(observed.requestId, "request-123");
      assert.equal(observed.idempotencyKey, "request-123");
      assert.equal(observed.idempotent, true);
      assert.equal(typeof observed.deadlineUnixMs, "number");
      assert.equal(observed.projectId, "unity-project-test");
      assert.equal(observed.editorInstanceId, "editor-test");
      assert.equal(authorization, `Bearer ${token}`);
      const expectedProof = createHmac("sha256", token)
        .update(`request-123\nhealth\n${observed.deadlineUnixMs}\nrequest-123\nunity-project-test\neditor-test`, "utf8")
        .digest("hex");
      assert.equal(observed.authProof, expectedProof);
      assert.equal(result.requestId, "request-123");
    } finally {
      await close(server);
    }
  });

  it("declares durable scenario restoration replay-safe", async () => {
    let observed: Record<string, unknown> = {};
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: observed.id, result: { ok: true } }));
    });
    const port = await listen(server);
    try {
      const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 1000, ...secureOptions(tokenFile) });
      await client.request("scenario.source_restore", { transactionId: "scenario:case" }, { requestId: "restore-request" });

      assert.equal(observed.idempotent, true);
    } finally {
      await close(server);
    }
  });

  it("reports a transport timeout as outcome unknown", async () => {
    const server = createServer(() => {
      // Intentionally leave the response pending past the request deadline.
    });
    const port = await listen(server);
    try {
      const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 30, ...secureOptions(tokenFile) });
      await assert.rejects(client.request("script.write", { path: "Assets/Test.cs", content: "" }, { requestId: "mutation-timeout" }), (error: unknown) => {
        assert.ok(error instanceof UnityRequestTimeoutError);
        assert.equal(error.requestId, "mutation-timeout");
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.code, "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN");
        return true;
      });
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  it("bounds a stalled WebSocket opening handshake", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const stalled = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Accept TCP and intentionally never answer the WebSocket upgrade.
    });
    const webSocketPort = await listenTcp(stalled);
    const closedHttpPort = await closedPort();
    try {
      const client = new UnityClient({ host: "127.0.0.1", port: closedHttpPort, webSocketPort, requestTimeoutMs: 75, ...secureOptions(tokenFile) });
      const started = Date.now();
      await assert.rejects(client.request("health", {}, { requestId: "stalled-handshake" }));
      assert.ok(Date.now() - started < 1000, "WebSocket opening handshake must honor the request timeout");
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeTcp(stalled);
    }
  });

  it("treats a malformed token as disconnected", async () => {
    const malformed = join(tokenDirectory, "malformed-token.txt");
    await writeFile(malformed, "not-a-token", "utf8");
    const client = new UnityClient({ host: "127.0.0.1", port: 1, requestTimeoutMs: 50, ...secureOptions(malformed) });

    assert.equal(await client.isConnected(), false);
  });

  it("removes an unclaimed queue item on timeout and reports a known non-execution", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "unity-mcp-client-"));
    try {
      const client = new UnityClient({ host: "127.0.0.1", port: 1, queueDir, requestTimeoutMs: 100, ...secureOptions(tokenFile) });
      const rejection = assert.rejects(
        client.request("script.write", { path: "Assets/Test.cs", content: "" }, { requestId: "queued-timeout" }),
        (error: unknown) => {
          assert.ok(error instanceof UnityRequestTimeoutError);
          assert.equal(error.outcomeUnknown, false);
          return true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      const pendingFiles = await readdir(join(queueDir, "pending"));
      assert.equal(pendingFiles.length, 1);
      assert.match(pendingFiles[0], /^[0-9a-f]{24}\.json$/);
      await rejection;
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });
});

function secureOptions(tokenFile: string): { projectId: string; editorInstanceId: string; tokenFile: string } {
  return { projectId: "unity-project-test", editorInstanceId: "editor-test", tokenFile };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function listenTcp(server: ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test server did not bind.");
  return address.port;
}

async function closeTcp(server: ReturnType<typeof createTcpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listenTcp(server);
  await closeTcp(server);
  return port;
}
