using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
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
        private readonly object historySync = new object();
        private readonly SemaphoreSlim httpConcurrency = new SemaphoreSlim(16, 16);
        private readonly BridgeRateLimiter rateLimiter = new BridgeRateLimiter(120, TimeSpan.FromSeconds(10));
        private HttpListener listener;
        private LoopbackWebSocketServer webSocketServer;
        private CancellationTokenSource cancellation;

        public bool IsRunning { get; private set; }
        public string LastError { get; private set; }
        public string LastRequest { get; private set; }
        public int Port { get; private set; } = UnityMcpGhostConfig.DefaultPort;
        public int WebSocketPort { get; private set; }
        public int ClientCount { get { return webSocketServer?.ClientCount ?? 0; } }
        public string QueueStatus { get { return DurableCommandQueue.StatusJson(); } }
        public IReadOnlyList<string> CommandHistory
        {
            get
            {
                lock (historySync)
                {
                    return commandHistory.ToArray();
                }
            }
        }

        public bool Start(int port)
        {
            if (IsRunning)
            {
                return true;
            }

            try
            {
                if (port < 1024 || port > 65535)
                {
                    throw new InvalidOperationException("Bridge port must be between 1024 and 65535.");
                }
                BridgeSecurity.InitializeOnMainThread();
                cancellation = new CancellationTokenSource();
                listener = new HttpListener();
                listener.Prefixes.Add("http://127.0.0.1:" + port + UnityMcpGhostConfig.WebSocketPath + "/");
                listener.Start();
                var settings = BridgeSecurity.Settings;
                webSocketServer = new LoopbackWebSocketServer(
                    settings.WebSocketPort,
                    JsonRpcUtil.MaxRequestCharacters,
                    BridgeSecurity.AuthenticateBearer,
                    HandleWebSocketMessage,
                    RecordTransportError);
                webSocketServer.Start();
                Port = port;
                WebSocketPort = settings.WebSocketPort;
                IsRunning = true;
                LastError = string.Empty;
                BridgeSecurity.WriteIdentity(Port, WebSocketPort, true);
                _ = Task.Run(() => AcceptLoop(cancellation.Token), cancellation.Token);
                return true;
            }
            catch (Exception exception)
            {
                LastError = exception.Message;
                IsRunning = false;
                listener?.Close();
                listener = null;
                webSocketServer?.Stop();
                webSocketServer = null;
                cancellation?.Cancel();
                cancellation = null;
                WriteIdentitySafely(port, BridgeSecurity.Settings.WebSocketPort, false);
                return false;
            }
        }

        public void Stop()
        {
            IsRunning = false;
            cancellation?.Cancel();
            listener?.Close();
            listener = null;
            webSocketServer?.Stop();
            webSocketServer = null;
            cancellation = null;
            WriteIdentitySafely(Port, WebSocketPort, false);
        }

        public void Heartbeat()
        {
            WriteIdentitySafely(Port, WebSocketPort, IsRunning);
        }

        private async Task AcceptLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && listener != null)
            {
                try
                {
                    var context = await listener.GetContextAsync();
                    if (!await ValidateNetworkRequest(context, token))
                    {
                        continue;
                    }
                    if (!IsWebSocketUpgrade(context.Request))
                    {
                        _ = HandleHttpRequest(context, token);
                        continue;
                    }
                    await WriteStatusResponse(context, 426, "Use the authenticated WebSocket endpoint advertised in bridge-identity.json.", token);
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

                var mediaType = (context.Request.ContentType ?? string.Empty).Split(';')[0].Trim();
                if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
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
                UnityEngine.Debug.LogException(exception);
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

        private async Task<string> HandleWebSocketMessage(string requestJson)
        {
            if (!rateLimiter.TryAcquire(DateTime.UtcNow))
            {
                return JsonRpcUtil.Error(new JsonRpcProtocolException(-32011, "Unity MCP bridge request rate exceeded."));
            }
            UnityMcpRequest request;
            try
            {
                request = JsonRpcUtil.ParseRequest(requestJson);
            }
            catch (JsonRpcProtocolException exception)
            {
                return JsonRpcUtil.Error(exception);
            }
            LastRequest = request.Method + " [" + request.Id + "]";
            RecordCommand(request.Method);
            return await DispatchDurably(request, requestJson);
        }

        private async Task<string> DispatchDurably(UnityMcpRequest request, string rawRequest)
        {
            var authorization = BridgeSecurity.AuthorizeRequest(request, false);
            if (!authorization.Allowed)
            {
                return BridgeSecurity.AuthorizationError(request, authorization);
            }

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

        private async Task<bool> ValidateNetworkRequest(HttpListenerContext context, CancellationToken token)
        {
            if (context.Request.RemoteEndPoint == null || !IPAddress.IsLoopback(context.Request.RemoteEndPoint.Address))
            {
                await WriteStatusResponse(context, 403, "Unity MCP bridge accepts loopback clients only.", token);
                return false;
            }
            if (!string.IsNullOrWhiteSpace(context.Request.Headers["Origin"]))
            {
                await WriteStatusResponse(context, 403, "Browser Origin requests are not accepted by the Unity MCP bridge.", token);
                return false;
            }
            if (!BridgeSecurity.AuthenticateBearer(context.Request.Headers["Authorization"]))
            {
                context.Response.Headers["WWW-Authenticate"] = "Bearer realm=\"unity-mcp-ghost\"";
                await WriteStatusResponse(context, 401, "Unity MCP bridge authentication failed.", token);
                return false;
            }
            if (!rateLimiter.TryAcquire(DateTime.UtcNow))
            {
                await WriteStatusResponse(context, 429, "Unity MCP bridge request rate exceeded.", token);
                return false;
            }
            return true;
        }

        private static bool IsWebSocketUpgrade(HttpListenerRequest request)
        {
            return request.IsWebSocketRequest
                || (string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(request.Headers["Upgrade"], "websocket", StringComparison.OrdinalIgnoreCase)
                    && (request.Headers["Connection"] ?? string.Empty).IndexOf("Upgrade", StringComparison.OrdinalIgnoreCase) >= 0);
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

        private void RecordCommand(string method)
        {
            if (string.IsNullOrEmpty(method))
            {
                return;
            }

            lock (historySync)
            {
                commandHistory.Add(DateTime.UtcNow.ToString("HH:mm:ss") + " UTC  " + method);
                if (commandHistory.Count > 50)
                {
                    commandHistory.RemoveAt(0);
                }
            }
        }

        private void RecordTransportError(Exception exception)
        {
            LastError = exception.Message;
            UnityEngine.Debug.LogException(exception);
        }

        private void WriteIdentitySafely(int port, int webSocketPort, bool running)
        {
            try
            {
                BridgeSecurity.WriteIdentity(port, webSocketPort, running);
            }
            catch (Exception exception)
            {
                LastError = "Could not persist bridge identity: " + exception.Message;
            }
        }
    }
}
