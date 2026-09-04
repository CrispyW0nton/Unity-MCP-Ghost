# GAM 215-equivalent fixture

## Qualification

**GAM 215-equivalent fixture complete; real course-project certification pending.**

The repository fixture is a clean-room validation target. It does not contain Academy of Art University artwork, scenes, scripts, downloads, or other course assets. The actual Variablekiller and Conditionalkiller projects were not available for certification.

## Compatible helper surface

`test-project/Assets/GAM215Fixture/Gam215CourseHarness.cs` exposes the course call shapes used by the exported Module 1-2 pages:

```csharp
Marvin.Play(scene);
Marvin.Write(label, stringOrIntOrFloat);
Marvin.Write(scene, label, stringOrIntOrFloat);
Marvin.ShowOrHide(scene, target, visible);
Marvin.Draw(scene, target, state);
```

Calls update serialized deterministic state, emit an exact `MARVIN|...` Console receipt, and change a camera-rendered visual target. This lets scenario cases verify the same source statement through Console, object/property, and screenshot evidence without arbitrary reflection.

## Automated inventory

`npm run test:course` executes all cases through `scenario_matrix_run` and then creates evidence bundles.

Module 1 has 23 cases:

- valid `MonoBehaviour`/`Start`, line and block comments, and two `print` calls;
- string, int, float, zero, negative, declaration, assignment, and `f` suffix;
- two-argument `Marvin.Write` string/int/float overloads;
- `+`, `-`, `*`, `/`, variable assignment, and parentheses;
- integer `Random.Range(min, max + 1)` with observed inclusive course maximum;
- float `Random.Range(min, max)` coverage, explicitly labeled inferred because the exported course exercise is missing;
- compiler-red seeds for malformed comments, braces, quotes, semicolon, undeclared, unassigned, redeclared, use-before-declaration, and case-mismatched identifiers;
- runtime-red missing/wrong-case `Start` and semantic seeds for quoted variable, wrong variable, wrong type, wrong Marvin argument order, and wrong label/value;
- an expected timeout path.

Module 2 has 43 cases:

- false and true visibility for Candle, Key, Raft, and Ladder;
- both `if/else` branches and both unary `!` outcomes;
- all four `||` rows and all four `&&` rows;
- early `return` with a zero-count assertion proving later code did not run;
- exactly 16 comparison cases: two `==`, two `!=`, and below/equal/above for `<=`, `<`, `>`, and `>=`;
- sequential assertions after `=`, `++`, `--`, `+=`, `-=`, `*=`, and `/=`;
- paired same-value controls that conceal a deliberate wrong-variable wire, followed by an isolated-variable case that exposes it;
- verified PageUp and PageDown delivery with observed `1 -> 0` page state;
- an expected timeout path.

Every runtime case declares Console and serialized visible-state expectations. Every runtime case that reaches the observation phase also captures a bounded 320x180 screenshot. Compiler-red cases stop before Play mode by design.

## Restoration and evidence

Every case starts from the same required SHA-256, writes through a durable source transaction, waits for that exact compile generation, runs its assertions, stops Play mode, restores the original bytes, waits for the restoration generation, and verifies the original SHA-256. Each module also runs a separate externally cancelled job to prove `finally` restoration.

Evidence is written only under the selected project's ignored `Library/UnityMcpGhost/evidence/<operationId>` directory. Each bundle contains a manifest, machine-readable scenario results, generation-scoped compiler and Console logs, redacted source diffs, screenshots, and a concise Markdown summary. Nothing is uploaded.

## Reproduction

1. Open `test-project` in Unity `2022.3.62f1` and let the Ghost bridge start.
2. From the repository root, run `npm ci`, `npm run build`, then `npm run test:course`.
3. Read the printed operation IDs and manifest paths. A passing run reports the qualification above and proves both module source hashes are identical to the starting hash.

To certify the actual course projects later, use separately authorized, opt-in, non-destructive manifests after discovering their real scene and script paths. Do not commit or silently modify those assets; record discrepancies as evidence.
