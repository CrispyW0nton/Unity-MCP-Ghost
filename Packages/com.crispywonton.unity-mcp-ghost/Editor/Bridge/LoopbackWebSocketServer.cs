using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class LoopbackWebSocketServer : IDisposable
    {
        private const int MaxHeaderBytes = 16 * 1024;
        private const int MaxClients = 8;
        private static readonly byte[] HeaderTerminator = { 13, 10, 13, 10 };
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly int port;
        private readonly int maximumMessageBytes;
        private readonly Func<string, bool> authenticateBearer;
        private readonly Func<string, Task<string>> dispatch;
        private readonly Action<Exception> reportError;
        private TcpListener listener;
        private CancellationTokenSource cancellation;
        private int clientCount;

        public LoopbackWebSocketServer(
            int port,
            int maximumMessageBytes,
            Func<string, bool> authenticateBearer,
            Func<string, Task<string>> dispatch,
            Action<Exception> reportError)
        {
            this.port = port;
            this.maximumMessageBytes = maximumMessageBytes;
            this.authenticateBearer = authenticateBearer ?? throw new ArgumentNullException("authenticateBearer");
            this.dispatch = dispatch ?? throw new ArgumentNullException("dispatch");
            this.reportError = reportError ?? throw new ArgumentNullException("reportError");
        }

        public int ClientCount => clientCount;

        public void Start()
        {
            if (listener != null)
            {
                return;
            }

            cancellation = new CancellationTokenSource();
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start(MaxClients);
            _ = Task.Run(() => AcceptLoop(cancellation.Token), cancellation.Token);
        }

        public void Stop()
        {
            cancellation?.Cancel();
            listener?.Stop();
            listener = null;
            cancellation?.Dispose();
            cancellation = null;
        }

        public void Dispose()
        {
            Stop();
        }

        private async Task AcceptLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && listener != null)
            {
                try
                {
                    var client = await listener.AcceptTcpClientAsync();
                    if (Interlocked.Increment(ref clientCount) > MaxClients)
                    {
                        Interlocked.Decrement(ref clientCount);
                        client.Close();
                        continue;
                    }
                    _ = Task.Run(() => HandleClient(client, token), token);
                }
                catch (ObjectDisposedException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (SocketException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception exception)
                {
                    if (!token.IsCancellationRequested)
                    {
                        reportError(exception);
                    }
                }
            }
        }

        private async Task HandleClient(TcpClient client, CancellationToken token)
        {
            try
            {
                client.NoDelay = true;
                using (client)
                using (var stream = client.GetStream())
                {
                    var reader = await ReadHandshake(stream, token);
                    var request = reader.Handshake;
                    if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase)
                        || !string.Equals(request.Path.TrimEnd('/'), UnityMcpGhostConfig.WebSocketPath.TrimEnd('/'), StringComparison.Ordinal))
                    {
                        await WriteHttpStatus(stream, 404, "Not Found", token);
                        return;
                    }
                    if (!string.IsNullOrWhiteSpace(request.Header("Origin")))
                    {
                        await WriteHttpStatus(stream, 403, "Browser Origin requests are not accepted.", token);
                        return;
                    }
                    if (!authenticateBearer(request.Header("Authorization")))
                    {
                        await WriteHttpStatus(stream, 401, "Authentication failed.", token, "WWW-Authenticate: Bearer realm=\"unity-mcp-ghost\"\r\n");
                        return;
                    }
                    if (!HeaderContainsToken(request.Header("Connection"), "Upgrade")
                        || !string.Equals(request.Header("Upgrade"), "websocket", StringComparison.OrdinalIgnoreCase)
                        || !string.Equals(request.Header("Sec-WebSocket-Version"), "13", StringComparison.Ordinal))
                    {
                        await WriteHttpStatus(stream, 426, "WebSocket Upgrade Required", token, "Sec-WebSocket-Version: 13\r\n");
                        return;
                    }

                    var key = request.Header("Sec-WebSocket-Key");
                    if (!IsValidWebSocketKey(key))
                    {
                        await WriteHttpStatus(stream, 400, "Invalid WebSocket key.", token);
                        return;
                    }

                    var accept = ComputeAcceptKey(key);
                    var response = "HTTP/1.1 101 Switching Protocols\r\n"
                        + "Upgrade: websocket\r\n"
                        + "Connection: Upgrade\r\n"
                        + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
                    await WriteBytes(stream, Encoding.ASCII.GetBytes(response), token);
                    await ReceiveLoop(reader, stream, token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
            }
            catch (IOException)
            {
                // Peer disconnects are expected and do not change bridge health.
            }
            catch (SocketException)
            {
                // Peer disconnects are expected and do not change bridge health.
            }
            catch (Exception exception)
            {
                reportError(exception);
            }
            finally
            {
                Interlocked.Decrement(ref clientCount);
            }
        }

        private async Task ReceiveLoop(HandshakeReader reader, Stream stream, CancellationToken token)
        {
            MemoryStream message = null;
            try
            {
                while (!token.IsCancellationRequested)
                {
                    var first = await reader.ReadByte(token);
                    var second = await reader.ReadByte(token);
                    var final = (first & 0x80) != 0;
                    var reserved = first & 0x70;
                    var opcode = first & 0x0f;
                    var masked = (second & 0x80) != 0;
                    ulong payloadLength = (uint)(second & 0x7f);
                    if (payloadLength == 126)
                    {
                        var lengthBytes = await reader.ReadExact(2, token);
                        payloadLength = (ulong)((lengthBytes[0] << 8) | lengthBytes[1]);
                    }
                    else if (payloadLength == 127)
                    {
                        var lengthBytes = await reader.ReadExact(8, token);
                        payloadLength = 0;
                        for (var index = 0; index < lengthBytes.Length; index++)
                        {
                            payloadLength = (payloadLength << 8) | lengthBytes[index];
                        }
                    }

                    var control = opcode >= 8;
                    if (reserved != 0 || !masked || (control && (!final || payloadLength > 125)))
                    {
                        await SendClose(stream, 1002, "Protocol error", token);
                        return;
                    }
                    if (payloadLength > (ulong)maximumMessageBytes)
                    {
                        await SendClose(stream, 1009, "Message too large", token);
                        return;
                    }

                    var mask = await reader.ReadExact(4, token);
                    var payload = await reader.ReadExact((int)payloadLength, token);
                    for (var index = 0; index < payload.Length; index++)
                    {
                        payload[index] = (byte)(payload[index] ^ mask[index % 4]);
                    }

                    if (opcode == 8)
                    {
                        await SendFrame(stream, 8, payload, token);
                        return;
                    }
                    if (opcode == 9)
                    {
                        await SendFrame(stream, 10, payload, token);
                        continue;
                    }
                    if (opcode == 10)
                    {
                        continue;
                    }
                    if (opcode == 2 || (opcode != 0 && opcode != 1))
                    {
                        await SendClose(stream, 1003, "Only text messages are supported", token);
                        return;
                    }
                    if ((opcode == 0 && message == null) || (opcode == 1 && message != null))
                    {
                        await SendClose(stream, 1002, "Invalid fragmentation", token);
                        return;
                    }

                    if (opcode == 1)
                    {
                        message = new MemoryStream();
                    }
                    if (message.Length + payload.Length > maximumMessageBytes)
                    {
                        await SendClose(stream, 1009, "Message too large", token);
                        return;
                    }
                    message.Write(payload, 0, payload.Length);
                    if (!final)
                    {
                        continue;
                    }

                    string requestJson;
                    try
                    {
                        requestJson = StrictUtf8.GetString(message.ToArray());
                    }
                    catch (DecoderFallbackException)
                    {
                        await SendClose(stream, 1007, "Invalid UTF-8", token);
                        return;
                    }
                    message.Dispose();
                    message = null;
                    var responseJson = await dispatch(requestJson);
                    await SendFrame(stream, 1, Encoding.UTF8.GetBytes(responseJson), token);
                }
            }
            finally
            {
                message?.Dispose();
            }
        }

        private static async Task<HandshakeReader> ReadHandshake(NetworkStream stream, CancellationToken token)
        {
            var bytes = new byte[MaxHeaderBytes];
            var count = 0;
            while (count < bytes.Length)
            {
                var read = await stream.ReadAsync(bytes, count, bytes.Length - count, token);
                if (read == 0)
                {
                    throw new IOException("Client disconnected during WebSocket handshake.");
                }
                count += read;
                var headerEnd = IndexOf(bytes, count, HeaderTerminator);
                if (headerEnd < 0)
                {
                    continue;
                }

                var headerText = Encoding.ASCII.GetString(bytes, 0, headerEnd);
                return new HandshakeReader(stream, ParseHandshake(headerText), bytes, headerEnd + HeaderTerminator.Length, count);
            }
            throw new InvalidDataException("WebSocket handshake headers exceed the configured limit.");
        }

        private static HandshakeRequest ParseHandshake(string text)
        {
            var lines = text.Split(new[] { "\r\n" }, StringSplitOptions.None);
            var requestLine = lines.Length > 0 ? lines[0].Split(' ') : Array.Empty<string>();
            if (requestLine.Length != 3 || !requestLine[2].StartsWith("HTTP/1.", StringComparison.Ordinal))
            {
                throw new InvalidDataException("Malformed WebSocket request line.");
            }
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var index = 1; index < lines.Length; index++)
            {
                var separator = lines[index].IndexOf(':');
                if (separator <= 0)
                {
                    throw new InvalidDataException("Malformed WebSocket request header.");
                }
                var name = lines[index].Substring(0, separator).Trim();
                var value = lines[index].Substring(separator + 1).Trim();
                if (headers.ContainsKey(name))
                {
                    headers[name] += "," + value;
                }
                else
                {
                    headers[name] = value;
                }
            }
            return new HandshakeRequest(requestLine[0], requestLine[1], headers);
        }

        private static bool IsValidWebSocketKey(string value)
        {
            try
            {
                return Convert.FromBase64String(value ?? string.Empty).Length == 16;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        private static string ComputeAcceptKey(string key)
        {
            using (var sha1 = SHA1.Create())
            {
                return Convert.ToBase64String(sha1.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            }
        }

        private static bool HeaderContainsToken(string value, string expected)
        {
            foreach (var part in (value ?? string.Empty).Split(','))
            {
                if (string.Equals(part.Trim(), expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static async Task WriteHttpStatus(Stream stream, int status, string message, CancellationToken token, string extraHeaders = "")
        {
            var body = Encoding.UTF8.GetBytes(message ?? string.Empty);
            var header = "HTTP/1.1 " + status + " " + message + "\r\n"
                + "Connection: close\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + body.Length + "\r\n"
                + extraHeaders
                + "\r\n";
            await WriteBytes(stream, Encoding.ASCII.GetBytes(header), token);
            await WriteBytes(stream, body, token);
        }

        private static async Task SendClose(Stream stream, ushort code, string reason, CancellationToken token)
        {
            var reasonBytes = Encoding.UTF8.GetBytes(reason ?? string.Empty);
            var payload = new byte[2 + reasonBytes.Length];
            payload[0] = (byte)(code >> 8);
            payload[1] = (byte)(code & 0xff);
            Buffer.BlockCopy(reasonBytes, 0, payload, 2, reasonBytes.Length);
            await SendFrame(stream, 8, payload, token);
        }

        private static async Task SendFrame(Stream stream, int opcode, byte[] payload, CancellationToken token)
        {
            payload = payload ?? Array.Empty<byte>();
            using (var frame = new MemoryStream())
            {
                frame.WriteByte((byte)(0x80 | opcode));
                if (payload.Length <= 125)
                {
                    frame.WriteByte((byte)payload.Length);
                }
                else if (payload.Length <= ushort.MaxValue)
                {
                    frame.WriteByte(126);
                    frame.WriteByte((byte)(payload.Length >> 8));
                    frame.WriteByte((byte)payload.Length);
                }
                else
                {
                    frame.WriteByte(127);
                    var length = (ulong)payload.Length;
                    for (var shift = 56; shift >= 0; shift -= 8)
                    {
                        frame.WriteByte((byte)(length >> shift));
                    }
                }
                frame.Write(payload, 0, payload.Length);
                await WriteBytes(stream, frame.ToArray(), token);
            }
        }

        private static async Task WriteBytes(Stream stream, byte[] bytes, CancellationToken token)
        {
            await stream.WriteAsync(bytes, 0, bytes.Length, token);
            await stream.FlushAsync(token);
        }

        private static int IndexOf(byte[] bytes, int count, byte[] pattern)
        {
            for (var index = 0; index <= count - pattern.Length; index++)
            {
                var match = true;
                for (var patternIndex = 0; patternIndex < pattern.Length; patternIndex++)
                {
                    if (bytes[index + patternIndex] != pattern[patternIndex])
                    {
                        match = false;
                        break;
                    }
                }
                if (match)
                {
                    return index;
                }
            }
            return -1;
        }

        private sealed class HandshakeRequest
        {
            private readonly Dictionary<string, string> headers;

            public HandshakeRequest(string method, string path, Dictionary<string, string> headers)
            {
                Method = method;
                Path = path;
                this.headers = headers;
            }

            public string Method { get; }
            public string Path { get; }
            public string Header(string name) => headers.TryGetValue(name, out var value) ? value : string.Empty;
        }

        private sealed class HandshakeReader
        {
            private readonly Stream stream;
            private readonly byte[] buffered;
            private readonly int bufferedEnd;
            private int bufferedOffset;

            public HandshakeReader(Stream stream, HandshakeRequest handshake, byte[] buffered, int bufferedOffset, int bufferedEnd)
            {
                this.stream = stream;
                Handshake = handshake;
                this.buffered = buffered;
                this.bufferedOffset = bufferedOffset;
                this.bufferedEnd = bufferedEnd;
            }

            public HandshakeRequest Handshake { get; }

            public async Task<byte> ReadByte(CancellationToken token)
            {
                return (await ReadExact(1, token))[0];
            }

            public async Task<byte[]> ReadExact(int count, CancellationToken token)
            {
                var result = new byte[count];
                var offset = 0;
                while (offset < count && bufferedOffset < bufferedEnd)
                {
                    result[offset++] = buffered[bufferedOffset++];
                }
                while (offset < count)
                {
                    var read = await stream.ReadAsync(result, offset, count - offset, token);
                    if (read == 0)
                    {
                        throw new IOException("WebSocket peer disconnected.");
                    }
                    offset += read;
                }
                return result;
            }
        }
    }
}
