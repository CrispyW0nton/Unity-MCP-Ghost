import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DefaultFixtureScript, repairSmokeScene, RepairSmokeState } from "../src/testing/repairSmokeState.js";
import type { UnityRequestOptions } from "../src/unity/UnityClient.js";

type PlayState = "stopped" | "playing" | "paused";

describe("repair smoke Editor restoration", () => {
  it("uses the repository fixture only for the default script and honors explicit scenes", () => {
    assert.equal(repairSmokeScene(DefaultFixtureScript), "Assets/GAM215Fixture/RuntimeControlFixture.unity");
    assert.equal(repairSmokeScene("Assets/ExternalProject/Player.cs"), undefined);
    assert.equal(repairSmokeScene("Assets/ExternalProject/Player.cs", "Assets/Scenes/Test.unity"), "Assets/Scenes/Test.unity");
    assert.equal(repairSmokeScene(DefaultFixtureScript, "Assets/Scenes/Test.unity"), "Assets/Scenes/Test.unity");
  });
  for (const initialState of ["stopped", "playing", "paused"] as const) {
    it(`settles before opening and restores the observed ${initialState} snapshot`, async () => {
      const unity = new FakeRepairUnity(initialState);
      const state = new RepairSmokeState(unity, 1000, unity.clock);
      await state.prepare(async () => {
        assert.equal(unity.state, "stopped", "fixture must open only after stopped is observed");
        assert.ok(unity.events.includes("observed:stopped"));
        unity.sceneSetup = [{ path: "Assets/Fixture.unity", isLoaded: true, isActive: true }];
        unity.selection = [];
      });
      unity.state = "playing";
      const restored = await state.restore();
      assert.equal(restored?.restored, true);
      assert.equal(unity.state, initialState);
      assert.deepEqual(unity.sceneSetup, unity.original.sceneSetup);
      assert.deepEqual(unity.selection, unity.original.selectionGlobalObjectIds);
      assert.equal(unity.events.at(-1), "editor.snapshot", "verify the final observed Editor snapshot");
      assert.equal(unity.events.filter((event) => event === "observed:stopped").length, 2);
      assert.deepEqual(
        unity.events.filter((event) => event.startsWith("set:")),
        initialState === "stopped" ? ["set:stopped", "set:stopped"] : ["set:stopped", "set:stopped", `set:${initialState}`]
      );
    });

    it(`leaves a dirty ${initialState} Editor untouched, including cleanup`, async () => {
      const unity = new FakeRepairUnity(initialState);
      unity.dirtyScenes = ["Assets/Original.unity"];
      const state = new RepairSmokeState(unity, 1000, unity.clock);
      await assert.rejects(
        state.prepare(async () => assert.fail("must not open a fixture")),
        /modified scene/
      );
      assert.equal(await state.restore(), undefined);
      assert.deepEqual(unity.events, ["editor.snapshot"]);
      assert.equal(unity.state, initialState);
    });
  }

  it("does not run the smoke body after a failed scene open, but restores the original Editor", async () => {
    const unity = new FakeRepairUnity("paused");
    const state = new RepairSmokeState(unity, 1000, unity.clock);
    let ran = false;
    await assert.rejects(async () => {
      try {
        await state.prepare(async () => {
          throw new Error("scene_open failed");
        });
        ran = true;
      } finally {
        await state.restore();
      }
    }, /scene_open failed/);
    assert.equal(ran, false);
    assert.equal(unity.state, "paused");
  });

  it("reports an observed scene/selection mismatch even when restore claims success", async () => {
    const unity = new FakeRepairUnity("stopped");
    const state = new RepairSmokeState(unity, 1000, unity.clock);
    await state.prepare();
    unity.dropRestoredSelection = true;
    await assert.rejects(state.restore(), /snapshot.*match/i);
  });

  it("rejects final evidence that no longer has the restored original Play state", async () => {
    const unity = new FakeRepairUnity("paused");
    const state = new RepairSmokeState(unity, 1000, unity.clock);
    await state.prepare();
    unity.finalSnapshotState = "playing";
    await assert.rejects(state.restore(), /snapshot.*match/i);
  });

  it("observes an ambiguous transition through retryable status-read failures", async () => {
    const unity = new FakeRepairUnity("playing");
    unity.ambiguousSet = true;
    unity.readFailures = [{ code: "UNITY_REQUEST_TIMEOUT" }, { code: "EXPIRED", data: { status: "expired", outcomeUnknown: false } }];
    const state = new RepairSmokeState(unity, 1000, unity.clock);
    await state.prepare();
    assert.equal(unity.state, "stopped");
    await state.restore();
    assert.equal(unity.state, "playing");
  });

  it("refuses to restore a snapshot captured during a Play transition", async () => {
    const unity = new FakeRepairUnity("stopped");
    unity.state = "enteringPlay";
    const state = new RepairSmokeState(unity, 1000, unity.clock);
    await assert.rejects(state.prepare(), /settled/i);
    assert.equal(await state.restore(), undefined);
    assert.deepEqual(unity.events, ["editor.snapshot"]);
  });

  it("times out before opening or restoring a scene when stopped cannot be observed", async () => {
    const unity = new FakeRepairUnity("playing");
    unity.neverSettle = true;
    const state = new RepairSmokeState(unity, 250, unity.clock);
    await assert.rejects(
      state.prepare(async () => assert.fail("must not open")),
      /Timed out/
    );
    await assert.rejects(state.restore(), /Timed out/);
    assert.equal(unity.events.includes("editor.restore_snapshot"), false);
    assert.ok(unity.timeouts.every((timeout) => timeout > 0 && timeout <= 250));
  });
});

