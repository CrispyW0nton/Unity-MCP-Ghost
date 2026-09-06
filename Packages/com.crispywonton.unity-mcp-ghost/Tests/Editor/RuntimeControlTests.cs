using System.IO;
using System.Linq;
using System.Text;
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

        [TestCase(false, false)]
        [TestCase(false, true)]
        [TestCase(true, false)]
        [TestCase(true, true)]
        public void ScenarioSourceFailurePreservesRecoveryAndRefusesRestoreOrCleanup(bool denyRead, bool includeSuccessfulMutation)
        {
            if (Application.platform != RuntimePlatform.WindowsEditor)
            {
                Assert.Ignore("This regression requires Windows file-sharing enforcement.");
            }

            using (var fixture = new ScenarioSourceFixture())
            {
                var beforeHash = ScriptFileTransaction.Read(fixture.SourcePath).Sha256;
                FileStream lockedSource = null;
                var mutationReached = false;
                ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
                {
                    if (step != "after-mutation" || destination != fixture.SourcePath) return;
                    lockedSource = new FileStream(fixture.SourcePath, FileMode.Open, FileAccess.Read, denyRead ? FileShare.None : FileShare.Read);
                    mutationReached = true;
                    throw new IOException("original scenario source failure");
                };

                JObject result;
                try { result = JObject.Parse(ScenarioBridgeController.ApplySources(fixture.ApplyRequest(includeSuccessfulMutation).ToString())); }
                finally
                {
                    lockedSource?.Dispose();
                    ScriptFileTransaction.BeforeIoForTests = null;
                }

                Assert.That(mutationReached, Is.True, "The injected lock must run after the failing source was mutated.");
                var transaction = fixture.GetTransaction();
                Assert.That((transaction["receipts"] as JArray)?.Count, Is.EqualTo(includeSuccessfulMutation ? 1 : 0), "The first mutation must succeed before the injected second-source failure.");
                Assert.That((transaction["receipts"] as JArray).All(item => item.Value<bool>("ok")), Is.True);
                Assert.That(result.Value<bool>("ok"), Is.False);
                Assert.That(result["error"]?.Value<string>("code"), Is.EqualTo("SCRIPT_IO_FAILED"));
                Assert.That(File.ReadAllText(fixture.SourcePath), Is.EqualTo("// after\n"));
                Assert.That(File.ReadAllText(fixture.FirstPath), Is.EqualTo("// first before\n"));
                var failed = result["failedMutationReceipt"] as JObject;
                Assert.That(failed, Is.Not.Null, "The public failure must expose the full failed mutation receipt.");
                Assert.That(failed.Value<bool>("ok"), Is.False);
                Assert.That(failed.Value<string>("path"), Is.EqualTo(fixture.SourceAssetPath));
                Assert.That(failed.Value<string>("beforeSha256"), Is.EqualTo(beforeHash));
                Assert.That(failed.Value<string>("afterSha256"), Is.EqualTo(denyRead ? null : ScriptFileTransaction.Read(fixture.SourcePath).Sha256));
                Assert.That(failed["error"]?.Value<string>("restorationStatus"), Is.EqualTo(denyRead ? "unknown" : "incomplete"));
                Assert.That(failed["error"]?.Value<string>("message"), Does.Contain("original scenario source failure"));
                Assert.That((failed["error"]?["recoveryErrors"] as JArray)?.Count, Is.GreaterThan(0));
                Assert.That(File.ReadAllText(failed.Value<string>("backupPath")), Is.EqualTo("// before\n"));
                Assert.That(File.ReadAllText(failed.Value<string>("backupMetaPath")), Is.EqualTo(fixture.Metadata));
                Assert.That(result.Value<bool>("requiresReconciliation"), Is.True);

                Assert.That(transaction.Value<string>("status"), Is.EqualTo("applyFailed"));
                Assert.That(transaction.Value<bool>("requiresReconciliation"), Is.True);
                Assert.That(JToken.DeepEquals(transaction["failedMutationReceipt"], failed), Is.True);
                Assert.That((transaction["receipts"] as JArray)?.Count, Is.EqualTo(includeSuccessfulMutation ? 1 : 0), "Failed receipts must not enter successful-receipt rollback.");
                Assert.That((transaction["rollback"] as JArray)?.Count, Is.EqualTo(includeSuccessfulMutation ? 1 : 0));
                Assert.That((transaction["rollback"] as JArray).All(item => item.Value<bool>("ok")), Is.True);
                var recoveryFiles = Directory.GetFiles(fixture.BackupDirectory, "*", SearchOption.AllDirectories);
                Assert.That(recoveryFiles, Is.Not.Empty);
                foreach (var state in (failed["error"]?["recoveryFileStates"] as JArray).OfType<JObject>())
                {
                    Assert.That(File.Exists(state.Value<string>("path")), Is.True);
                    Assert.That(ScriptFileTransaction.Read(state.Value<string>("path")).Sha256, Is.EqualTo(state.Value<string>("sha256")));
                }

                var request = new JObject { ["transactionId"] = fixture.TransactionId }.ToString();
                var restored = JObject.Parse(ScenarioBridgeController.RestoreSources(request));
                Assert.That(restored.Value<bool>("ok"), Is.False);
                Assert.That(restored["error"]?.Value<string>("code"), Is.EqualTo("SCENARIO_SOURCE_RECONCILIATION_REQUIRED"));
                Assert.That(JToken.DeepEquals(restored["failedMutationReceipt"], failed), Is.True);
                Assert.That(fixture.GetTransaction().Value<string>("status"), Is.EqualTo("applyFailed"));

                var completed = JObject.Parse(ScenarioBridgeController.CompleteSources(request));
                Assert.That(completed.Value<bool>("ok"), Is.False);
                Assert.That(completed["error"]?.Value<string>("code"), Is.EqualTo("SCENARIO_SOURCE_RECONCILIATION_REQUIRED"));
                Assert.That(JToken.DeepEquals(completed["failedMutationReceipt"], failed), Is.True);
                Assert.That(JToken.DeepEquals(fixture.GetTransaction(), transaction), Is.True, "Refusal must preserve the durable transaction and its recovery evidence.");
                Assert.That(Directory.GetFiles(fixture.BackupDirectory, "*", SearchOption.AllDirectories), Is.EquivalentTo(recoveryFiles));
                Assert.That(File.ReadAllText(fixture.SourcePath), Is.EqualTo("// after\n"));
            }
        }

        [Test]
        public void ScenarioSourceCompensatedFailurePreservesReceiptAndAllowsCleanup()
        {
            using (var fixture = new ScenarioSourceFixture())
            {
                var mutationReached = false;
                ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
                {
                    if (step == "after-mutation" && destination == fixture.SourcePath)
                    {
                        mutationReached = true;
                        throw new IOException("compensatable scenario source failure");
                    }
                };
                var result = JObject.Parse(ScenarioBridgeController.ApplySources(fixture.ApplyRequest(true).ToString()));
                ScriptFileTransaction.BeforeIoForTests = null;

                Assert.That(mutationReached, Is.True, "The injected failure must run after the second source was mutated.");
                var transaction = fixture.GetTransaction();
                Assert.That((transaction["receipts"] as JArray)?.Count, Is.EqualTo(1));
                Assert.That(transaction["receipts"]?[0]?.Value<bool>("ok"), Is.True);
                Assert.That(result.Value<bool>("ok"), Is.False);
                var failed = result["failedMutationReceipt"] as JObject;
                Assert.That(failed, Is.Not.Null);
                Assert.That(failed["error"]?.Value<string>("restorationStatus"), Is.EqualTo("complete"));
                Assert.That(result.Value<bool>("requiresReconciliation"), Is.False);
                Assert.That(File.ReadAllText(fixture.SourcePath), Is.EqualTo("// before\n"));
                Assert.That(File.ReadAllText(fixture.FirstPath), Is.EqualTo("// first before\n"));
                Assert.That(JToken.DeepEquals(transaction["failedMutationReceipt"], failed), Is.True);
                Assert.That((transaction["receipts"] as JArray)?.Count, Is.EqualTo(1));

                var request = new JObject { ["transactionId"] = fixture.TransactionId }.ToString();
                var restored = JObject.Parse(ScenarioBridgeController.RestoreSources(request));
                Assert.That(restored.Value<bool>("ok"), Is.True);
                Assert.That(restored.Value<string>("status"), Is.EqualTo("restored"));
                var completed = JObject.Parse(ScenarioBridgeController.CompleteSources(request));
                Assert.That(completed.Value<bool>("ok"), Is.True);
                Assert.That(JObject.Parse(ScenarioBridgeController.GetSourceTransaction(request))["error"]?.Value<string>("code"), Is.EqualTo("SCENARIO_TRANSACTION_NOT_FOUND"));
            }
        }

        private sealed class ScenarioSourceFixture : System.IDisposable
        {
            private readonly string assetDirectory;
            private readonly string transactionPath;
            private readonly string previousBackupRoot = ScriptFileTransaction.BackupRootForTests;
            public readonly string TransactionId = "scenario-receipt-test-" + System.Guid.NewGuid().ToString("N");
            public readonly string SourceAssetPath;
            public readonly string SourcePath;
            public readonly string FirstPath;
            public readonly string BackupDirectory;
            public readonly string Metadata = "fileFormatVersion: 2\nguid: " + System.Guid.NewGuid().ToString("N") + "\n";
            private readonly string firstAssetPath;

            public ScenarioSourceFixture()
            {
                var fixtureName = "sr-" + TransactionId.Substring(TransactionId.Length - 16);
                var assetRoot = "Assets/" + fixtureName + "~";
                assetDirectory = ProjectPathPolicy.FullAssetPath(assetRoot);
                SourceAssetPath = assetRoot + "/Second.cs";
                firstAssetPath = assetRoot + "/First.cs";
                SourcePath = ProjectPathPolicy.FullAssetPath(SourceAssetPath);
                FirstPath = ProjectPathPolicy.FullAssetPath(firstAssetPath);
                BackupDirectory = Path.Combine(ProjectPathPolicy.ProjectRoot, "Library", fixtureName);
                using (var sha256 = System.Security.Cryptography.SHA256.Create())
                {
                    var hash = string.Concat(sha256.ComputeHash(Encoding.UTF8.GetBytes(TransactionId)).Select(value => value.ToString("x2")));
                    transactionPath = Path.Combine(BridgeSecurity.StateRoot, "scenario-transactions", hash + ".json");
                }
                Assert.That(Directory.Exists(assetDirectory), Is.False);
                Assert.That(Directory.Exists(BackupDirectory), Is.False);
                Directory.CreateDirectory(assetDirectory);
                Directory.CreateDirectory(BackupDirectory);
                File.WriteAllText(SourcePath, "// before\n", new UTF8Encoding(false));
                File.WriteAllText(SourcePath + ".meta", Metadata, new UTF8Encoding(false));
                File.WriteAllText(FirstPath, "// first before\n", new UTF8Encoding(false));
                ScriptFileTransaction.BackupRootForTests = BackupDirectory;
            }

            public JObject ApplyRequest(bool includeSuccessfulMutation)
            {
                var mutations = new JArray();
                if (includeSuccessfulMutation)
                {
                    mutations.Add(new JObject { ["path"] = firstAssetPath, ["content"] = "// first after\n", ["expectedSha256"] = ScriptFileTransaction.Read(FirstPath).Sha256 });
                }
                mutations.Add(new JObject { ["path"] = SourceAssetPath, ["content"] = "// after\n", ["expectedSha256"] = ScriptFileTransaction.Read(SourcePath).Sha256 });
                return new JObject { ["transactionId"] = TransactionId, ["mutations"] = mutations };
            }

            public JObject GetTransaction()
            {
                var response = JObject.Parse(ScenarioBridgeController.GetSourceTransaction(new JObject { ["transactionId"] = TransactionId }.ToString()));
                Assert.That(response.Value<bool>("ok"), Is.True);
                return (JObject)response["transaction"];
            }

            public void Dispose()
            {
                ScriptFileTransaction.BeforeIoForTests = null;
                ScriptFileTransaction.BackupRootForTests = previousBackupRoot;
                foreach (var directory in new[] { assetDirectory, BackupDirectory })
                {
                    var validated = ProjectPathPolicy.RequireUnderProjectRoot(directory);
                    var fixtureName = "sr-" + TransactionId.Substring(TransactionId.Length - 16);
                    Assert.That(Path.GetFileName(validated), Is.EqualTo(directory == assetDirectory ? fixtureName + "~" : fixtureName));
                    if (Directory.Exists(validated)) Directory.Delete(validated, true);
                }
                File.Delete(ProjectPathPolicy.RequireUnderProjectRoot(transactionPath));
            }
        }
    }
}
