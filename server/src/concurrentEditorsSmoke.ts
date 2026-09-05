import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rmdir, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import WebSocket from "ws";
import { projectIdForPath } from "./config.js";
import { certifiedUnityVersion, stopOwnedProcess, unityEditorPath } from "./testing/unityEditor.js";
import { BridgeStartupError, isExpectedEndpointConflict, type BridgeStartupFailure } from "./testing/bridgeStartupEvidence.js";

const workspaceRoot = resolve();
const fixtureRoot = resolve(workspaceRoot, "test-project");
const packageRoot = resolve(workspaceRoot, "Packages", "com.crispywonton.unity-mcp-ghost");
const logRoot = resolve(fixtureRoot, "Logs", "concurrent-editors");
const editorPath = unityEditorPath();
const editorStartupTimeoutMs = 7 * 60 * 1000;

type PhaseName = "distinct" | "http-collision" | "websocket-collision";
type SignalName = "SIGINT" | "SIGTERM";

interface BridgePorts {
  port: number;
  webSocketPort: number;
}

interface BridgeIdentity extends BridgePorts {
  schemaVersion: number;
  projectId: string;
  editorInstanceId: string;
  projectRoot: string;
  running: boolean;
  heartbeatUtc: string;
  packageVersion: string;
  unityVersion: string;
  tokenFile: string;
  startupFailure?: BridgeStartupFailure | null;
}

interface PreparedProject {
  label: string;
  phase: PhaseName;
  projectPath: string;
  ports: BridgePorts;
}

interface ManagedEditor extends PreparedProject {
  logPath: string;
  child: ReturnType<typeof spawn>;
  startupError?: Error;
}

interface Check {
  name: string;
  ok: boolean;
  observed: unknown;
}

interface RpcResponse {
  status: number;
  body: {
    result?: Record<string, unknown>;
    error?: { data?: { code?: unknown } };
  };
}

interface Evidence {
  schemaVersion: 2;
  ok: boolean;
  mode: "full" | "self-cancel";
  startedAt: string;
  completedAt?: string;
  cancelled: boolean;
  cancellationSignal: SignalName | null;
  certifiedUnityVersion: string;
  editorPath: string;
  temporaryWorkspace: string;
  projects: Array<Omit<BridgeIdentity, "tokenFile"> & { label: string; phase: PhaseName }>;
  checks: Check[];
  cleanup: {
    editorProcessesStopped: boolean;
    registryEntriesRemoved: string[];
    temporaryWorkspaceRemoved: boolean;
  };
  error: string | null;
}

interface RunContext {
  evidence: Evidence;
  cancellation: AbortController;
  editors: ManagedEditor[];
  preparedProjects: PreparedProject[];
  identities: BridgeIdentity[];
  removedRegistryPaths: Set<string>;
}

interface PhaseCleanup {
  ok: boolean;
  error?: Error;
  registryPaths: string[];
}

class RunnerCancelledError extends Error {
  constructor(public readonly signalName: SignalName) {
    super(`Concurrent-Editor certification cancelled by ${signalName}.`);
    this.name = "RunnerCancelledError";
  }
}

