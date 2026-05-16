import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

export interface UnityRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string;
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
}

export interface UnityClientOptions {
  host: string;
  port: number;
  queueDir?: string;
  requestTimeoutMs: number;
}

export class UnityClient {
  private socket: WebSocket | undefined;
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
    return `ws://${this.options.host}:${this.options.port}/unity-mcp-ghost/`;
  }

  public get httpEndpoint(): string {
    return `http://${this.options.host}:${this.options.port}/unity-mcp-ghost/`;
  }

  public get queueEndpoint(): string | undefined {
    return this.options.queueDir;
  }

  public async isConnected(): Promise<boolean> {
    try {
      await this.requestViaHttp("health", {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "health",
        params: {}
      });
      return true;
    } catch {
      return false;
    }
  }

  public async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = randomUUID();
    const payload: UnityRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    try {
      return await this.requestViaHttp<T>(method, payload);
    } catch (error) {
      if (error instanceof UnityCommandError || error instanceof UnityRequestTimeoutError) {
        throw error;
      }

      try {
        const socket = await this.connect();
        return await this.requestViaSocket<T>(socket, payload, method);
      } catch (socketError) {
        if (socketError instanceof UnityCommandError || socketError instanceof UnityRequestTimeoutError) {
          throw socketError;
        }

        if (!this.options.queueDir) {
          throw socketError;
        }

        return this.requestViaQueue<T>(payload, method);
      }
    }
  }

  private async requestViaHttp<T>(method: string, payload: UnityRpcRequest): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.options.requestTimeoutMs);

    try {
      const response = await fetch(this.httpEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`Unity HTTP bridge responded ${response.status}: ${method}`);
      }

      const rpcResponse = (await response.json()) as UnityRpcResponse<T>;
      if (rpcResponse.error) {
        throw new UnityCommandError(rpcResponse.error.message);
      }

      return rpcResponse.result as T;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new UnityRequestTimeoutError(`Unity HTTP request timed out: ${method}`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestViaSocket<T>(socket: WebSocket, payload: UnityRpcRequest, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(payload.id);
        reject(new UnityRequestTimeoutError(`Unity request timed out: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(payload.id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(payload.id);
        reject(error);
      });
    });
  }

  private async requestViaQueue<T>(payload: UnityRpcRequest, method: string): Promise<T> {
    const queueDir = this.options.queueDir;
    if (!queueDir) {
      throw new Error("Unity durable queue is not configured.");
    }

    const pendingDir = join(queueDir, "pending");
    const resultsDir = join(queueDir, "results");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(resultsDir, { recursive: true });

    const pendingPath = join(pendingDir, `${payload.id}.json`);
    const tempPath = `${pendingPath}.tmp`;
    const resultPath = join(resultsDir, `${payload.id}.json`);

    await writeFile(tempPath, JSON.stringify(payload), "utf8");
    await rename(tempPath, pendingPath);

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.options.requestTimeoutMs) {
      const response = await this.tryReadQueuedResponse<T>(resultPath);
      if (response.found) {
        await rm(resultPath, { force: true });
        if (response.error) {
          throw new Error(response.error.message);
        }

        return response.result as T;
      }

      await delay(100);
    }

    throw new Error(`Unity durable queue request timed out: ${method}`);
  }

  private async tryReadQueuedResponse<T>(path: string): Promise<{ found: false } | { found: true; result?: T; error?: UnityRpcResponse["error"] }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return { found: false };
    }

    const response = JSON.parse(raw) as UnityRpcResponse<T>;
    return {
      found: true,
      result: response.result,
      error: response.error
    };
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    this.socket?.terminate();

    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => this.rejectPending(new Error("Unity bridge connection closed.")));
    socket.on("error", (error) => this.rejectPending(error));

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    return socket;
  }

  private handleMessage(raw: string): void {
    let response: UnityRpcResponse;
    try {
      response = JSON.parse(raw) as UnityRpcResponse;
    } catch {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new UnityCommandError(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

class UnityCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnityCommandError";
  }
}

class UnityRequestTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnityRequestTimeoutError";
  }
}
