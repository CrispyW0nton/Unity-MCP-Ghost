import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

export type ToolRiskLevel = "read" | "safe-write" | "asset-write" | "code-write" | "destructive" | "build-system" | "test-execution";

export interface ToolDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  data?: unknown;
}

export interface GhostToolError {
  code: string;
  message: string;
  data?: unknown;
}

export interface GhostToolResponse<TData = unknown> {
  ok: boolean;
  data: TData;
  error: GhostToolError | null;
  diagnostics: ToolDiagnostic[];
  requestId: string;
  operationId: string | null;
  projectId: string | null;
  confidence: number;
  undoGroupId: number | null;
  durationMs: number;
  warnings: string[];
}

export interface GhostToolMeta {
  risk: ToolRiskLevel;
  mutates: boolean;
  supportsDryRun: boolean;
  phase: number;
  relatedResources?: string[];
  examples?: unknown[];
}

export function successResponse<TData>(
  text: string,
  data: TData,
  startedAt: number,
  options: {
    diagnostics?: ToolDiagnostic[];
    confidence?: number;
    undoGroupId?: number | null;
    requestId?: string;
    operationId?: string | null;
    projectId?: string | null;
    warnings?: string[];
  } = {}
): CallToolResult {
  const bridgeFailure = detectBridgeFailure(data);
  if (bridgeFailure) {
    return bridgeFailureResponse(text, data, bridgeFailure, startedAt, options);
  }

  const dataRecord = asObject(data);
  const structuredContent: GhostToolResponse<TData> = {
    ok: true,
    data,
    error: null,
    diagnostics: options.diagnostics ?? [],
    requestId: options.requestId ?? readString(dataRecord, "requestId") ?? randomUUID(),
    operationId: options.operationId ?? readString(dataRecord, "operationId"),
    projectId: options.projectId ?? readString(dataRecord, "projectId"),
    confidence: options.confidence ?? 1,
    undoGroupId: options.undoGroupId ?? readUndoGroupId(data),
    durationMs: Date.now() - startedAt,
    warnings: options.warnings ?? readWarnings(dataRecord)
  };

  return {
    content: [{ type: "text", text }],
    structuredContent: structuredContent as unknown as Record<string, unknown>
  };
}

export function failureResponse(
  text: string,
  error: unknown,
  startedAt: number,
  diagnostics: ToolDiagnostic[] = [],
  options: {
    code?: string;
    data?: unknown;
    requestId?: string;
    operationId?: string | null;
    projectId?: string | null;
    warnings?: string[];
  } = {}
): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const errorData = readErrorData(error);
  const outcomeUnknown = readBoolean(error, "outcomeUnknown") === true;
  const structuredContent: GhostToolResponse<unknown> = {
    ok: false,
    data: options.data ?? errorData ?? null,
    error: {
      code: options.code ?? readErrorCode(error) ?? "UNITY_REQUEST_FAILED",
      message,
      ...(errorData === undefined ? {} : { data: errorData })
    },
    diagnostics: [
      ...diagnostics,
      {
        severity: "error",
        message
      }
    ],
    requestId: options.requestId ?? readErrorRequestId(error) ?? randomUUID(),
    operationId: options.operationId ?? null,
    projectId: options.projectId ?? null,
    confidence: 0,
    undoGroupId: null,
    durationMs: Date.now() - startedAt,
    warnings: options.warnings ?? (outcomeUnknown ? ["The request may have mutated Unity after the caller stopped waiting; retry only with the same request ID."] : [])
  };

  return {
    isError: true,
    content: [{ type: "text", text: `${text}: ${message}` }],
    structuredContent: structuredContent as unknown as Record<string, unknown>
  };
}

