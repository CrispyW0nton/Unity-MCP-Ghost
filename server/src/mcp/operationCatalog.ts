import { z } from "zod";
import type { GhostToolMeta } from "./toolResponse.js";

export const OperationCatalogVersion = 1;

export const OperationProfiles = ["core", "authoring", "code", "runtime", "validation", "all"] as const;
export type OperationProfile = (typeof OperationProfiles)[number];
export type ToolSchema = Record<string, z.ZodType>;

export interface OperationCatalogEntry extends Omit<GhostToolMeta, "examples"> {
  operationId: string;
  version: number;
  name: string;
  description: string;
  profile: Exclude<OperationProfile, "all">;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  examples: unknown[];
}

const catalogs = new WeakMap<object, Map<string, OperationCatalogEntry>>();

export function parseOperationProfiles(value: string | undefined, fallback: OperationProfile[] = ["core"]): OperationProfile[] {
  const values = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) return [...fallback];

  const invalid = values.filter((entry) => !OperationProfiles.includes(entry as OperationProfile));
  if (invalid.length > 0) {
    throw new Error(`--tool-profile contains unsupported values: ${invalid.join(", ")}. Expected ${OperationProfiles.join(", ")}.`);
  }
  const profiles = [...new Set(values as OperationProfile[])];
  return profiles.includes("all") ? ["all"] : profiles;
}

export function recordOperation(
  owner: object,
  name: string,
  description: string,
  inputShape: ToolSchema,
  outputShape: ToolSchema,
  meta: GhostToolMeta
): OperationCatalogEntry {
  const input = z.object(inputShape);
  const examples = validateOrGenerateExamples(name, input, meta.examples);
  const entry: OperationCatalogEntry = {
    operationId: `ghost.tool.${name}.v${OperationCatalogVersion}`,
    version: OperationCatalogVersion,
    name,
    description,
    profile: profileForOperation(name),
    inputSchema: asJsonSchema(input),
    outputSchema: asJsonSchema(z.object(outputShape)),
    examples,
    risk: meta.risk,
    mutates: meta.mutates,
    supportsDryRun: meta.supportsDryRun,
    phase: meta.phase,
    relatedResources: [...(meta.relatedResources ?? [])],
    destructive: meta.destructive ?? meta.risk === "destructive",
    idempotent: meta.idempotent ?? !meta.mutates,
    openWorld: meta.openWorld ?? meta.risk === "external",
    permissionClass: meta.permissionClass ?? permissionClass(meta),
    mainThread: meta.mainThread ?? meta.mutates,
    undoable: meta.undoable ?? false,
    expectedDurationMs: meta.expectedDurationMs ?? defaultDuration(meta),
    bridgeOperations: [...(meta.bridgeOperations ?? [])]
  };

  let catalog = catalogs.get(owner);
  if (!catalog) {
    catalog = new Map();
    catalogs.set(owner, catalog);
  }
  catalog.set(name, entry);
  return entry;
}

export function listOperationCatalog(owner: object): OperationCatalogEntry[] {
  return [...(catalogs.get(owner)?.values() ?? [])].sort((left, right) => left.operationId.localeCompare(right.operationId));
}

export function operationEnabled(entry: OperationCatalogEntry, profiles: readonly OperationProfile[]): boolean {
  return profiles.includes("all") || entry.profile === "core" || profiles.includes(entry.profile);
}

export function searchOperationCatalog(
  owner: object,
  options: {
    query?: string;
    profiles?: readonly OperationProfile[];
    risk?: GhostToolMeta["risk"];
    mutates?: boolean;
    limit?: number;
    cursor?: string;
    fields?: string[];
  }
): { catalogVersion: number; items: Array<Record<string, unknown>>; nextCursor: string | null; truncated: boolean; totalMatched: number } {
  const query = options.query?.trim().toLowerCase() ?? "";
  const profiles: readonly OperationProfile[] = options.profiles?.length ? options.profiles : ["all"];
  const matched = listOperationCatalog(owner).filter((entry) => {
    if (!operationEnabled(entry, profiles)) return false;
    if (options.risk && entry.risk !== options.risk) return false;
    if (options.mutates !== undefined && entry.mutates !== options.mutates) return false;
    if (!query) return true;
    return `${entry.operationId} ${entry.name} ${entry.description} ${entry.profile} ${entry.relatedResources?.join(" ") ?? ""}`.toLowerCase().includes(query);
  });

  const start = decodeCursor(options.cursor);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const page = matched.slice(start, start + limit);
  const fields = new Set(options.fields ?? []);
  const items = page.map((entry) => projectEntry(entry, fields));
  const next = start + page.length;
  return {
    catalogVersion: OperationCatalogVersion,
    items,
    nextCursor: next < matched.length ? Buffer.from(String(next), "utf8").toString("base64url") : null,
    truncated: next < matched.length,
    totalMatched: matched.length
  };
}

