using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class PlayModeController
    {
        private static readonly string StatePath = Path.Combine(BridgeSecurity.StateRoot, "play-mode-state.json");
        private static PlayModeState persisted;

        static PlayModeController()
        {
            persisted = Load();
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        public static string Get()
        {
            var state = CurrentState();
            persisted.LastObservedState = state;
            Save();
            var scene = SceneManager.GetActiveScene();
            return new JObject
            {
                ["ok"] = true,
                ["state"] = state,
                ["activeScene"] = scene.path,
                ["projectId"] = BridgeSecurity.ProjectId,
                ["editorInstanceId"] = BridgeSecurity.EditorInstanceId,
                ["transitionGeneration"] = persisted.TransitionGeneration,
                ["requestedState"] = persisted.RequestedState,
                ["lastTransitionUtc"] = persisted.LastTransitionUtc,
                ["frameCount"] = Time.frameCount,
                ["timeSinceStartup"] = Time.realtimeSinceStartup
            }.ToString(Formatting.None);
        }

        public static string Set(string json)
        {
            var requested = JsonRpcUtil.ReadString(json, "state", string.Empty).ToLowerInvariant();
            if (requested != "playing" && requested != "paused" && requested != "stopped")
            {
                return Failure("INVALID_PLAY_MODE_STATE", "state must be playing, paused, or stopped.");
            }

            var dirtyScenes = DirtyScenes();
            var saveModifiedScenes = JsonRpcUtil.ReadBool(json, "saveModifiedScenes", false);
            if (requested != "stopped" && dirtyScenes.Count > 0)
            {
                if (!saveModifiedScenes || dirtyScenes.Exists(scene => string.IsNullOrWhiteSpace(scene.path)))
                {
                    return Conflict(dirtyScenes, saveModifiedScenes && dirtyScenes.Exists(scene => string.IsNullOrWhiteSpace(scene.path))
                        ? "Untitled modified scenes cannot be saved non-interactively."
                        : "Modified scenes must be saved explicitly or the caller must set saveModifiedScenes=true.");
                }

                foreach (var scene in dirtyScenes)
                {
                    if (!EditorSceneManager.SaveScene(scene) || scene.isDirty)
                    {
                        return Conflict(DirtyScenes(), "Unity did not confirm that every modified scene was saved.");
                    }
                }
            }

            persisted.TransitionGeneration++;
            persisted.RequestedState = requested;
            persisted.LastTransitionUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            var before = CurrentState();
            if (requested == "stopped")
            {
                EditorApplication.isPaused = false;
                if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isPlaying)
                {
                    persisted.LastObservedState = "exitingPlay";
                    Save();
                    EditorApplication.isPlaying = false;
                }
                else
                {
                    persisted.LastObservedState = "stopped";
                    Save();
                }
            }
            else if (EditorApplication.isPlaying)
            {
                EditorApplication.isPaused = requested == "paused";
                persisted.LastObservedState = requested;
                Save();
            }
            else
            {
                persisted.LastObservedState = "enteringPlay";
                Save();
                EditorApplication.isPlaying = true;
            }

            return new JObject
            {
                ["ok"] = true,
                ["requestedState"] = requested,
                ["stateBefore"] = before,
                ["state"] = CurrentState(),
                ["transitionGeneration"] = persisted.TransitionGeneration,
                ["saveModifiedScenes"] = saveModifiedScenes,
                ["savedScenes"] = saveModifiedScenes ? new JArray(dirtyScenes.ConvertAll(scene => scene.path)) : new JArray()
            }.ToString(Formatting.None);
        }

        public static string Step()
        {
            if (!EditorApplication.isPlaying || !EditorApplication.isPaused)
            {
                return Failure("PLAY_MODE_STEP_REQUIRES_PAUSE", "play_mode_step requires Play mode to be paused.");
            }

            var frame = Time.frameCount;
            var time = Time.realtimeSinceStartup;
            EditorApplication.Step();
            return new JObject
            {
                ["ok"] = true,
                ["state"] = "paused",
                ["transitionGeneration"] = persisted.TransitionGeneration,
                ["beforeFrame"] = frame,
                ["beforeTime"] = time,
                ["expectedFrame"] = frame + 1
            }.ToString(Formatting.None);
        }

        internal static string DescribeState(bool isPlaying, bool isPaused, bool isPlayingOrWillChange, string lastObservedState)
        {
            if (isPlaying && isPaused)
            {
                return "paused";
            }
            if (isPlaying)
            {
                return string.Equals(lastObservedState, "exitingPlay", StringComparison.Ordinal) ? "exitingPlay" : "playing";
            }
            if (isPlayingOrWillChange)
            {
                return "enteringPlay";
            }
            return "stopped";
        }

        private static string CurrentState()
        {
            return DescribeState(EditorApplication.isPlaying, EditorApplication.isPaused, EditorApplication.isPlayingOrWillChangePlaymode, persisted.LastObservedState);
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            switch (change)
            {
                case PlayModeStateChange.ExitingEditMode:
                    if (persisted.LastObservedState != "enteringPlay")
                    {
                        persisted.TransitionGeneration++;
                        persisted.RequestedState = "playing";
                    }
                    persisted.LastObservedState = "enteringPlay";
                    break;
                case PlayModeStateChange.EnteredPlayMode:
                    if (persisted.RequestedState == "paused")
                    {
                        EditorApplication.isPaused = true;
                        persisted.LastObservedState = "paused";
                    }
                    else
                    {
                        persisted.LastObservedState = "playing";
                    }
                    break;
                case PlayModeStateChange.ExitingPlayMode:
                    if (persisted.LastObservedState != "exitingPlay")
                    {
                        persisted.TransitionGeneration++;
                        persisted.RequestedState = "stopped";
                    }
                    persisted.LastObservedState = "exitingPlay";
                    break;
                case PlayModeStateChange.EnteredEditMode:
                    persisted.LastObservedState = "stopped";
                    break;
            }
            persisted.LastTransitionUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            Save();
        }

        private static List<Scene> DirtyScenes()
        {
            var scenes = new List<Scene>();
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                if (scene.isLoaded && scene.isDirty)
                {
                    scenes.Add(scene);
                }
            }
            return scenes;
        }

        private static string Conflict(List<Scene> scenes, string message)
        {
            return new JObject
            {
                ["ok"] = false,
                ["state"] = CurrentState(),
                ["error"] = new JObject
                {
                    ["code"] = "UNSAVED_SCENE_CONFLICT",
                    ["message"] = message,
                    ["scenes"] = new JArray(scenes.ConvertAll(scene => string.IsNullOrWhiteSpace(scene.path) ? scene.name : scene.path))
                }
            }.ToString(Formatting.None);
        }

        private static string Failure(string code, string message)
        {
            return new JObject
            {
                ["ok"] = false,
                ["state"] = CurrentState(),
                ["error"] = new JObject { ["code"] = code, ["message"] = message }
            }.ToString(Formatting.None);
        }

        private static PlayModeState Load()
        {
            try
            {
                if (File.Exists(StatePath))
                {
                    return JsonConvert.DeserializeObject<PlayModeState>(File.ReadAllText(StatePath)) ?? new PlayModeState();
                }
            }
            catch
            {
                // State is advisory; the live Editor state remains authoritative.
            }
            return new PlayModeState();
        }

        private static void Save()
        {
            AtomicStateFile.WriteAllText(StatePath, JsonConvert.SerializeObject(persisted, Formatting.Indented));
        }

        [Serializable]
        private sealed class PlayModeState
        {
            public int TransitionGeneration;
            public string RequestedState = "stopped";
            public string LastObservedState = "stopped";
            public string LastTransitionUtc = string.Empty;
        }
    }
}
