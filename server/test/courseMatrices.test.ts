import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModule1Matrix, buildModule2Matrix, CourseFixtureScript } from "../src/course/courseMatrices.js";

const baseline = "using UnityEngine; public sealed class StudentExercise : MonoBehaviour {}\n";
const sha256 = "a".repeat(64);

describe("GAM 215-equivalent declarative matrices", () => {
  it("independently asserts each Marvin Write overload output", () => {
    const exercise = buildModule1Matrix(baseline, sha256).cases.find((item) => item.id === "m1-marvin-write-overloads")!;
    for (const message of ["MARVIN|Write|Module1|String|hello|true", "MARVIN|Write|Module1|Int|7|true", "MARVIN|Write|Module1|Float|2.5|true"]) {
      assert.ok(
        exercise.consoleAssertions?.some((item) => item.exact === message && item.count === 1),
        `missing exact output ${message}`
      );
    }
  });

  it("declares file-specific diagnostic codes for every seeded compiler defect", () => {
    const expectedCodes: Record<string, string[]> = {
      "m1-syntax-malformed-comment": ["CS1513", "CS1035"],
      "m1-syntax-malformed-brace": ["CS1513"],
      "m1-syntax-malformed-quote": ["CS1010", "CS1026", "CS1002"],
      "m1-syntax-missing-semicolon": ["CS1002"],
      "m1-identifier-undeclared": ["CS0103"],
      "m1-identifier-unassigned": ["CS0165"],
      "m1-identifier-redeclared": ["CS0128"],
      "m1-identifier-use-before-declaration": ["CS0841"],
      "m1-identifier-case-mismatch": ["CS0103"]
    };
    const exercises = buildModule1Matrix(baseline, sha256).cases.filter((item) => item.expectedResult === "compile-failure");
    assert.equal(exercises.length, Object.keys(expectedCodes).length);
    for (const exercise of exercises) {
      assert.deepEqual(
        exercise.expectedCompilerDiagnostics,
        expectedCodes[exercise.id].map((code) => ({ file: CourseFixtureScript, severity: "error", code })),
        exercise.id
      );
    }
  });

  it("covers every required Module 1 construct and seeded defect", () => {
    const matrix = buildModule1Matrix(baseline, sha256);
    const ids = matrix.cases.map((item) => item.id);
    const sources = matrix.cases.map(sourceOf).join("\n");

    assert.equal(matrix.cases.length, 23);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of [
      "m1-skeleton-comments-two-prints",
      "m1-variables-types-signed-zero",
      "m1-marvin-write-overloads",
      "m1-arithmetic-assignment-parentheses",
      "m1-random-range-int-inclusive-max",
      "m1-random-range-float-inferred",
      "m1-syntax-malformed-comment",
      "m1-syntax-malformed-brace",
      "m1-syntax-malformed-quote",
      "m1-syntax-missing-semicolon",
      "m1-lifecycle-missing-start",
      "m1-lifecycle-wrong-case-start",
      "m1-identifier-undeclared",
      "m1-identifier-unassigned",
      "m1-identifier-redeclared",
      "m1-identifier-use-before-declaration",
      "m1-identifier-case-mismatch",
      "m1-semantic-quoted-variable",
      "m1-semantic-wrong-variable",
      "m1-semantic-wrong-type",
      "m1-semantic-wrong-marvin-argument-order",
      "m1-semantic-wrong-label-value",
      "m1-timeout-restoration"
    ])
      assert.ok(ids.includes(id), `missing ${id}`);

    for (const token of [
      "// A clean-room single-line comment",
      "/* A clean-room block comment. */",
      "private void Start()",
      "print(",
      "string localTitle",
      "int localZero = 0",
      "int localNegative = -4",
      "float localSpeed = 1.5f",
      "localAssigned = localNegative",
      "localCopy + 3",
      "localAdd - 5",
      "localSubtract * 4",
      "localMultiply / 2",
      "(localAdd + localSubtract) * 2",
      "Random.Range(localMin, localMax + 1)",
      "float localRoll = Random.Range(localMin, localMax)"
    ])
      assert.ok(sources.includes(token), `missing source token ${token}`);

    verifyRestorableRuntimeEvidence(matrix.cases);
  });

  it("covers Module 2 truth tables, 16 comparisons, assignment flow, return, and navigation", () => {
    const matrix = buildModule2Matrix(baseline, sha256);
    const ids = matrix.cases.map((item) => item.id);
    const sources = matrix.cases.map(sourceOf).join("\n");

    assert.equal(matrix.cases.length, 43);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.filter((id) => id.startsWith("m2-boolean-")).length, 8);
    assert.equal(ids.filter((id) => id.startsWith("m2-if-else-")).length, 2);
    assert.equal(ids.filter((id) => id.startsWith("m2-not-")).length, 2);
    assert.equal(ids.filter((id) => id.startsWith("m2-or-")).length, 4);
    assert.equal(ids.filter((id) => id.startsWith("m2-and-")).length, 4);
    assert.equal(ids.filter((id) => id.startsWith("m2-comparison-")).length, 16);
    assert.ok(ids.includes("m2-return-stops-later-scene"));
    assert.ok(ids.includes("m2-assignment-operator-flow"));
    assert.ok(ids.includes("m2-wiring-both-false-conceals-defect"));
    assert.ok(ids.includes("m2-wiring-both-true-conceals-defect"));
    assert.ok(ids.includes("m2-wiring-isolated-change-exposes-defect"));
    assert.ok(ids.includes("m2-page-up-page-down-navigation"));
    assert.ok(ids.includes("m2-timeout-restoration"));

    for (const token of [
      "bool localVisible",
      "if (localHasItem)",
      "!localHasShield",
      "localLeft || localRight",
      "localLeft && localRight",
      "return;",
      "localLeft == localRight",
      "localLeft != localRight",
      "localLeft <= localRight",
      "localLeft < localRight",
      "localLeft > localRight",
      "localLeft >= localRight",
      "localMoney = localWallet",
      "++localMoney",
      "--localMoney",
      "localMoney += 85.0f",
      "localMoney -= 5.0f",
      "localMoney *= 9",
      "localMoney /= 3",
      "Marvin.Play(",
      "Marvin.Write(",
      "Marvin.Draw(",
      "Marvin.ShowOrHide("
    ])
      assert.ok(sources.includes(token), `missing source token ${token}`);

    const navigation = matrix.cases.find((item) => item.id === "m2-page-up-page-down-navigation");
    assert.deepEqual(
      navigation?.inputs?.map((item) => item.key),
      ["PageUp", "PageDown"]
    );
    assert.deepEqual(
      navigation?.inputs?.map((item) => item.backend),
      ["project-test-driver", "project-test-driver"]
    );
    verifyRestorableRuntimeEvidence(matrix.cases);
  });
});

function sourceOf(item: ReturnType<typeof buildModule1Matrix>["cases"][number]): string {
  return item.sourceMutations?.[0]?.content ?? "";
}

function verifyRestorableRuntimeEvidence(cases: ReturnType<typeof buildModule1Matrix>["cases"]): void {
  for (const item of cases) {
    assert.equal(item.sourceMutations?.length, 1, `${item.id} must mutate exactly one fixture source`);
    assert.equal(item.sourceMutations?.[0]?.path, CourseFixtureScript);
    assert.equal(item.sourceMutations?.[0]?.expectedSha256, sha256);
    if (item.expectedResult === "compile-failure") continue;
    assert.ok((item.consoleAssertions?.length ?? 0) > 0, `${item.id} needs Console evidence`);
    assert.ok((item.objectAssertions?.length ?? 0) > 0, `${item.id} needs deterministic visible-state evidence`);
    assert.equal(item.screenshotAssertions?.length, 1, `${item.id} needs screenshot evidence`);
  }
}
