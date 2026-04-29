import { randomUUID } from "node:crypto";
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

export interface UnityClientOptions {
  host: string;
  port: number;
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
    return `ws://${this.options.host}:${this.options.port}/unity-mcp-ghost`;
  }

  public async isConnected(): Promise<boolean> {
    try {
      await this.connect();
      return this.socket?.readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  }

  public async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const socket = await this.connect();
    const id = randomUUID();

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Unity request timed out: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
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
      pending.reject(new Error(response.error.message));
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
