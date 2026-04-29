export type TransportKind = "stdio";

export interface ServerConfig {
  transport: TransportKind;
  unityHost: string;
  unityPort: number;
  requestTimeoutMs: number;
}

export function readConfig(argv: string[]): ServerConfig {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];
    args.set(current.slice(2), next && !next.startsWith("--") ? next : "true");
  }

  const transport = args.get("transport") ?? "stdio";
  if (transport !== "stdio") {
    throw new Error(`Unsupported transport '${transport}'. Only stdio is implemented in this scaffold.`);
  }

  return {
    transport,
    unityHost: args.get("unity-host") ?? "127.0.0.1",
    unityPort: Number.parseInt(args.get("unity-port") ?? "6400", 10),
    requestTimeoutMs: Number.parseInt(args.get("request-timeout-ms") ?? "30000", 10)
  };
}
