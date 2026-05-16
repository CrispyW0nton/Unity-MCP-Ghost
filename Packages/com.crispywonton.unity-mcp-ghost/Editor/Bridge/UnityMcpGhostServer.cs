using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostServer
    {
        public static readonly UnityMcpGhostServer Shared = new UnityMcpGhostServer();

        private readonly CommandRegistry commands = new CommandRegistry();
        private readonly List<string> commandHistory = new List<string>();
        private HttpListener listener;
        private CancellationTokenSource cancellation;
        private int clientCount;

        public bool IsRunning { get; private set; }
        public string LastError { get; private set; }
        public string LastRequest { get; private set; }
        public int Port { get; private set; } = UnityMcpGhostConfig.DefaultPort;
        public int ClientCount { get { return clientCount; } }
        public string QueueStatus { get { return DurableCommandQueue.StatusJson(); } }
        public IReadOnlyList<string> CommandHistory { get { return commandHistory; } }

        public bool Start(int port)
        {
            if (IsRunning)
            {
                return true;
            }

            try
            {
                cancellation = new CancellationTokenSource();
                listener = new HttpListener();
                listener.Prefixes.Add("http://127.0.0.1:" + port + UnityMcpGhostConfig.WebSocketPath + "/");
                listener.Start();
                Port = port;
                IsRunning = true;
                LastError = string.Empty;
                _ = AcceptLoop(cancellation.Token);
                return true;
            }
            catch (Exception exception)
            {
                LastError = exception.Message;
                IsRunning = false;
                listener?.Close();
                listener = null;
                cancellation?.Cancel();
                cancellation = null;
                return false;
            }
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
                        _ = HandleHttpRequest(context, token);
                        continue;
                    }

                    var webSocketContext = await context.AcceptWebSocketAsync(null);
                    clientCount++;
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

        private async Task HandleHttpRequest(HttpListenerContext context, CancellationToken token)
        {
            if (!string.Equals(context.Request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.StatusCode = 400;
                context.Response.Close();
                return;
            }

            string requestJson;
            using (var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding))
            {
                requestJson = await reader.ReadToEndAsync();
            }

            LastRequest = requestJson;
            var request = JsonRpcUtil.ParseRequest(requestJson);
            RecordCommand(request.Method);

            var completion = new TaskCompletionSource<string>();
            MainThreadDispatcher.Enqueue(() =>
            {
                try
                {
                    completion.SetResult(commands.Execute(request));
                }
                catch (Exception exception)
                {
                    completion.SetResult(JsonRpcUtil.Error(request.Id, -32000, exception.Message));
                }
            });

            var responseJson = await completion.Task;
            var bytes = Encoding.UTF8.GetBytes(responseJson);
            context.Response.StatusCode = 200;
            context.Response.ContentType = "application/json";
            context.Response.ContentEncoding = Encoding.UTF8;
            context.Response.ContentLength64 = bytes.Length;
            await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length, token);
            context.Response.Close();
        }

        private async Task ClientLoop(WebSocket socket, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];

            try
            {
                while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
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
                    RecordCommand(request.Method);

                    MainThreadDispatcher.Enqueue(() =>
                    {
                        var responseJson = commands.Execute(request);
                        _ = Send(socket, responseJson, token);
                    });
                }
            }
            catch (Exception exception)
            {
                LastError = exception.Message;
            }
            finally
            {
                clientCount = Math.Max(0, clientCount - 1);
            }
        }

        private static Task Send(WebSocket socket, string json, CancellationToken token)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            return socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
        }

        private void RecordCommand(string method)
        {
            if (string.IsNullOrEmpty(method))
            {
                return;
            }

            commandHistory.Add(DateTime.UtcNow.ToString("HH:mm:ss") + " UTC  " + method);
            if (commandHistory.Count > 50)
            {
                commandHistory.RemoveAt(0);
            }
        }
    }
}
