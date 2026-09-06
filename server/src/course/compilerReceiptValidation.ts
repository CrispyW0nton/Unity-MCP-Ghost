import type { ScenarioCaseDefinition } from "../scenario/ScenarioJobManager.js";

/**
 * Returns the IDs of compiler-diagnostic cases whose terminal receipts do not
 * prove every diagnostic declared by the course matrix.
 */
export function invalidCompilerReceiptCaseIds(expectedCases: readonly ScenarioCaseDefinition[], observedCases: readonly Record<string, unknown>[]): string[] {
  return expectedCases
    .filter((expected) => {
      if (!expected.expectedCompilerDiagnostics) return false;
      const observed = observedCases.find((item) => item.id === expected.id) ?? {};
      const receipt = objectValue(observed.compilerAssertions);
      const compileGeneration = objectValue(observed.compile).generation;
      const receiptGeneration = receipt.generation;
      const assertions = arrayValue(receipt.assertions).map(objectValue);
      return (
        receipt.ok !== true ||
        !isPositiveSafeInteger(compileGeneration) ||
        !isPositiveSafeInteger(receiptGeneration) ||
        receiptGeneration !== compileGeneration ||
        assertions.length !== expected.expectedCompilerDiagnostics.length ||
        expected.expectedCompilerDiagnostics.some((diagnostic, index) => {
          const assertion = assertions[index];
          return (
            !assertion ||
            assertion.file !== diagnostic.file ||
            assertion.code !== diagnostic.code ||
            assertion.severity !== diagnostic.severity ||
            assertion.minimumCount !== (diagnostic.minimumCount ?? 1) ||
            !isNonnegativeSafeInteger(assertion.observedCount) ||
            assertion.observedCount < (diagnostic.minimumCount ?? 1) ||
            assertion.matched !== true
          );
        })
      );
    })
    .map((item) => item.id);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
