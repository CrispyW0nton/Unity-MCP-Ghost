using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class RuntimeControlTests
    {
        [SetUp]
        public void SetUp()
        {
            ConsoleLogBuffer.ResetForTests();
            InputSimulationController.ResetForTests();
        }

        [TearDown]
        public void TearDown()
        {
            ConsoleLogBuffer.ResetForTests();
            InputSimulationController.ResetForTests();
        }

        [Test]
        public void ConsoleBoundaryExcludesHistoricalEntriesAndMatchesNewEntry()
        {
            ConsoleLogBuffer.AddForTests("historical", LogType.Log);
            var mark = JObject.Parse(ConsoleLogBuffer.MarkBoundary("case-start"));
            ConsoleLogBuffer.AddForTests("Hello course", LogType.Log);

            var result = JObject.Parse(ConsoleLogBuffer.Query("{\"boundary\":\"" + mark["boundary"] + "\",\"severity\":\"log\",\"exact\":\"Hello course\",\"count\":1}", false));

            Assert.That(result["matched"]?.Value<bool>(), Is.True);
            Assert.That(result["count"]?.Value<int>(), Is.EqualTo(1));
            Assert.That(result["entries"]?[0]?["message"]?.Value<string>(), Is.EqualTo("Hello course"));
        }

        [Test]
        public void ConsoleAssertionFailsWhenUnexpectedErrorAppearsAfterBoundary()
        {
            var mark = JObject.Parse(ConsoleLogBuffer.MarkBoundary("before-error"));
            ConsoleLogBuffer.AddForTests("Expected log", LogType.Log);
            ConsoleLogBuffer.AddForTests("Unexpected failure", LogType.Error);

            var result = JObject.Parse(ConsoleLogBuffer.Query("{\"boundary\":\"" + mark["boundary"] + "\",\"severity\":\"log\",\"exact\":\"Expected log\",\"count\":1,\"failOnUnexpectedErrors\":true}", true));

            Assert.That(result["ok"]?.Value<bool>(), Is.False);
            Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("CONSOLE_ASSERTION_FAILED"));
            Assert.That((result["unexpectedErrors"] as JArray)?.Count, Is.EqualTo(1));
        }

        [Test]
        public void UnknownConsoleBoundaryIsTypedFailure()
        {
            var result = JObject.Parse(ConsoleLogBuffer.Query("{\"boundary\":\"missing\"}", true));

            Assert.That(result["ok"]?.Value<bool>(), Is.False);
            Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("CONSOLE_BOUNDARY_NOT_FOUND"));
        }

        [Test]
        public void EvictedPostBoundaryErrorMakesAssertionIncomplete()
        {
            var mark = JObject.Parse(ConsoleLogBuffer.MarkBoundary("before-noise"));
            ConsoleLogBuffer.AddNoisyEntriesForTests(1000);

            var result = JObject.Parse(ConsoleLogBuffer.Query("{\"boundary\":\"" + mark["boundary"] + "\",\"severity\":\"log\",\"contains\":\"noise\",\"minimumCount\":1,\"failOnUnexpectedErrors\":true}", true));

            Assert.That(result["ok"]?.Value<bool>(), Is.False);
            Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("CONSOLE_BOUNDARY_TRUNCATED"));
        }

        [Test]
        public void ConsoleLocationFilterUnderstandsUnityStackTraceLocations()
        {
            var mark = JObject.Parse(ConsoleLogBuffer.MarkBoundary("before-location"));
            ConsoleLogBuffer.AddForTests("Located log", LogType.Log, "Example.Start () (at Assets/GAM215Fixture/Example.cs:42)");

            var result = JObject.Parse(ConsoleLogBuffer.Query("{\"boundary\":\"" + mark["boundary"] + "\",\"file\":\"GAM215Fixture/Example.cs\",\"line\":42,\"count\":1}", true));

            Assert.That(result["ok"]?.Value<bool>(), Is.True);
            Assert.That(result["entries"]?[0]?["file"]?.Value<string>(), Is.EqualTo("Assets/GAM215Fixture/Example.cs"));
            Assert.That(result["entries"]?[0]?["line"]?.Value<int>(), Is.EqualTo(42));
        }

        [TestCase(false, false, false, "stopped", "stopped")]
        [TestCase(false, false, true, "stopped", "enteringPlay")]
        [TestCase(true, false, true, "playing", "playing")]
        [TestCase(true, true, true, "playing", "paused")]
        [TestCase(true, false, false, "exitingPlay", "exitingPlay")]
        public void PlayModeStateNamesAreExact(bool playing, bool paused, bool willChange, string observed, string expected)
        {
            Assert.That(PlayModeController.DescribeState(playing, paused, willChange, observed), Is.EqualTo(expected));
        }

        [Test]
        public void InputOutsidePlayModeReturnsTypedFailure()
        {
            var result = JObject.Parse(InputSimulationController.Simulate("{\"device\":\"keyboard\",\"action\":\"tap\",\"key\":\"PageUp\"}"));

            Assert.That(result["ok"]?.Value<bool>(), Is.False);
            Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("INPUT_REQUIRES_PLAY_MODE"));
        }

        [Test]
        public void PlayModeRefusesAnUnsavedDirtySceneWithoutExplicitSave()
        {
            var dirtyScene = SceneManager.GetActiveScene();
            Undo.IncrementCurrentGroup();
            var undoGroup = Undo.GetCurrentGroup();
            var marker = new GameObject("Unsaved Play Mode Conflict");
            Undo.RegisterCreatedObjectUndo(marker, "Create unsaved Play mode conflict marker");
            try
            {
                EditorSceneManager.MarkSceneDirty(dirtyScene);

                var result = JObject.Parse(PlayModeController.Set("{\"state\":\"playing\",\"saveModifiedScenes\":false}"));

                Assert.That(result["ok"]?.Value<bool>(), Is.False);
                Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("UNSAVED_SCENE_CONFLICT"));
                Assert.That((result["error"]?["scenes"] as JArray)?.Count, Is.GreaterThanOrEqualTo(1));
                Assert.That(EditorApplication.isPlayingOrWillChangePlaymode, Is.False);
            }
            finally
            {
                Undo.RevertAllDownToGroup(undoGroup);
            }
        }

        [Test]
        public void RuntimeAssertionReadsSerializedComponentStateWithoutArbitraryReflection()
        {
            var gameObject = new GameObject("Runtime Assertion Target");
            var collider = gameObject.AddComponent<BoxCollider>();
            collider.isTrigger = true;
            try
            {
                var result = JObject.Parse(ScenarioBridgeController.InspectRuntime(
                    "{\"name\":\"Runtime Assertion Target\",\"component\":\"BoxCollider\",\"propertyPath\":\"m_IsTrigger\",\"equals\":true}",
                    true));

                Assert.That(result["ok"]?.Value<bool>(), Is.True);
                Assert.That(result["matched"]?.Value<bool>(), Is.True);
                Assert.That(result["observed"]?.Value<bool>(), Is.True);
            }
            finally
            {
                Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void ScenarioSourcePreflightRejectsMissingExpectedHashBeforeMutation()
        {
            var result = JObject.Parse(ScenarioBridgeController.ApplySources(
                "{\"mutations\":[{\"path\":\"Assets/GAM215Fixture/Gam215InputDriver.cs\",\"content\":\"changed\",\"expectedSha256\":\"\"}]}"));

            Assert.That(result["ok"]?.Value<bool>(), Is.False);
            Assert.That(result["error"]?["code"]?.Value<string>(), Is.EqualTo("SCRIPT_HASH_MISMATCH"));
        }
    }
}
