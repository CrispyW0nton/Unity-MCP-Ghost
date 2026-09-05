import { isDeepStrictEqual } from "node:util";
import type { UnityClient } from "../unity/UnityClient.js";

type PlayState = "stopped" | "playing" | "paused";

export const DefaultFixtureScript = "Assets/GAM215Fixture/StudentExercise.cs";
const DefaultFixtureScene = "Assets/GAM215Fixture/RuntimeControlFixture.unity";

export function repairSmokeScene(scriptPath: string, explicitScene?: string): string | undefined {
  return explicitScene ?? (scriptPath === DefaultFixtureScript ? DefaultFixtureScene : undefined);
}

export class RepairSmokeState {
  private original?: Record<string, unknown>;
  private transitionGeneration = 0;

  public constructor(
    private readonly unity: Pick<UnityClient, "request">,
    private readonly timeoutMs: number,
    private readonly clock = { now: Date.now, delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }
  ) {}

  public async prepare(openScene?: () => Promise<void>): Promise<void> {
    const snapshot = await this.request("editor.snapshot", {});
    if (Array.isArray(snapshot.dirtyScenes) && snapshot.dirtyScenes.length > 0) {
      throw new Error("Repair smoke refuses to replace a pre-existing modified scene.");
    }
    if (!Array.isArray(snapshot.dirtyScenes) || !Array.isArray(snapshot.sceneSetup) || !Array.isArray(snapshot.selectionGlobalObjectIds)) {
      throw new Error("Repair smoke requires a complete Editor snapshot.");
    }
    const playMode = asRecord(snapshot.playMode);
    if (playMode.ok !== true || !isPlayState(playMode.state)) {
      throw new Error("Repair smoke requires an initially settled Play mode state.");
    }
    // Rejected captures must never become eligible for destructive restoration.
    this.original = snapshot;
    this.transitionGeneration = Number(playMode.transitionGeneration ?? 0);
    await this.settlePlayMode("stopped");
    await openScene?.();
  }

  public async restore(): Promise<Record<string, unknown> | undefined> {
    if (!this.original) return;
    await this.settlePlayMode("stopped");
    const restored = await this.request("editor.restore_snapshot", { snapshot: this.original });
    if (restored.restored !== true) throw new Error("Unity did not confirm Editor snapshot restoration.");
    this.verifySnapshot(restored, "stopped");
    const originalPlay = asRecord(this.original.playMode).state as PlayState;
    if (originalPlay !== "stopped") await this.settlePlayMode(originalPlay);
    const observed = await this.request("editor.snapshot", {});
    this.verifySnapshot(observed, originalPlay);
    return { ...observed, restored: true };
  }

  private verifySnapshot(observed: Record<string, unknown>, state: PlayState): void {
    const sceneSetup = (snapshot: Record<string, unknown>) =>
      Array.isArray(snapshot.sceneSetup)
        ? snapshot.sceneSetup.map((scene) => {
            const { path, isLoaded, isActive } = asRecord(scene);
            return { path, isLoaded, isActive };
          })
        : undefined;
    const selection = (snapshot: Record<string, unknown>) =>
      Array.isArray(snapshot.selectionGlobalObjectIds) ? [...snapshot.selectionGlobalObjectIds].sort() : undefined;
    if (
      !this.original ||
      asRecord(observed.playMode).state !== state ||
      !isDeepStrictEqual(sceneSetup(observed), sceneSetup(this.original)) ||
      !isDeepStrictEqual(selection(observed), selection(this.original))
    ) {
      throw new Error("Restored Editor snapshot does not match the original scenes, selection, and Play mode.");
    }
  }

  private async settlePlayMode(state: PlayState): Promise<void> {
    const deadline = this.clock.now() + this.timeoutMs;
    let generation = this.transitionGeneration + 1;
    try {
      const initiated = await this.request("play_mode.set", { state, saveModifiedScenes: false });
      generation = Number(initiated.transitionGeneration ?? 0);
    } catch (error) {
      if (!isAmbiguous(error)) throw error;
    }
    while (this.clock.now() < deadline) {
      try {
        const observed = await this.request("play_mode.get", {}, Math.min(5000, deadline - this.clock.now()));
        if (observed.state === state && Number(observed.transitionGeneration ?? 0) >= generation) {
          this.transitionGeneration = Number(observed.transitionGeneration);
          return;
        }
      } catch (error) {
        const record = asRecord(error);
        const data = asRecord(record.data);
        if (
          !isAmbiguous(error) &&
          record.code !== "UNITY_REQUEST_TIMEOUT" &&
          !(record.code === "EXPIRED" && data.outcomeUnknown === false && data.status === "expired")
        )
          throw error;
      }
      const remaining = deadline - this.clock.now();
      if (remaining > 0) await this.clock.delay(Math.min(100, remaining));
    }
    throw new Error(`Timed out waiting for repair smoke Play mode '${state}'.`);
  }

  private async request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const result = asRecord(await this.unity.request(method, params, { timeoutMs }));
    if (result.ok !== true) {
      const error = asRecord(result.error);
      throw Object.assign(new Error(String(error.message ?? `${method} did not report success.`)), { code: error.code, data: result });
    }
    return result;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isPlayState(state: unknown): state is PlayState {
  return state === "stopped" || state === "playing" || state === "paused";
}

function isAmbiguous(error: unknown): boolean {
  return ["EXECUTING", "OUTCOME_UNKNOWN", "REQUEST_EXECUTION_IN_PROGRESS", "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN"].includes(String(asRecord(error).code));
}