function bridgeFailureResponse<TData>(
  text: string,
  data: TData,
  error: GhostToolError,
  startedAt: number,
  options: {
    diagnostics?: ToolDiagnostic[];
    requestId?: string;
    operationId?: string | null;
    projectId?: string | null;
    warnings?: string[];
  }
): CallToolResult {
  const dataRecord = asObject(data);
  const diagnostics = options.diagnostics ?? diagnosticsFromData(dataRecord, error);
  const structuredContent: GhostToolResponse<TData> = {
    ok: false,
    data,
    error,
    diagnostics,
    requestId: options.requestId ?? readString(dataRecord, "requestId") ?? randomUUID(),
    operationId: options.operationId ?? readString(dataRecord, "operationId"),
    projectId: options.projectId ?? readString(dataRecord, "projectId"),
    confidence: 0,
    undoGroupId: readUndoGroupId(data),
    durationMs: Date.now() - startedAt,
    warnings: options.warnings ?? readWarnings(dataRecord)
  };

  return {
    isError: true,
    content: [{ type: "text", text: `${text} ${error.code}: ${error.message}` }],
    structuredContent: structuredContent as unknown as Record<string, unknown>
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

function readUndoGroupId(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const undoGroupId = (value as { undoGroupId?: unknown }).undoGroupId;
  return typeof undoGroupId === "number" ? undoGroupId : null;
}

function detectBridgeFailure(value: unknown): GhostToolError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const state = asObject(record.state);
  const failedCount = readFailureCount(record) + readFailureCount(state);
  if (failedCount > 0) {
    return {
      code: "UNITY_TESTS_FAILED",
      message: `${failedCount} Unity test${failedCount === 1 ? "" : "s"} failed.`,
      data: { failed: failedCount }
    };
  }

  const rootStatus = readString(record, "status");
  const stateStatus = readString(state, "status");
  const terminalFailure = failureStatus(stateStatus) ?? failureStatus(rootStatus);
  if (terminalFailure) {
    const source = stateStatus ? state : record;
    const parsed = parseError(source.error);
    return {
      code: terminalFailure.code,
      message: parsed?.message ?? `Unity operation ended with status ${terminalFailure.status}.`,
      ...(parsed?.data === undefined ? {} : { data: parsed.data })
    };
  }

  if (record.ok === false) {
    const parsed = parseError(record.error);
    return {
      code: parsed?.code ?? "UNITY_BRIDGE_FAILED",
      message: parsed?.message ?? readString(record, "message") ?? "Unity bridge reported failure.",
      ...(parsed?.data === undefined ? {} : { data: parsed.data })
    };
  }

  return null;
}

function failureStatus(status: string | null): { status: string; code: string } | null {
  switch (status?.toLowerCase()) {
    case "failed":
      return { status, code: "UNITY_OPERATION_FAILED" };
    case "timeout":
    case "timed_out":
      return { status, code: "UNITY_OPERATION_TIMEOUT" };
    case "cancelled":
    case "canceled":
    case "aborted":
      return { status, code: "UNITY_OPERATION_CANCELLED" };
    case "outcomeunknown":
    case "outcome_unknown":
      return { status, code: "UNITY_OPERATION_OUTCOME_UNKNOWN" };
    default:
      return null;
  }
}

function parseError(value: unknown): GhostToolError | null {
  if (typeof value === "string" && value.length > 0) {
    return { code: "UNITY_BRIDGE_FAILED", message: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const message = readString(record, "message");
  if (!message) {
    return null;
  }

  return {
    code: readString(record, "code") ?? "UNITY_BRIDGE_FAILED",
    message,
    ...(record.data === undefined ? {} : { data: record.data })
  };
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function readErrorData(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as { data?: unknown }).data;
}

function readErrorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const requestId = (error as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "boolean" ? result : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFailureCount(record: Record<string, unknown>): number {
  const value = record.failed;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readWarnings(record: Record<string, unknown>): string[] {
  return Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === "string") : [];
}

function diagnosticsFromData(record: Record<string, unknown>, error: GhostToolError): ToolDiagnostic[] {
  if (Array.isArray(record.diagnostics)) {
    const diagnostics = record.diagnostics.filter(isToolDiagnostic);
    if (diagnostics.length > 0) {
      return diagnostics;
    }
  }

  return [{ severity: "error", message: error.message, code: error.code, data: error.data }];
}

function isToolDiagnostic(value: unknown): value is ToolDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const diagnostic = value as { severity?: unknown; message?: unknown };
  return (diagnostic.severity === "info" || diagnostic.severity === "warning" || diagnostic.severity === "error") && typeof diagnostic.message === "string";
}
