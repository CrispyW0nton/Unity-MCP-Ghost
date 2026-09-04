using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class DurableCommandQueueTests
    {
        private string directory;

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Path.GetTempPath(), "gmcp-queue-" + Guid.NewGuid().ToString("N"));
            DurableCommandQueue.QueueRootOverrideForTests = Path.Combine(directory, "queue");
            RequestExecutionStore.RootOverrideForTests = Path.Combine(directory, "requests");
        }

        [TearDown]
        public void TearDown()
        {
            DurableCommandQueue.QueueRootOverrideForTests = null;
            RequestExecutionStore.ResetForTests();
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void AtomicallyClaimsAndPersistsResult()
        {
            WritePending("request-1", "health");

            var processed = DurableCommandQueue.PollWithinBudget(8, 1000);
            var response = JObject.Parse(File.ReadAllText(Path.Combine(DurableCommandQueue.ResultsDirectory, "request-1.json")));

            Assert.That(processed, Is.EqualTo(1));
            Assert.That(response["result"]["ok"].Value<bool>(), Is.True);
            Assert.That(Directory.GetFiles(DurableCommandQueue.PendingDirectory).Length, Is.EqualTo(0));
            Assert.That(Directory.GetFiles(DurableCommandQueue.ProcessingDirectory, "*.claim.json").Length, Is.EqualTo(0));
        }

        [Test]
        public void PollHonorsItemBudgetAndAppliesBackpressureAcrossFrames()
        {
            WritePending("request-1", "health");
            WritePending("request-2", "health");
            WritePending("request-3", "health");

            var processed = DurableCommandQueue.PollWithinBudget(2, 1000);

            Assert.That(processed, Is.EqualTo(2));
            Assert.That(Directory.GetFiles(DurableCommandQueue.PendingDirectory, "*.json").Length, Is.EqualTo(1));
            Assert.That(Directory.GetFiles(DurableCommandQueue.ResultsDirectory, "*.json").Length, Is.EqualTo(2));
        }

        private static void WritePending(string id, string method)
        {
            Directory.CreateDirectory(DurableCommandQueue.PendingDirectory);
            var request = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = id,
                ["idempotencyKey"] = id,
                ["idempotent"] = true,
                ["deadlineUnixMs"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(),
                ["method"] = method,
                ["params"] = new JObject()
            };
            File.WriteAllText(Path.Combine(DurableCommandQueue.PendingDirectory, id + ".json"), request.ToString(Newtonsoft.Json.Formatting.None));
        }
    }
}