class FakeRepairUnity {
  public state: string;
  public dirtyScenes: string[] = [];
  public sceneSetup = [{ path: "Assets/Original.unity", isLoaded: true, isActive: true }];
  public selection = ["GlobalObjectId_V1-original"];
  public readonly original: Record<string, unknown>;
  public readonly events: string[] = [];
  public readonly timeouts: number[] = [];
  public dropRestoredSelection = false;
  public neverSettle = false;
  public ambiguousSet = false;
  public readFailures: Record<string, unknown>[] = [];
  public finalSnapshotState?: string;
  private generation = 1;
  private pending?: PlayState;
  private reads = 0;
  private time = 0;
  public readonly clock = {
    now: () => this.time,
    delay: async (ms: number) => {
      this.time += ms;
    }
  };

  public constructor(initialState: PlayState) {
    this.state = initialState;
    this.original = structuredClone(this.snapshot());
  }

  public async request<T = unknown>(method: string, params: unknown = {}, options: UnityRequestOptions = {}): Promise<T> {
    this.events.push(method);
    if (options.timeoutMs !== undefined) this.timeouts.push(options.timeoutMs);
    const args = params as Record<string, unknown>;
    let result: unknown;
    if (method === "editor.snapshot") {
      result = structuredClone(this.snapshot());
      if (this.finalSnapshotState) (result as { playMode: { state: string } }).playMode.state = this.finalSnapshotState;
    } else if (method === "play_mode.set") {
      this.pending = args.state as PlayState;
      this.events.push(`set:${this.pending}`);
      this.reads = 0;
      this.generation += 1;
      this.state = this.pending === "stopped" ? "exitingPlay" : "enteringPlay";
      result = { ok: true, state: this.pending, transitionGeneration: this.generation };
      if (this.ambiguousSet) {
        this.ambiguousSet = false;
        throw Object.assign(new Error("transition response lost"), { code: "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN" });
      }
    } else if (method === "play_mode.get") {
      if (this.readFailures.length) throw Object.assign(new Error("read expired"), this.readFailures.shift());
      this.reads += 1;
      if (this.reads === 1) {
        result = { ok: true, state: this.pending, transitionGeneration: this.generation - 1 };
      } else {
        if (this.pending && this.reads >= 3 && !this.neverSettle) {
          this.state = this.pending;
          this.pending = undefined;
          this.events.push(`observed:${this.state}`);
        }
        result = { ok: true, state: this.state, transitionGeneration: this.generation };
      }
    } else if (method === "editor.restore_snapshot") {
      assert.equal(this.state, "stopped", "snapshot restore requires settled stopped Play mode");
      const snapshot = args.snapshot as Record<string, unknown>;
      this.sceneSetup = structuredClone(snapshot.sceneSetup) as typeof this.sceneSetup;
      this.selection = this.dropRestoredSelection ? [] : (structuredClone(snapshot.selectionGlobalObjectIds) as string[]);
      result = { ...this.snapshot(), restored: true };
    } else {
      assert.fail(`Unexpected request ${method}`);
    }
    return result as T;
  }

  private snapshot(): Record<string, unknown> {
    return {
      ok: true,
      sceneSetup: this.sceneSetup,
      selectionGlobalObjectIds: this.selection,
      dirtyScenes: this.dirtyScenes,
      playMode: { ok: true, state: this.state, transitionGeneration: this.generation }
    };
  }
}
