import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { encodeQueueRequest, MAX_QUEUE_ENVELOPE_BYTES, MAX_QUEUE_REQUEST_BYTES, QueueRequestEnvelopeError } from "../src/unity/queueRequestEnvelope.js";

const token = "0123456789abcdef".repeat(4);

describe("queue request v2 envelope", () => {
  it("matches the shared public C# known-answer vector byte for byte", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("../../Packages/com.crispywonton.unity-mcp-ghost/Tests/Editor/Fixtures/queue-request-v2.json", import.meta.url), "utf8")
    ) as { token: string; requestJson: string; authProof: string };
    const envelope = JSON.parse(encodeQueueRequest(fixture.requestJson, fixture.token));

    assert.deepEqual(Object.keys(envelope), ["authProofVersion", "requestJson", "authProof"]);
    assert.equal(envelope.authProofVersion, 2);
    assert.equal(envelope.requestJson, fixture.requestJson);
    assert.equal(envelope.authProof, fixture.authProof);
    assert.ok(Object.is(JSON.parse(fixture.requestJson).params.negativeZero, -0));
    assert.equal(JSON.parse(fixture.requestJson).params.scientific, 1250);
    assert.equal(JSON.parse(fixture.requestJson).params.operations[0].params.nested.values[3], 1e-7);
    assert.notEqual(JSON.parse(encodeQueueRequest(JSON.stringify(JSON.parse(fixture.requestJson)), fixture.token)).authProof, fixture.authProof);
  });

  it("authenticates all metadata and nested parameter bytes with the domain-separated ASCII token key", () => {
    const request = {
      jsonrpc: "2.0",
      id: "request",
      requestId: "request",
      method: "health",
      deadlineUnixMs: 2000000000000,
      idempotencyKey: "request-key",
      idempotent: true,
      projectId: "project",
      editorInstanceId: "editor",
      params: { dryRun: true, path: "Assets/雪.txt", content: "original", operations: [{ method: "health", params: { nested: ["original"] } }] }
    };
    const original = JSON.stringify(request);
    const envelope = JSON.parse(encodeQueueRequest(original, token));
    assert.equal(
      envelope.authProof,
      createHmac("sha256", Buffer.from(token, "ascii"))
        .update("UnityMcpGhost.Queue.v2\0" + original, "utf8")
        .digest("hex")
    );
    assert.notEqual(
      envelope.authProof,
      createHmac("sha256", Buffer.from(token, "hex"))
        .update("UnityMcpGhost.Queue.v2\0" + original, "utf8")
        .digest("hex")
    );
    assert.notEqual(envelope.authProof, createHmac("sha256", token).update(original, "utf8").digest("hex"));

    const changedRequests: unknown[] = [
      ...["jsonrpc", "id", "requestId", "method", "idempotencyKey", "projectId", "editorInstanceId"].map((field) => ({ ...request, [field]: "changed" })),
      { ...request, deadlineUnixMs: request.deadlineUnixMs + 1 },
      { ...request, idempotent: false },
      { ...request, params: { ...request.params, dryRun: false } },
      { ...request, params: { ...request.params, path: "Assets/Changed.txt" } },
      { ...request, params: { ...request.params, content: "changed" } },
      { ...request, params: { ...request.params, operations: [{ method: "health", params: { nested: ["changed"] } }] } }
    ];
    for (const changed of changedRequests) {
      assert.notEqual(JSON.parse(encodeQueueRequest(JSON.stringify(changed), token)).authProof, envelope.authProof);
    }
    assert.notEqual(JSON.parse(encodeQueueRequest(original + " ", token)).authProof, envelope.authProof);
    assert.ok(!encodeQueueRequest(original, token).includes(token));
  });

  it("rejects missing and malformed token values without exposing them", () => {
    for (const invalid of [undefined, null, "", "secret-that-must-not-be-echoed", "a".repeat(63), "A".repeat(64)]) {
      assert.throws(
        () => encodeQueueRequest("{}", invalid as string),
        (error: unknown) => {
          assert.ok(error instanceof QueueRequestEnvelopeError);
          assert.equal(error.code, "AUTHENTICATION_FAILED");
          assert.ok(!error.message.includes("secret-that-must-not-be-echoed"));
          return true;
        }
      );
    }
  });

  it("accepts exact UTF-8 inner boundaries and rejects one byte over", () => {
    const request = '"' + "é".repeat((MAX_QUEUE_REQUEST_BYTES - 2) / 2) + '"';
    assert.equal(Buffer.byteLength(request), MAX_QUEUE_REQUEST_BYTES);
    assert.equal(JSON.parse(encodeQueueRequest(request, token)).requestJson, request);
    assert.throws(() => encodeQueueRequest(request + " ", token), { code: "REQUEST_TOO_LARGE" });
  });

  it("bounds the worst-case outer escaping expansion", () => {
    // The codec authenticates text before the receiver's semantic JSON parser.
    const request = "\0".repeat(MAX_QUEUE_REQUEST_BYTES);
    const envelope = encodeQueueRequest(request, token);
    assert.equal(JSON.parse(envelope).requestJson, request);
    assert.ok(Buffer.byteLength(envelope) > 6 * MAX_QUEUE_REQUEST_BYTES);
    assert.ok(Buffer.byteLength(envelope) <= MAX_QUEUE_ENVELOPE_BYTES);
  });

  it("rejects unpaired UTF-16 surrogates instead of signing replacement UTF-8 bytes", () => {
    for (const invalid of ["\ud800", "\udc00", "before\ud800after"]) {
      assert.throws(() => encodeQueueRequest(invalid, token), { code: "INVALID_UTF8" });
    }
    assert.equal(JSON.parse(encodeQueueRequest('"🦊"', token)).requestJson, '"🦊"');
  });
});
