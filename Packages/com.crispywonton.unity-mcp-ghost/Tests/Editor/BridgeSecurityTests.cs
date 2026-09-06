using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
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
            var differentLastDigit = first[63] == '0' ? '1' : '0';
            Assert.That(BridgeSecurity.AuthenticateBearer("Bearer " + first.Substring(0, 63) + differentLastDigit), Is.False);
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
            Assert.That(BridgeSecurity.AuthorizeRequest(request).Code, Is.EqualTo("PROJECT_ID_REQUIRED"));

            request.ProjectId = "wrong-project";
            Assert.That(BridgeSecurity.AuthorizeRequest(request).Code, Is.EqualTo("PROJECT_ID_MISMATCH"));

            request.ProjectId = BridgeSecurity.ProjectId;
            request.EditorInstanceId = "wrong-editor";
            Assert.That(BridgeSecurity.AuthorizeRequest(request).Code, Is.EqualTo("EDITOR_INSTANCE_ID_MISMATCH"));

            request.EditorInstanceId = BridgeSecurity.EditorInstanceId;
            Assert.That(BridgeSecurity.AuthorizeRequest(request).Allowed, Is.True);
        }

        [TestCase("id")]
        [TestCase("requestId")]
        [TestCase("method")]
        [TestCase("deadlineUnixMs")]
        [TestCase("idempotencyKey")]
        [TestCase("projectId")]
        [TestCase("editorInstanceId")]
        [TestCase("jsonrpc")]
        public void QueueProofBindsEveryRequestMetadataField(string field)
        {
            var request = QueueRequestEnvelopeTests.RequestObject();
            var envelope = JObject.Parse(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token));
            var authenticated = QueueRequestEnvelopeTests.DecodeForTests(envelope.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token);
            Assert.That(BridgeSecurity.AuthorizeRequest(JsonRpcUtil.ParseRequest(authenticated)).Allowed, Is.True);

            request[field] = field == "deadlineUnixMs" ? (JToken)(request[field].Value<long>() + 1) : new JValue("changed");
            envelope["requestJson"] = request.ToString(Newtonsoft.Json.Formatting.None);
            var error = Assert.Throws<QueueRequestEnvelopeException>(() => QueueRequestEnvelopeTests.DecodeForTests(envelope.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token));
            Assert.That(error.Code, Is.EqualTo("AUTHENTICATION_FAILED"));
        }

        [TestCase("dryRun")]
        [TestCase("path")]
        [TestCase("content")]
        [TestCase("nestedBatch")]
        [TestCase("idempotent")]
        public void QueueProofRejectsTamperingToParametersAndIdempotencyDeclaration(string field)
        {
            // Only authorize a health request; this regression never executes a mutation.
            var request = QueueRequestEnvelopeTests.RequestObject();
            var parameters = JObject.Parse("{\"dryRun\":true,\"path\":\"Assets/Original.txt\",\"content\":\"original\",\"operations\":[{\"method\":\"health\",\"params\":{\"content\":\"original\"}}]}");
            request["params"] = parameters;
            var envelope = JObject.Parse(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token));
            var authenticated = QueueRequestEnvelopeTests.DecodeForTests(envelope.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token);
            Assert.That(BridgeSecurity.AuthorizeRequest(JsonRpcUtil.ParseRequest(authenticated)).Allowed, Is.True);

            switch (field)
            {
                case "dryRun": parameters["dryRun"] = false; break;
                case "path": parameters["path"] = "Assets/Changed.txt"; break;
                case "content": parameters["content"] = "changed"; break;
                case "nestedBatch": parameters["operations"][0]["params"]["content"] = "changed"; break;
                case "idempotent": request["idempotent"] = false; break;
            }
            envelope["requestJson"] = request.ToString(Newtonsoft.Json.Formatting.None);

            var error = Assert.Throws<QueueRequestEnvelopeException>(() => QueueRequestEnvelopeTests.DecodeForTests(envelope.ToString(Newtonsoft.Json.Formatting.None), BridgeSecurity.Token));
            Assert.That(error.Code, Is.EqualTo("AUTHENTICATION_FAILED"));
        }

        [Test]
        public void AuthenticatedQueueStillEnforcesIdentityAndCapabilities()
        {
            var request = QueueRequestEnvelopeTests.RequestObject();
            request["projectId"] = "wrong-project";
            var authenticated = QueueRequestEnvelopeTests.DecodeForTests(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(), BridgeSecurity.Token), BridgeSecurity.Token);
            Assert.That(BridgeSecurity.AuthorizeRequest(JsonRpcUtil.ParseRequest(authenticated)).Code, Is.EqualTo("PROJECT_ID_MISMATCH"));

            request["projectId"] = BridgeSecurity.ProjectId;
            request["method"] = "asset.delete";
            authenticated = QueueRequestEnvelopeTests.DecodeForTests(QueueRequestEnvelopeTests.EncodeForTests(request.ToString(), BridgeSecurity.Token), BridgeSecurity.Token);
            Assert.That(BridgeSecurity.AuthorizeCapability(JsonRpcUtil.ParseRequest(authenticated).Method, "{}", BridgeSettings.CreateDefault(BridgeSecurity.DeterministicPort)).Code,
                Is.EqualTo("DESTRUCTIVE_CAPABILITY_DISABLED"));
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
        public void HealthReflectsActiveCapabilityRevocationWithoutWaitingForIdentityHeartbeat()
        {
            // Replace only the cached in-memory settings for this serial test.
            // Never save settings, republish identity, or modify token files.
            var field = typeof(BridgeSecurity).GetField("settings",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Assert.That(field, Is.Not.Null);
            var active = BridgeSecurity.Settings;
            var original = field.GetValue(null);
            try
            {
                active.AllowDestructive = true;
                field.SetValue(null, active);
                var startupHealth = ReadAuthorizedHealth();

                active.AllowDestructive = false;
                var revokedHealth = ReadAuthorizedHealth();
                Assert.That((bool?)revokedHealth["capabilities"]?["destructive"], Is.False,
                    "Health must expose the currently enforced capability after revocation.");
                Assert.That((bool?)startupHealth["capabilities"]?["destructive"], Is.True);
                Assert.That(BridgeSecurity.AuthorizeRequest(Request("script.delete")).Code,
                    Is.EqualTo("DESTRUCTIVE_CAPABILITY_DISABLED"));
                Assert.That((string)revokedHealth["projectId"], Is.EqualTo(BridgeSecurity.ProjectId));
                Assert.That((string)revokedHealth["editorInstanceId"], Is.EqualTo(BridgeSecurity.EditorInstanceId));
                Assert.That((bool)revokedHealth["authenticated"], Is.True);
            }
            finally
            {
                field.SetValue(null, original);
            }
        }

        private static JObject ReadAuthorizedHealth()
        {
            var request = Request("health");
            Assert.That(BridgeSecurity.AuthorizeRequest(request).Allowed, Is.True);
            var response = JObject.Parse(new CommandRegistry().Execute(request));
            Assert.That(response["error"], Is.Null, response.ToString());
            return (JObject)response["result"];
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

        [TestCase("http", 6501)]
        [TestCase("websocket", 16501)]
        public void AddressInUseBindFailureNamesTheExactTransportAndPort(string transport, int port)
        {
            var failure = BridgeStartupFailure.FromException(
                new SocketException((int)SocketError.AddressAlreadyInUse), "bind", transport, port);

            Assert.That(failure.Code, Is.EqualTo("BRIDGE_ENDPOINT_CONFLICT"));
            var receipt = failure.ToJson();
            Assert.That((string)receipt["stage"], Is.EqualTo("bind"));
            Assert.That((string)receipt["transport"], Is.EqualTo(transport));
            Assert.That((int)receipt["port"], Is.EqualTo(port));
            Assert.That((string)receipt["socketErrorCode"], Is.EqualTo("AddressAlreadyInUse"));
        }

        [Test]
        public void HttpUrlRegistrationConflictIsRecognizedOnlyDuringHttpBind()
        {
            var exception = new HttpListenerException(183);
            Assert.That(BridgeStartupFailure.FromException(exception, "bind", "http", 6501).Code,
                Is.EqualTo("BRIDGE_ENDPOINT_CONFLICT"));
            Assert.That(BridgeStartupFailure.FromException(exception, "bind", "websocket", 16501).Code,
                Is.EqualTo("BRIDGE_STARTUP_FAILED"));
            Assert.That(BridgeStartupFailure.FromException(exception, "publish", "http", 6501).Code,
                Is.EqualTo("BRIDGE_STARTUP_FAILED"));
        }

        [Test]
        public void GenericOrPermissionFailuresCannotClaimEndpointConflictsOrPublishExceptionMessages()
        {
            const string secret = "startup-exception-secret-that-must-not-be-published";
            foreach (var exception in new Exception[]
            {
                new InvalidOperationException("Address already in use: " + secret),
                new SocketException((int)SocketError.AccessDenied),
                new HttpListenerException(5, secret)
            })
            {
                var failure = BridgeStartupFailure.FromException(exception, "bind", "http", 6501);
                Assert.That(failure.Code, Is.EqualTo("BRIDGE_STARTUP_FAILED"));
                Assert.That(failure.ToJson().ToString(), Does.Not.Contain(secret));
            }
            Assert.That(BridgeStartupFailure.FromException(
                new SocketException((int)SocketError.AddressAlreadyInUse), "initialize", "http", 6501).Code,
                Is.EqualTo("BRIDGE_STARTUP_FAILED"));
        }

        [Test]
        public void FailedHttpBindPersistsConfiguredPortsAndReceiptAcrossHeartbeats()
        {
            var occupied = new TcpListener(IPAddress.Loopback, 0);
            occupied.Start();
            var server = new UnityMcpGhostServer();
            try
            {
                var port = ((IPEndPoint)occupied.LocalEndpoint).Port;
                var webSocketPort = BridgeSecurity.Settings.WebSocketPort;
                Assert.That(server.Start(port), Is.False);
                var first = JObject.Parse(File.ReadAllText(BridgeSecurity.IdentityPath));
                Assert.That((bool)first["running"], Is.False);
                Assert.That((int)first["port"], Is.EqualTo(port));
                Assert.That((int)first["webSocketPort"], Is.EqualTo(webSocketPort));
                Assert.That((string)first["startupFailure"]["code"], Is.EqualTo("BRIDGE_ENDPOINT_CONFLICT"));
                Assert.That((string)first["startupFailure"]["transport"], Is.EqualTo("http"));
                Assert.That((int)first["startupFailure"]["port"], Is.EqualTo(port));

                server.Heartbeat();
                var heartbeat = JObject.Parse(File.ReadAllText(BridgeSecurity.IdentityPath));
                Assert.That(JToken.DeepEquals(first["startupFailure"], heartbeat["startupFailure"]), Is.True);
                Assert.That((int)heartbeat["port"], Is.EqualTo(port));
                Assert.That((int)heartbeat["webSocketPort"], Is.EqualTo(webSocketPort));
                Assert.That(heartbeat.ToString(), Does.Not.Contain(BridgeSecurity.Token));
            }
            finally
            {
                server.Stop();
                occupied.Stop();
                UnityMcpGhostServer.Shared.Heartbeat();
            }
        }

        [Test]
        public void RunningIdentityClearsAnyPriorStartupFailure()
        {
            var failure = BridgeStartupFailure.FromException(
                new SocketException((int)SocketError.AddressAlreadyInUse), "bind", "http", 6501);
            try
            {
                BridgeSecurity.WriteIdentity(6501, 16501, false, failure);
                var failed = JObject.Parse(File.ReadAllText(BridgeSecurity.IdentityPath));
                Assert.That((string)failed["startupFailure"]["code"], Is.EqualTo("BRIDGE_ENDPOINT_CONFLICT"));

                BridgeSecurity.WriteIdentity(6501, 16501, true, failure);
                var running = JObject.Parse(File.ReadAllText(BridgeSecurity.IdentityPath));
                Assert.That(running["startupFailure"].Type, Is.EqualTo(JTokenType.Null));
            }
            finally
            {
                UnityMcpGhostServer.Shared.Heartbeat();
            }
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
