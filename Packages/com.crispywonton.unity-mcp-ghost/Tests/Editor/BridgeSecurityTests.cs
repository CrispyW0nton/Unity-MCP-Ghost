using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class BridgeSecurityTests
    {
        [Test]
        public void TokenIsStableRandomLengthAndBearerComparisonIsExact()
        {
            var first = BridgeSecurity.Token;
            var second = BridgeSecurity.Token;

            Assert.That(first, Is.EqualTo(second));
            Assert.That(first, Has.Length.EqualTo(64));
            Assert.That(BridgeSecurity.AuthenticateBearer("Bearer " + first), Is.True);
            Assert.That(BridgeSecurity.AuthenticateBearer("Bearer " + first.Substring(0, 63) + "0"), Is.False);
            Assert.That(BridgeSecurity.AuthenticateBearer(first), Is.False);
        }

        [Test]
        public void DefaultPortsAreDeterministicDistinctAndValid()
        {
            var settings = BridgeSettings.CreateDefault(BridgeSecurity.DeterministicPort);

            Assert.That(settings.Port, Is.InRange(6400, 7399));
            Assert.That(settings.WebSocketPort, Is.InRange(16400, 26399));
            Assert.That(settings.WebSocketPort, Is.Not.EqualTo(settings.Port));
        }

        [Test]
        public void RequestMustPinExactProjectAndEditorIdentity()
        {
            var request = Request("health");
            request.ProjectId = string.Empty;
            Assert.That(BridgeSecurity.AuthorizeRequest(request, false).Code, Is.EqualTo("PROJECT_ID_REQUIRED"));

            request.ProjectId = "wrong-project";
            Assert.That(BridgeSecurity.AuthorizeRequest(request, false).Code, Is.EqualTo("PROJECT_ID_MISMATCH"));

            request.ProjectId = BridgeSecurity.ProjectId;
            request.EditorInstanceId = "wrong-editor";
            Assert.That(BridgeSecurity.AuthorizeRequest(request, false).Code, Is.EqualTo("EDITOR_INSTANCE_ID_MISMATCH"));

            request.EditorInstanceId = BridgeSecurity.EditorInstanceId;
            Assert.That(BridgeSecurity.AuthorizeRequest(request, false).Allowed, Is.True);
        }

        [Test]
        public void QueueProofBindsRequestIdentityMethodAndDeadline()
        {
            var request = Request("health");
            request.AuthProof = BridgeSecurity.CreateQueueProof(request);
            Assert.That(BridgeSecurity.AuthorizeRequest(request, true).Allowed, Is.True);

            request.Method = "editor.get_state";
            Assert.That(BridgeSecurity.AuthorizeRequest(request, true).Code, Is.EqualTo("AUTHENTICATION_FAILED"));
        }

        [Test]
        public void DefaultCapabilitiesDenyDestructivePackageAndUnsafeExecution()
        {
            var settings = BridgeSettings.CreateDefault(BridgeSecurity.DeterministicPort);

            Assert.That(BridgeSecurity.AuthorizeCapability("asset.delete", "{}", settings).Code, Is.EqualTo("DESTRUCTIVE_CAPABILITY_DISABLED"));
            Assert.That(BridgeSecurity.AuthorizeCapability("package.search", "{}", settings).Code, Is.EqualTo("PACKAGE_NETWORK_CAPABILITY_DISABLED"));
            Assert.That(BridgeSecurity.AuthorizeCapability("script.execute", "{}", settings).Code, Is.EqualTo("ARBITRARY_CODE_CAPABILITY_DISABLED"));
            Assert.That(BridgeSecurity.AuthorizeCapability("reflection.invoke", "{}", settings).Code, Is.EqualTo("REFLECTION_CAPABILITY_DISABLED"));
            Assert.That(BridgeSecurity.AuthorizeCapability("asset.delete", "{\"dryRun\":true}", settings).Allowed, Is.True);
        }

        [Test]
        public void PackageAddRequiresEnabledCapabilityAndAllowedSource()
        {
            var settings = BridgeSettings.CreateDefault(BridgeSecurity.DeterministicPort);
            settings.AllowPackageNetwork = true;

            Assert.That(BridgeSecurity.AuthorizeCapability("package.add", "{\"packageId\":\"https://example.invalid/package.git\"}", settings).Code, Is.EqualTo("PACKAGE_SOURCE_NOT_ALLOWED"));
            Assert.That(BridgeSecurity.AuthorizeCapability("package.add", "{\"packageId\":\"com.unity.inputsystem\"}", settings).Allowed, Is.True);
        }

        [Test]
        public void BatchAuthorizationUsesTheMaximumNestedCapability()
        {
            var settings = BridgeSettings.CreateDefault(BridgeSecurity.DeterministicPort);
            var parameters = new JObject
            {
                ["operations"] = new JArray
                {
                    new JObject { ["method"] = "editor.get_state", ["params"] = new JObject() },
                    new JObject { ["method"] = "script.delete", ["params"] = new JObject { ["path"] = "Assets/Test.cs" } }
                }
            }.ToString();

            Assert.That(BridgeSecurity.AuthorizeCapability("batch.execute", parameters, settings).Code, Is.EqualTo("DESTRUCTIVE_CAPABILITY_DISABLED"));
        }

        [Test]
        public void RateLimiterRejectsBurstAndRecoversAfterWindow()
        {
            var limiter = new BridgeRateLimiter(2, TimeSpan.FromSeconds(1));
            var start = DateTime.UtcNow;

            Assert.That(limiter.TryAcquire(start), Is.True);
            Assert.That(limiter.TryAcquire(start), Is.True);
            Assert.That(limiter.TryAcquire(start), Is.False);
            Assert.That(limiter.TryAcquire(start.AddSeconds(1)), Is.True);
        }

        [Test]
        public void IdentityFileContainsLocationNotSecretValue()
        {
            BridgeSecurity.WriteIdentity(BridgeSecurity.DeterministicPort, BridgeSecurity.DeterministicWebSocketPort, false);
            var identity = File.ReadAllText(BridgeSecurity.IdentityPath);

            Assert.That(identity, Does.Contain(BridgeSecurity.ProjectId));
            Assert.That(identity, Does.Contain(BridgeSecurity.EditorInstanceId));
            Assert.That(identity, Does.Contain("\"webSocketPort\""));
            Assert.That(identity, Does.Contain(BridgeSecurity.TokenPath.Replace("\\", "\\\\")));
            Assert.That(identity, Does.Not.Contain(BridgeSecurity.Token));
        }

        private static UnityMcpRequest Request(string method)
        {
            return new UnityMcpRequest
            {
                Id = "security-test",
                IdJson = "\"security-test\"",
                Method = method,
                RawJson = "{}",
                DeadlineUnixMs = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(),
                IdempotencyKey = "security-test",
                ClientDeclaredIdempotent = true,
                ProjectId = BridgeSecurity.ProjectId,
                EditorInstanceId = BridgeSecurity.EditorInstanceId
            };
        }
    }
}
