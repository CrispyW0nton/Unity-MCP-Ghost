import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UnityClient, UnityRequestTimeoutError } from "../src/unity/UnityClient.js";

describe("UnityClient durable request semantics", () => {
  it("sends correlation, deadline, and idempotency metadata", async () => {
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
      const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 1000 });
      const result = await client.request<Record<string, unknown>>("health", {}, { requestId: "request-123" });

      assert.equal(observed.id, "request-123");
      assert.equal(observed.requestId, "request-123");
      assert.equal(observed.idempotencyKey, "request-123");
      assert.equal(observed.idempotent, true);
      assert.equal(typeof observed.deadlineUnixMs, "number");
      assert.equal(result.requestId, "request-123");
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
      const client = new UnityClient({ host: "127.0.0.1", port, requestTimeoutMs: 30 });
      await assert.rejects(
        client.request("script.write", { path: "Assets/Test.cs", content: "" }, { requestId: "mutation-timeout" }),
        (error: unknown) => {
          assert.ok(error instanceof UnityRequestTimeoutError);
          assert.equal(error.requestId, "mutation-timeout");
          assert.equal(error.outcomeUnknown, true);
          assert.equal(error.code, "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN");
          return true;
        }
      );
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  it("removes an unclaimed queue item on timeout and reports a known non-execution", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "unity-mcp-client-"));
    try {
      const client = new UnityClient({ host: "127.0.0.1", port: 1, queueDir, requestTimeoutMs: 100 });
      await assert.rejects(client.request("script.write", { path: "Assets/Test.cs", content: "" }, { requestId: "queued-timeout" }), (error: unknown) => {
        assert.ok(error instanceof UnityRequestTimeoutError);
        assert.equal(error.outcomeUnknown, false);
        return true;
      });
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });
});

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
