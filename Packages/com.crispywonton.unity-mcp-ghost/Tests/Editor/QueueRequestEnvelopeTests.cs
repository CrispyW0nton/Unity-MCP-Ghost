using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class QueueRequestEnvelopeTests
    {
        private const string PublicToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        [Test]
        public void VerifiesSharedNodeKnownAnswerWithoutReserializingInnerJson()
        {
            var fixtureAsset = AssetDatabase.LoadAssetAtPath<TextAsset>("Packages/com.crispywonton.unity-mcp-ghost/Tests/Editor/Fixtures/queue-request-v2.json");
            Assert.That(fixtureAsset, Is.Not.Null, "The shared public vector must be available in installed package layouts.");
            var fixture = JObject.Parse(fixtureAsset.text);
            var requestJson = fixture["requestJson"].Value<string>();
            var envelope = new JObject
            {
                ["authProofVersion"] = 2,
                ["requestJson"] = requestJson,
                ["authProof"] = fixture["authProof"]
            };

            Assert.That(DecodeForTests(envelope.ToString(Formatting.None), fixture["token"].Value<string>()), Is.EqualTo(requestJson));
            Assert.That(requestJson, Does.Contain("1.25e+3").And.Contain("\"negativeZero\":-0").And.Contain("雪"));
            Assert.That(JsonRpcUtil.ParseRequest(requestJson).Method, Is.EqualTo("health"));
            envelope["requestJson"] = requestJson.Replace("1.25e+3", "1250");
            AssertFailure(envelope.ToString(Formatting.None), "AUTHENTICATION_FAILED");
        }

        [TestCase(null)]
        [TestCase("")]
        [TestCase("not-a-token")]
        [TestCase("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")]
        public void RejectsMissingMalformedAndWrongToken(string token)
        {
            var envelope = EncodeForTests("{}", PublicToken);
            var error = Assert.Throws<QueueRequestEnvelopeException>(() => DecodeForTests(envelope, token));
            Assert.That(error.Code, Is.EqualTo("AUTHENTICATION_FAILED"));
            Assert.That(error.Message, Does.Not.Contain(PublicToken));
        }

        [TestCase(null)]
        [TestCase("")]
        [TestCase("ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFAB")]
        [TestCase("0000000000000000000000000000000000000000000000000000000000000000")]
        public void RejectsMissingMalformedAndWrongProof(string proof)
        {
            var envelope = JObject.Parse(EncodeForTests("{}", PublicToken));
            if (proof == null) envelope.Remove("authProof");
            else envelope["authProof"] = proof;
            AssertFailure(envelope.ToString(Formatting.None), "AUTHENTICATION_FAILED");
        }

        [TestCase("{}")]
        [TestCase("{\"jsonrpc\":\"2.0\",\"id\":\"legacy\",\"method\":\"health\",\"authProof\":\"legacy\"}")]
        [TestCase("{\"authProofVersion\":1}")]
        [TestCase("{\"authProofVersion\":3}")]
        [TestCase("{\"authProofVersion\":2.0}")]
        [TestCase("{\"authProofVersion\":\"2\"}")]
        public void RejectsLegacyMissingAndUnsupportedVersions(string envelope)
        {
            AssertFailure(envelope, "QUEUE_PROOF_VERSION_UNSUPPORTED");
        }

        [TestCase("")]
        [TestCase("[]")]
        [TestCase("null")]
        [TestCase("{broken}")]
        [TestCase("{\"authProofVersion\":2,\"requestJson\":{}}")]
        [TestCase("{\"authProofVersion\":2,\"requestJson\":\"{}\",\"authProof\":\"x\",\"extra\":true}")]
        [TestCase("{\"authProofVersion\":2,\"authProofVersion\":2}")]
        [TestCase("{\"authProofVersion\":2,\"requestJson\":\"{}\",\"requestJson\":\"{}\"}")]
        [TestCase("{\"authProofVersion\":2,\"authProof\":\"x\",\"authProof\":\"x\"}")]
        [TestCase("{\"authProofVersion\":2,\"requestJson\":\"{}\",\"request\\u004ason\":\"{}\"}")]
        public void RejectsMalformedDuplicateAndUnexpectedOuterFields(string envelope)
        {
            AssertFailure(envelope, "QUEUE_ENVELOPE_INVALID");
        }

        [Test]
        public void RejectsTrailingOuterContentAndAuthenticatesBeforeInnerParsing()
        {
            AssertFailure(EncodeForTests("{}", PublicToken) + " {}", "QUEUE_ENVELOPE_INVALID");
            var malformedInner = "{secret-invalid-inner";
            // A valid proof returns exact bytes; JSON-RPC parsing is the next boundary.
            Assert.That(DecodeForTests(EncodeForTests(malformedInner, PublicToken), PublicToken), Is.EqualTo(malformedInner));
            var envelope = JObject.Parse(EncodeForTests("{}", PublicToken));
            envelope["requestJson"] = malformedInner;
            var error = Assert.Throws<QueueRequestEnvelopeException>(() => DecodeForTests(envelope.ToString(Formatting.None), PublicToken));
            Assert.That(error.Code, Is.EqualTo("AUTHENTICATION_FAILED"));
            Assert.That(error.Message, Does.Not.Contain("secret-invalid-inner"));
        }

        [Test]
        public void RejectsInvalidUtf8BytesWithoutReplacementDecoding()
        {
            var valid = Encoding.UTF8.GetBytes(EncodeForTests("{}", PublicToken));
            var bytes = new byte[valid.Length + 2];
            Array.Copy(valid, bytes, valid.Length);
            bytes[valid.Length] = 0xc3;
            bytes[valid.Length + 1] = 0x28;
            using (var stream = new MemoryStream(bytes))
            {
                var error = Assert.Throws<QueueRequestEnvelopeException>(() => QueueRequestEnvelope.Decode(stream, PublicToken));
                Assert.That(error.Code, Is.EqualTo("INVALID_UTF8"));
            }
        }

        [Test]
        public void InnerLimitCountsUtf8BytesAndAcceptsTheExactBoundary()
        {
            var boundary = new string('é', QueueRequestEnvelope.MaxRequestBytes / 2);
            Assert.That(DecodeForTests(EncodeForTests(boundary, PublicToken), PublicToken), Is.EqualTo(boundary));
            AssertFailure(EncodeForTests(boundary + "a", PublicToken), "REQUEST_TOO_LARGE");
        }

        [Test]
        public void OuterLimitAcceptsBoundaryAndStopsAfterLimitPlusOneWithoutSeeking()
        {
            var valid = EncodeForTests("{}", PublicToken);
            var exact = valid + new string(' ', QueueRequestEnvelope.MaxEnvelopeBytes - Encoding.UTF8.GetByteCount(valid));
            Assert.That(DecodeForTests(exact, PublicToken), Is.EqualTo("{}"));
            using (var stream = new NonSeekableStream(Encoding.UTF8.GetBytes(exact + "extra bytes")))
            {
                var error = Assert.Throws<QueueRequestEnvelopeException>(() => QueueRequestEnvelope.Decode(stream, PublicToken));
                Assert.That(error.Code, Is.EqualTo("QUEUE_ENVELOPE_TOO_LARGE"));
                Assert.That(stream.Consumed, Is.EqualTo(QueueRequestEnvelope.MaxEnvelopeBytes + 1));
            }
        }

        internal static JObject RequestObject(string id = "security-test", string method = "health")
        {
            return new JObject
            {
                ["jsonrpc"] = "2.0", ["id"] = id, ["requestId"] = id,
                ["idempotencyKey"] = id, ["idempotent"] = true,
                ["deadlineUnixMs"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(),
                ["projectId"] = BridgeSecurity.ProjectId, ["editorInstanceId"] = BridgeSecurity.EditorInstanceId,
                ["method"] = method, ["params"] = new JObject()
            };
        }

        internal static string EncodeForTests(string requestJson, string token)
        {
            // Deliberately independent of the production decoder; shared vector above
            // additionally prevents a matching mistake in both test/production C# code.
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token)))
            {
                return new JObject
                {
                    ["authProofVersion"] = 2,
                    ["requestJson"] = requestJson,
                    ["authProof"] = string.Concat(hmac.ComputeHash(Encoding.UTF8.GetBytes("UnityMcpGhost.Queue.v2\0" + requestJson)).Select(value => value.ToString("x2")))
                }.ToString(Formatting.None);
            }
        }

        internal static string DecodeForTests(string envelope, string token)
        {
            using (var stream = new MemoryStream(new UTF8Encoding(false, true).GetBytes(envelope)))
            {
                return QueueRequestEnvelope.Decode(stream, token);
            }
        }

        private static void AssertFailure(string envelope, string code)
        {
            var error = Assert.Throws<QueueRequestEnvelopeException>(() => DecodeForTests(envelope, PublicToken));
            Assert.That(error.Code, Is.EqualTo(code));
        }

        private sealed class NonSeekableStream : MemoryStream
        {
            public NonSeekableStream(byte[] bytes) : base(bytes) { }
            public override bool CanSeek => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public long Consumed { get; private set; }
            public override int Read(byte[] buffer, int offset, int count)
            {
                var read = base.Read(buffer, offset, count);
                Consumed += read;
                return read;
            }
        }
    }
}
