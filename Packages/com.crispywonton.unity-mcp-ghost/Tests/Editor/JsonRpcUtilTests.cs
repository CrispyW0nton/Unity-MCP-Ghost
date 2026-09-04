using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class JsonRpcUtilTests
    {
        [Test]
        public void ParseRequest_PreservesStringAndNumericIds()
        {
            var stringRequest = JsonRpcUtil.ParseRequest("{\"jsonrpc\":\"2.0\",\"id\":\"alpha\",\"method\":\"ping\",\"params\":{}}");
            var numericRequest = JsonRpcUtil.ParseRequest("{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"ping\",\"params\":{}}");

            Assert.That(stringRequest.IdJson, Is.EqualTo("\"alpha\""));
            Assert.That(numericRequest.IdJson, Is.EqualTo("42"));
            Assert.That(JObject.Parse(JsonRpcUtil.Success(numericRequest, "{\"ok\":true}"))["id"].Type, Is.EqualTo(JTokenType.Integer));
        }

        [Test]
        public void ParseRequest_ScopesReadsToParams()
        {
            var request = JsonRpcUtil.ParseRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"example\",\"nested\":{\"limit\":999},\"params\":{\"limit\":5,\"message\":\"ok\"}}");

            Assert.That(JsonRpcUtil.ReadInt(request.RawJson, "limit", 0), Is.EqualTo(5));
            Assert.That(JsonRpcUtil.ReadString(request.RawJson, "message", ""), Is.EqualTo("ok"));
        }

        [Test]
        public void ParseRequest_RejectsDuplicateKeysAtAnyDepth()
        {
            Assert.Throws<JsonRpcProtocolException>(() => JsonRpcUtil.ParseRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"limit\":1,\"limit\":2}}"));
        }

        [Test]
        public void Serializer_RoundTripsUnicodeAndControlEscapes()
        {
            const string value = "Marvin ☃\b\f\n\r\t";
            var objectJson = "{\"value\":\"" + JsonRpcUtil.Escape(value) + "\"}";

            Assert.That(JsonRpcUtil.ReadString(objectJson, "value", ""), Is.EqualTo(value));
        }

        [TestCase("not json", -32700)]
        [TestCase("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}", -32600)]
        [TestCase("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"\"}", -32600)]
        [TestCase("{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"ping\"}", -32600)]
        public void ParseRequest_RejectsMalformedOrInvalidRequests(string json, int expectedCode)
        {
            var exception = Assert.Throws<JsonRpcProtocolException>(() => JsonRpcUtil.ParseRequest(json));

            Assert.That(exception.ErrorCode, Is.EqualTo(expectedCode));
        }

        [Test]
        public void ParseRequest_RejectsOversizedBodies()
        {
            var oversized = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"value\":\"" + new string('x', JsonRpcUtil.MaxRequestCharacters) + "\"}}";

            Assert.Throws<JsonRpcProtocolException>(() => JsonRpcUtil.ParseRequest(oversized));
        }

        [Test]
        public void CommandRegistry_ReturnsUnknownMethodErrorWithOriginalIdType()
        {
            var request = JsonRpcUtil.ParseRequest("{\"jsonrpc\":\"2.0\",\"id\":73,\"method\":\"does.not.exist\",\"params\":{}}");

            var response = JObject.Parse(new CommandRegistry().Execute(request));

            Assert.That(response["id"].Type, Is.EqualTo(JTokenType.Integer));
            Assert.That(response["id"].Value<int>(), Is.EqualTo(73));
            Assert.That(response["error"]["code"].Value<int>(), Is.EqualTo(-32601));
        }
    }
}
