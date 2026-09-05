export type BridgeTransport = "http" | "websocket";

export interface BridgeStartupFailure {
  code: string;
  stage: string;
  transport: BridgeTransport | null;
  port: number | null;
  exceptionType: string;
  nativeErrorCode: number | null;
  socketErrorCode: string | null;
}

export interface BridgeStartupIdentity {
  running: boolean;
  port: number;
  webSocketPort: number;
  startupFailure?: BridgeStartupFailure | null;
}

export class BridgeStartupError<T extends BridgeStartupIdentity = BridgeStartupIdentity> extends Error {
  readonly code: "BRIDGE_ENDPOINT_CONFLICT" | "BRIDGE_STARTUP_FAILED";

  constructor(
    public readonly identity: T,
    label: string
  ) {
    const code = hasBindConflict(identity) ? "BRIDGE_ENDPOINT_CONFLICT" : "BRIDGE_STARTUP_FAILED";
    const failure = identity.startupFailure;
    super(
      `${label} bridge startup failed: ${code}${failure ? ` (${failure.stage}, ${failure.transport ?? "no transport"}, port ${failure.port ?? "none"})` : " (no startup receipt)"}.`
    );
    this.name = "BridgeStartupError";
    this.code = code;
  }
}

export function isExpectedEndpointConflict(error: unknown, transport: BridgeTransport, port: number): boolean {
  return (
    error instanceof BridgeStartupError &&
    hasBindConflict(error.identity) &&
    error.identity.startupFailure?.transport === transport &&
    error.identity.startupFailure.port === port
  );
}

function hasBindConflict(identity: BridgeStartupIdentity): boolean {
  const failure = identity.startupFailure;
  if (identity.running !== false || !failure || failure.code !== "BRIDGE_ENDPOINT_CONFLICT" || failure.stage !== "bind") return false;
  if (failure.transport !== "http" && failure.transport !== "websocket") return false;
  if (typeof failure.port !== "number" || !Number.isInteger(failure.port) || failure.port < 1024 || failure.port > 65535) return false;
  if (failure.port !== (failure.transport === "http" ? identity.port : identity.webSocketPort)) return false;
  return (
    (failure.exceptionType === "System.Net.Sockets.SocketException" && failure.socketErrorCode === "AddressAlreadyInUse") ||
    (failure.transport === "http" && failure.exceptionType === "System.Net.HttpListenerException" && failure.nativeErrorCode === 183)
  );
}
