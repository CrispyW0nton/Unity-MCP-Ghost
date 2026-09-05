import { createHash, createHmac, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

export interface UnityRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface UnityRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
  requestId: string;
  idempotencyKey: string;
  idempotent: boolean;
  deadlineUnixMs: number;
  projectId: string;
  editorInstanceId: string;
  authProof: string;
}

export interface UnityClientOptions {
  host: string;
  port: number;
  webSocketPort?: number;
  queueDir?: string;
  requestTimeoutMs: number;
  projectId: string;
  editorInstanceId: string;
  tokenFile: string;
}

export interface UnityRequestOptions {
  requestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class UnityClient {
  private socket: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private token: string | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  public constructor(private readonly options: UnityClientOptions) {}

  public get endpoint(): string {
    return `ws://${this.options.host}:${this.options.webSocketPort ?? this.options.port}/unity-mcp-ghost/`;
  }

  public get httpEndpoint(): string {
    return `http://${this.options.host}:${this.options.port}/unity-mcp-ghost/`;
  }

  public get queueEndpoint(): string | undefined {
    return this.options.queueDir;
  }

  public async isConnected(): Promise<boolean> {
    const token = await this.readToken();
    const payload = createPayload("health", {}, randomUUID(), this.options.requestTimeoutMs, this.options.projectId, this.options.editorInstanceId, token);
    try {
      await this.requestViaHttp("health", payload, this.options.requestTimeoutMs, token);
      return true;
    } catch {
      return false;
    }
  }

  public async request<T = unknown>(method: string, params: unknown = {}, options: UnityRequestOptions = {}): Promise<T> {
    const id = options.requestId ?? readRequestId(params) ?? randomUUID();
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    const token = await this.readToken();
    const payload = createPayload(method, params, id, timeoutMs, this.options.projectId, this.options.editorInstanceId, token, options.idempotencyKey);

    try {
      return withRequestMetadata(
        await this.requestViaHttp<T>(method, payload, timeoutMs, token, options.signal),
        id,
        this.options.projectId,
        this.options.editorInstanceId
      );
    } catch (error) {
      if (error instanceof UnityCommandError || error instanceof UnityRequestTimeoutError) {
        throw annotateError(error, id, this.options.projectId, this.options.editorInstanceId);
      }

      try {
        const socket = await this.connect(token);
        return withRequestMetadata(
          await this.requestViaSocket<T>(socket, payload, method, timeoutMs, options.signal),
          id,
          this.options.projectId,
          this.options.editorInstanceId
        );
      } catch (socketError) {
        if (socketError instanceof UnityCommandError || socketError instanceof UnityRequestTimeoutError) {
          throw annotateError(socketError, id, this.options.projectId, this.options.editorInstanceId);
        }
        if (!this.options.queueDir) {
          throw annotateError(socketError, id, this.options.projectId, this.options.editorInstanceId);
        }
        try {
          return withRequestMetadata(
            await this.requestViaQueue<T>(payload, method, timeoutMs, options.signal),
            id,
            this.options.projectId,
            this.options.editorInstanceId
          );
        } catch (queueError) {
          throw annotateError(queueError, id, this.options.projectId, this.options.editorInstanceId);
        }
      }
    }
  }

  private async requestViaHttp<T>(method: string, payload: UnityRpcRequest, timeoutMs: number, token: string, signal?: AbortSignal): Promise<T> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    const abort = () => abortController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }

