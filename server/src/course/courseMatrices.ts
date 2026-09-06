import type { ScenarioCaseDefinition, ScenarioConsoleAssertion, ScenarioMatrixDefinition, ScenarioObjectAssertion } from "../scenario/ScenarioJobManager.js";

export const CourseFixtureScene = "Assets/GAM215Fixture/RuntimeControlFixture.unity";
export const CourseFixtureScript = "Assets/GAM215Fixture/StudentExercise.cs";
export const CourseHarnessObject = "GAM215 Course Harness";
export const CourseHarnessComponent = "Gam215CourseHarness";

// Observed with the supported Unity 2022.3 compiler; cascading errors are explicit.
const seededCompilerCodes: Record<string, string[]> = {
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

interface RuntimeCaseOptions {
  id: string;
  body: string;
  expectedMarvinLog?: string;
  consoleAssertions?: ScenarioConsoleAssertion[];
  objectAssertions?: ScenarioObjectAssertion[];
  expectedResult?: "pass" | "assertion-failure" | "timeout";
  expectedFailureCode?: string;
  methodName?: string;
  inputs?: ScenarioCaseDefinition["inputs"];
}

export function buildModule1Matrix(originalContent: string, originalSha256: string): ScenarioMatrixDefinition {
  const runtime = (options: RuntimeCaseOptions) => runtimeCase(originalContent, originalSha256, options);
  const cases: ScenarioCaseDefinition[] = [
    runtime({
      id: "m1-skeleton-comments-two-prints",
      body: `// A clean-room single-line comment.
        /* A clean-room block comment. */
        print("M1|PRINT|one");
        print("M1|PRINT|two");
        Marvin.Write("Skeleton", "ready");`,
      consoleAssertions: [exactLog("M1|PRINT|one"), exactLog("M1|PRINT|two")],
      expectedMarvinLog: "MARVIN|Write|Module1|Skeleton|ready|true",
      objectAssertions: harnessEquals("VisibleText", "ready")
    }),
    runtime({
      id: "m1-variables-types-signed-zero",
      body: `string localTitle;
        localTitle = "Ghost";
        int localZero = 0;
        int localNegative = -4;
        float localSpeed = 1.5f;
        int localAssigned;
        localAssigned = localNegative;
        print("M1|STRING|" + localTitle);
        print("M1|INT|" + localZero);
        print("M1|SIGNED|" + localAssigned);
        print("M1|FLOAT|" + localSpeed);
        Marvin.Write("Float", localSpeed);`,
      consoleAssertions: [exactLog("M1|STRING|Ghost"), exactLog("M1|INT|0"), exactLog("M1|SIGNED|-4"), exactLog("M1|FLOAT|1.5")],
      expectedMarvinLog: "MARVIN|Write|Module1|Float|1.5|true",
      objectAssertions: harnessEquals("VisibleText", "1.5")
    }),
    runtime({
      id: "m1-marvin-write-overloads",
      body: `string localText = "hello";
        int localCount = 7;
        float localRatio = 2.5f;
        Marvin.Write("String", localText);
        Marvin.Write("Int", localCount);
        Marvin.Write("Float", localRatio);
        print("M1|WRITE|overloads");`,
      consoleAssertions: [
        exactLog("COURSE|m1-marvin-write-overloads"),
        exactLog("MARVIN|Write|Module1|String|hello|true"),
        exactLog("MARVIN|Write|Module1|Int|7|true")
      ],
      expectedMarvinLog: "MARVIN|Write|Module1|Float|2.5|true",
      objectAssertions: [...harnessEquals("VisibleText", "2.5"), ...harnessEquals("CallCount", 3)]
    }),
    runtime({
      id: "m1-arithmetic-assignment-parentheses",
      body: `int localBase = 12;
        int localCopy;
        localCopy = localBase;
        int localAdd = localCopy + 3;
        int localSubtract = localAdd - 5;
        int localMultiply = localSubtract * 4;
        int localDivide = localMultiply / 2;
        int localGrouped = (localAdd + localSubtract) * 2;
        print("M1|ARITH|" + localAdd + "|" + localSubtract + "|" + localMultiply + "|" + localDivide + "|" + localGrouped);
        Marvin.Write("Grouped", localGrouped);`,
      consoleAssertions: [exactLog("M1|ARITH|15|10|40|20|50")],
      expectedMarvinLog: "MARVIN|Write|Module1|Grouped|50|true",
      objectAssertions: harnessEquals("VisibleText", "50")
    }),
    runtime({
      id: "m1-random-range-int-inclusive-max",
      body: `Random.InitState(215);
        int localMin = 0;
        int localMax = 5;
        bool localSawInclusiveMaximum = false;
        for (int localIndex = 0; localIndex < 256; localIndex++)
        {
            int localRoll = Random.Range(localMin, localMax + 1);
            if (localRoll == localMax)
            {
                localSawInclusiveMaximum = true;
            }
        }
        print("M1|RANGE_INT|" + localSawInclusiveMaximum);
        Marvin.Write("Inclusive Maximum", localSawInclusiveMaximum ? "true" : "false");`,
      consoleAssertions: [exactLog("M1|RANGE_INT|True")],
      expectedMarvinLog: "MARVIN|Write|Module1|Inclusive Maximum|true|true",
      objectAssertions: harnessEquals("VisibleText", "true")
    }),
    runtime({
      id: "m1-random-range-float-inferred",
      body: `// Inferred language coverage: the exported course exercise omits its float-range implementation.
        Random.InitState(215);
        float localMin = -1.25f;
        float localMax = 2.75f;
        float localRoll = Random.Range(localMin, localMax);
        bool localInRange = localRoll >= localMin && localRoll <= localMax;
        print("M1|RANGE_FLOAT_INFERRED|" + localInRange);
        Marvin.Write("Float Range Inferred", localInRange ? "true" : "false");`,
      consoleAssertions: [exactLog("M1|RANGE_FLOAT_INFERRED|True")],
      expectedMarvinLog: "MARVIN|Write|Module1|Float Range Inferred|true|true",
      objectAssertions: harnessEquals("VisibleText", "true")
    }),
    compileFailure(
      "m1-syntax-malformed-comment",
      `using UnityEngine;
public sealed class StudentExercise : MonoBehaviour
{
    private void Start()
    {
        /* unterminated clean-room comment
    }
}
`,
      originalSha256
    ),
    compileFailure(
      "m1-syntax-malformed-brace",
      `using UnityEngine;
public sealed class StudentExercise : MonoBehaviour
{
    private void Start()
    {
        print("brace");
`,
      originalSha256
    ),
    compileFailure("m1-syntax-malformed-quote", studentSource(`print("unterminated);`), originalSha256),
    compileFailure(
      "m1-syntax-missing-semicolon",
      studentSource(`int localValue = 1
        print(localValue);`),
      originalSha256
    ),
    compileFailure("m1-identifier-undeclared", studentSource(`localScore = 1;`), originalSha256),
    compileFailure(
      "m1-identifier-unassigned",
      studentSource(`int localScore;
        print(localScore);`),
      originalSha256
    ),
    compileFailure(
      "m1-identifier-redeclared",
      studentSource(`int localScore = 1;
        int localScore = 2;`),
      originalSha256
    ),
    compileFailure(
      "m1-identifier-use-before-declaration",
      studentSource(`print(localScore);
        int localScore = 1;`),
      originalSha256
    ),
    compileFailure(
      "m1-identifier-case-mismatch",
      studentSource(`int localScore = 1;
        print(localscore);`),
      originalSha256
    ),
    runtime({
      id: "m1-lifecycle-missing-start",
      methodName: "Begin",
      body: `Marvin.Write("Lifecycle", "wrong");
        print("COURSE|m1-lifecycle-missing-start");`,
      expectedResult: "assertion-failure",
      expectedFailureCode: "RUNTIME_ASSERTION_FAILED",
      consoleAssertions: [exactLog("COURSE|m1-lifecycle-missing-start", 0)],
      objectAssertions: harnessEquals("LastAction", "Write")
    }),
    runtime({
      id: "m1-lifecycle-wrong-case-start",
      methodName: "start",
      body: `Marvin.Write("Lifecycle", "wrong case");
        print("COURSE|m1-lifecycle-wrong-case-start");`,
      expectedResult: "assertion-failure",
      expectedFailureCode: "RUNTIME_ASSERTION_FAILED",
      consoleAssertions: [exactLog("COURSE|m1-lifecycle-wrong-case-start", 0)],
      objectAssertions: harnessEquals("LastAction", "Write")
    }),
    semanticFailure(
      runtime,
      "m1-semantic-quoted-variable",
      `int localScore = 7;
        Marvin.Write("Score", "localScore");`,
      "VisibleText",
      "7"
    ),
    semanticFailure(
      runtime,
      "m1-semantic-wrong-variable",
      `int localScore = 7;
        int localOtherScore = 9;
        Marvin.Write("Score", localOtherScore);`,
      "VisibleText",
      "7"
    ),
    semanticFailure(
      runtime,
      "m1-semantic-wrong-type",
      `int localScore = 7;
        string localWrongValue = "seven";
        Marvin.Write("Score", localWrongValue);`,
      "VisibleText",
      "7"
    ),
    semanticFailure(
      runtime,
      "m1-semantic-wrong-marvin-argument-order",
      `string localQuote = "Stay curious";
        Marvin.Write(localQuote, "Favorite Quote");`,
      "Target",
      "Favorite Quote"
    ),
    semanticFailure(
      runtime,
      "m1-semantic-wrong-label-value",
      `int localScore = 7;
        Marvin.Write("Wrong Label", localScore + 1);`,
      "Target",
      "Score"
    ),
    runtime({
      id: "m1-timeout-restoration",
      body: `Marvin.Write("Timeout", "source must restore");`,
      expectedResult: "timeout",
      expectedFailureCode: "CONSOLE_WAIT_TIMEOUT",
      consoleAssertions: [exactLog("M1|THIS_LOG_DOES_NOT_EXIST", 1, 300)],
      objectAssertions: harnessEquals("VisibleText", "source must restore")
    })
  ];

  return matrix("GAM 215-equivalent Module 1", cases);
}

export function buildModule2Matrix(originalContent: string, originalSha256: string): ScenarioMatrixDefinition {
  const runtime = (options: RuntimeCaseOptions) => runtimeCase(originalContent, originalSha256, options);
  const cases: ScenarioCaseDefinition[] = [];

  for (const target of ["Candle", "Key", "Raft", "Ladder"]) {
    for (const visible of [false, true]) {
      const value = visible ? "true" : "false";
      cases.push(
        runtime({
          id: `m2-boolean-${target.toLowerCase()}-${value}`,
          body: `bool localVisible = ${value};
        Marvin.Play("Inventory");
        Marvin.ShowOrHide("Inventory", "${target}", localVisible);`,
          expectedMarvinLog: `MARVIN|ShowOrHide|Inventory|${target}|${value}|${value}`,
          objectAssertions: [...harnessEquals("Target", target), ...harnessEquals("Visible", visible)]
        })
      );
    }
  }

  cases.push(
    branchCase(runtime, "m2-if-else-false", false, "Shining"),
    branchCase(runtime, "m2-if-else-true", true, "Candle"),
    notCase(runtime, false),
    notCase(runtime, true)
  );

  for (const left of [false, true]) {
    for (const right of [false, true]) {
      const result = left || right ? "Healing" : "No Healing";
      cases.push(logicCase(runtime, "or", left, right, result));
    }
  }
  for (const left of [false, true]) {
    for (const right of [false, true]) {
      const result = left && right ? "Dying" : "Escaped";
      cases.push(logicCase(runtime, "and", left, right, result));
    }
  }

  cases.push(
    runtime({
      id: "m2-return-stops-later-scene",
      body: `bool localGameOver = true;
        Marvin.Play("Current Scene");
        print("M2|RETURN|before");
        if (localGameOver)
        {
            Marvin.Draw("Current Scene", "Outcome", "Game Over");
            return;
        }
        Marvin.Play("Later Scene");
        print("M2|RETURN|after");`,
      consoleAssertions: [exactLog("M2|RETURN|before"), exactLog("M2|RETURN|after", 0)],
      expectedMarvinLog: "MARVIN|Draw|Current Scene|Outcome|Game Over|true",
      objectAssertions: [...harnessEquals("CurrentScene", "Current Scene"), ...harnessEquals("VisibleText", "Game Over")]
    })
  );

  cases.push(
    comparisonCase(runtime, "eq", "==", 'string localLeft = "alpha";', 'string localRight = "alpha";', "Equal"),
    comparisonCase(runtime, "eq", "==", 'string localLeft = "alpha";', 'string localRight = "beta";', "Different", "different"),
    comparisonCase(runtime, "neq", "!=", 'string localLeft = "green";', 'string localRight = "green";', "Same"),
    comparisonCase(runtime, "neq", "!=", 'string localLeft = "green";', 'string localRight = "orange";', "Different", "different"),
    ...orderedComparisonCases(runtime, "lte", "<=", "float", [9.5, 10, 10.5], 10),
    ...orderedComparisonCases(runtime, "lt", "<", "float", [9.5, 10, 10.5], 10),
    ...orderedComparisonCases(runtime, "gt", ">", "int", [9, 10, 11], 10),
    ...orderedComparisonCases(runtime, "gte", ">=", "int", [9, 10, 11], 10)
  );

  cases.push(
    runtime({
      id: "m2-assignment-operator-flow",
      body: `float localMoney = 0.0f;
        float localWallet = 20.0f;
        localMoney = localWallet;
        print("M2|ASSIGN|=|" + localMoney);
        ++localMoney;
        print("M2|ASSIGN|++|" + localMoney);
        --localMoney;
        print("M2|ASSIGN|--|" + localMoney);
        localMoney += 85.0f;
        print("M2|ASSIGN|+=|" + localMoney);
        localMoney -= 5.0f;
        print("M2|ASSIGN|-=|" + localMoney);
        localMoney *= 9;
        print("M2|ASSIGN|*=|" + localMoney);
        localMoney /= 3;
        print("M2|ASSIGN|/=|" + localMoney);
        Marvin.Write("Casino", "Money", localMoney);`,
      consoleAssertions: [
        exactLog("M2|ASSIGN|=|20"),
        exactLog("M2|ASSIGN|++|21"),
        exactLog("M2|ASSIGN|--|20"),
        exactLog("M2|ASSIGN|+=|105"),
        exactLog("M2|ASSIGN|-=|100"),
        exactLog("M2|ASSIGN|*=|900"),
        exactLog("M2|ASSIGN|/=|300")
      ],
      expectedMarvinLog: "MARVIN|Write|Casino|Money|300|true",
      objectAssertions: harnessEquals("VisibleText", "300")
    })
  );

  cases.push(
    wiringCase(runtime, "m2-wiring-both-false-conceals-defect", false, false, "pass"),
    wiringCase(runtime, "m2-wiring-both-true-conceals-defect", true, true, "pass"),
    wiringCase(runtime, "m2-wiring-isolated-change-exposes-defect", true, false, "assertion-failure")
  );

  cases.push(
    runtime({
      id: "m2-page-up-page-down-navigation",
      body: `Marvin.Play("Navigation");`,
      consoleAssertions: [exactLog("GAM215_PAGE:1"), exactLog("GAM215_PAGE:0")],
      expectedMarvinLog: "MARVIN|Play|Navigation||Navigation|true",
      objectAssertions: [
        ...harnessEquals("CurrentScene", "Navigation"),
        { name: "GAM215 Runtime Driver", component: "Gam215InputDriver", propertyPath: "PageIndex", equals: 0 }
      ],
      inputs: [
        { backend: "project-test-driver", device: "keyboard", action: "tap", key: "PageUp" },
        { backend: "project-test-driver", device: "keyboard", action: "tap", key: "PageDown" }
      ]
    })
  );

  cases.push(
    runtime({
      id: "m2-timeout-restoration",
      body: `Marvin.Play("Timeout");`,
      expectedResult: "timeout",
      expectedFailureCode: "CONSOLE_WAIT_TIMEOUT",
      consoleAssertions: [exactLog("M2|THIS_LOG_DOES_NOT_EXIST", 1, 300)],
      objectAssertions: harnessEquals("CurrentScene", "Timeout")
    })
  );

  return matrix("GAM 215-equivalent Module 2", cases);
}

export function cancellationCase(moduleId: "m1" | "m2", originalContent: string, originalSha256: string): ScenarioCaseDefinition {
  return runtimeCase(originalContent, originalSha256, {
    id: `${moduleId}-cancellation-restoration`,
    body: `Marvin.Write("Cancellation", "${moduleId}");`,
    consoleAssertions: [exactLog(`${moduleId.toUpperCase()}|CANCEL|WAIT`, 1, 30000)],
    objectAssertions: harnessEquals("VisibleText", moduleId)
  });
}

function matrix(name: string, cases: ScenarioCaseDefinition[]): ScenarioMatrixDefinition {
  return {
    name,
    scenePath: CourseFixtureScene,
    compileTimeoutMs: 60000,
    zeroCompilerErrors: true,
    failFast: false,
    cleanupRequired: true,
    cases
  };
}

function runtimeCase(originalContent: string, originalSha256: string, options: RuntimeCaseOptions): ScenarioCaseDefinition {
  const marker = `COURSE|${options.id}`;
  const body = options.body.includes("return;") ? options.body : `${options.body}\n        print("${marker}");`;
  const source = studentSource(body, options.methodName ?? "Start");
  const assertions = options.consoleAssertions ?? [exactLog(marker)];
  if (options.expectedMarvinLog) assertions.push(exactLog(options.expectedMarvinLog));
  return {
    id: options.id,
    description: "Clean-room GAM 215-equivalent runtime case with Console, visible-state, screenshot, and restoration evidence.",
    expectedResult: options.expectedResult ?? "pass",
    expectedFailureCode: options.expectedFailureCode,
    timeoutMs: 90000,
    sourceMutations: [{ path: CourseFixtureScript, content: source, expectedSha256: originalSha256 }],
    inputs: options.inputs ?? [],
    consoleAssertions: assertions,
    screenshotAssertions: [{ label: options.id, mode: "mainCamera", width: 320, height: 180, superSize: 1 }],
    objectAssertions: options.objectAssertions ?? harnessEquals("CallCount", 1)
  };
}

function studentSource(body: string, methodName = "Start"): string {
  return `using UnityEngine;

public sealed class StudentExercise : MonoBehaviour
{
    private void ${methodName}()
    {
        ${body}
    }
}
`;
}

function compileFailure(id: string, content: string, originalSha256: string): ScenarioCaseDefinition {
  const codes = seededCompilerCodes[id];
  if (!codes) throw new Error(`Seeded compiler case ${id} needs explicit diagnostic expectations.`);
  return {
    id,
    description: "Expected compiler failure from a deliberately seeded clean-room student-code defect.",
    expectedResult: "compile-failure",
    expectedFailureCode: "SCENARIO_COMPILE_FAILED",
    expectedCompilerDiagnostics: codes.map((code) => ({ file: CourseFixtureScript, severity: "error", code })),
    timeoutMs: 90000,
    sourceMutations: [{ path: CourseFixtureScript, content, expectedSha256: originalSha256 }]
  };
}

function semanticFailure(
  runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition,
  id: string,
  body: string,
  propertyPath: string,
  expected: unknown
): ScenarioCaseDefinition {
  return runtime({
    id,
    body,
    expectedResult: "assertion-failure",
    expectedFailureCode: "RUNTIME_ASSERTION_FAILED",
    objectAssertions: harnessEquals(propertyPath, expected)
  });
}

function branchCase(runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition, id: string, hasItem: boolean, expected: string): ScenarioCaseDefinition {
  return runtime({
    id,
    body: `bool localHasItem = ${hasItem ? "true" : "false"};
        if (localHasItem)
        {
            Marvin.Draw("Branch", "Outcome", "Candle");
        }
        else
        {
            Marvin.Draw("Branch", "Outcome", "Shining");
        }`,
    expectedMarvinLog: `MARVIN|Draw|Branch|Outcome|${expected}|true`,
    objectAssertions: harnessEquals("VisibleText", expected)
  });
}

function notCase(runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition, hasShield: boolean): ScenarioCaseDefinition {
  const expected = hasShield ? "Safe" : "Hurt";
  return runtime({
    id: `m2-not-${hasShield ? "true" : "false"}`,
    body: `bool localHasShield = ${hasShield ? "true" : "false"};
        if (!localHasShield)
        {
            Marvin.Draw("Mountain", "Hero", "Hurt");
        }
        else
        {
            Marvin.Draw("Mountain", "Hero", "Safe");
        }`,
    expectedMarvinLog: `MARVIN|Draw|Mountain|Hero|${expected}|true`,
    objectAssertions: harnessEquals("VisibleText", expected)
  });
}

function logicCase(
  runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition,
  operator: "or" | "and",
  left: boolean,
  right: boolean,
  expected: string
): ScenarioCaseDefinition {
  const expression = operator === "or" ? "localLeft || localRight" : "localLeft && localRight";
  const id = `m2-${operator}-${left}-${right}`;
  return runtime({
    id,
    body: `bool localLeft = ${left};
        bool localRight = ${right};
        if (${expression})
        {
            Marvin.Draw("Logic", "Outcome", "${operator === "or" ? "Healing" : "Dying"}");
        }
        else
        {
            Marvin.Draw("Logic", "Outcome", "${operator === "or" ? "No Healing" : "Escaped"}");
        }`,
    expectedMarvinLog: `MARVIN|Draw|Logic|Outcome|${expected}|true`,
    objectAssertions: harnessEquals("VisibleText", expected)
  });
}

function comparisonCase(
  runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition,
  family: string,
  operator: string,
  leftDeclaration: string,
  rightDeclaration: string,
  expected: string,
  suffix = "same"
): ScenarioCaseDefinition {
  return runtime({
    id: `m2-comparison-${family}-${suffix}`,
    body: `${leftDeclaration}
        ${rightDeclaration}
        if (localLeft ${operator} localRight)
        {
            Marvin.Draw("Comparison", "Outcome", "${family === "neq" ? "Different" : "Equal"}");
        }
        else
        {
            Marvin.Draw("Comparison", "Outcome", "${family === "neq" ? "Same" : "Different"}");
        }`,
    expectedMarvinLog: `MARVIN|Draw|Comparison|Outcome|${expected}|true`,
    objectAssertions: harnessEquals("VisibleText", expected)
  });
}

function orderedComparisonCases(
  runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition,
  family: string,
  operator: string,
  type: "int" | "float",
  values: number[],
  boundary: number
): ScenarioCaseDefinition[] {
  return values.map((value, index) => {
    const relation = ["below", "equal", "above"][index];
    const condition = evaluateOrdered(value, boundary, operator);
    const expected = condition ? "Condition True" : "Condition False";
    const format = (item: number) => (type === "float" ? `${item.toFixed(1)}f` : String(item));
    return runtime({
      id: `m2-comparison-${family}-${relation}`,
      body: `${type} localLeft = ${format(value)};
        ${type} localRight = ${format(boundary)};
        if (localLeft ${operator} localRight)
        {
            Marvin.Draw("Comparison", "Outcome", "Condition True");
        }
        else
        {
            Marvin.Draw("Comparison", "Outcome", "Condition False");
        }`,
      expectedMarvinLog: `MARVIN|Draw|Comparison|Outcome|${expected}|true`,
      objectAssertions: harnessEquals("VisibleText", expected)
    });
  });
}

function evaluateOrdered(left: number, right: number, operator: string): boolean {
  switch (operator) {
    case "<=":
      return left <= right;
    case "<":
      return left < right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      throw new Error(`Unsupported comparison operator: ${operator}`);
  }
}

function wiringCase(
  runtime: (options: RuntimeCaseOptions) => ScenarioCaseDefinition,
  id: string,
  batteringRam: boolean,
  catapult: boolean,
  expectedResult: "pass" | "assertion-failure"
): ScenarioCaseDefinition {
  return runtime({
    id,
    body: `bool localHasBatteringRam = ${batteringRam};
        bool localHasCatapult = ${catapult};
        Marvin.ShowOrHide("Fortress", "Battering Ram", localHasBatteringRam);
        // Deliberate semantic defect: the catapult is wired to the battering-ram variable.
        Marvin.ShowOrHide("Fortress", "Catapult", localHasBatteringRam);
        print("M2|WIRE|expected-catapult|" + localHasCatapult);`,
    expectedResult,
    expectedFailureCode: expectedResult === "assertion-failure" ? "RUNTIME_ASSERTION_FAILED" : undefined,
    consoleAssertions: [exactLog(`M2|WIRE|expected-catapult|${catapult ? "True" : "False"}`)],
    expectedMarvinLog: `MARVIN|ShowOrHide|Fortress|Catapult|${batteringRam}|${batteringRam}`,
    objectAssertions: harnessEquals("Visible", catapult)
  });
}

function harnessEquals(propertyPath: string, equals: unknown): ScenarioObjectAssertion[] {
  return [{ name: CourseHarnessObject, component: CourseHarnessComponent, propertyPath, equals }];
}

function exactLog(exact: string, count = 1, timeoutMs = 5000): ScenarioConsoleAssertion {
  return { severity: "log", exact, count, timeoutMs };
}
