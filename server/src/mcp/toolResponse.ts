import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolRiskLevel = "read" | "safe-write" | "asset-write" | "code-write" | "destructive" | "build-system" | "test-execution";

export interface ToolDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  data?: unknown;
}

export interface GhostToolResponse<TData = unknown> {
  ok: boolean;
  data: TData;
  diagnostics: ToolDiagnostic[];
  confidence: number;
  undoGroupId: number | null;
  durationMs: number;
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
  } = {}
): CallToolResult {
  const structuredContent: GhostToolResponse<TData> = {
    ok: true,
    data,
    diagnostics: options.diagnostics ?? [],
    confidence: options.confidence ?? 1,
    undoGroupId: options.undoGroupId ?? readUndoGroupId(data),
    durationMs: Date.now() - startedAt
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
  diagnostics: ToolDiagnostic[] = []
): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent: GhostToolResponse<null> = {
    ok: false,
    data: null,
    diagnostics: [
      ...diagnostics,
      {
        severity: "error",
        message
      }
    ],
    confidence: 0,
    undoGroupId: null,
    durationMs: Date.now() - startedAt
  };

  return {
    isError: true,
    content: [{ type: "text", text: `${text}: ${message}` }],
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
