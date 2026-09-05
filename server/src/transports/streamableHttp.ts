import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server, type ServerOptions, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  JSONRPCMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";

const mcpHttpHeaders = { projectId: "x-ghost-project-id", editorInstanceId: "x-ghost-editor-id" } as const;

export interface McpHttpLimits {
  headerBytes: number;
  bodyBytes: number;
  resultBytes: number;
  bodyTimeoutMs: number;
  requestTimeoutMs: number;
  connections: number;
  activeRequests: number;
  requestsPerWindow: number;
  rateWindowMs: number;
}

const hardLimits: McpHttpLimits = {
  headerBytes: 32768,
  bodyBytes: 2 * 1024 * 1024,
  resultBytes: 16 * 1024 * 1024,
  bodyTimeoutMs: 10000,
  requestTimeoutMs: 3600000,
  connections: 64,
  activeRequests: 16,
  requestsPerWindow: 600,
  rateWindowMs: 60000
};
const defaultLimits: McpHttpLimits = {
  headerBytes: 16384,
  bodyBytes: 1024 * 1024,
  resultBytes: 8 * 1024 * 1024,
  bodyTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  connections: 32,
  activeRequests: 8,
  requestsPerWindow: 120,
  rateWindowMs: 60000
};

export interface StreamableHttpOptions {
  host: "127.0.0.1" | "::1";
  /** Zero is allowed for embedded/test callers; the public CLI requires 1024..65535. */
  port: number;
  tokenFile: string;
  projectId: string;
  editorInstanceId: string;
  createServer: () => McpServer;
  /** Optional embedding/test seam; the factory must return an unbound Node HTTP server. */
  httpServerFactory?: (options: ServerOptions, listener: RequestListener) => Server;
  limits?: Partial<McpHttpLimits>;
}

export interface StreamableHttpService {
  url: string;
  stats(): { connections: number; activeRequests: number; closing: boolean };
  /** Closes HTTP resources, not Unity jobs. In-flight mutations can have unknown outcomes. */
  close(): Promise<{ unfinishedRequests: number; outcomeUnknown: boolean }>;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly rpcCode = -32000
  ) {
    super(code);
  }
}