export function profileForOperation(name: string): Exclude<OperationProfile, "all"> {
  if (["ping", "health", "capabilities_search", "operation_get", "operation_list", "operation_cancel", "operation_result"].includes(name)) return "core";
  if (/^(play_mode_|console_|input_|screenshot_|visual_)/.test(name)) return "runtime";
  if (/^(scenario_|evidence_|tests_|compile_|script_|repair_|patch_|unity_get_console)/.test(name)) return "validation";
  if (/^(asset_references_|prefab_references_|unity_event_|animator_|meta_|unused_|class_|call_|lint_|project_index_|test_scope_)/.test(name)) return "code";
  return "authoring";
}

function validateOrGenerateExamples(name: string, schema: z.ZodObject<ToolSchema>, supplied: unknown[] | undefined): unknown[] {
  const candidates = supplied?.length ? supplied : [exampleFromJsonSchema(asJsonSchema(schema), name)];
  return candidates.map((candidate) => {
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Invalid operation example for ${name}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
}

function asJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

function exampleFromJsonSchema(schema: Record<string, unknown>, propertyName: string): unknown {
  if ("default" in schema) return schema.default;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const union = schema[unionKey];
    if (Array.isArray(union) && union.length > 0) {
      const nonNull = union.find((item) => asRecord(item).type !== "null") ?? union[0];
      return exampleFromJsonSchema(asRecord(nonNull), propertyName);
    }
  }

  const type = Array.isArray(schema.type) ? schema.type.find((value) => value !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const properties = asRecord(schema.properties);
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([key, value]) => required.has(key) || "default" in asRecord(value))
        .map(([key, value]) => [key, exampleFromJsonSchema(asRecord(value), key)])
    );
  }
  if (type === "array") {
    const count = Math.max(1, numberValue(schema.minItems, 0));
    return Array.from({ length: count }, () => exampleFromJsonSchema(asRecord(schema.items), propertyName));
  }
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") {
    const minimum = numberValue(schema.minimum, numberValue(schema.exclusiveMinimum, -1) + 1);
    return Math.max(0, minimum);
  }
  if (type === "string") return exampleString(propertyName, schema);
  return null;
}

function exampleString(name: string, schema: Record<string, unknown>): string {
  if (schema.format === "uuid" || /(?:request|operation)id/i.test(name)) return "00000000-0000-4000-8000-000000000000";
  if (/sha256|hash/i.test(name) || String(schema.pattern ?? "").includes("64")) return "0".repeat(64);
  if (/scene.*path/i.test(name)) return "Assets/Example.unity";
  if (/path/i.test(name)) return "Assets/Example.cs";
  if (/method/i.test(name)) return "health";
  if (/component|type/i.test(name)) return "Transform";
  if (/content|source/i.test(name)) return "using UnityEngine; public class Example : MonoBehaviour {}";
  if (/name|label|query|filter|message|objective/i.test(name)) return "example";
  const minimum = Math.max(1, numberValue(schema.minLength, 1));
  return "x".repeat(minimum);
}

function projectEntry(entry: OperationCatalogEntry, fields: Set<string>): Record<string, unknown> {
  const source = entry as unknown as Record<string, unknown>;
  if (fields.size === 0) return { ...source };
  const always = new Set(["operationId", "name", "profile", ...fields]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => always.has(key)));
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Number.isSafeInteger(decoded) && decoded >= 0) return decoded;
  } catch {
    // Fall through to the stable typed error below.
  }
  throw Object.assign(new Error("The operation catalog cursor is invalid."), { code: "INVALID_CURSOR" });
}

function permissionClass(meta: GhostToolMeta): string {
  if (meta.risk === "read") return "read";
  if (meta.risk === "external") return "package-network";
  if (meta.risk === "arbitrary-code") return "arbitrary-code";
  if (meta.risk === "destructive") return "destructive";
  return "project-write";
}

function defaultDuration(meta: GhostToolMeta): { minimum: number; maximum: number } {
  if (meta.risk === "test-execution" || meta.risk === "build-system") return { minimum: 100, maximum: 900000 };
  return meta.mutates ? { minimum: 1, maximum: 300000 } : { minimum: 1, maximum: 30000 };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
