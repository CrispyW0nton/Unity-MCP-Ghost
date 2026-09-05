import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { readConfig } from "./config.js";

interface Check {
  name: string;
  ok: boolean;
  observed: unknown;
}

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const token = (await readFile(config.unityTokenFile, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error("Bridge token file is malformed.");
  const url = `http://${config.unityHost}:${config.unityPort}/unity-mcp-ghost/`;
  const websocketUrl = `ws://${config.unityHost}:${config.unityWebSocketPort}/unity-mcp-ghost/`;
  const checks: Check[] = [];

  await statusCheck(checks, "HTTP missing token", 401, () => post(url, payload(config, "health"), {}));
  await statusCheck(checks, "HTTP wrong token", 401, () => post(url, payload(config, "health"), { authorization: "Bearer wrong" }));
  await statusCheck(checks, "HTTP browser Origin", 403, () =>
    post(url, payload(config, "health"), { authorization: `Bearer ${token}`, origin: "https://example.invalid" })
  );
  await jsonErrorCheck(checks, "HTTP wrong project", "PROJECT_ID_MISMATCH", () =>
    post(url, payload(config, "health", { projectId: "unity-project-wrong" }), { authorization: `Bearer ${token}` })
  );
  await jsonErrorCheck(checks, "HTTP wrong editor", "EDITOR_INSTANCE_ID_MISMATCH", () =>
    post(url, payload(config, "health", { editorInstanceId: "editor-wrong" }), { authorization: `Bearer ${token}` })
  );
  await jsonErrorCheck(checks, "destructive capability default deny", "DESTRUCTIVE_CAPABILITY_DISABLED", () =>
    post(url, payload(config, "asset.delete", { params: { path: "Assets/GhostSecuritySmoke.asset", dryRun: false }, idempotent: false }), {
      authorization: `Bearer ${token}`
    })
  );
  await jsonErrorCheck(checks, "package/network capability default deny", "PACKAGE_NETWORK_CAPABILITY_DISABLED", () =>
    post(url, payload(config, "package.search", { params: { query: "input" }, idempotent: false }), { authorization: `Bearer ${token}` })
  );
  await resultCheck(checks, "HTTP valid pinned health", config.unityProjectId, config.unityEditorInstanceId, () =>
    post(url, payload(config, "health"), { authorization: `Bearer ${token}` })
  );

  await websocketStatusCheck(checks, "WebSocket missing token", websocketUrl, {}, 401);
  await websocketStatusCheck(checks, "WebSocket browser Origin", websocketUrl, { authorization: `Bearer ${token}`, origin: "https://example.invalid" }, 403);
  await websocketSuccessCheck(checks, websocketUrl, token, payload(config, "health"), config.unityProjectId, config.unityEditorInstanceId);
  await websocketOversizeCheck(checks, websocketUrl, token);

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, endpoint: url, checks }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

function payload(
  config: ReturnType<typeof readConfig>,
  method: string,
  overrides: { projectId?: string; editorInstanceId?: string; params?: unknown; idempotent?: boolean } = {}
): Record<string, unknown> {
  const id = randomUUID();
  return {
    jsonrpc: "2.0",
    id,
    requestId: id,
    method,
    params: overrides.params ?? {},
    deadlineUnixMs: Date.now() + 10000,
    idempotencyKey: id,
    idempotent: overrides.idempotent ?? true,
    projectId: overrides.projectId ?? config.unityProjectId,
    editorInstanceId: overrides.editorInstanceId ?? config.unityEditorInstanceId
  };
}

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function statusCheck(checks: Check[], name: string, expected: number, run: () => Promise<Response>): Promise<void> {
  const response = await run();
  checks.push({ name, ok: response.status === expected, observed: { status: response.status } });
  await response.text();
}

async function jsonErrorCheck(checks: Check[], name: string, expectedCode: string, run: () => Promise<Response>): Promise<void> {
  const response = await run();
  const text = await response.text();
  let body: { error?: { data?: { code?: unknown } } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`${name} returned non-JSON status ${response.status}: ${text.slice(0, 160)}`);
  }
  const code = body.error?.data?.code;
  checks.push({ name, ok: response.status === 200 && code === expectedCode, observed: { status: response.status, code } });
}

async function resultCheck(checks: Check[], name: string, projectId: string, editorInstanceId: string, run: () => Promise<Response>): Promise<void> {
  const response = await run();
  const text = await response.text();
  let body: { result?: { ok?: unknown; projectId?: unknown; editorInstanceId?: unknown } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`${name} returned non-JSON status ${response.status}: ${text.slice(0, 160)}`);
  }
  checks.push({
    name,
    ok: response.status === 200 && body.result?.ok === true && body.result.projectId === projectId && body.result.editorInstanceId === editorInstanceId,
    observed: { status: response.status, ok: body.result?.ok, projectId: body.result?.projectId, editorInstanceId: body.result?.editorInstanceId }
  });
}

async function websocketStatusCheck(checks: Check[], name: string, url: string, headers: Record<string, string>, expectedStatus: number): Promise<void> {
  const observed = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${name} timed out.`));
    }, 5000);
    socket.once("unexpected-response", (_request, response: IncomingMessage) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      resolve(101);
    });
    socket.once("error", () => {
      // unexpected-response carries the status and is the assertion signal.
    });
  });
  checks.push({ name, ok: observed === expectedStatus, observed: { status: observed } });
}

async function websocketSuccessCheck(
  checks: Check[],
  url: string,
  token: string,
  request: Record<string, unknown>,
  projectId: string,
  editorInstanceId: string
): Promise<void> {
  const observed = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Valid WebSocket request timed out."));
    }, 5000);
    socket.once("open", () => {
      const serialized = JSON.stringify(request);
      const split = Math.floor(serialized.length / 2);
      socket.send(serialized.slice(0, split), { fin: false });
      socket.send(serialized.slice(split), { fin: true });
    });
    socket.once("message", (data) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once("error", reject);
  });
  const result = observed.result as Record<string, unknown> | undefined;
  checks.push({
    name: "WebSocket fragmented pinned health",
    ok: result?.ok === true && result.projectId === projectId && result.editorInstanceId === editorInstanceId,
    observed: { ok: result?.ok, projectId: result?.projectId, editorInstanceId: result?.editorInstanceId }
  });
}

async function websocketOversizeCheck(checks: Check[], url: string, token: string): Promise<void> {
  const observed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Oversized WebSocket request timed out."));
    }, 5000);
    socket.once("open", () => socket.send("x".repeat(1024 * 1024 + 1)));
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
    socket.once("error", reject);
  });
  checks.push({ name: "WebSocket oversized message", ok: observed.code === 1009, observed });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
