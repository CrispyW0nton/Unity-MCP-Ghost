using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class OperationStoreTests
    {
        private string directory;

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Path.GetTempPath(), "gmcp-operations-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            OperationStore.RootOverrideForTests = directory;
        }

        [TearDown]
        public void TearDown()
        {
            AtomicStateFile.ReplaceOverrideForTests = null;
            OperationStore.ClearForTests();
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void CompletedResultRemainsReadableAfterDomainReloadSimulation()
        {
            OperationStore.Register("operation-1", "tests", "fixture", () => "{\"ok\":true,\"status\":\"success\",\"passed\":3}");
            var completed = JObject.Parse(OperationStore.Read("operation-1"));
            OperationStore.ClearLiveForTests();

            var restored = JObject.Parse(OperationStore.Read("operation-1"));

            Assert.That(completed["status"].Value<string>(), Is.EqualTo("success"));
            Assert.That(restored["state"]["passed"].Value<int>(), Is.EqualTo(3));
        }

        [Test]
        public void RunningOperationBecomesOutcomeUnknownAfterDomainReloadSimulation()
        {
            OperationStore.Register("operation-2", "package", "add", () => "{\"status\":\"running\"}");
            OperationStore.ClearLiveForTests();

            var result = JObject.Parse(OperationStore.Read("operation-2"));

            Assert.That(result.Value<bool>("ok"), Is.False);
            Assert.That(result["status"].Value<string>(), Is.EqualTo("outcomeUnknown"));
            Assert.That(result["state"]["outcomeUnknown"].Value<bool>(), Is.True);
        }

        [Test]
        public void SafePollingOperationCanBeCancelledDeterministically()
        {
            OperationStore.Register("operation-3", "compile", "wait", () => "{\"status\":\"running\"}", null, true);

            var result = JObject.Parse(OperationStore.Cancel("operation-3"));

            Assert.That(result["status"].Value<string>(), Is.EqualTo("cancelled"));
            Assert.That(result["state"]["error"]["code"].Value<string>(), Is.EqualTo("OPERATION_CANCELLED"));
        }

        [Test]
        public void UncancellableMutationReportsOutcomeUnknown()
        {
            OperationStore.Register("operation-4", "package", "add", () => "{\"status\":\"running\"}");

            var result = JObject.Parse(OperationStore.Cancel("operation-4"));

            Assert.That(result["status"].Value<string>(), Is.EqualTo("outcomeUnknown"));
            Assert.That(result["state"]["error"]["code"].Value<string>(), Is.EqualTo("OPERATION_OUTCOME_UNKNOWN"));
        }

        [Test]
        public void FailedStateReplacementPreservesLastDurableOperation()
        {
            OperationStore.Register("save-failure", "tests", "fixture", () => "{\"status\":\"running\"}");
            var path = Directory.GetFiles(directory, "*.operation.json")[0];
            var before = File.ReadAllBytes(path);
            var injected = new IOException("injected operation save failure");
            AtomicStateFile.ReplaceOverrideForTests = (source, destination) =>
            {
                if (destination == path) throw injected;
                File.Replace(source, destination, null);
            };

            Assert.Throws<IOException>(() => OperationStore.Update("save-failure", "{\"status\":\"success\"}"));

            Assert.That(File.ReadAllBytes(path), Is.EqualTo(before));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
            AtomicStateFile.ReplaceOverrideForTests = null;
            OperationStore.ClearLiveForTests();
            Assert.That(JObject.Parse(OperationStore.Read("save-failure")).Value<string>("status"), Is.EqualTo("outcomeUnknown"));
        }
    }
}
