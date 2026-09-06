import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "./config.js";
import { UnityClient } from "./unity/UnityClient.js";
import { encodeQueueRequest } from "./unity/queueRequestEnvelope.js";

// Live, read-only health probes against the repository fixture. Rejected packets
// may remain in its ignored deadletter directory as security evidence.
const config = readConfig(process.argv.slice(2));
const fixture = resolve("test-project");
assert.equal(config.unityProjectPath, fixture, "Queue smoke requires the repository test-project.");
const queueRoot = join(fixture, "Library", "UnityMcpGhost", "queue");
assert.equal(config.unityQueueDir, queueRoot, "Queue smoke must use the selected fixture's queue.");
const token = (await readFile(config.unityTokenFile, "utf8")).trim().toLowerCase();
assert.ok(/^[0-9a-f]{64}$/.test(token), "Queue smoke token is missing or invalid.");
const checks: { name: string; ok: boolean; observed: unknown }[] = [];
const client = new UnityClient({
  host: "127.0.0.1",
  // Port zero cannot identify a listening bridge: exercise the actual fallback.
  port: 0,
  webSocketPort: 0,
  queueDir: queueRoot,
  projectId: config.unityProjectId,
  editorInstanceId: config.unityEditorInstanceId,
  tokenFile: config.unityTokenFile,
  requestTimeoutMs: 30000
});

try {
  const result = await client.request<Record<string, unknown>>("health");
  assert.equal(result.ok, true);
  assert.equal(result.projectId, config.unityProjectId);
  assert.equal(result.editorInstanceId, config.unityEditorInstanceId);
  checks.push({ name: "actual UnityClient queue fallback", ok: true, observed: { ok: result.ok } });

  const valid = request();
  const response = await exchange(valid.id, encodeQueueRequest(JSON.stringify(valid), token));
  assert.equal(response.id, valid.id);
  assert.equal(response.result?.ok, true);
  assert.equal(response.result?.projectId, config.unityProjectId);
  assert.equal(response.result?.editorInstanceId, config.unityEditorInstanceId);
  checks.push({ name: "signed raw queue health and exact response identity", ok: true, observed: { ok: true } });

  for (const field of ["params", "idempotent", "idempotencyKey", "projectId", "editorInstanceId"] as const) {
    const original = request();
    const envelope = JSON.parse(encodeQueueRequest(JSON.stringify(original), token)) as { requestJson: string };
    const changed = JSON.parse(envelope.requestJson) as Record<string, unknown>;
    changed[field] = field === "params" ? { dryRun: false, content: "tampered", nested: { value: "changed" } } : field === "idempotent" ? false : "changed";
    envelope.requestJson = JSON.stringify(changed);
    const rejected = await exchange(original.id, JSON.stringify(envelope));
    assert.equal(rejected.error?.data?.code, "AUTHENTICATION_FAILED", `Tampered ${field} was not rejected before execution.`);
    assert.equal(rejected.result, undefined);
    checks.push({ name: `tampered ${field}`, ok: true, observed: { code: rejected.error.data.code } });
  }

  const legacy = request();
  const rejected = await exchange(legacy.id, JSON.stringify(legacy));
  assert.equal(rejected.error?.data?.code, "QUEUE_PROOF_VERSION_UNSUPPORTED");
  assert.equal(rejected.result, undefined);
  checks.push({ name: "legacy queue request rejected", ok: true, observed: { code: rejected.error.data.code } });
  process.stdout.write(`${JSON.stringify({ ok: true, projectId: config.unityProjectId, editorInstanceId: config.unityEditorInstanceId, checks }, null, 2)}\n`);
} finally {
  client.dispose();
}

function request() {
  const id = randomUUID();
  return {
    jsonrpc: "2.0",
    id,
    requestId: id,
    method: "health",
    params: { dryRun: true, content: "fixture", nested: { value: "original" } },
    idempotencyKey: id,
    idempotent: true,
    deadlineUnixMs: Date.now() + 30000,
    projectId: config.unityProjectId,
    editorInstanceId: config.unityEditorInstanceId
  };
}

interface QueueResponse {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { data?: { code?: unknown } };
}

async function exchange(id: string, body: string): Promise<QueueResponse> {
  const key = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24);
  const pending = join(queueRoot, "pending", `${key}.json`);
  const temporary = `${pending}.${randomUUID()}.tmp`;
  const result = join(queueRoot, "results", `${key}.json`);
  const signal = AbortSignal.timeout(30000);
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", signal });
    await rename(temporary, pending);
    while (!signal.aborted) {
      const value = await readBoundedResult(result);
      if (value !== undefined) return value;
      await delay(100, undefined, { signal });
    }
    throw new Error("Queue smoke timed out without a receipt.");
  } finally {
    // These names belong to this probe alone. Never remove active claims or
    // recovery material, and never delete an entire queue directory.
    await Promise.all([temporary, pending, result].map((path) => rm(path, { force: true })));
  }
}

async function readBoundedResult(path: string): Promise<QueueResponse | undefined> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    assert.ok(length <= 65536, "Queue health receipt exceeded the smoke's 64 KiB bound.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))) as QueueResponse;
  } finally {
    await file.close();
  }
}
