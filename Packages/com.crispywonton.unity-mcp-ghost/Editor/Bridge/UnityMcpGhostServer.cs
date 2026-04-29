using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostServer
    {
        private readonly CommandRegistry commands = new CommandRegistry();
        private HttpListener listener;
        private CancellationTokenSource cancellation;

        public bool IsRunning { get; private set; }
        public string LastError { get; private set; }
        public string LastRequest { get; private set; }

        public void Start(int port)
        {
            if (IsRunning)
            {
                return;
            }

            cancellation = new CancellationTokenSource();
            listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + UnityMcpGhostConfig.WebSocketPath + "/");
            listener.Start();
            IsRunning = true;
            LastError = string.Empty;
            _ = AcceptLoop(cancellation.Token);
        }

        public void Stop()
        {
            IsRunning = false;
            cancellation?.Cancel();
            listener?.Close();
            listener = null;
            cancellation = null;
        }

        private async Task AcceptLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && listener != null)
            {
                try
                {
                    var context = await listener.GetContextAsync();
                    if (!context.Request.IsWebSocketRequest)
                    {
                        context.Response.StatusCode = 400;
                        context.Response.Close();
                        continue;
                    }

                    var webSocketContext = await context.AcceptWebSocketAsync(null);
                    _ = ClientLoop(webSocketContext.WebSocket, token);
                }
                catch (Exception exception)
                {
                    if (!token.IsCancellationRequested)
                    {
                        LastError = exception.Message;
                    }
                }
            }
        }

        private async Task ClientLoop(WebSocket socket, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];

            while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                try
                {
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", token);
                        return;
                    }

                    var requestJson = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    LastRequest = requestJson;
                    var request = JsonRpcUtil.ParseRequest(requestJson);

                    MainThreadDispatcher.Enqueue(() =>
                    {
                        var responseJson = commands.Execute(request);
                        _ = Send(socket, responseJson, token);
                    });
                }
                catch (Exception exception)
                {
                    LastError = exception.Message;
                    return;
                }
            }
        }

        private static Task Send(WebSocket socket, string json, CancellationToken token)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            return socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
        }
    }
}
