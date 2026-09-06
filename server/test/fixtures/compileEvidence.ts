// Controlled bridge data shaped like CompileDiagnosticBuffer's actual JSON.
// This fixture is not evidence of a live Unity compilation.
export function compileDiagnostic(generation: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: 1,
    generation,
    timestampUtc: "2026-09-06T12:00:00Z",
    assembly: "Assembly-CSharp",
    severity: "error",
    code: "CS1002",
    message: "error CS1002: ; expected",
    file: "Assets/Broken.cs",
    line: 1,
    column: 50,
    ...fields
  };
}

export function compileState(
  generation: number,
  status: "success" | "failed" | "waiting",
  diagnostics = status === "failed" ? [compileDiagnostic(generation)] : []
): Record<string, unknown> {
  return {
    ok: status !== "failed",
    status,
    generation,
    observed: status !== "waiting",
    requestedAtUtc: "2026-09-06T11:59:59Z",
    observedAtUtc: status === "waiting" ? null : "2026-09-06T12:00:00Z",
    completedAtUtc: status === "waiting" ? null : "2026-09-06T12:00:01Z",
    sourcePath: "Assets/Broken.cs",
    diagnostics,
    diagnosticsTruncated: false,
    errorCount: diagnostics.filter((item) => item.severity === "error").length,
    ...(status === "failed" ? { error: { code: "COMPILE_GENERATION_FAILED", message: "Compile generation completed with compiler errors." } } : {})
  };
}
