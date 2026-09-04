using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal enum WebSocketMessageAppendStatus
    {
        Continue,
        Complete,
        Close,
        InvalidType,
        TooLarge,
        InvalidUtf8
    }

    internal sealed class BoundedWebSocketMessage : IDisposable
    {
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly int maximumBytes;
        private readonly MemoryStream stream = new MemoryStream();
        private bool completed;

        public BoundedWebSocketMessage(int maximumBytes)
        {
            this.maximumBytes = Math.Max(1, maximumBytes);
        }

        public WebSocketMessageAppendStatus Append(ArraySegment<byte> bytes, WebSocketReceiveResult result)
        {
            if (completed)
            {
                throw new InvalidOperationException("WebSocket message is already complete.");
            }
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return WebSocketMessageAppendStatus.Close;
            }
            if (result.MessageType != WebSocketMessageType.Text)
            {
                return WebSocketMessageAppendStatus.InvalidType;
            }
            if (stream.Length + result.Count > maximumBytes)
            {
                return WebSocketMessageAppendStatus.TooLarge;
            }
            stream.Write(bytes.Array, bytes.Offset, result.Count);
            if (!result.EndOfMessage)
            {
                return WebSocketMessageAppendStatus.Continue;
            }
            completed = true;
            try
            {
                StrictUtf8.GetString(stream.ToArray());
                return WebSocketMessageAppendStatus.Complete;
            }
            catch (DecoderFallbackException)
            {
                return WebSocketMessageAppendStatus.InvalidUtf8;
            }
        }

        public string GetText()
        {
            if (!completed)
            {
                throw new InvalidOperationException("WebSocket message is incomplete.");
            }
            return StrictUtf8.GetString(stream.ToArray());
        }

        public void Dispose()
        {
            stream.Dispose();
        }
    }
}