/** Private local-process transport for the installed SDK's protocol generations, not an OAuth host. */
export async function startStreamableHttp(options: StreamableHttpOptions): Promise<StreamableHttpService> {
  if (options.host !== "127.0.0.1" && options.host !== "::1") throw new Error("MCP HTTP requires a literal loopback address.");
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid MCP HTTP port.");
  for (const pin of [options.projectId, options.editorInstanceId]) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(pin)) throw new Error("Invalid MCP HTTP identity pin.");
  }
  const limits = { ...defaultLimits, ...options.limits };
  for (const key of Object.keys(hardLimits) as Array<keyof McpHttpLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > hardLimits[key]) throw new Error(`Invalid MCP HTTP limit: ${key}.`);
  }
  if (limits.headerBytes < 512 || limits.resultBytes < 512)
    throw new Error("MCP HTTP header/result limits must allow a bounded error receipt (at least 512 bytes).");
  if (limits.rateWindowMs < 1000) throw new Error("MCP HTTP rate windows must be at least 1000 milliseconds.");
  const credential = await readProtectedToken(options.tokenFile);
  const credentialHash = digest(`Bearer ${credential}`);
  const sockets = new Set<Socket>();
  const requestedSockets = new WeakSet<object>();
  const headerDeadlines = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  const active = new Set<{ stop(): void; dispatched: boolean }>();
  let admittedWork = 0;
  let closing = false;
  let closePromise: ReturnType<StreamableHttpService["close"]> | undefined;
  let windowStart = Date.now();
  let windowRequests = 0;
  let authority = "";
  const server = (options.httpServerFactory ?? createHttpServer)({ maxHeaderSize: limits.headerBytes, requireHostHeader: true }, (request, response) => {
    requestedSockets.add(request.socket);
    clearTimeout(headerDeadlines.get(request.socket));
    headerDeadlines.delete(request.socket);
    void handle(request, response);
  });
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = limits.bodyTimeoutMs;
  server.headersTimeout = limits.bodyTimeoutMs;
  server.keepAliveTimeout = 1;
  server.on("connection", (socket) => {
    if (closing || sockets.size >= limits.connections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const headerDeadline = setTimeout(() => socket.destroy(), limits.bodyTimeoutMs);
    headerDeadlines.set(socket, headerDeadline);
    socket.once("close", () => {
      sockets.delete(socket);
      clearTimeout(headerDeadline);
      headerDeadlines.delete(socket);
    });
    socket.setTimeout(Math.min(limits.bodyTimeoutMs, limits.requestTimeoutMs), () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => {
    // Never echo parser input or headers, including Authorization.
    if (socket.writable && !requestedSockets.has(socket)) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  server.on("checkContinue", (request, response) => {
    reject(request, response, new HttpFailure(417, "MCP_HTTP_EXPECT_UNSUPPORTED"));
  });
  server.on("checkExpectation", (request, response) => {
    reject(request, response, new HttpFailure(417, "MCP_HTTP_EXPECT_UNSUPPORTED"));
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, rejectListen) => {
    const failed = () => {
      server.removeListener("listening", ready);
      rejectListen(new Error("MCP HTTP listener could not bind."));
    };
    const ready = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP listener did not bind.");
  authority = `${options.host === "::1" ? "[::1]" : options.host}:${address.port}`;
  server.on("error", () => {
    void close();
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let id: string | number | null = null;
    let dispatched = false;
    let detached = false;
    let admission = 0;
    let finishedPromise: Promise<void> | undefined;
    const pendingReplies = new Set<string | number>();
    let protocolServer: McpServer | undefined;
    let sdk: WebStandardStreamableHTTPServerTransport | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expiresAt = Date.now() + limits.requestTimeoutMs;
    const stopped = new AbortController();
    const item = {
      get dispatched() {
        return dispatched;
      },
      stop: () => terminate("MCP_HTTP_SHUTDOWN", 503)
    };
    const disconnected = () => {
      delivered();
      if (!response.writableFinished) terminate("MCP_HTTP_DISCONNECTED", 499);
    };
    function delivered(): void {
      if (deadline) clearTimeout(deadline);
      response.removeListener("close", disconnected);
      response.removeListener("finish", delivered);
    }
    function terminate(code: string, status: number): void {
      if (detached) return;
      detached = true;
      if (!response.destroyed) {
        if (response.headersSent || response.writableEnded) response.destroy();
        else sendError(response, status, code, id, dispatched);
      }
      stopped.abort();
      // Close only the HTTP transport. Protocol close would implicitly abort the handler's signal.
      void sdk?.close();
      request.destroy();
    }
    function finished(): Promise<void> {
      finishedPromise ??= (async () => {
        await protocolServer?.close();
        active.delete(item);
        admittedWork -= admission;
      })();
      return finishedPromise;
    }
    function expired(): boolean {
      if (!detached && Date.now() >= expiresAt) terminate("MCP_HTTP_REQUEST_TIMEOUT", 504);
      return detached;
    }
    try {
      if (closing) throw new HttpFailure(503, "MCP_HTTP_SHUTDOWN");
      validateHeaders(request);
      if (Date.now() - windowStart >= limits.rateWindowMs) {
        windowStart = Date.now();
        windowRequests = 0;
      }
      if (++windowRequests > limits.requestsPerWindow) throw new HttpFailure(429, "MCP_HTTP_RATE_LIMIT");
      if (admittedWork >= limits.activeRequests) throw new HttpFailure(503, "MCP_HTTP_CONCURRENCY_LIMIT");
      active.add(item);
      admittedWork++;
      admission = 1;
      response.once("close", disconnected);
      response.once("finish", delivered);
      deadline = setTimeout(() => terminate("MCP_HTTP_REQUEST_TIMEOUT", 504), limits.requestTimeoutMs);
      request.socket.setTimeout(0);
      const parsed = await readBody(request, limits, stopped.signal);
      if (stopped.signal.aborted) return;
      const protocol = request.headers["mcp-protocol-version"];
      if (typeof protocol === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) throw new HttpFailure(400, "MCP_HTTP_UNSUPPORTED_PROTOCOL_VERSION");
      const batch = Array.isArray(parsed);
      // https://modelcontextprotocol.io/specification/2025-06-18/changelog removes batching.
      // Missing version follows the SDK's legacy default (2025-03-26).
      if (batch && String(protocol ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION) >= "2025-06-18") throw new HttpFailure(400, "MCP_HTTP_BATCH_UNSUPPORTED");
      const entries: unknown[] = batch ? parsed : [parsed];
      if (!entries.length) throw new HttpFailure(400, "MCP_HTTP_INVALID_JSONRPC", -32600);
      if (admittedWork + entries.length - 1 > limits.activeRequests) throw new HttpFailure(503, "MCP_HTTP_CONCURRENCY_LIMIT");
      const messages: JSONRPCMessage[] = [];
      const requestIds = new Set<string | number>();
      for (const entry of entries) {
        const message = JSONRPCMessageSchema.safeParse(entry);
        if (!message.success) throw new HttpFailure(400, "MCP_HTTP_INVALID_JSONRPC", -32600);
        const value = message.data;
        if ("id" in value && Buffer.byteLength(JSON.stringify(value.id) ?? "") > 128) throw new HttpFailure(400, "MCP_HTTP_REQUEST_ID_LIMIT");
        if ("id" in value && value.id !== undefined) {
          if (requestIds.has(value.id)) throw new HttpFailure(400, "MCP_HTTP_DUPLICATE_REQUEST_ID", -32600);
          requestIds.add(value.id);
        }
        if ("method" in value && value.method === "notifications/cancelled") {
          // No session/request routing exists across stateless POSTs. Use durable operation_cancel instead.
          throw new HttpFailure(400, "MCP_HTTP_USE_OPERATION_CANCEL");
        }
        if (batch && "method" in value && value.method === "initialize") throw new HttpFailure(400, "MCP_HTTP_INITIALIZATION_BATCH", -32600);
        messages.push(value);
      }
      // The legacy transport permits request/notification batches or response batches, not mixtures.
      // https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
      if (batch && messages.some((value) => "method" in value) && messages.some((value) => !("method" in value)))
        throw new HttpFailure(400, "MCP_HTTP_INVALID_JSONRPC", -32600);
      const responseCount = messages.filter((value) => "method" in value && "id" in value).length;
      // Reserve array syntax and divide both serialization budgets across all replies before dispatch.
      // Every admitted response retains enough space for its own typed error and original ID.
      const resultShare = Math.floor((limits.resultBytes - (batch ? responseCount + 1 : 0)) / Math.max(1, responseCount));
      const nodeShare = Math.floor((100000 - (batch ? 1 : 0)) / Math.max(1, responseCount));
      if (responseCount && resultShare < 512) throw new HttpFailure(413, "MCP_HTTP_BATCH_RESULT_BUDGET");
      if (windowRequests + entries.length - 1 > limits.requestsPerWindow) throw new HttpFailure(429, "MCP_HTTP_RATE_LIMIT");
      windowRequests += entries.length - 1;
      admittedWork += entries.length - 1;
      admission = entries.length;
      const value = batch ? messages : messages[0];
      id = !batch && "id" in messages[0] ? (messages[0].id ?? null) : null;
      sdk = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const adapter: Transport = {
        start: async () => {
          await sdk!.start();
        },
        close: async () => {
          await sdk!.close();
          adapter.onclose?.();
        },
        send: async (outgoing, sendOptions) => {
          const terminal = "id" in outgoing && ("result" in outgoing || "error" in outgoing);
          try {
            if (!expired()) {
              let bounded: JSONRPCMessage;
              try {
                bounded = fitsJson(outgoing, resultShare, nodeShare)
                  ? outgoing
                  : rpcError("MCP_HTTP_RESULT_TOO_LARGE", "id" in outgoing ? (outgoing.id ?? null) : id, dispatched);
              } catch {
                bounded = rpcError("MCP_HTTP_RESULT_UNSERIALIZABLE", "id" in outgoing ? (outgoing.id ?? null) : id, dispatched);
              }
              await sdk!.send(bounded, sendOptions);
            }
          } finally {
            // A detached batch owns all its admission slots until the final request handler replies.
            if (terminal) {
              pendingReplies.delete(outgoing.id!);
              if (detached && pendingReplies.size === 0) await finished();
            }
          }
        }
      };
      sdk.onmessage = (incoming, extra) => {
        if ("method" in incoming && "id" in incoming) pendingReplies.add(incoming.id);
        adapter.onmessage?.(incoming, extra);
      };
      sdk.onerror = () => adapter.onerror?.(new Error("MCP HTTP protocol transport failed."));
      protocolServer = options.createServer();
      await protocolServer.connect(adapter);
      if (expired()) return;
      dispatched = messages.some((value) => "method" in value && "id" in value && value.method === "tools/call");
      // Authentication is consumed at the boundary; never forward its secret to SDK requestInfo/tool callbacks.
      const safeHeaders: Record<string, string> = { "content-type": "application/json", accept: String(request.headers.accept ?? "") };
      if (typeof protocol === "string") safeHeaders["mcp-protocol-version"] = protocol;
      const webRequest = new Request(`http://${authority}/mcp`, { method: "POST", headers: safeHeaders });
      const result = await raceAbort(sdk.handleRequest(webRequest, { parsedBody: value }), stopped.signal);
      if (!result || expired()) return;
      let body = Buffer.from(await result.arrayBuffer());
      // SDK JSON mode returns an object for one reply, including a one-request mixed batch.
      if (batch && responseCount === 1 && result.status === 200) body = Buffer.concat([Buffer.from("["), body, Buffer.from("]")]);
      if (expired()) return;
      if (body.length > limits.resultBytes) throw new HttpFailure(500, "MCP_HTTP_RESULT_TOO_LARGE");
      response.writeHead(result.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Connection: "close"
      });
      response.end(body);
    } catch (error) {
      if (!detached) {
        const failure = error instanceof HttpFailure ? error : new HttpFailure(500, "MCP_HTTP_INTERNAL_ERROR");
        reject(request, response, failure, id, dispatched);
      }
    } finally {
      if (!detached || pendingReplies.size === 0) await finished();
      // Timed-out/disconnected handlers keep the batch's admission slots until all actual replies.
      // There is no transport replay or Unity cancellation.
      // Delivery has an independent lifetime: response.end() can leave bytes queued on a slow socket.
      // Only finish/close clears its absolute deadline, even after all handler admissions are released.
    }
  }

  function validateHeaders(request: IncomingMessage): void {
    const counts = new Map<string, number>();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index].toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count !== 1)) throw new HttpFailure(400, "MCP_HTTP_DUPLICATE_HEADER");
    if (request.rawHeaders.length > 128) throw new HttpFailure(431, "MCP_HTTP_HEADER_LIMIT");
    if (counts.has("origin")) throw new HttpFailure(403, "MCP_HTTP_ORIGIN_FORBIDDEN");
    if (request.headers.host !== authority) throw new HttpFailure(403, "MCP_HTTP_HOST_FORBIDDEN");
    if (!timingSafeEqual(digest(String(request.headers.authorization ?? "")), credentialHash)) throw new HttpFailure(401, "MCP_HTTP_UNAUTHORIZED");
    if (request.headers[mcpHttpHeaders.projectId] !== options.projectId || request.headers[mcpHttpHeaders.editorInstanceId] !== options.editorInstanceId)
      throw new HttpFailure(403, "MCP_HTTP_IDENTITY_MISMATCH");
    if (request.url !== "/mcp") throw new HttpFailure(404, "MCP_HTTP_PATH_NOT_FOUND");
    if (request.method !== "POST") throw new HttpFailure(405, "MCP_HTTP_METHOD_NOT_ALLOWED");
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(String(request.headers["content-type"] ?? "")))
      throw new HttpFailure(415, "MCP_HTTP_CONTENT_TYPE");
    if (counts.has("content-encoding")) throw new HttpFailure(415, "MCP_HTTP_CONTENT_ENCODING");
    if (counts.has("mcp-session-id") || counts.has("last-event-id")) throw new HttpFailure(400, "MCP_HTTP_STATELESS_ONLY");
    if (counts.has("expect") || counts.has("trailer")) throw new HttpFailure(400, "MCP_HTTP_HEADER_UNSUPPORTED");
    if (request.headers["content-length"] && Number(request.headers["content-length"]) > limits.bodyBytes) throw new HttpFailure(413, "MCP_HTTP_BODY_LIMIT");
  }

  function close(): ReturnType<StreamableHttpService["close"]> {
    if (closePromise) return closePromise;
    closing = true;
    const unfinishedRequests = [...active].filter((item) => item.dispatched).length;
    for (const item of active) item.stop();
    closePromise = new Promise((resolve) => {
      server.close(() => resolve({ unfinishedRequests, outcomeUnknown: unfinishedRequests > 0 }));
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  }
  return { url: `http://${authority}/mcp`, stats: () => ({ connections: sockets.size, activeRequests: admittedWork, closing }), close };
}

function reject(request: IncomingMessage, response: ServerResponse, error: HttpFailure, id: string | number | null = null, unknown = false): void {
  sendError(response, error.status, error.code, id, unknown, error.rpcCode);
  response.once("finish", () => request.destroy());
}

function sendError(response: ServerResponse, status: number, code: string, id: string | number | null, unknown: boolean, rpcCode = -32000): void {
  if (response.destroyed || response.headersSent || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
    ...(status === 405 ? { Allow: "POST" } : {})
  });
  response.end(JSON.stringify(rpcError(code, id, unknown, rpcCode)));
}

function rpcError(code: string, id: string | number | null, outcomeUnknown: boolean, rpcCode = -32000): JSONRPCMessage {
  return { jsonrpc: "2.0", id, error: { code: rpcCode, message: code, data: { code, outcomeUnknown, retrySafe: false } } } as JSONRPCMessage;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function readProtectedToken(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw new Error("unsafe token file");
    if (process.platform === "win32") {
      const script =
        '$ErrorActionPreference = "Stop"; $a = [System.IO.File]::GetAccessControl($env:GHOST_MCP_HTTP_TOKEN_PATH); $u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $u -or !$a.AreAccessRulesProtected) { exit 1 }; foreach ($r in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Value -ne $u) { exit 1 } }';
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, GHOST_MCP_HTTP_TOKEN_PATH: path },
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024
      });
    } else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("unsafe token permissions");
    const file = await open(path, "r");
    try {
      const current = await file.stat();
      if (info.ino !== current.ino || info.dev !== current.dev || current.size > 128 || !current.isFile()) throw new Error("token changed");
      const buffer = Buffer.alloc(129);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 128) throw new Error("oversized token");
      const token = buffer.subarray(0, bytesRead).toString("utf8").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("malformed token");
      return token;
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("MCP HTTP requires an existing, valid, owner-only bridge token file.");
  }
}

