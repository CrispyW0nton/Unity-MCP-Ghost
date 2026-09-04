using System;
using System.Net.WebSockets;
using System.Text;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class BoundedWebSocketMessageTests
    {
        [Test]
        public void ReassemblesFragmentedTextBeforeParsing()
        {
            var first = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",");
            var secondBody = Encoding.UTF8.GetBytes("\"method\":\"ping\"}");
            var second = new byte[secondBody.Length + 4];
            Buffer.BlockCopy(secondBody, 0, second, 2, secondBody.Length);
            using (var message = new BoundedWebSocketMessage(1024))
            {
                var firstStatus = message.Append(new ArraySegment<byte>(first), new WebSocketReceiveResult(first.Length, WebSocketMessageType.Text, false));
                var secondStatus = message.Append(new ArraySegment<byte>(second, 2, secondBody.Length), new WebSocketReceiveResult(secondBody.Length, WebSocketMessageType.Text, true));

                Assert.That(firstStatus, Is.EqualTo(WebSocketMessageAppendStatus.Continue));
                Assert.That(secondStatus, Is.EqualTo(WebSocketMessageAppendStatus.Complete));
                Assert.That(message.GetText(), Is.EqualTo("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}"));
            }
        }

        [Test]
        public void RejectsAggregateSizeAcrossFragments()
        {
            using (var message = new BoundedWebSocketMessage(5))
            {
                Assert.That(message.Append(new ArraySegment<byte>(new byte[] { 1, 2, 3 }), new WebSocketReceiveResult(3, WebSocketMessageType.Text, false)), Is.EqualTo(WebSocketMessageAppendStatus.Continue));
                Assert.That(message.Append(new ArraySegment<byte>(new byte[] { 4, 5, 6 }), new WebSocketReceiveResult(3, WebSocketMessageType.Text, true)), Is.EqualTo(WebSocketMessageAppendStatus.TooLarge));
            }
        }

        [Test]
        public void RejectsInvalidUtf8AtMessageBoundary()
        {
            using (var message = new BoundedWebSocketMessage(10))
            {
                var invalid = new byte[] { 0xc3, 0x28 };
                Assert.That(message.Append(new ArraySegment<byte>(invalid), new WebSocketReceiveResult(invalid.Length, WebSocketMessageType.Text, true)), Is.EqualTo(WebSocketMessageAppendStatus.InvalidUtf8));
            }
        }
    }
}
