using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class RequestExecutionStoreTests
    {
        private string directory;
        private DateTime now;

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Path.GetTempPath(), "gmcp-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            now = new DateTime(2026, 9, 4, 20, 0, 0, DateTimeKind.Utc);
            RequestExecutionStore.RootOverrideForTests = directory;
            RequestExecutionStore.UtcNow = () => now;
        }

        [TearDown]
        public void TearDown()
        {
            RequestExecutionStore.ResetForTests();
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void CompletedRequestReturnsPersistedResponseWithoutASecondClaim()
        {
            var request = Request("health", "shared-key", "{}");
            var raw = Raw(request, "{}");

            var first = RequestExecutionStore.Begin(request, raw, "owner-a");
            var completed = RequestExecutionStore.Complete(request, "owner-a", JsonRpcUtil.Success(request, "{\"ok\":true}"));
            var duplicate = RequestExecutionStore.Begin(request, raw, "owner-b");

            Assert.That(first.Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            Assert.That(duplicate.Disposition, Is.EqualTo(RequestClaimDisposition.Cached));
            Assert.That(duplicate.ResponseJson, Is.EqualTo(completed));
        }

        [Test]
        public void ReusingIdempotencyKeyWithDifferentPayloadIsRejected()
        {
            var firstRequest = Request("script.write", "same-key", "{\"content\":\"one\"}");
            var secondRequest = Request("script.write", "same-key", "{\"content\":\"two\"}");
            RequestExecutionStore.Begin(firstRequest, Raw(firstRequest, firstRequest.RawJson), "owner-a");

            var conflict = RequestExecutionStore.Begin(secondRequest, Raw(secondRequest, secondRequest.RawJson), "owner-b");

            Assert.That(conflict.Disposition, Is.EqualTo(RequestClaimDisposition.Conflict));
            Assert.That(JObject.Parse(conflict.ResponseJson)["error"]["code"].Value<int>(), Is.EqualTo(-32005));
        }

        [Test]
        public void SemanticRetryIgnoresDeadlineAndAuthenticationProofChanges()
        {
            var request = Request("health", "semantic-retry", "{\"b\":2,\"a\":1}");
            var first = RequestExecutionStore.Begin(request, Raw(request, request.RawJson, 1000, "proof-one"), "owner-a");
            var completed = RequestExecutionStore.Complete(request, "owner-a", JsonRpcUtil.Success(request, "{\"ok\":true}"));
            var retryRequest = Request("health", "semantic-retry", "{\"a\":1,\"b\":2}");
            retryRequest.Id = "retry-request";
            retryRequest.IdJson = "\"retry-request\"";

            var retry = RequestExecutionStore.Begin(retryRequest, Raw(retryRequest, retryRequest.RawJson, 2000, "proof-two"), "owner-b");

            Assert.That(first.Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            Assert.That(retry.Disposition, Is.EqualTo(RequestClaimDisposition.Cached));
            Assert.That(JObject.Parse(completed)["id"].Value<string>(), Is.EqualTo("semantic-retry"));
            Assert.That(JObject.Parse(retry.ResponseJson)["id"].Value<string>(), Is.EqualTo("retry-request"));
        }

        [Test]
        public void StaleNonIdempotentRequestBecomesOutcomeUnknownInsteadOfReplaying()
        {
            var request = Request("script.write", "mutation-key", "{\"content\":\"one\"}");
            var raw = Raw(request, request.RawJson);
            RequestExecutionStore.Begin(request, raw, "owner-a");
            now = now.AddMinutes(3);

            var stale = RequestExecutionStore.Begin(request, raw, "owner-b");

            Assert.That(stale.Disposition, Is.EqualTo(RequestClaimDisposition.OutcomeUnknown));
            Assert.That(JObject.Parse(stale.ResponseJson)["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
        }

        [Test]
        public void StaleReadOnlyRequestCanBeReclaimed()
        {
            var request = Request("health", "read-key", "{}");
            var raw = Raw(request, request.RawJson);
            RequestExecutionStore.Begin(request, raw, "owner-a");
            now = now.AddMinutes(3);

            var reclaimed = RequestExecutionStore.Begin(request, raw, "owner-b");

            Assert.That(reclaimed.Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            Assert.That(reclaimed.Owner, Is.EqualTo("owner-b"));
        }

        [Test]
        public void StaleScenarioRestoreCanBeReclaimedAfterDomainReload()
        {
            var request = Request("scenario.source_restore", "restore-key", "{\"transactionId\":\"scenario:case\"}");
            var raw = Raw(request, request.RawJson);
            RequestExecutionStore.Begin(request, raw, "owner-a");
            now = now.AddMinutes(3);

            var reclaimed = RequestExecutionStore.Begin(request, raw, "owner-b");

            Assert.That(reclaimed.Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            Assert.That(reclaimed.Owner, Is.EqualTo("owner-b"));
        }

        [Test]
        public void UnsafeIdempotencyKeyNeverBecomesAPath()
        {
            var request = Request("health", "../../outside", "{}");

            var claim = RequestExecutionStore.Begin(request, Raw(request, request.RawJson), "owner-a");

            Assert.That(claim.Disposition, Is.EqualTo(RequestClaimDisposition.Claimed));
            Assert.That(Directory.GetFiles(directory, "*.state.json").Length, Is.EqualTo(1));
            Assert.That(Directory.Exists(Path.Combine(directory, "..", "outside")), Is.False);
        }

        [Test]
        public void MissingCompletedResultNeverCausesMutationReplay()
        {
            var request = Request("script.write", "missing-result", "{\"content\":\"one\"}");
            var raw = Raw(request, request.RawJson);
            RequestExecutionStore.Begin(request, raw, "owner-a");
            RequestExecutionStore.Complete(request, "owner-a", JsonRpcUtil.Success(request, "{\"ok\":true}"));
            File.Delete(Directory.GetFiles(directory, "*.result.json").Single());

            var duplicate = RequestExecutionStore.Begin(request, raw, "owner-b");

            Assert.That(duplicate.Disposition, Is.EqualTo(RequestClaimDisposition.OutcomeUnknown));
            Assert.That(JObject.Parse(duplicate.ResponseJson)["error"]["data"]["outcomeUnknown"].Value<bool>(), Is.True);
        }

        private static UnityMcpRequest Request(string method, string key, string parameters)
        {
            return new UnityMcpRequest
            {
                Id = key,
                IdJson = "\"" + JsonRpcUtil.Escape(key) + "\"",
                IdempotencyKey = key,
                Method = method,
                RawJson = parameters,
                ProjectId = "project-test",
                EditorInstanceId = "editor-test"
            };
        }

        private static string Raw(UnityMcpRequest request, string parameters, long deadlineUnixMs = 0, string authProof = "")
        {
            return new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = request.Id,
                ["idempotencyKey"] = request.IdempotencyKey,
                ["method"] = request.Method,
                ["params"] = JObject.Parse(parameters),
                ["deadlineUnixMs"] = deadlineUnixMs,
                ["authProof"] = authProof
            }.ToString(Newtonsoft.Json.Formatting.None);
        }
    }
}
