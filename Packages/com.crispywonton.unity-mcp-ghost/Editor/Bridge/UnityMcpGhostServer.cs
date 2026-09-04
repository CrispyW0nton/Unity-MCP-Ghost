using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostServer
    {
        public static readonly UnityMcpGhostServer Shared = new UnityMcpGhostServer();

        private readonly CommandRegistry commands = new CommandRegistry();
        private readonly List<string> commandHistory = new List<string>();
        private readonly SemaphoreSlim httpConcurrency = new SemaphoreSlim(16, 16);
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
            if (!httpConcurrency.Wait(0))
            {
                await WriteStatusResponse(context, 429, "Unity MCP bridge is at its concurrency limit.", token);
                return;
            }

            try
            {
            if (!string.Equals(context.Request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase))
            {
                await WriteStatusResponse(context, 405, "Only POST is supported.", token);
                return;
            }

            if (string.IsNullOrWhiteSpace(context.Request.ContentType) || !context.Request.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
            {
                await WriteStatusResponse(context, 415, "Content-Type must be application/json.", token);
                return;
            }

            if (context.Request.ContentLength64 > JsonRpcUtil.MaxRequestCharacters)
            {
                await WriteStatusResponse(context, 413, "Request body exceeds the configured limit.", token);
                return;
            }

            string requestJson;
            try
            {
                requestJson = await ReadBoundedRequest(context.Request.InputStream, context.Request.ContentEncoding);
            }
            catch (JsonRpcProtocolException exception)
            {
                await WriteHttpResponse(context, JsonRpcUtil.Error(exception), token);
                return;
            }

            UnityMcpRequest request;
            try
            {
                request = JsonRpcUtil.ParseRequest(requestJson);
            }
            catch (JsonRpcProtocolException exception)
            {
                await WriteHttpResponse(context, JsonRpcUtil.Error(exception), token);
                return;
            }
            LastRequest = request.Method + " [" + request.Id + "]";
            RecordCommand(request.Method);
            var responseJson = await DispatchDurably(request, requestJson);
            await WriteHttpResponse(context, responseJson, token);
            }
            catch (Exception exception)
            {
                LastError = exception.Message;
                if (context.Response.OutputStream.CanWrite)
                {
                    await WriteStatusResponse(context, 500, "Unity MCP bridge failed to process the request.", token);
                }
            }
            finally
            {
                httpConcurrency.Release();
            }
        }

        private static async Task WriteHttpResponse(HttpListenerContext context, string responseJson, CancellationToken token)
        {
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
            var buffer = new byte[16 * 1024];
            var sendLock = new SemaphoreSlim(1, 1);

            try
            {
                while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    string requestJson;
                    using (var message = new BoundedWebSocketMessage(JsonRpcUtil.MaxRequestCharacters))
                    {
                        while (true)
                        {
                            var segment = new ArraySegment<byte>(buffer);
                            var result = await socket.ReceiveAsync(segment, token);
                            var status = message.Append(segment, result);
                            if (status == WebSocketMessageAppendStatus.Close)
                            {
                                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", token);
                                return;
                            }
                            if (status == WebSocketMessageAppendStatus.InvalidType)
                            {
                                await socket.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "Only text JSON messages are supported.", token);
                                return;
                            }
                            if (status == WebSocketMessageAppendStatus.TooLarge)
                            {
                                await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message exceeds the configured limit.", token);
                                return;
                            }
                            if (status == WebSocketMessageAppendStatus.InvalidUtf8)
                            {
                                await socket.CloseAsync(WebSocketCloseStatus.InvalidPayloadData, "Message is not valid UTF-8.", token);
                                return;
                            }
                            if (status == WebSocketMessageAppendStatus.Complete)
                            {
                                requestJson = message.GetText();
                                break;
                            }
                        }
                    }
                    UnityMcpRequest request;
                    try
                    {
                        request = JsonRpcUtil.ParseRequest(requestJson);
                    }
                    catch (JsonRpcProtocolException exception)
                    {
                        await Send(socket, JsonRpcUtil.Error(exception), token, sendLock);
                        continue;
                    }
                    LastRequest = request.Method + " [" + request.Id + "]";
                    RecordCommand(request.Method);
                    var responseJson = await DispatchDurably(request, requestJson);
                    await Send(socket, responseJson, token, sendLock);
                }
            }
            catch (Exception exception)
            {
                LastError = exception.Message;
            }
            finally
            {
                sendLock.Dispose();
                clientCount = Math.Max(0, clientCount - 1);
            }
        }

        private async Task<string> DispatchDurably(UnityMcpRequest request, string rawRequest)
        {
            var owner = Guid.NewGuid().ToString("N");
            RequestClaim claim;
            try
            {
                claim = RequestExecutionStore.Begin(request, rawRequest, owner);
            }
            catch (Exception exception)
            {
                return JsonRpcUtil.Error(request, -32000, "Failed to claim durable request: " + exception.Message);
            }
            if (claim.Disposition != RequestClaimDisposition.Claimed)
            {
                return claim.ResponseJson;
            }

            var completion = new TaskCompletionSource<string>();
            DateTime? deadlineUtc = request.DeadlineUnixMs > 0
                ? new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(request.DeadlineUnixMs)
                : (DateTime?)null;
            Action<string> complete = response => completion.TrySetResult(RequestExecutionStore.Complete(request, owner, response));
            var enqueued = MainThreadDispatcher.TryEnqueue(
                () => complete(commands.Execute(request)),
                deadlineUtc,
                () => complete(JsonRpcUtil.Error(request, -32004, "Request deadline elapsed in the Unity main-thread queue.", new JObject
                {
                    ["code"] = "REQUEST_DEADLINE_EXCEEDED",
                    ["requestId"] = request.Id,
                    ["outcomeUnknown"] = false
                })),
                exception => complete(JsonRpcUtil.Error(request, -32000, exception.Message)));
            if (!enqueued)
            {
                complete(JsonRpcUtil.Error(request, -32008, "Unity main-thread queue is at capacity.", new JObject
                {
                    ["code"] = "BRIDGE_BACKPRESSURE",
                    ["requestId"] = request.Id,
                    ["pending"] = MainThreadDispatcher.PendingCount,
                    ["limit"] = MainThreadDispatcher.MaxPendingItems
                }));
            }
            return await completion.Task;
        }

        private static async Task<string> ReadBoundedRequest(Stream stream, Encoding encoding)
        {
            using (var message = new MemoryStream())
            {
                var buffer = new byte[8192];
                while (true)
                {
                    var read = await stream.ReadAsync(buffer, 0, buffer.Length);
                    if (read == 0)
                    {
                        return (encoding ?? Encoding.UTF8).GetString(message.ToArray());
                    }
                    if (message.Length + read > JsonRpcUtil.MaxRequestCharacters)
                    {
                        throw new JsonRpcProtocolException(-32600, "Invalid request: request body exceeds the configured limit.");
                    }
                    message.Write(buffer, 0, read);
                }
            }
        }

        private static async Task WriteStatusResponse(HttpListenerContext context, int statusCode, string message, CancellationToken token)
        {
            var bytes = Encoding.UTF8.GetBytes(message ?? string.Empty);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "text/plain";
            context.Response.ContentEncoding = Encoding.UTF8;
            context.Response.ContentLength64 = bytes.Length;
            await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length, token);
            context.Response.Close();
        }

        private static async Task Send(WebSocket socket, string json, CancellationToken token, SemaphoreSlim sendLock)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            await sendLock.WaitAsync(token);
            try
            {
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
            }
            finally
            {
                sendLock.Release();
            }
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
