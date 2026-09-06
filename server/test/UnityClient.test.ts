import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { UnityClient, UnityCommandError, UnityRequestTimeoutError } from "../src/unity/UnityClient.js";
import { MAX_QUEUE_REQUEST_BYTES } from "../src/unity/queueRequestEnvelope.js";

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
      assert.equal(observed.authProof, undefined);
      assert.equal(observed.authProofVersion, undefined);
      assert.equal(observed.requestJson, undefined);
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

  it("disposes an owned fallback WebSocket and rejects pending and future requests", { timeout: 2000 }, async () => {
    const http = createServer((_request, response) => response.writeHead(503).end());
    const websocket = new WebSocketServer({ server: http });
    const port = await listen(http);
    const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 60000, ...secureOptions(tokenFile) });
    try {
      assert.equal(typeof client.dispose, "function");
      let received!: () => void;
      const observed = new Promise<void>((resolve) => {
        received = resolve;
      });
      let closed!: Promise<void>;
      let authorization = "";
      let payload: Record<string, unknown> = {};
      websocket.on("connection", (socket, request) => {
        authorization = request.headers.authorization ?? "";
        closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        socket.on("message", (message) => {
          payload = JSON.parse(message.toString()) as Record<string, unknown>;
          received();
        });
      });
      const pending = assert.rejects(client.request("health"), /cancelled|disposed/i);
      await observed;
      assert.equal(authorization, `Bearer ${token}`);
      assert.equal(payload.method, "health");
      assert.equal(payload.authProof, undefined);
      assert.equal(payload.authProofVersion, undefined);
      assert.equal(payload.requestJson, undefined);
      client.dispose();
      client.dispose();
      await pending;
      await closed;
      assert.equal(websocket.clients.size, 0);
      await assert.rejects(client.request("health"), /disposed/i);
      assert.equal(await client.isConnected(), false);
    } finally {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await close(http);
    }
  });

  it("disposes during HTTP work without opening a fallback connection", { timeout: 2000 }, async () => {
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const http = createServer(() => observed());
    const websocket = new WebSocketServer({ server: http });
    const port = await listen(http);
    const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 60000, ...secureOptions(tokenFile) });
    let connections = 0;
    websocket.on("connection", () => {
      connections += 1;
    });
    try {
      assert.equal(typeof client.dispose, "function");
      const pending = assert.rejects(client.request("health"), /cancelled|disposed/i);
      await started;
      client.dispose();
      await pending;
      assert.equal(connections, 0);
      await assert.rejects(client.request("health"), /disposed/i);
    } finally {
      http.closeAllConnections();
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await close(http);
    }
  });

  it("disposes a WebSocket while its opening handshake is pending", { timeout: 2000 }, async () => {
    const sockets = new Set<import("node:net").Socket>();
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let closed!: Promise<void>;
    const stalled = createTcpServer((socket) => {
      sockets.add(socket);
      closed = new Promise<void>((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        })
      );
      socket.once("data", () => observed());
    });
    const webSocketPort = await listenTcp(stalled);
    const client = new UnityClient({ host: "127.0.0.1", port: await closedPort(), webSocketPort, requestTimeoutMs: 60000, ...secureOptions(tokenFile) });
    try {
      const pending = assert.rejects(client.request("health"), /cancelled|disposed/i);
      await started;
      client.dispose();
      await pending;
      await closed;
      assert.equal(sockets.size, 0);
    } finally {
      client.dispose();
      for (const socket of sockets) socket.destroy();
      await closeTcp(stalled);
    }
  });

  it("removes an unclaimed queue item on timeout and reports a known non-execution", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "unity-mcp-client-"));
    const client = new UnityClient({ host: "127.0.0.1", port: 1, queueDir, requestTimeoutMs: 1000, ...secureOptions(tokenFile) });
    let rejection: Promise<void> | undefined;
    try {
      rejection = assert.rejects(client.request("script.write", { path: "Assets/Test.cs", content: "" }, { requestId: "queued-timeout" }), (error: unknown) => {
        assert.ok(error instanceof UnityRequestTimeoutError);
        assert.equal(error.outcomeUnknown, false);
        return true;
      });
      let pendingFiles: string[] = [];
      const deadline = Date.now() + 2000;
      while (pendingFiles.length === 0 && Date.now() < deadline) {
        pendingFiles = await readdir(join(queueDir, "pending")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        pendingFiles = pendingFiles.filter((file) => file.endsWith(".json"));
        if (pendingFiles.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(pendingFiles.length, 1);
      assert.match(pendingFiles[0], /^[0-9a-f]{24}\.json$/);
      const envelope = JSON.parse(await readFile(join(queueDir, "pending", pendingFiles[0]), "utf8"));
      assert.deepEqual(Object.keys(envelope), ["authProofVersion", "requestJson", "authProof"]);
      assert.equal(envelope.authProofVersion, 2);
      assert.equal(
        envelope.authProof,
        createHmac("sha256", token)
          .update("UnityMcpGhost.Queue.v2\0" + envelope.requestJson, "utf8")
          .digest("hex")
      );
      const inner = JSON.parse(envelope.requestJson);
      assert.deepEqual(inner.params, { path: "Assets/Test.cs", content: "" });
      assert.equal(inner.idempotent, false);
      assert.equal(inner.id, "queued-timeout");
      assert.equal(inner.authProof, undefined);
      await rejection;
      assert.deepEqual(await readdir(join(queueDir, "pending")), []);
    } finally {
      try {
        await rejection;
      } finally {
        client.dispose();
        await rm(queueDir, { recursive: true, force: true });
      }
    }
  });

  it("rejects oversized queue serialization before writing a pending file", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "unity-mcp-oversized-"));
    const client = new UnityClient({ host: "127.0.0.1", port: 1, queueDir, requestTimeoutMs: 1000, ...secureOptions(tokenFile) });
    try {
      await assert.rejects(client.request("health", { content: "é".repeat(MAX_QUEUE_REQUEST_BYTES / 2) }, { requestId: "oversized" }), {
        code: "REQUEST_TOO_LARGE",
        requestId: "oversized",
        projectId: "unity-project-test"
      });
      assert.deepEqual(await readdir(queueDir), []);
    } finally {
      client.dispose();
      await rm(queueDir, { recursive: true, force: true });
    }
  });

  for (const errorCode of [undefined, "AUTHENTICATION_FAILED"]) {
    it(`consumes a v2 queue ${errorCode ? "typed authentication error" : "successful result"} without replay`, async () => {
      const queueDir = await mkdtemp(join(tmpdir(), "unity-mcp-result-"));
      const client = new UnityClient({ host: "127.0.0.1", port: 1, queueDir, requestTimeoutMs: 2000, ...secureOptions(tokenFile) });
      const requestId = errorCode ? "queued-rejected" : "queued-success";
      const params = { dryRun: true, operations: [{ method: "health", params: { text: "雪🦊\n\t", nested: [1e-7, true, null] } }] };
      const settled = client.request("health", params, { requestId }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error })
      );
      try {
        let files: string[] = [];
        const deadline = Date.now() + 2000;
        while (files.length === 0 && Date.now() < deadline) {
          files = (await readdir(join(queueDir, "pending")).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
          if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(files.length, 1);
        const pendingPath = join(queueDir, "pending", files[0]);
        const raw = await readFile(pendingPath, "utf8");
        const envelope = JSON.parse(raw);
        const inner = JSON.parse(envelope.requestJson);
        assert.deepEqual(inner.params, params);
        assert.equal(
          envelope.authProof,
          createHmac("sha256", token)
            .update("UnityMcpGhost.Queue.v2\0" + envelope.requestJson, "utf8")
            .digest("hex")
        );
        assert.ok(!raw.includes(token));
        await rm(pendingPath);
        await writeFile(
          join(queueDir, "results", files[0]),
          JSON.stringify({
            jsonrpc: "2.0",
            id: errorCode ? null : inner.id,
            ...(errorCode
              ? { error: { code: -32010, message: "The durable queue request proof is missing or invalid.", data: { code: errorCode } } }
              : { result: { ok: true } })
          }),
          "utf8"
        );
        const outcome = await settled;
        if (errorCode) {
          assert.ok(outcome.error instanceof UnityCommandError);
          assert.equal(outcome.error.code, errorCode);
          assert.equal(outcome.error.requestId, requestId);
        } else {
          assert.equal(outcome.error, undefined);
          assert.deepEqual(outcome.result, { ok: true, requestId, projectId: "unity-project-test", editorInstanceId: "editor-test" });
        }
        assert.deepEqual(await readdir(join(queueDir, "pending")), []);
        assert.deepEqual(await readdir(join(queueDir, "results")), []);
      } finally {
        client.dispose();
        await settled;
        await rm(queueDir, { recursive: true, force: true });
      }
    });
  }
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
