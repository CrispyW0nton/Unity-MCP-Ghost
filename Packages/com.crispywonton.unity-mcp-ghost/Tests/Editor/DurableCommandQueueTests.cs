using System;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
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

        [TestCase(false)]
        [TestCase(true)]
        public void TamperedNestedParametersCannotReachExecutionOrReplay(bool stale)
        {
            var request = QueueRequestEnvelopeTests.RequestObject("tampered");
            request["params"] = JObject.Parse("{\"dryRun\":true,\"operations\":[{\"method\":\"health\",\"params\":{\"content\":\"original\"}}]}");
            var envelope = JObject.Parse(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Formatting.None), BridgeSecurity.Token));
            request["params"]["operations"][0]["params"]["content"] = "private-content-must-not-be-echoed";
            request["params"]["dryRun"] = false;
            envelope["requestJson"] = request.ToString(Formatting.None);

            AssertRejectedBeforeExecution("tampered", envelope.ToString(Formatting.None), stale, "AUTHENTICATION_FAILED");
        }

        [TestCase(false)]
        [TestCase(true)]
        public void TamperedIdempotencyDeclarationCannotReachExecutionOrReplay(bool stale)
        {
            var request = QueueRequestEnvelopeTests.RequestObject("idempotency");
            request["idempotent"] = false;
            var envelope = JObject.Parse(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Formatting.None), BridgeSecurity.Token));
            request["idempotent"] = true;
            envelope["requestJson"] = request.ToString(Formatting.None);

            AssertRejectedBeforeExecution("idempotency", envelope.ToString(Formatting.None), stale, "AUTHENTICATION_FAILED");
        }

        [TestCase(false)]
        [TestCase(true)]
        public void LegacyAndUnauthenticatedProjectMetadataCannotReachExecutionOrReplay(bool stale)
        {
            var raw = QueueRequestEnvelopeTests.RequestObject("legacy");
            raw["projectId"] = "wrong-project";
            raw["authProof"] = "legacy-proof";
            AssertRejectedBeforeExecution("legacy", raw.ToString(Formatting.None), stale, "QUEUE_PROOF_VERSION_UNSUPPORTED");
        }

        [TestCase(false)]
        [TestCase(true)]
        public void InvalidSignedInnerJsonKeepsProtocolCodeWithoutLeakingContent(bool stale)
        {
            var raw = "{\"jsonrpc\":\"2.0\",\"method\":\"health\",\"params\":{\"private-content-must-not-be-echoed\":1,\"private-content-must-not-be-echoed\":2}}";
            var envelope = QueueRequestEnvelopeTests.EncodeForTests(raw, BridgeSecurity.Token);
            var response = AssertRejectedBeforeExecution("duplicate", envelope, stale, "INVALID_REQUEST");
            Assert.That(response["error"]["code"].Value<int>(), Is.EqualTo(-32700));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void InvalidSignedProtocolKeepsAuthenticatedCorrelationAndRpcCode(bool stale)
        {
            var raw = QueueRequestEnvelopeTests.RequestObject("invalid-protocol");
            raw["jsonrpc"] = "private-content-must-not-be-echoed";
            var response = AssertRejectedBeforeExecution("invalid-protocol", QueueRequestEnvelopeTests.EncodeForTests(raw.ToString(Formatting.None), BridgeSecurity.Token), stale, "INVALID_REQUEST", "invalid-protocol");
            Assert.That(response["error"]["code"].Value<int>(), Is.EqualTo(-32600));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void OversizedFileCannotReachExecutionOrReplay(bool stale)
        {
            AssertRejectedBeforeExecution("oversized", new string(' ', QueueRequestEnvelope.MaxEnvelopeBytes + 1), stale, "QUEUE_ENVELOPE_TOO_LARGE");
        }

        [TestCase(false)]
        [TestCase(true)]
        public void InvalidUtf8FileCannotReachExecutionOrReplay(bool stale)
        {
            var path = WriteQueued("invalid-utf8", "", stale);
            File.WriteAllBytes(path, new byte[] { 0x7b, 0xc0, 0xaf, 0x7d });
            DurableCommandQueue.PollWithinBudget(8, 1000);

            var response = ReadResponse("invalid-utf8");
            Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo("INVALID_UTF8"));
            Assert.That(Directory.Exists(Path.Combine(directory, "requests")), Is.False);
            Assert.That(Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json").Length, Is.EqualTo(1));
        }

        [Test]
        public void StaleAuthenticatedReadOnlyRequestRecoversAndUsesInnerSemanticFingerprint()
        {
            var request = QueueRequestEnvelopeTests.RequestObject("recovered");
            var inner = request.ToString(Formatting.None);
            WriteQueued("recovered", QueueRequestEnvelopeTests.EncodeForTests(inner, BridgeSecurity.Token), true);
            DurableCommandQueue.PollWithinBudget(8, 1000);
            Assert.That(ReadResponse("recovered")["result"]["ok"].Value<bool>(), Is.True);

            // A transport retry with a renewed deadline shares the existing semantic
            // request fingerprint, even though its envelope and HMAC differ.
            request["deadlineUnixMs"] = request["deadlineUnixMs"].Value<long>() + 1000;
            WriteQueued("retry", QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Formatting.Indented), BridgeSecurity.Token), false);
            DurableCommandQueue.PollWithinBudget(8, 1000);
            Assert.That(ReadResponse("retry")["result"]["ok"].Value<bool>(), Is.True);
            Assert.That(Directory.GetFiles(Path.Combine(directory, "requests"), "*.state.json").Length, Is.EqualTo(1));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void AuthenticatedStorageFailurePreservesCorrelationAndUnknownOutcome(bool stale)
        {
            // A file where the request-state directory must be forces Begin to fail.
            // No handler runs, but the receipt must not promise a known execution outcome.
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "requests"), "private-content-must-not-be-echoed");
            var request = QueueRequestEnvelopeTests.RequestObject("storage-failure");
            if (stale) request["method"] = "queue.test_non_replayable"; // Recovery only calls Begin; no mutation handler is involved.
            WriteQueued("storage-failure", QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Formatting.None), BridgeSecurity.Token), stale);
            DurableCommandQueue.PollWithinBudget(8, 1000);

            var response = ReadResponse("storage-failure");
            Assert.That(response["id"].Value<string>(), Is.EqualTo("storage-failure"));
            Assert.That(response["error"]["code"].Value<int>(), Is.EqualTo(-32000));
            Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo("QUEUE_PROCESSING_FAILED"));
            Assert.That(response["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
            Assert.That(response.ToString(), Does.Not.Contain("private-content-must-not-be-echoed").And.Not.Contain(BridgeSecurity.Token));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void UnclaimedNonReplayableRecoveryPersistsUnknownOutcomeAndRetainsPayload(bool expired)
        {
            var raw = QueueRequestEnvelopeTests.RequestObject("recovery-unclaimed", "queue.test_non_replayable");
            raw["idempotent"] = false;
            if (expired) raw["deadlineUnixMs"] = DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds();
            var envelope = QueueRequestEnvelopeTests.EncodeForTests(raw.ToString(Formatting.None), BridgeSecurity.Token);
            WriteQueued("recovery-unclaimed", envelope, true);

            DurableCommandQueue.PollWithinBudget(8, 1000);

            var response = ReadResponse("recovery-unclaimed");
            Assert.That(response["id"].Value<string>(), Is.EqualTo("recovery-unclaimed"));
            Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo("OUTCOME_UNKNOWN"));
            Assert.That(response["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
            var states = Directory.GetFiles(Path.Combine(directory, "requests"), "*.state.json");
            Assert.That(states.Length, Is.EqualTo(1));
            Assert.That(JObject.Parse(File.ReadAllText(states[0]))["Status"].Value<string>(), Is.EqualTo("outcomeUnknown"));
            var retained = Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json");
            Assert.That(retained.Length, Is.EqualTo(1));
            Assert.That(File.ReadAllText(retained[0]), Is.EqualTo(envelope));
            Assert.That(Directory.GetFiles(DurableCommandQueue.ProcessingDirectory), Is.Empty);

            // A renewed deadline and a new transport owner are not replay authority.
            raw["deadlineUnixMs"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
            var retryJson = raw.ToString(Formatting.None);
            var retry = RequestExecutionStore.Begin(JsonRpcUtil.ParseRequest(retryJson), retryJson, "retry-owner");
            Assert.That(retry.Disposition, Is.EqualTo(RequestClaimDisposition.OutcomeUnknown));
        }

        [TestCase(false, false)]
        [TestCase(false, true)]
        [TestCase(true, false)]
        [TestCase(true, true)]
        public void NonReplayableRecoveryPreservesKnownResultsAndUncertainPayloads(bool expired, bool completed)
        {
            var now = DateTime.UtcNow;
            var raw = QueueRequestEnvelopeTests.RequestObject("recovery-existing", "queue.test_non_replayable");
            raw["idempotent"] = false;
            if (expired) raw["deadlineUnixMs"] = new DateTimeOffset(now).AddMinutes(-1).ToUnixTimeMilliseconds();
            var json = raw.ToString(Formatting.None);
            var request = JsonRpcUtil.ParseRequest(json);
            RequestExecutionStore.UtcNow = () => now.AddMinutes(-3);
            Assert.That(RequestExecutionStore.Begin(request, json, "original-owner").Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            string completedResponse = null;
            if (completed) completedResponse = RequestExecutionStore.Complete(request, "original-owner", JsonRpcUtil.Success(request, "{\"ok\":true,\"mutationCount\":1}"));
            RequestExecutionStore.UtcNow = () => now;
            var envelope = QueueRequestEnvelopeTests.EncodeForTests(json, BridgeSecurity.Token);
            WriteQueued("recovery-existing", envelope, true);

            DurableCommandQueue.PollWithinBudget(8, 1000);

            var response = ReadResponse("recovery-existing");
            Assert.That(response["id"].Value<string>(), Is.EqualTo("recovery-existing"));
            var retained = Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json");
            if (completed)
            {
                Assert.That(response.ToString(Formatting.None), Is.EqualTo(JObject.Parse(completedResponse).ToString(Formatting.None)));
                Assert.That(retained, Is.Empty);
            }
            else
            {
                Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo("OUTCOME_UNKNOWN"));
                Assert.That(response["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
                Assert.That(retained.Length, Is.EqualTo(1));
                Assert.That(File.ReadAllText(retained[0]), Is.EqualTo(envelope));
            }
            Assert.That(Directory.GetFiles(DurableCommandQueue.ProcessingDirectory), Is.Empty);
        }

        [Test]
        public void RecoveryMarkerSurvivesCompletedReceiptEviction()
        {
            var now = DateTime.UtcNow;
            RequestExecutionStore.UtcNow = () => now;
            var raw = QueueRequestEnvelopeTests.RequestObject("recovery-retention", "queue.test_non_replayable");
            var envelope = QueueRequestEnvelopeTests.EncodeForTests(raw.ToString(Formatting.None), BridgeSecurity.Token);
            WriteQueued("recovery-retention", envelope, true);
            DurableCommandQueue.PollWithinBudget(8, 1000);
            var requestDirectory = Path.Combine(directory, "requests");
            var markerPath = Directory.GetFiles(requestDirectory, "*.state.json").Single();
            var markerBytes = File.ReadAllBytes(markerPath);
            File.SetLastWriteTimeUtc(markerPath, now.AddMinutes(-5));

            // Real persisted completions put the marker beyond the result-cache cap.
            for (var index = 0; index < 1001; index++)
            {
                var newerJson = QueueRequestEnvelopeTests.RequestObject("newer-" + index, "health").ToString(Formatting.None);
                var newer = JsonRpcUtil.ParseRequest(newerJson);
                Assert.That(RequestExecutionStore.Begin(newer, newerJson, "newer-owner").Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
                RequestExecutionStore.Complete(newer, "newer-owner", JsonRpcUtil.Success(newer, "{\"ok\":true}"));
            }
            now = now.AddMinutes(2);
            raw["deadlineUnixMs"] = new DateTimeOffset(now).AddMinutes(1).ToUnixTimeMilliseconds();
            var retryJson = raw.ToString(Formatting.None);

            var retry = RequestExecutionStore.Begin(JsonRpcUtil.ParseRequest(retryJson), retryJson, "retry-owner");

            Assert.That(retry.Disposition, Is.EqualTo(RequestClaimDisposition.OutcomeUnknown));
            Assert.That(File.ReadAllBytes(markerPath), Is.EqualTo(markerBytes));
            Assert.That(Directory.GetFiles(requestDirectory, "*.result.json").Length, Is.EqualTo(1000), "Completed-result eviction must still work.");
            var retained = Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json").Single();
            Assert.That(File.ReadAllText(retained), Is.EqualTo(envelope));
        }

        [Test]
        public void RecoveryPreservesActiveExecutionOwnerAndItsLaterCompletion()
        {
            var now = DateTime.UtcNow;
            RequestExecutionStore.UtcNow = () => now;
            var json = QueueRequestEnvelopeTests.RequestObject("recovery-active", "queue.test_non_replayable").ToString(Formatting.None);
            var request = JsonRpcUtil.ParseRequest(json);
            Assert.That(RequestExecutionStore.Begin(request, json, "active-owner").Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            var statePath = Directory.GetFiles(Path.Combine(directory, "requests"), "*.state.json").Single();
            var stateBytes = File.ReadAllBytes(statePath);
            var envelope = QueueRequestEnvelopeTests.EncodeForTests(json, BridgeSecurity.Token);
            WriteQueued("recovery-active", envelope, true);

            DurableCommandQueue.PollWithinBudget(8, 1000);

            var response = ReadResponse("recovery-active");
            Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo("EXECUTING"));
            Assert.That(response["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
            Assert.That(File.ReadAllBytes(statePath), Is.EqualTo(stateBytes), "A stale queue lease must not revoke a different transport's live owner.");
            var retained = Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json").Single();
            Assert.That(File.ReadAllText(retained), Is.EqualTo(envelope));
            Assert.That(Directory.GetFiles(DurableCommandQueue.ProcessingDirectory), Is.Empty);
            var completed = RequestExecutionStore.Complete(request, "active-owner", JsonRpcUtil.Success(request, "{\"ok\":true,\"mutationCount\":1}"));
            Assert.That(JObject.Parse(completed)["result"]["ok"].Value<bool>(), Is.True);
            var retry = RequestExecutionStore.Begin(request, json, "retry-owner");
            Assert.That(retry.Disposition, Is.EqualTo(RequestClaimDisposition.Cached));
            Assert.That(retry.ResponseJson, Is.EqualTo(completed));
        }

        private JObject AssertRejectedBeforeExecution(string id, string envelope, bool stale, string code, string responseId = null)
        {
            WriteQueued(id, envelope, stale);
            DurableCommandQueue.PollWithinBudget(8, 1000);
            var response = ReadResponse(id);

            Assert.That(response["error"]["data"]["code"].Value<string>(), Is.EqualTo(code));
            Assert.That(response["result"], Is.Null);
            Assert.That(response["id"].Value<string>(), Is.EqualTo(responseId));
            Assert.That(response.ToString(), Does.Not.Contain("private-content-must-not-be-echoed").And.Not.Contain(BridgeSecurity.Token));
            Assert.That(Directory.Exists(Path.Combine(directory, "requests")), Is.False, "Rejected input must never enter the execution store or handler.");
            Assert.That(Directory.GetFiles(DurableCommandQueue.PendingDirectory, "*.json"), Is.Empty);
            Assert.That(Directory.GetFiles(DurableCommandQueue.ProcessingDirectory), Is.Empty);
            var deadletters = Directory.GetFiles(DurableCommandQueue.DeadLetterDirectory, "*.json");
            Assert.That(deadletters.Length, Is.EqualTo(1));
            Assert.That(File.ReadAllText(deadletters[0]), Is.EqualTo(envelope));
            return response;
        }

        private static JObject ReadResponse(string id)
        {
            return JObject.Parse(File.ReadAllText(Path.Combine(DurableCommandQueue.ResultsDirectory, id + ".json")));
        }

        private static string WriteQueued(string id, string envelope, bool stale)
        {
            var targetDirectory = stale ? DurableCommandQueue.ProcessingDirectory : DurableCommandQueue.PendingDirectory;
            Directory.CreateDirectory(targetDirectory);
            var path = Path.Combine(targetDirectory, id + (stale ? ".worker.claim.json" : ".json"));
            File.WriteAllText(path, envelope, new UTF8Encoding(false));
            if (stale)
            {
                File.WriteAllText(path + ".lease", new JObject
                {
                    ["queueKey"] = id,
                    ["leaseExpiresUtc"] = DateTime.UtcNow.AddMinutes(-1).ToString("O")
                }.ToString(Formatting.None));
            }
            return path;
        }

        private static void WritePending(string id, string method)
        {
            var request = QueueRequestEnvelopeTests.RequestObject(id, method);
            WriteQueued(id, QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Formatting.None), BridgeSecurity.Token), false);
        }
    }
}
