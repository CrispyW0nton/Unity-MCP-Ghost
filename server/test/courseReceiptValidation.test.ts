import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invalidCompilerReceiptCaseIds } from "../src/course/compilerReceiptValidation.js";
import type { ScenarioCaseDefinition } from "../src/scenario/ScenarioJobManager.js";

const expected: ScenarioCaseDefinition[] = [
  {
    id: "seeded-compiler-defect",
    expectedCompilerDiagnostics: [{ file: "Assets/StudentExercise.cs", code: "CS1002", severity: "error", minimumCount: 2 }]
  }
];

function matchingCase(): Record<string, unknown> {
  return {
    id: "seeded-compiler-defect",
    compile: { generation: 42 },
    compilerAssertions: {
      ok: true,
      generation: 42,
      assertions: [{ file: "Assets/StudentExercise.cs", code: "CS1002", severity: "error", minimumCount: 2, observedCount: 2, matched: true }]
    }
  };
}

function invalid(observedCases: Record<string, unknown>[]): void {
  assert.deepEqual(invalidCompilerReceiptCaseIds(expected, observedCases), ["seeded-compiler-defect"]);
}

describe("course compiler receipt validation", () => {
  it("rejects a missing compiler case or receipt", () => {
    invalid([]);
    const observed = matchingCase();
    delete observed.compilerAssertions;
    invalid([observed]);
  });

  it("rejects a receipt from another compile generation", () => {
    const observed = matchingCase();
    (observed.compilerAssertions as Record<string, unknown>).generation = 41;
    invalid([observed]);
  });

  it("rejects absent or nonpositive compile receipt generations", () => {
    const absent = matchingCase();
    delete (absent.compile as Record<string, unknown>).generation;
    delete (absent.compilerAssertions as Record<string, unknown>).generation;
    invalid([absent]);

    const nonpositive = matchingCase();
    (nonpositive.compile as Record<string, unknown>).generation = 0;
    (nonpositive.compilerAssertions as Record<string, unknown>).generation = 0;
    invalid([nonpositive]);
  });

  it("rejects missing or extra diagnostic assertions", () => {
    const observed = matchingCase();
    (observed.compilerAssertions as Record<string, unknown>).assertions = [];
    invalid([observed]);
    (observed.compilerAssertions as Record<string, unknown>).assertions = [
      { file: "Assets/StudentExercise.cs", code: "CS1002", severity: "error", minimumCount: 2, observedCount: 2, matched: true },
      { file: "Assets/StudentExercise.cs", code: "CS0000", severity: "error", minimumCount: 1, observedCount: 1, matched: true }
    ];
    invalid([observed]);
  });

  for (const [label, field, value] of [
    ["file", "file", "Assets/Other.cs"],
    ["code", "code", "CS0103"],
    ["severity", "severity", "warning"],
    ["minimum count", "minimumCount", 1],
    ["matched flag", "matched", false]
  ] as const) {
    it(`rejects a wrong diagnostic ${label}`, () => {
      const observed = matchingCase();
      ((observed.compilerAssertions as Record<string, unknown>).assertions as Record<string, unknown>[])[0][field] = value;
      invalid([observed]);
    });
  }

  it("rejects missing or insufficient observed diagnostic counts", () => {
    const missing = matchingCase();
    delete ((missing.compilerAssertions as Record<string, unknown>).assertions as Record<string, unknown>[])[0].observedCount;
    invalid([missing]);

    const insufficient = matchingCase();
    ((insufficient.compilerAssertions as Record<string, unknown>).assertions as Record<string, unknown>[])[0].observedCount = 1;
    invalid([insufficient]);
  });

  it("rejects receipt ok:false even when every assertion claims a match", () => {
    const observed = matchingCase();
    (observed.compilerAssertions as Record<string, unknown>).ok = false;
    invalid([observed]);
  });

  it("uses a default minimum count of one and ignores cases without compiler expectations", () => {
    const defaultMinimum: ScenarioCaseDefinition[] = [
      { id: "default-minimum", expectedCompilerDiagnostics: [{ file: "Assets/StudentExercise.cs", code: "CS1002", severity: "error" }] }
    ];
    const defaultReceipt = matchingCase();
    defaultReceipt.id = "default-minimum";
    ((defaultReceipt.compilerAssertions as Record<string, unknown>).assertions as Record<string, unknown>[])[0].minimumCount = 1;
    ((defaultReceipt.compilerAssertions as Record<string, unknown>).assertions as Record<string, unknown>[])[0].observedCount = 1;
    assert.deepEqual(invalidCompilerReceiptCaseIds(defaultMinimum, [defaultReceipt]), []);
    assert.deepEqual(invalidCompilerReceiptCaseIds([{ id: "runtime-case" }], [{}]), []);
  });

  it("accepts a fully matching exact-generation receipt", () => {
    assert.deepEqual(invalidCompilerReceiptCaseIds(expected, [matchingCase()]), []);
  });
});