async function readBody(request: IncomingMessage, limits: McpHttpLimits, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => fail(new HttpFailure(408, "MCP_HTTP_BODY_TIMEOUT")), limits.bodyTimeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("error", error);
      request.removeListener("aborted", aborted);
      signal.removeEventListener("abort", aborted);
    }
    function fail(reason: HttpFailure): void {
      cleanup();
      request.pause();
      rejectBody(reason);
    }
    function aborted(): void {
      fail(new HttpFailure(400, "MCP_HTTP_BODY_ABORTED"));
    }
    function error(): void {
      fail(new HttpFailure(400, "MCP_HTTP_BODY_ERROR"));
    }
    function data(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > limits.bodyBytes) {
        fail(new HttpFailure(413, "MCP_HTTP_BODY_LIMIT"));
        return;
      }
      chunks.push(chunk);
    }
    function end(): void {
      cleanup();
      try {
        if (Object.keys(request.trailers).length) throw new HttpFailure(400, "MCP_HTTP_HEADER_UNSUPPORTED");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!fitsJson(value, limits.bodyBytes)) throw new HttpFailure(400, "MCP_HTTP_JSON_COMPLEXITY_LIMIT");
        resolve(value);
      } catch (error) {
        rejectBody(error instanceof HttpFailure ? error : new HttpFailure(400, "MCP_HTTP_INVALID_JSON", -32700));
      }
    }
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    request.once("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Bounds serialization work/depth before the SDK allocates a serialized response. */
function fitsJson(value: unknown, limit: number, nodeLimit = 100000): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 64 || ++nodes > nodeLimit) return false;
    const current = entry.value;
    if (current !== null && typeof current === "object") {
      bytes += 2;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        if (Buffer.byteLength(key) > limit - bytes) return false;
        bytes += Array.isArray(current) ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
        if (bytes > limit || pending.length + nodes >= nodeLimit) return false;
        pending.push({ value: (current as Record<string, unknown>)[key], depth: entry.depth + 1 });
      }
    } else {
      if (typeof current === "string" && Buffer.byteLength(current) > limit - bytes) return false;
      const json = JSON.stringify(current);
      if (json !== undefined) bytes += Buffer.byteLength(json);
    }
    if (bytes > limit || pending.length + nodes > nodeLimit) return false;
  }
  return true;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let abort: () => void = () => {};
  const cancelled = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
