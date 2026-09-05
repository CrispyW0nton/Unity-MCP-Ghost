using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class LoopbackWebSocketServerTests
    {
        private const string Token = "test-token";

        [TestCase("", "", 401)]
        [TestCase("Bearer test-token", "https://example.invalid", 403)]
        [TestCase("Bearer test-token", "", 426)]
        public void RejectsUnauthenticatedBrowserAndInvalidUpgradeRequests(string authorization, string origin, int expectedStatus)
        {
            Task.Run(() => RejectsUnauthenticatedBrowserAndInvalidUpgradeRequestsAsync(authorization, origin, expectedStatus))
                .GetAwaiter()
                .GetResult();
        }

        private static async Task RejectsUnauthenticatedBrowserAndInvalidUpgradeRequestsAsync(string authorization, string origin, int expectedStatus)
        {
            using (var server = CreateServer(1024))
            {
                server.Start();
                var request = Handshake(authorization, origin, includeUpgrade: false);
                var response = await SendHttp(server.BoundPort, request);

                StringAssert.StartsWith("HTTP/1.1 " + expectedStatus, response);
            }
        }

        [Test]
        public void AuthenticatedFragmentedMessageIsReassembledAndDispatched()
        {
            Task.Run(AuthenticatedFragmentedMessageIsReassembledAndDispatchedAsync).GetAwaiter().GetResult();
        }

        private static async Task AuthenticatedFragmentedMessageIsReassembledAndDispatchedAsync()
        {
            using (var server = CreateServer(1024))
            using (var client = await ConnectAuthenticated(server))
            {
                var stream = client.GetStream();
                await WriteFrame(stream, 1, false, Encoding.UTF8.GetBytes("{\"part\":"));
                await WriteFrame(stream, 0, true, Encoding.UTF8.GetBytes("true}"));

                var frame = await ReadFrame(stream);

                Assert.That(frame.Opcode, Is.EqualTo(1));
                Assert.That(Encoding.UTF8.GetString(frame.Payload), Is.EqualTo("{\"ok\":true}"));
            }
        }

        [Test]
        public void OversizedMessageClosesWith1009()
        {
            Task.Run(OversizedMessageClosesWith1009Async).GetAwaiter().GetResult();
        }

        private static async Task OversizedMessageClosesWith1009Async()
        {
            using (var server = CreateServer(8))
            using (var client = await ConnectAuthenticated(server))
            {
                var stream = client.GetStream();
                await WriteFrame(stream, 1, true, Encoding.UTF8.GetBytes("0123456789"));

                var frame = await ReadFrame(stream);

                Assert.That(frame.Opcode, Is.EqualTo(8));
                Assert.That((frame.Payload[0] << 8) | frame.Payload[1], Is.EqualTo(1009));
            }
        }

        [Test]
        public void IncompleteHandshakesExpireWithoutBlockingAuthenticatedClients()
        {
            Task.Run(IncompleteHandshakesExpireWithoutBlockingAuthenticatedClientsAsync).GetAwaiter().GetResult();
        }

        private static async Task IncompleteHandshakesExpireWithoutBlockingAuthenticatedClientsAsync()
        {
            var partialClients = new List<TcpClient>();
            using (var server = CreateServer(1024, TimeSpan.FromMilliseconds(100)))
            {
                server.Start();
                try
                {
                    for (var index = 0; index < 8; index++)
                    {
                        var client = new TcpClient();
                        await client.ConnectAsync("127.0.0.1", server.BoundPort);
                        partialClients.Add(client);
                        var bytes = Encoding.ASCII.GetBytes("GET /unity-mcp-ghost/ HTTP/1.1\r\nHost: localhost\r\n");
                        await client.GetStream().WriteAsync(bytes, 0, bytes.Length);
                    }

                    using (var authenticated = await ConnectAuthenticated(server))
                    {
                        Assert.That(authenticated.Connected, Is.True);
                    }

                    await Task.Delay(250);
                    Assert.That(server.PendingHandshakeCount, Is.EqualTo(0));
                    Assert.That(server.ClientCount, Is.EqualTo(0));
                }
                finally
                {
                    foreach (var client in partialClients)
                    {
                        client.Dispose();
                    }
                }
            }
        }

        private static LoopbackWebSocketServer CreateServer(int maxBytes, TimeSpan? timeout = null)
        {
            return new LoopbackWebSocketServer(
                0,
                maxBytes,
                value => string.Equals(value, "Bearer " + Token, StringComparison.Ordinal),
                value => Task.FromResult(value == "{\"part\":true}" ? "{\"ok\":true}" : "{\"ok\":false}"),
                exception => { },
                timeout);
        }

        private static async Task<TcpClient> ConnectAuthenticated(LoopbackWebSocketServer server)
        {
            if (server.BoundPort == 0)
            {
                server.Start();
            }
            var client = new TcpClient();
            await client.ConnectAsync("127.0.0.1", server.BoundPort);
            var stream = client.GetStream();
            var request = Handshake("Bearer " + Token, "", includeUpgrade: true);
            var bytes = Encoding.ASCII.GetBytes(request);
            await stream.WriteAsync(bytes, 0, bytes.Length);
            var response = await ReadHttp(stream);
            StringAssert.StartsWith("HTTP/1.1 101", response);
            return client;
        }

        private static string Handshake(string authorization, string origin, bool includeUpgrade)
        {
            var builder = new StringBuilder("GET /unity-mcp-ghost/ HTTP/1.1\r\nHost: localhost\r\n");
            if (!string.IsNullOrEmpty(authorization)) builder.Append("Authorization: ").Append(authorization).Append("\r\n");
            if (!string.IsNullOrEmpty(origin)) builder.Append("Origin: ").Append(origin).Append("\r\n");
            if (includeUpgrade)
            {
                builder.Append("Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAECAwQFBgcICQoLDA0ODw==\r\n");
            }
            return builder.Append("\r\n").ToString();
        }

        private static async Task<string> SendHttp(int port, string request)
        {
            using (var client = new TcpClient())
            {
                await client.ConnectAsync("127.0.0.1", port);
                var stream = client.GetStream();
                var bytes = Encoding.ASCII.GetBytes(request);
                await stream.WriteAsync(bytes, 0, bytes.Length);
                return await ReadHttp(stream);
            }
        }

        private static async Task<string> ReadHttp(NetworkStream stream)
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
            using (var buffer = new MemoryStream())
            {
                var bytes = new byte[256];
                while (Encoding.ASCII.GetString(buffer.ToArray()).IndexOf("\r\n\r\n", StringComparison.Ordinal) < 0)
                {
                    var read = await stream.ReadAsync(bytes, 0, bytes.Length, cancellation.Token);
                    if (read == 0) break;
                    buffer.Write(bytes, 0, read);
                }
                return Encoding.ASCII.GetString(buffer.ToArray());
            }
        }

        private static async Task WriteFrame(NetworkStream stream, int opcode, bool final, byte[] payload)
        {
            var mask = new byte[] { 1, 2, 3, 4 };
            using (var frame = new MemoryStream())
            {
                frame.WriteByte((byte)((final ? 0x80 : 0) | opcode));
                frame.WriteByte((byte)(0x80 | payload.Length));
                frame.Write(mask, 0, mask.Length);
                for (var index = 0; index < payload.Length; index++) frame.WriteByte((byte)(payload[index] ^ mask[index % mask.Length]));
                var bytes = frame.ToArray();
                await stream.WriteAsync(bytes, 0, bytes.Length);
            }
        }

        private static async Task<WebSocketFrame> ReadFrame(NetworkStream stream)
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
            {
                var header = await ReadExact(stream, 2, cancellation.Token);
                var length = header[1] & 0x7f;
                if (length == 126)
                {
                    var extended = await ReadExact(stream, 2, cancellation.Token);
                    length = (extended[0] << 8) | extended[1];
                }
                return new WebSocketFrame { Opcode = header[0] & 0x0f, Payload = await ReadExact(stream, length, cancellation.Token) };
            }
        }

        private static async Task<byte[]> ReadExact(NetworkStream stream, int count, CancellationToken token)
        {
            var result = new byte[count];
            var offset = 0;
            while (offset < count)
            {
                var read = await stream.ReadAsync(result, offset, count - offset, token);
                if (read == 0) throw new EndOfStreamException();
                offset += read;
            }
            return result;
        }

        private sealed class WebSocketFrame
        {
            public int Opcode;
            public byte[] Payload;
        }
    }
}
