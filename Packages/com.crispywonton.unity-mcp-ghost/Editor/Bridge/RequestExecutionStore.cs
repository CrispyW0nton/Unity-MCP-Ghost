using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal enum RequestClaimDisposition
    {
        Claimed,
        Cached,
        InProgress,
        OutcomeUnknown,
        Conflict,
        Expired
    }

    internal sealed class RequestClaim
    {
        public RequestClaimDisposition Disposition;
        public string Owner = string.Empty;
        public string ResponseJson = string.Empty;
    }

    internal static class RequestExecutionStore
    {
        private const int MaxStoredResults = 1000;
        private const int MaxResponseBytes = 4 * 1024 * 1024;
        private static readonly TimeSpan ResultTtl = TimeSpan.FromHours(24);
        private static readonly TimeSpan DefaultLease = TimeSpan.FromMinutes(2);
        private static readonly object Sync = new object();
        private static DateTime nextCleanupUtc = DateTime.MinValue;

        internal static string RootOverrideForTests;
        internal static Func<DateTime> UtcNow = () => DateTime.UtcNow;

        public static RequestClaim Begin(UnityMcpRequest request, string rawRequest, string owner)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.IdempotencyKey))
            {
                return new RequestClaim
                {
                    Disposition = RequestClaimDisposition.Conflict,
                    ResponseJson = JsonRpcUtil.Error(request, -32005, "A durable request requires an idempotency key.")
                };
            }

            lock (Sync)
            {
                EnsureDirectories();
                CleanupIfDue();
                var now = UtcNow();
                if (request.DeadlineUnixMs > 0 && now > FromUnixMilliseconds(request.DeadlineUnixMs))
                {
                    return new RequestClaim
                    {
                        Disposition = RequestClaimDisposition.Expired,
                        ResponseJson = JsonRpcUtil.Error(request, -32004, "Request deadline elapsed before execution.", OutcomeData(request, "expired", false))
                    };
                }

                var key = SafeKey(request.IdempotencyKey);
                var statePath = StatePath(key);
                var resultPath = ResultPath(key);
                var payloadSha256 = Hash(rawRequest ?? string.Empty);
                var existing = ReadState(statePath);
                if (File.Exists(statePath) && existing == null)
                {
                    return new RequestClaim
                    {
                        Disposition = RequestClaimDisposition.OutcomeUnknown,
                        ResponseJson = JsonRpcUtil.Error(request, -32006, "The durable request state is unreadable; the request will not be replayed.", OutcomeData(request, "outcomeUnknown", true))
                    };
                }
                if (existing != null && !string.Equals(existing.PayloadSha256, payloadSha256, StringComparison.OrdinalIgnoreCase))
                {
                    return new RequestClaim
                    {
                        Disposition = RequestClaimDisposition.Conflict,
                        ResponseJson = JsonRpcUtil.Error(request, -32005, "The idempotency key was already used with a different request payload.", OutcomeData(request, "conflict", true))
                    };
                }

                if (File.Exists(resultPath))
                {
                    return new RequestClaim
                    {
                        Disposition = RequestClaimDisposition.Cached,
                        ResponseJson = File.ReadAllText(resultPath)
                    };
                }

                var replaySafe = IsReplaySafe(request);
                if (existing != null && string.Equals(existing.Status, "executing", StringComparison.Ordinal))
                {
                    var leaseExpiresUtc = ParseUtc(existing.LeaseExpiresUtc);
                    if (leaseExpiresUtc > now)
                    {
                        return new RequestClaim
                        {
                            Disposition = RequestClaimDisposition.InProgress,
                            ResponseJson = JsonRpcUtil.Error(request, -32003, "The request is already executing.", OutcomeData(request, "executing", true))
                        };
                    }

                    if (!replaySafe)
                    {
                        existing.Status = "outcomeUnknown";
                        existing.UpdatedUtc = FormatUtc(now);
                        WriteAtomic(statePath, JsonConvert.SerializeObject(existing, Formatting.Indented));
                        return new RequestClaim
                        {
                            Disposition = RequestClaimDisposition.OutcomeUnknown,
                            ResponseJson = JsonRpcUtil.Error(request, -32006, "A non-idempotent request lost its execution lease; its outcome is unknown and it will not be replayed.", OutcomeData(request, "outcomeUnknown", true))
                        };
                    }
                }
                else if (existing != null)
                {
                    return new RequestClaim
                    {
                        Disposition = RequestClaimDisposition.OutcomeUnknown,
                        ResponseJson = JsonRpcUtil.Error(request, -32006, "The durable request result is missing; the request will not be replayed.", OutcomeData(request, "outcomeUnknown", true))
                    };
                }

                var leaseEnd = now.Add(DefaultLease);
                if (request.DeadlineUnixMs > 0)
                {
                    var requestedDeadline = FromUnixMilliseconds(request.DeadlineUnixMs).AddSeconds(5);
                    if (requestedDeadline < leaseEnd)
                    {
                        leaseEnd = requestedDeadline;
                    }
                }
                var state = new RequestExecutionState
                {
                    IdempotencyKey = request.IdempotencyKey,
                    RequestId = request.Id,
                    Method = request.Method,
                    PayloadSha256 = payloadSha256,
                    Status = "executing",
                    ReplaySafe = replaySafe,
                    Owner = owner,
                    ClaimedUtc = existing?.ClaimedUtc ?? FormatUtc(now),
                    UpdatedUtc = FormatUtc(now),
                    LeaseExpiresUtc = FormatUtc(leaseEnd)
                };
                WriteAtomic(statePath, JsonConvert.SerializeObject(state, Formatting.Indented));
                return new RequestClaim { Disposition = RequestClaimDisposition.Claimed, Owner = owner };
            }
        }

        public static string Complete(UnityMcpRequest request, string owner, string responseJson)
        {
            lock (Sync)
            {
                EnsureDirectories();
                var key = SafeKey(request.IdempotencyKey);
                var statePath = StatePath(key);
                var state = ReadState(statePath);
                if (state == null || !string.Equals(state.Owner, owner, StringComparison.Ordinal) || !string.Equals(state.Status, "executing", StringComparison.Ordinal))
                {
                    return JsonRpcUtil.Error(request, -32006, "The request execution lease changed before its result could be committed.", OutcomeData(request, "outcomeUnknown", true));
                }

                var boundedResponse = BoundResponse(request, responseJson);
                WriteAtomic(ResultPath(key), boundedResponse);
                var now = UtcNow();
                state.Status = "completed";
                state.UpdatedUtc = FormatUtc(now);
                state.CompletedUtc = FormatUtc(now);
                state.LeaseExpiresUtc = string.Empty;
                WriteAtomic(statePath, JsonConvert.SerializeObject(state, Formatting.Indented));
                return boundedResponse;
            }
        }

        public static bool IsReplaySafe(UnityMcpRequest request)
        {
            if (request == null)
            {
                return false;
            }
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return true;
            }

            switch (request.Method)
            {
                case "ping":
                case "health":
                case "editor.get_state":
                case "console.get_logs":
                case "console.diagnostics_get":
                case "console.query":
                case "console.assert":
                case "compile.diagnostics_get":
                case "compile.status_get":
                case "play_mode.get":
                case "input.status":
                case "editor.snapshot":
                case "runtime.inspect":
                case "runtime.assert":
                case "scenario.source_get":
                case "scenario.source_restore":
                case "scene.get_hierarchy":
                case "scene.list_open":
                case "scene.get_setup":
                case "gameobject.find":
                case "gameobject.get":
                case "component.get":
                case "asset.find":
                case "script.read":
                case "operation.get":
                case "operation.list":
                case "screenshot.baselines_list":
                    return true;
                default:
                    return request.Method != null && request.Method.StartsWith("semantic.", StringComparison.Ordinal);
            }
        }

        internal static void ResetForTests()
        {
            lock (Sync)
            {
                nextCleanupUtc = DateTime.MinValue;
                UtcNow = () => DateTime.UtcNow;
                RootOverrideForTests = null;
            }
        }

        private static string BoundResponse(UnityMcpRequest request, string responseJson)
        {
            var bytes = Encoding.UTF8.GetByteCount(responseJson ?? string.Empty);
            return bytes <= MaxResponseBytes
                ? responseJson
                : JsonRpcUtil.Error(request, -32007, "Unity response exceeded the durable transport limit.", new JObject { ["code"] = "RESULT_TOO_LARGE", ["bytes"] = bytes, ["limitBytes"] = MaxResponseBytes });
        }

        private static JObject OutcomeData(UnityMcpRequest request, string status, bool outcomeUnknown)
        {
            return new JObject
            {
                ["code"] = status == "outcomeUnknown" ? "OUTCOME_UNKNOWN" : status.ToUpperInvariant(),
                ["requestId"] = request?.Id ?? string.Empty,
                ["idempotencyKey"] = request?.IdempotencyKey ?? string.Empty,
                ["status"] = status,
                ["outcomeUnknown"] = outcomeUnknown
            };
        }

        private static void CleanupIfDue()
        {
            var now = UtcNow();
            if (now < nextCleanupUtc)
            {
                return;
            }
            nextCleanupUtc = now.AddMinutes(1);
            var states = new DirectoryInfo(Root()).GetFiles("*.state.json").OrderByDescending(file => file.LastWriteTimeUtc).ToList();
            foreach (var file in states)
            {
                var state = ReadState(file.FullName);
                var completedUtc = ParseUtc(state?.CompletedUtc);
                var expired = completedUtc != DateTime.MinValue && now - completedUtc > ResultTtl;
                var excessive = states.IndexOf(file) >= MaxStoredResults && state != null && state.Status != "executing";
                if (!expired && !excessive)
                {
                    continue;
                }
                File.Delete(file.FullName);
                var key = file.Name.Substring(0, file.Name.Length - ".state.json".Length);
                var resultPath = ResultPath(key);
                if (File.Exists(resultPath))
                {
                    File.Delete(resultPath);
                }
            }
        }

        private static RequestExecutionState ReadState(string path)
        {
            if (!File.Exists(path))
            {
                return null;
            }
            try
            {
                return JsonConvert.DeserializeObject<RequestExecutionState>(File.ReadAllText(path));
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void EnsureDirectories()
        {
            Directory.CreateDirectory(Root());
        }

        private static string Root()
        {
            if (!string.IsNullOrWhiteSpace(RootOverrideForTests))
            {
                return Path.GetFullPath(RootOverrideForTests);
            }
            var projectRoot = ProjectPathPolicy.ProjectRoot;
            return Path.Combine(projectRoot, "Library", "UnityMcpGhost", "requests");
        }

        private static string StatePath(string key)
        {
            return Path.Combine(Root(), key + ".state.json");
        }

        private static string ResultPath(string key)
        {
            return Path.Combine(Root(), key + ".result.json");
        }

        private static string SafeKey(string value)
        {
            return Hash(value ?? string.Empty);
        }

        private static string Hash(string value)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(Encoding.UTF8.GetBytes(value)).Select(item => item.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        private static void WriteAtomic(string path, string contents)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporaryPath, contents ?? string.Empty, new UTF8Encoding(false));
            if (File.Exists(path))
            {
                try
                {
                    File.Replace(temporaryPath, path, null);
                }
                catch (IOException)
                {
                    File.Delete(path);
                    File.Move(temporaryPath, path);
                }
            }
            else
            {
                File.Move(temporaryPath, path);
            }
        }

        private static DateTime FromUnixMilliseconds(long value)
        {
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(value);
        }

        private static DateTime ParseUtc(string value)
        {
            return DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
                ? parsed
                : DateTime.MinValue;
        }

        private static string FormatUtc(DateTime value)
        {
            return value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }

        private sealed class RequestExecutionState
        {
            public string IdempotencyKey = string.Empty;
            public string RequestId = string.Empty;
            public string Method = string.Empty;
            public string PayloadSha256 = string.Empty;
            public string Status = string.Empty;
            public bool ReplaySafe;
            public string Owner = string.Empty;
            public string ClaimedUtc = string.Empty;
            public string UpdatedUtc = string.Empty;
            public string LeaseExpiresUtc = string.Empty;
            public string CompletedUtc = string.Empty;
        }
    }
}