    try {
      const response = await fetch(this.httpEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: abortController.signal
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new UnityCommandError(
            `Unity bridge authentication failed (${response.status}).`,
            response.status,
            { code: "UNITY_BRIDGE_AUTHENTICATION_FAILED" },
            payload.id
          );
        }
        throw new Error(`Unity HTTP bridge responded ${response.status}: ${method}`);
      }
      return unwrapResponse<T>((await response.json()) as UnityRpcResponse<T>, payload.id);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new UnityRequestTimeoutError(
          timedOut ? `Unity HTTP request timed out: ${method}` : `Unity HTTP request was cancelled: ${method}`,
          payload.id,
          !payload.idempotent,
          timedOut
            ? payload.idempotent
              ? "UNITY_REQUEST_TIMEOUT"
              : "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN"
            : payload.idempotent
              ? "UNITY_REQUEST_CANCELLED"
              : "UNITY_REQUEST_CANCELLED_OUTCOME_UNKNOWN"
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private requestViaSocket<T>(socket: WebSocket, payload: UnityRpcRequest, method: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timeout);
        this.pending.delete(payload.id);
        reject(
          new UnityRequestTimeoutError(
            `Unity WebSocket request was cancelled: ${method}`,
            payload.id,
            !payload.idempotent,
            payload.idempotent ? "UNITY_REQUEST_CANCELLED" : "UNITY_REQUEST_CANCELLED_OUTCOME_UNKNOWN"
          )
        );
      };
      const timeout = setTimeout(() => {
        this.pending.delete(payload.id);
        signal?.removeEventListener("abort", cancel);
        reject(
          new UnityRequestTimeoutError(
            `Unity WebSocket request timed out: ${method}`,
            payload.id,
            !payload.idempotent,
            payload.idempotent ? "UNITY_REQUEST_TIMEOUT" : "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN"
          )
        );
      }, timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });

      this.pending.set(payload.id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", cancel);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", cancel);
          reject(error);
        },
        timeout
      });

      if (signal?.aborted) {
        cancel();
        return;
      }
      socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(payload.id);
        signal?.removeEventListener("abort", cancel);
        reject(error);
      });
    });
  }

  private async requestViaQueue<T>(payload: UnityRpcRequest, method: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const queueDir = this.options.queueDir;
    if (!queueDir) {
      throw new Error("Unity durable queue is not configured.");
    }

    const pendingDir = join(queueDir, "pending");
    const resultsDir = join(queueDir, "results");
    const cancellationDir = join(queueDir, "cancellations");
    await Promise.all([mkdir(pendingDir, { recursive: true }), mkdir(resultsDir, { recursive: true }), mkdir(cancellationDir, { recursive: true })]);
    const queueKey = createHash("sha256").update(payload.id, "utf8").digest("hex").slice(0, 24);
    const pendingPath = join(pendingDir, `${queueKey}.json`);
    const tempPath = `${pendingPath}.${randomUUID()}.tmp`;
    const resultPath = join(resultsDir, `${queueKey}.json`);

    await writeFile(tempPath, JSON.stringify(payload), "utf8");
    await rename(tempPath, pendingPath);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs && !signal?.aborted) {
      const response = await this.tryReadQueuedResponse<T>(resultPath);
      if (response.found) {
        await rm(resultPath, { force: true });
        return unwrapResponse(response.response, payload.id);
      }
      await delay(100);
    }

    const pendingRemoved = await removeIfPresent(pendingPath);
    if (!pendingRemoved) {
      await writeFile(
        join(cancellationDir, `${queueKey}.json`),
        JSON.stringify({ requestId: payload.id, idempotencyKey: payload.idempotencyKey, requestedAt: new Date().toISOString() }),
        "utf8"
      );
    }
    const lateResponse = await this.tryReadQueuedResponse<T>(resultPath);
    if (lateResponse.found) {
      await rm(resultPath, { force: true });
      return unwrapResponse(lateResponse.response, payload.id);
    }
    throw new UnityRequestTimeoutError(
      signal?.aborted ? `Unity durable queue request was cancelled: ${method}` : `Unity durable queue request timed out: ${method}`,
      payload.id,
      !pendingRemoved && !payload.idempotent,
      signal?.aborted
        ? !pendingRemoved && !payload.idempotent
          ? "UNITY_REQUEST_CANCELLED_OUTCOME_UNKNOWN"
          : "UNITY_REQUEST_CANCELLED"
        : !pendingRemoved && !payload.idempotent
          ? "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN"
          : "UNITY_REQUEST_TIMEOUT"
    );
  }

  private async tryReadQueuedResponse<T>(path: string): Promise<{ found: false } | { found: true; response: UnityRpcResponse<T> }> {
    try {
      return { found: true, response: JSON.parse(await readFile(path, "utf8")) as UnityRpcResponse<T> };
    } catch {
      return { found: false };
    }
  }

  private async connect(token: string): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.socket;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.socket?.terminate();
    const socket = new WebSocket(this.endpoint, { headers: { authorization: `Bearer ${token}` } });
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.rejectPending(new Error("Unity bridge connection closed."));
    });
    socket.on("error", (error) => this.rejectPending(error));

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private handleMessage(raw: string): void {
    let response: UnityRpcResponse;
    try {
      response = JSON.parse(raw) as UnityRpcResponse;
    } catch {
      return;
    }
    const id = String(response.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(id);
    try {
      pending.resolve(unwrapResponse(response, id));
    } catch (error) {
      pending.reject(error as Error);
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async readToken(): Promise<string> {
    if (this.token) return this.token;
    const value = (await readFile(this.options.tokenFile, "utf8")).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Unity bridge token file is malformed: ${this.options.tokenFile}`);
    }
    this.token = value;
    return value;
  }
}

function createPayload(
  method: string,
  params: unknown,
  id: string,
  timeoutMs: number,
  projectId: string,
  editorInstanceId: string,
  token: string,
  idempotencyKey?: string
): UnityRpcRequest {
  const payload: UnityRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params,
    requestId: id,
    idempotencyKey: idempotencyKey ?? id,
    idempotent: isReplaySafe(method, params),
    deadlineUnixMs: Date.now() + timeoutMs,
    projectId,
    editorInstanceId,
    authProof: ""
  };
  payload.authProof = createHmac("sha256", token)
    .update(`${payload.id}\n${payload.method}\n${payload.deadlineUnixMs}\n${payload.idempotencyKey}\n${payload.projectId}\n${payload.editorInstanceId}`, "utf8")
    .digest("hex");
  return payload;
}

function unwrapResponse<T>(response: UnityRpcResponse<T>, requestId: string): T {
  if (response.error) {
    throw new UnityCommandError(response.error.message, response.error.code, response.error.data, requestId);
  }
  return response.result as T;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export class UnityCommandError extends Error {
  public readonly code: string;

  public constructor(
    message: string,
    public readonly rpcCode?: number,
    public readonly data?: unknown,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "UnityCommandError";
    this.code = readErrorDataCode(data) ?? "UNITY_COMMAND_ERROR";
  }
}

export class UnityRequestTimeoutError extends Error {
  public constructor(
    message: string,
    public readonly requestId: string,
    public readonly outcomeUnknown: boolean,
    public readonly code = "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN"
  ) {
    super(message);
    this.name = "UnityRequestTimeoutError";
  }
}

function readRequestId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as { requestId?: unknown }).requestId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withRequestMetadata<T>(value: T, requestId: string, projectId: string, editorInstanceId: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string") {
    record.requestId = requestId;
  }
  if (typeof record.projectId !== "string") {
    record.projectId = projectId;
  }
  if (typeof record.editorInstanceId !== "string") {
    record.editorInstanceId = editorInstanceId;
  }
  return value;
}

function annotateError(error: unknown, requestId: string, projectId: string, editorInstanceId: string): unknown {
  if (!error || typeof error !== "object") return error;
  const record = error as Record<string, unknown>;
  if (typeof record.requestId !== "string") record.requestId = requestId;
  if (typeof record.projectId !== "string") record.projectId = projectId;
  if (typeof record.editorInstanceId !== "string") record.editorInstanceId = editorInstanceId;
  return error;
}

function isReplaySafe(method: string, params: unknown): boolean {
  if (params && typeof params === "object" && !Array.isArray(params) && (params as { dryRun?: unknown }).dryRun === true) {
    return true;
  }
  return (
    new Set([
      "ping",
      "health",
      "editor.get_state",
      "console.get_logs",
      "console.diagnostics_get",
      "console.query",
      "console.assert",
      "compile.diagnostics_get",
      "compile.status_get",
      "play_mode.get",
      "input.status",
      "editor.snapshot",
      "runtime.inspect",
      "runtime.assert",
      "scenario.source_get",
      "scenario.source_restore",
      "scene.get_hierarchy",
      "scene.list_open",
      "scene.get_setup",
      "gameobject.find",
      "gameobject.get",
      "component.get",
      "asset.find",
      "script.read",
      "operation.get",
      "operation.list",
      "screenshot.baselines_list"
    ]).has(method) || method.startsWith("semantic.")
  );
}

function readErrorDataCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    await rm(path);
    return true;
  } catch {
    return false;
  }
}