async function main(): Promise<void> {
  if (platform() !== "win32") {
    throw new Error("The concurrent-Editor certification runner currently targets the advertised Windows baseline only.");
  }
  if (!process.env.LOCALAPPDATA) {
    throw new Error("LOCALAPPDATA is required to verify and clean the per-project discovery registry.");
  }

  await access(editorPath);
  await Promise.all([
    access(resolve(fixtureRoot, "Assets")),
    access(resolve(fixtureRoot, "Packages")),
    access(resolve(fixtureRoot, "ProjectSettings")),
    access(packageRoot)
  ]);
  await mkdir(logRoot, { recursive: true });

  const selfCancel = process.argv.includes("--self-cancel-after-ready");
  const evidencePath = resolve(fixtureRoot, "Logs", selfCancel ? "concurrent-editors-cancellation-result.json" : "concurrent-editors-result.json");
  const temporaryWorkspace = await mkdtemp(resolve(tmpdir(), "unity-mcp-ghost-concurrent-"));
  const evidence: Evidence = {
    schemaVersion: 2,
    ok: false,
    mode: selfCancel ? "self-cancel" : "full",
    startedAt: new Date().toISOString(),
    cancelled: false,
    cancellationSignal: null,
    certifiedUnityVersion,
    editorPath,
    temporaryWorkspace,
    projects: [],
    checks: [],
    cleanup: { editorProcessesStopped: false, registryEntriesRemoved: [], temporaryWorkspaceRemoved: false },
    error: null
  };
  const context: RunContext = {
    evidence,
    cancellation: new AbortController(),
    editors: [],
    preparedProjects: [],
    identities: [],
    removedRegistryPaths: new Set<string>()
  };
  let receivedSignal: SignalName | undefined;
  const cancel = (signalName: SignalName): void => {
    if (context.cancellation.signal.aborted) return;
    receivedSignal = signalName;
    evidence.cancelled = true;
    evidence.cancellationSignal = signalName;
    context.cancellation.abort(new RunnerCancelledError(signalName));
  };
  const onSigint = (): void => cancel("SIGINT");
  const onSigterm = (): void => cancel("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let runError: Error | undefined;
  try {
    await runDistinctPhase(context, temporaryWorkspace, selfCancel ? () => process.emit("SIGTERM") : undefined);
    await runCollisionPhase(context, temporaryWorkspace, "http-collision");
    await runCollisionPhase(context, temporaryWorkspace, "websocket-collision");
  } catch (error) {
    runError = asError(error);
  } finally {
    const finalCleanup = await cleanupPhase(context, context.editors, context.preparedProjects);
    if (!finalCleanup.ok) runError = combineErrors(runError, finalCleanup.error!);
    evidence.cleanup.editorProcessesStopped = context.editors.every(hasExited);
    if (!evidence.cleanup.editorProcessesStopped) {
      runError = combineErrors(runError, new Error("One or more Unity Editor processes did not stop cleanly."));
    }

    try {
      await removeTemporaryWorkspace(temporaryWorkspace);
      evidence.cleanup.temporaryWorkspaceRemoved = !(await pathExists(temporaryWorkspace));
      if (!evidence.cleanup.temporaryWorkspaceRemoved) throw new Error(`Temporary workspace still exists: ${temporaryWorkspace}`);
    } catch (error) {
      runError = combineErrors(runError, asError(error));
    }

    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    evidence.completedAt = new Date().toISOString();
    evidence.error = runError?.message ?? null;
    const cleanupComplete = evidence.cleanup.editorProcessesStopped && evidence.cleanup.temporaryWorkspaceRemoved;
    const checksPassed = evidence.checks.every((check) => check.ok);
    evidence.ok = selfCancel
      ? receivedSignal === "SIGTERM" && runError instanceof RunnerCancelledError && checksPassed && cleanupComplete
      : !runError && checksPassed && cleanupComplete;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  if (!evidence.ok) throw runError ?? new Error("Concurrent-Editor certification did not satisfy its evidence contract.");
  const outcome = selfCancel ? "Cancellation cleanup" : "Concurrent Unity Editor routing";
  process.stdout.write(`${outcome} passed ${evidence.checks.length} checks. Evidence: ${evidencePath}\n`);
}

async function runDistinctPhase(context: RunContext, root: string, triggerCancellation?: () => void): Promise<void> {
  const [projectAPath, projectBPath] = selectDistinctProjectPaths(resolve(root, "distinct"));
  const projects: PreparedProject[] = [
    createPreparedProject("distinct-project-a", "distinct", projectAPath),
    createPreparedProject("distinct-project-b", "distinct", projectBPath)
  ];
  let phaseError: Error | undefined;
  let cleanup: PhaseCleanup | undefined;

  try {
    await prepareAndStart(context, projects);
    const editors = editorsForProjects(context, projects);
    const readiness = await Promise.allSettled(editors.map((editor) => waitForBridge(editor, editorStartupTimeoutMs, context.cancellation.signal)));
    retainFulfilledIdentities(context, readiness);
    const rejected = readiness.filter((result) => result.status === "rejected");
    if (rejected.length > 0) throw asError(rejected[0].reason);
    const identities = readiness.map((result) => (result as PromiseFulfilledResult<BridgeIdentity>).value);
    addEvidenceProjects(context.evidence, projects, identities);

    record(
      context.evidence,
      "both Unity Editor processes remain live",
      editors.every((editor) => !hasExited(editor)),
      processStates(editors)
    );
    record(
      context.evidence,
      "both bridges report the certified Unity version",
      identities.every((identity) => identity.unityVersion === certifiedUnityVersion),
      { unityVersions: identities.map((identity) => identity.unityVersion) }
    );
    record(
      context.evidence,
      "each bridge reports its exact temporary project root",
      identities.every((identity, index) => samePath(identity.projectRoot, projects[index].projectPath)),
      { reported: identities.map((identity) => identity.projectRoot), expected: projects.map((project) => project.projectPath) }
    );
    record(
      context.evidence,
      "each bridge uses the deterministic ports for its selected project",
      identities.every((identity, index) => identity.port === projects[index].ports.port && identity.webSocketPort === projects[index].ports.webSocketPort),
      { actual: identities.map(toPorts), expected: projects.map((project) => project.ports) }
    );
    record(
      context.evidence,
      "concurrent projects have distinct identities and endpoints",
      new Set(identities.map((identity) => identity.projectId)).size === 2 &&
        new Set(identities.map((identity) => identity.editorInstanceId)).size === 2 &&
        new Set(identities.map((identity) => identity.port)).size === 2 &&
        new Set(identities.map((identity) => identity.webSocketPort)).size === 2,
      {
        projectIds: identities.map((identity) => identity.projectId),
        editorInstanceIds: identities.map((identity) => identity.editorInstanceId),
        httpPorts: identities.map((identity) => identity.port),
        webSocketPorts: identities.map((identity) => identity.webSocketPort)
      }
    );

    const tokens = await Promise.all(identities.map(readToken));
    record(
      context.evidence,
      "project bridge tokens are independently generated",
      tokens.every((token) => /^[0-9a-f]{64}$/i.test(token)) && tokens[0] !== tokens[1],
      { validTokenLengths: tokens.map((token) => token.length) }
    );

    if (triggerCancellation) {
      record(context.evidence, "signal-handler cancellation begins only after both bridges are ready", true, processStates(editors));
      triggerCancellation();
      throwIfCancelled(context.cancellation.signal);
    }

    const [healthA, healthB] = await Promise.all([
      postRpc(identities[0], tokens[0], identities[0].projectId, identities[0].editorInstanceId, context.cancellation.signal),
      postRpc(identities[1], tokens[1], identities[1].projectId, identities[1].editorInstanceId, context.cancellation.signal)
    ]);
    record(
      context.evidence,
      "authenticated HTTP health remains pinned to each live Editor",
      healthMatches(healthA, identities[0]) && healthMatches(healthB, identities[1]),
      { projectA: summarizeRpc(healthA), projectB: summarizeRpc(healthB) }
    );

    const [socketA, socketB] = await Promise.all([
      websocketRpc(identities[0], tokens[0], identities[0].projectId, identities[0].editorInstanceId, context.cancellation.signal),
      websocketRpc(identities[1], tokens[1], identities[1].projectId, identities[1].editorInstanceId, context.cancellation.signal)
    ]);
    record(
      context.evidence,
      "authenticated WebSocket health remains pinned to each live Editor",
      healthMatches(socketA, identities[0]) && healthMatches(socketB, identities[1]),
      { projectA: summarizeRpc(socketA), projectB: summarizeRpc(socketB) }
    );

    const wrongProject = await postRpc(identities[0], tokens[0], identities[1].projectId, identities[0].editorInstanceId, context.cancellation.signal);
    record(
      context.evidence,
      "cross-project HTTP pinning is rejected without fallback",
      errorCode(wrongProject) === "PROJECT_ID_MISMATCH",
      summarizeRpc(wrongProject)
    );

    const wrongEditor = await postRpc(identities[0], tokens[0], identities[0].projectId, identities[1].editorInstanceId, context.cancellation.signal);
    record(
      context.evidence,
      "cross-Editor HTTP pinning is rejected without fallback",
      errorCode(wrongEditor) === "EDITOR_INSTANCE_ID_MISMATCH",
      summarizeRpc(wrongEditor)
    );

    const wrongToken = await postRpc(identities[0], tokens[1], identities[0].projectId, identities[0].editorInstanceId, context.cancellation.signal);
    record(context.evidence, "one project's token cannot authenticate to the other HTTP bridge", wrongToken.status === 401, {
      status: wrongToken.status
    });

    const wrongSocketProject = await websocketRpc(
      identities[0],
      tokens[0],
      identities[1].projectId,
      identities[0].editorInstanceId,
      context.cancellation.signal
    );
    record(
      context.evidence,
      "cross-project WebSocket pinning is rejected without fallback",
      errorCode(wrongSocketProject) === "PROJECT_ID_MISMATCH",
      summarizeRpc(wrongSocketProject)
    );

    const wrongSocketEditor = await websocketRpc(
      identities[0],
      tokens[0],
      identities[0].projectId,
      identities[1].editorInstanceId,
      context.cancellation.signal
    );
    record(
      context.evidence,
      "cross-Editor WebSocket pinning is rejected without fallback",
      errorCode(wrongSocketEditor) === "EDITOR_INSTANCE_ID_MISMATCH",
      summarizeRpc(wrongSocketEditor)
    );

    const wrongSocketToken = await websocketRpc(identities[0], tokens[1], identities[0].projectId, identities[0].editorInstanceId, context.cancellation.signal);
    record(context.evidence, "one project's token cannot authenticate to the other WebSocket bridge", wrongSocketToken.status === 401, {
      status: wrongSocketToken.status
    });

    const registries = await Promise.all(identities.map(readRegistry));
    registries.forEach((registry, index) => {
      const identity = identities[index];
      record(
        context.evidence,
        `discovery registry ${index + 1} identifies the exact live project and Editor`,
        registry.projectId === identity.projectId &&
          registry.editorInstanceId === identity.editorInstanceId &&
          registry.port === identity.port &&
          registry.webSocketPort === identity.webSocketPort &&
          registry.running === true,
        summarizeIdentity(registry)
      );
    });
  } catch (error) {
    phaseError = asError(error);
  } finally {
    cleanup = await cleanupPhase(context, editorsForProjects(context, projects), projects);
  }

  recordCleanup(context.evidence, "distinct-endpoint phase cleans both Editors and discovery entries", cleanup!);
  if (phaseError) throw phaseError;
  if (!cleanup!.ok) throw cleanup!.error;
}

async function runCollisionPhase(context: RunContext, root: string, phase: "http-collision" | "websocket-collision"): Promise<void> {
  const projects = collisionProjects(resolve(root, phase), phase);
  let phaseError: Error | undefined;
  let cleanup: PhaseCleanup | undefined;

  try {
    await prepareAndStart(context, projects);
    const editors = editorsForProjects(context, projects);
    const readiness = await Promise.allSettled(editors.map((editor) => waitForBridge(editor, editorStartupTimeoutMs, context.cancellation.signal)));
    retainFulfilledIdentities(context, readiness);
    const recovered = await recoverIdentities(projects);
    recovered.forEach((identity) => retainIdentity(context, identity));
    addEvidenceProjects(context.evidence, projects, recovered);

    const successes = readiness.filter((result): result is PromiseFulfilledResult<BridgeIdentity> => result.status === "fulfilled");
    const failures = readiness.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const transport = phase === "http-collision" ? "http" : "websocket";
    const conflictPort = transport === "http" ? projects[0].ports.port : projects[0].ports.webSocketPort;
    const conflictFailures = failures.filter((result) => isExpectedEndpointConflict(result.reason, transport, conflictPort));
    record(
      context.evidence,
      `${phase} produces one ready bridge and one bind conflict on the exact configured transport and port`,
      successes.length === 1 && failures.length === 1 && conflictFailures.length === 1,
      {
        expectedConflict: { transport, port: conflictPort },
        readyProjects: successes.map((result) => result.value.projectId),
        failures: failures.map((result) => ({
          code: result.reason instanceof BridgeStartupError ? result.reason.code : "UNEXPECTED_STARTUP_FAILURE",
          message: asError(result.reason).message,
          startupFailure: result.reason instanceof BridgeStartupError ? (result.reason.identity.startupFailure ?? null) : null
        }))
      }
    );
    record(
      context.evidence,
      `${phase} leaves both Unity Editor processes live while only one bridge owns the endpoint`,
      editors.every((editor) => !hasExited(editor)) && recovered.filter((identity) => identity.running).length === 1,
      { ...processStates(editors), identities: recovered.map(summarizeIdentity) }
    );
    record(
      context.evidence,
      `${phase} reports the configured HTTP and WebSocket ports for both startup attempts`,
      recovered.length === projects.length &&
        recovered.every((identity) => {
          const project = projects.find((candidate) => samePath(candidate.projectPath, identity.projectRoot));
          return project && identity.port === project.ports.port && identity.webSocketPort === project.ports.webSocketPort;
        }),
      { configured: projects.map((project) => project.ports), reported: recovered.map(toPorts) }
    );

    const winner = recovered.find((identity) => identity.running);
    const loser = recovered.find((identity) => !identity.running);
    if (!winner || !loser) throw new Error(`${phase} did not expose an unambiguous winning and losing bridge identity.`);
    const winnerToken = await readToken(winner);
    const loserToken = await readToken(loser);

    if (phase === "http-collision") {
      record(
        context.evidence,
        "forced HTTP collision uses the same configured port",
        projects[0].ports.port === projects[1].ports.port && recovered.every((identity) => identity.port === projects[0].ports.port),
        { configured: projects.map((project) => project.ports), reported: recovered.map(toPorts) }
      );
      const pinnedLoser = await postRpc(winner, winnerToken, loser.projectId, loser.editorInstanceId, context.cancellation.signal);
      record(
        context.evidence,
        "HTTP collision cannot route a losing project pin through the occupied endpoint",
        errorCode(pinnedLoser) === "PROJECT_ID_MISMATCH",
        summarizeRpc(pinnedLoser)
      );
      const foreignToken = await postRpc(winner, loserToken, loser.projectId, loser.editorInstanceId, context.cancellation.signal);
      record(context.evidence, "HTTP collision rejects the losing project's token at the occupied endpoint", foreignToken.status === 401, {
        status: foreignToken.status
      });
    } else {
      record(
        context.evidence,
        "forced WebSocket collision uses the same configured port and distinct HTTP ports",
        projects[0].ports.webSocketPort === projects[1].ports.webSocketPort && projects[0].ports.port !== projects[1].ports.port,
        { configured: projects.map((project) => project.ports), reported: recovered.map(toPorts) }
      );
      const pinnedLoser = await websocketRpc(winner, winnerToken, loser.projectId, loser.editorInstanceId, context.cancellation.signal);
      record(
        context.evidence,
        "WebSocket collision cannot route a losing project pin through the occupied endpoint",
        errorCode(pinnedLoser) === "PROJECT_ID_MISMATCH",
        summarizeRpc(pinnedLoser)
      );
      const foreignToken = await websocketRpc(winner, loserToken, loser.projectId, loser.editorInstanceId, context.cancellation.signal);
      record(context.evidence, "WebSocket collision rejects the losing project's token at the occupied endpoint", foreignToken.status === 401, {
        status: foreignToken.status
      });
    }
  } catch (error) {
    phaseError = asError(error);
  } finally {
    cleanup = await cleanupPhase(context, editorsForProjects(context, projects), projects);
  }

  recordCleanup(context.evidence, `${phase} partial-startup path cleans both Editors and both discovery entries`, cleanup!);
  if (phaseError) throw phaseError;
  if (!cleanup!.ok) throw cleanup!.error;
}

function selectDistinctProjectPaths(root: string): [string, string] {
  const first = resolve(root, "project-a");
  const firstPorts = deterministicPorts(first);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const second = resolve(root, `project-b-${suffix}`);
    const secondPorts = deterministicPorts(second);
    if (firstPorts.port !== secondPorts.port && firstPorts.webSocketPort !== secondPorts.webSocketPort) return [first, second];
  }
  throw new Error("Could not derive two temporary project paths with distinct deterministic ports.");
}

function collisionProjects(root: string, phase: "http-collision" | "websocket-collision"): PreparedProject[] {
  const [firstPath, secondPath] = selectDistinctProjectPaths(root);
  const firstPorts = deterministicPorts(firstPath);
  const secondPorts = deterministicPorts(secondPath);
  const forcedSecondPorts =
    phase === "http-collision"
      ? { port: firstPorts.port, webSocketPort: secondPorts.webSocketPort }
      : { port: secondPorts.port, webSocketPort: firstPorts.webSocketPort };
  return [
    { label: `${phase}-project-a`, phase, projectPath: firstPath, ports: firstPorts },
    { label: `${phase}-project-b`, phase, projectPath: secondPath, ports: forcedSecondPorts }
  ];
}

function createPreparedProject(label: string, phase: PhaseName, projectPath: string): PreparedProject {
  return { label, phase, projectPath, ports: deterministicPorts(projectPath) };
}

async function prepareAndStart(context: RunContext, projects: PreparedProject[]): Promise<void> {
  throwIfCancelled(context.cancellation.signal);
  context.preparedProjects.push(...projects);
  await Promise.all(projects.map(prepareProject));
  for (const project of projects) context.editors.push(startEditor(project));
}

async function prepareProject(project: PreparedProject): Promise<void> {
  await mkdir(project.projectPath, { recursive: true });
  await Promise.all(
    ["Assets", "Packages", "ProjectSettings"].map((directory) =>
      cp(resolve(fixtureRoot, directory), resolve(project.projectPath, directory), { recursive: true })
    )
  );
  const manifestPath = resolve(project.projectPath, "Packages", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
  manifest.dependencies ??= {};
  manifest.dependencies["com.crispywonton.unity-mcp-ghost"] = `file:${packageRoot.replaceAll("\\", "/")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(resolve(project.projectPath, "Packages", "packages-lock.json"), { force: true });

  const stateRoot = resolve(project.projectPath, "Library", "UnityMcpGhost");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    resolve(stateRoot, "bridge-settings.json"),
    `${JSON.stringify(
      {
        Port: project.ports.port,
        WebSocketPort: project.ports.webSocketPort,
        AutoStart: true,
        AllowDestructive: false,
        AllowPackageNetwork: false,
        AllowArbitraryCode: false,
        AllowReflection: false,
        PackageSourceAllowlist: ["com.unity."]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function startEditor(project: PreparedProject): ManagedEditor {
  const logPath = resolve(logRoot, `${project.label}.log`);
  const editor: ManagedEditor = {
    ...project,
    logPath,
    child: spawn(editorPath, ["-batchmode", "-nographics", "-projectPath", project.projectPath, "-logFile", logPath], {
      stdio: "ignore",
      windowsHide: true
    })
  };
  editor.child.once("error", (error) => {
    editor.startupError = error;
  });
  return editor;
}

async function waitForBridge(editor: ManagedEditor, timeoutMs: number, signal: AbortSignal): Promise<BridgeIdentity> {
  const identityPath = identityPathForProject(editor.projectPath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    if (editor.startupError) throw new Error(`${editor.label} failed to start: ${editor.startupError.message}`);
    if (hasExited(editor)) {
      throw new Error(`${editor.label} exited with code ${editor.child.exitCode ?? editor.child.signalCode}. See ${editor.logPath}`);
    }
    try {
      const identity = JSON.parse(await readFile(identityPath, "utf8")) as BridgeIdentity;
      if (isFreshIdentity(identity, editor.projectPath)) {
        if (!identity.running) throw new BridgeStartupError(identity, editor.label);
        const token = await readToken(identity);
        const health = await postRpc(identity, token, identity.projectId, identity.editorInstanceId, signal);
        if (healthMatches(health, identity)) return identity;
      }
    } catch (error) {
      if (error instanceof BridgeStartupError || signal.aborted) throw error;
      // The package may still be resolving, compiling, starting, or publishing its identity atomically.
    }
    await delay(500, signal);
  }
  throw new Error(`${editor.label} bridge did not become ready within ${timeoutMs} ms. See ${editor.logPath}`);
}

function isFreshIdentity(identity: BridgeIdentity, projectPath: string): boolean {
  const heartbeat = Date.parse(identity.heartbeatUtc);
  return identity.schemaVersion === 1 && Number.isFinite(heartbeat) && Date.now() - heartbeat < 30_000 && samePath(identity.projectRoot, projectPath);
}

function retainFulfilledIdentities(context: RunContext, results: PromiseSettledResult<BridgeIdentity>[]): void {
  results.forEach((result) => {
    if (result.status === "fulfilled") retainIdentity(context, result.value);
  });
}

function retainIdentity(context: RunContext, identity: BridgeIdentity): void {
  if (!context.identities.some((candidate) => identityKey(candidate) === identityKey(identity))) context.identities.push(identity);
}

function addEvidenceProjects(evidence: Evidence, projects: PreparedProject[], identities: BridgeIdentity[]): void {
  identities.forEach(({ tokenFile: _tokenFile, ...identity }) => {
    const project = projects.find((candidate) => samePath(candidate.projectPath, identity.projectRoot));
    if (!project) throw new Error(`Recovered an identity outside the prepared phase projects: ${identity.projectRoot}`);
    if (evidence.projects.some((candidate) => identityKey(candidate) === identityKey(identity))) return;
    evidence.projects.push({ ...identity, label: project.label, phase: project.phase });
  });
}

async function recoverIdentities(projects: PreparedProject[]): Promise<BridgeIdentity[]> {
  const results = await Promise.allSettled(
    projects.map(async (project) => JSON.parse(await readFile(identityPathForProject(project.projectPath), "utf8")) as BridgeIdentity)
  );
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

async function cleanupPhase(context: RunContext, editors: ManagedEditor[], projects: PreparedProject[]): Promise<PhaseCleanup> {
  let cleanupError: Error | undefined;
  const processResults = await Promise.allSettled(editors.map(stopEditor));
  processResults.forEach((result, index) => {
    if (result.status === "rejected" || !hasExited(editors[index])) {
      cleanupError = combineErrors(cleanupError, result.status === "rejected" ? asError(result.reason) : new Error(`${editors[index].label} did not stop.`));
    }
  });

  const recovered = await recoverIdentities(projects);
  recovered.forEach((identity) => retainIdentity(context, identity));
  const phasePaths = new Set(projects.map((project) => normalizePath(project.projectPath)));
  const cleanupIdentities = context.identities.filter((identity) => phasePaths.has(normalizePath(identity.projectRoot)));
  const registryCandidates = new Set(cleanupIdentities.map(registryPath));
  const discoveredRegistryResults = await Promise.allSettled(projects.map(registryPathsForProject));
  discoveredRegistryResults.forEach((result) => {
    if (result.status === "fulfilled") {
      result.value.forEach((path) => registryCandidates.add(path));
    } else {
      cleanupError = combineErrors(cleanupError, asError(result.reason));
    }
  });
  const registryResults = await Promise.allSettled([...registryCandidates].map(removeRegistryPath));
  const registryPaths: string[] = [];
  registryResults.forEach((result) => {
    if (result.status === "fulfilled") {
      registryPaths.push(result.value);
      context.removedRegistryPaths.add(result.value);
    } else {
      cleanupError = combineErrors(cleanupError, asError(result.reason));
    }
  });
  context.evidence.cleanup.registryEntriesRemoved = [...context.removedRegistryPaths].sort();

  const remainingRegistryResults = await Promise.allSettled(projects.map(registryPathsForProject));
  for (const result of remainingRegistryResults) {
    if (result.status === "rejected") {
      cleanupError = combineErrors(cleanupError, asError(result.reason));
    } else if (result.value.length > 0) {
      cleanupError = combineErrors(cleanupError, new Error(`Discovery registry entries remain after cleanup: ${result.value.join(", ")}`));
    }
  }
  return { ok: !cleanupError, error: cleanupError, registryPaths };
}

function recordCleanup(evidence: Evidence, name: string, cleanup: PhaseCleanup): void {
  evidence.checks.push({ name, ok: cleanup.ok, observed: { registryPaths: cleanup.registryPaths, error: cleanup.error?.message } });
}

async function stopEditor(editor: ManagedEditor): Promise<void> {
  await stopOwnedProcess(editor.child);
}

function hasExited(editor: ManagedEditor): boolean {
  return editor.child.exitCode !== null || editor.child.signalCode !== null;
}

async function postRpc(
  identity: BridgeIdentity,
  token: string,
  projectId: string,
  editorInstanceId: string,
  cancellationSignal: AbortSignal
): Promise<RpcResponse> {
  const id = randomUUID();
  const response = await fetch(`http://127.0.0.1:${identity.port}/unity-mcp-ghost/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(rpcPayload(id, projectId, editorInstanceId)),
    signal: AbortSignal.any([cancellationSignal, AbortSignal.timeout(5000)])
  });
  const text = await response.text();
  let body: RpcResponse["body"] = {};
  if (text) {
    try {
      body = JSON.parse(text) as RpcResponse["body"];
    } catch {
      body = {};
    }
  }
  return { status: response.status, body };
}

function websocketRpc(
  identity: BridgeIdentity,
  token: string,
  projectId: string,
  editorInstanceId: string,
  cancellationSignal: AbortSignal
): Promise<RpcResponse> {
  return new Promise((resolveResponse, reject) => {
    const id = randomUUID();
    const socket = new WebSocket(`ws://127.0.0.1:${identity.webSocketPort}/unity-mcp-ghost/`, {
      headers: { authorization: `Bearer ${token}` }
    });
    let settled = false;
    const finish = (response: RpcResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancellationSignal.removeEventListener("abort", onAbort);
      socket.terminate();
      resolveResponse(response);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancellationSignal.removeEventListener("abort", onAbort);
      socket.terminate();
      reject(error);
    };
    const onAbort = (): void => fail(cancellationSignal.reason ?? new RunnerCancelledError("SIGTERM"));
    const timeout = setTimeout(() => fail(new Error(`WebSocket request timed out for ${identity.projectId}.`)), 10_000);
    cancellationSignal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => socket.send(JSON.stringify(rpcPayload(id, projectId, editorInstanceId))));
    socket.once("unexpected-response", (_request, response) => finish({ status: response.statusCode ?? 0, body: {} }));
    socket.once("message", (message) => {
      try {
        finish({ status: 101, body: JSON.parse(message.toString()) as RpcResponse["body"] });
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", fail);
  });
}

function rpcPayload(id: string, projectId: string, editorInstanceId: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    requestId: id,
    method: "health",
    params: {},
    deadlineUnixMs: Date.now() + 10_000,
    idempotencyKey: id,
    idempotent: true,
    projectId,
    editorInstanceId
  };
}

function healthMatches(response: RpcResponse, identity: BridgeIdentity): boolean {
  return (
    (response.status === 200 || response.status === 101) &&
    response.body.result?.ok === true &&
    response.body.result.projectId === identity.projectId &&
    response.body.result.editorInstanceId === identity.editorInstanceId
  );
}

function errorCode(response: RpcResponse): unknown {
  return response.body.error?.data?.code;
}

function summarizeRpc(response: RpcResponse): Record<string, unknown> {
  return {
    status: response.status,
    ok: response.body.result?.ok,
    projectId: response.body.result?.projectId,
    editorInstanceId: response.body.result?.editorInstanceId,
    errorCode: errorCode(response)
  };
}

function summarizeIdentity(identity: BridgeIdentity): Record<string, unknown> {
  return {
    projectId: identity.projectId,
    editorInstanceId: identity.editorInstanceId,
    projectRoot: identity.projectRoot,
    port: identity.port,
    webSocketPort: identity.webSocketPort,
    running: identity.running
  };
}

async function readToken(identity: BridgeIdentity): Promise<string> {
  return (await readFile(identity.tokenFile, "utf8")).trim();
}

async function readRegistry(identity: BridgeIdentity): Promise<BridgeIdentity> {
  return JSON.parse(await readFile(registryPath(identity), "utf8")) as BridgeIdentity;
}

async function removeRegistryPath(path: string): Promise<string> {
  const root = registryRoot();
  const resolved = resolve(path);
  if (!normalizePath(resolved).startsWith(`${normalizePath(root)}${sep}`) || !/^[0-9a-f]{32}\.json$/i.test(basename(resolved))) {
    throw new Error(`Refusing to remove an unexpected discovery registry path: ${resolved}`);
  }
  await rm(resolved, { force: true });
  if (await pathExists(resolved)) throw new Error(`Discovery registry entry was not removed: ${resolved}`);
  try {
    await rmdir(dirname(resolved));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
  return resolved;
}

function registryPath(identity: Pick<BridgeIdentity, "projectId" | "editorInstanceId">): string {
  return resolve(registryRoot(), identity.projectId, `${identity.editorInstanceId}.json`);
}

function registryRoot(): string {
  return resolve(process.env.LOCALAPPDATA!, "UnityMcpGhost", "editors");
}

async function registryPathsForProject(project: PreparedProject): Promise<string[]> {
  const directory = resolve(registryRoot(), projectIdForPath(project.projectPath));
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const paths: string[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/i.test(name)) {
      throw new Error(`Unexpected file in the owned discovery registry directory: ${resolve(directory, name)}`);
    }
    const path = resolve(directory, name);
    const identity = JSON.parse(await readFile(path, "utf8")) as BridgeIdentity;
    if (!samePath(identity.projectRoot, project.projectPath)) {
      throw new Error(`Discovery registry project root mismatch during cleanup: ${path}`);
    }
    paths.push(path);
  }
  return paths;
}

function identityPathForProject(projectPath: string): string {
  return resolve(projectPath, "Library", "UnityMcpGhost", "bridge-identity.json");
}

function deterministicPorts(projectPath: string): BridgePorts {
  const projectHash = projectIdForPath(projectPath).slice("unity-project-".length);
  return {
    port: 6400 + (Number.parseInt(projectHash.slice(0, 8), 16) % 1000),
    webSocketPort: 16400 + (Number.parseInt(projectHash.slice(8, 16), 16) % 10000)
  };
}

function toPorts(value: BridgePorts): BridgePorts {
  return { port: value.port, webSocketPort: value.webSocketPort };
}

function record(evidence: Evidence, name: string, ok: boolean, observed: unknown): void {
  evidence.checks.push({ name, ok, observed });
  if (!ok) throw new Error(`Concurrent-Editor check failed: ${name}`);
}

function processStates(editors: ManagedEditor[]): Record<string, unknown> {
  return {
    processStates: editors.map((editor) => ({ label: editor.label, exitCode: editor.child.exitCode, signalCode: editor.child.signalCode }))
  };
}

function editorsForProjects(context: RunContext, projects: PreparedProject[]): ManagedEditor[] {
  const paths = new Set(projects.map((project) => normalizePath(project.projectPath)));
  return context.editors.filter((editor) => paths.has(normalizePath(editor.projectPath)));
}

function identityKey(identity: Pick<BridgeIdentity, "projectId" | "editorInstanceId">): string {
  return `${identity.projectId}/${identity.editorInstanceId}`;
}

function normalizePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+$/, "")
    .toUpperCase();
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

async function removeTemporaryWorkspace(path: string): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const resolved = resolve(path);
  if (dirname(resolved) !== temporaryRoot || !basename(resolved).startsWith("unity-mcp-ghost-concurrent-")) {
    throw new Error(`Refusing to remove an unexpected temporary workspace: ${resolved}`);
  }
  if (!resolved.startsWith(`${temporaryRoot}${sep}`)) throw new Error(`Temporary workspace escaped the OS temporary directory: ${resolved}`);
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Concurrent-Editor certification was cancelled.");
}

function combineErrors(current: Error | undefined, next: Error): Error {
  return current ? new Error(`${current.message}; cleanup: ${next.message}`) : next;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  throwIfCancelled(signal);
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Concurrent-Editor certification was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
