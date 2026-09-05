using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class DurableCommandQueue
    {
        private const int MaxItemsPerPoll = 8;
        private const double MaxMillisecondsPerPoll = 8d;
        private const int MaxRetainedResults = 1000;
        private static readonly TimeSpan ClaimLease = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan ResultTtl = TimeSpan.FromHours(24);
        private static readonly CommandRegistry Commands = new CommandRegistry();
        private static double nextPollTime;
        private static DateTime nextCleanupUtc = DateTime.MinValue;

        internal static string QueueRootOverrideForTests;

        static DurableCommandQueue()
        {
            EnsureDirectories();
            EditorApplication.update -= Poll;
            EditorApplication.update += Poll;
        }

        public static string QueueRoot => !string.IsNullOrWhiteSpace(QueueRootOverrideForTests)
            ? Path.GetFullPath(QueueRootOverrideForTests)
            : Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "queue"));

        public static string PendingDirectory => Path.Combine(QueueRoot, "pending");
        public static string ProcessingDirectory => Path.Combine(QueueRoot, "processing");
        public static string ResultsDirectory => Path.Combine(QueueRoot, "results");
        public static string CancellationDirectory => Path.Combine(QueueRoot, "cancellations");
        public static string DeadLetterDirectory => Path.Combine(QueueRoot, "deadletter");

        public static string StatusJson()
        {
            EnsureDirectories();
            return new JObject
            {
                ["queueRoot"] = QueueRoot,
                ["pendingCount"] = Directory.GetFiles(PendingDirectory, "*.json").Length,
                ["processingCount"] = Directory.GetFiles(ProcessingDirectory, "*.claim.json").Length,
                ["resultCount"] = Directory.GetFiles(ResultsDirectory, "*.json").Length,
                ["cancellationCount"] = Directory.GetFiles(CancellationDirectory, "*.json").Length,
                ["maxItemsPerPoll"] = MaxItemsPerPoll,
                ["maxMillisecondsPerPoll"] = MaxMillisecondsPerPoll,
                ["resultTtlHours"] = ResultTtl.TotalHours
            }.ToString(Formatting.None);
        }

        private static void Poll()
        {
            if (EditorApplication.timeSinceStartup < nextPollTime)
            {
                return;
            }
            nextPollTime = EditorApplication.timeSinceStartup + 0.25d;
            PollWithinBudget(MaxItemsPerPoll, MaxMillisecondsPerPoll);
        }

        internal static int PollWithinBudget(int maxItems, double maxMilliseconds)
        {
            EnsureDirectories();
            RecoverStaleClaims();
            CleanupResults();
            var processed = 0;
            var stopwatch = Stopwatch.StartNew();
            foreach (var path in Directory.GetFiles(PendingDirectory, "*.json").OrderBy(value => value, StringComparer.Ordinal))
            {
                if (processed >= Math.Max(1, maxItems) || stopwatch.Elapsed.TotalMilliseconds >= Math.Max(0.1d, maxMilliseconds))
                {
                    break;
                }
                if (TryProcessFile(path))
                {
                    processed++;
                }
            }
            return processed;
        }

        private static bool TryProcessFile(string pendingPath)
        {
            var queueKey = Path.GetFileNameWithoutExtension(pendingPath);
            var owner = Guid.NewGuid().ToString("N").Substring(0, 12);
            var claimPath = Path.Combine(ProcessingDirectory, queueKey + "." + owner + ".claim.json");
            try
            {
                File.Move(pendingPath, claimPath);
            }
            catch (IOException)
            {
                return false;
            }

            var leasePath = claimPath + ".lease";
            WriteAtomic(leasePath, new JObject
            {
                ["queueKey"] = queueKey,
                ["owner"] = owner,
                ["claimedUtc"] = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                ["leaseExpiresUtc"] = DateTime.UtcNow.Add(ClaimLease).ToString("O", CultureInfo.InvariantCulture)
            }.ToString(Formatting.None));

            string response;
            UnityMcpRequest request = null;
            try
            {
                var json = File.ReadAllText(claimPath);
                request = JsonRpcUtil.ParseRequest(json);
                if (string.IsNullOrEmpty(request.Id))
                {
                    request.Id = queueKey;
                    request.IdJson = JsonConvert.ToString(queueKey);
                }
                if (string.IsNullOrWhiteSpace(request.IdempotencyKey))
                {
                    request.IdempotencyKey = request.Id;
                }
                var authorization = BridgeSecurity.AuthorizeRequest(request, true);
                if (!authorization.Allowed)
                {
                    response = BridgeSecurity.AuthorizationError(request, authorization);
                }
                else
                {
                    var claim = RequestExecutionStore.Begin(request, json, owner);
                    var cancellationPath = Path.Combine(CancellationDirectory, queueKey + ".json");
                    if (claim.Disposition == RequestClaimDisposition.Claimed && File.Exists(cancellationPath))
                    {
                        response = RequestExecutionStore.Complete(request, owner, JsonRpcUtil.Error(request, -32009, "Queue request was cancelled before execution.", new JObject
                        {
                            ["code"] = "REQUEST_CANCELLED",
                            ["requestId"] = request.Id,
                            ["outcomeUnknown"] = false
                        }));
                        DeleteIfExists(cancellationPath);
                    }
                    else
                    {
                        response = claim.Disposition == RequestClaimDisposition.Claimed
                            ? RequestExecutionStore.Complete(request, owner, Commands.Execute(request))
                            : claim.ResponseJson;
                    }
                }
            }
            catch (JsonRpcProtocolException exception)
            {
                response = JsonRpcUtil.Error(exception);
                MoveToDeadLetter(claimPath, queueKey);
            }
            catch (Exception exception)
            {
                response = request != null
                    ? JsonRpcUtil.Error(request, -32000, exception.Message)
                    : JsonRpcUtil.Error(new JsonRpcProtocolException(-32000, exception.Message));
                MoveToDeadLetter(claimPath, queueKey);
            }

            WriteAtomic(Path.Combine(ResultsDirectory, queueKey + ".json"), response);
            DeleteIfExists(claimPath);
            DeleteIfExists(leasePath);
            return true;
        }

        private static void RecoverStaleClaims()
        {
            foreach (var claimPath in Directory.GetFiles(ProcessingDirectory, "*.claim.json"))
            {
                var leasePath = claimPath + ".lease";
                var lease = ReadObject(leasePath);
                var leaseExpires = ParseUtc(lease?["leaseExpiresUtc"]?.Value<string>());
                if (leaseExpires > DateTime.UtcNow)
                {
                    continue;
                }

                var queueKey = lease?["queueKey"]?.Value<string>();
                if (string.IsNullOrWhiteSpace(queueKey))
                {
                    queueKey = Path.GetFileName(claimPath).Split('.')[0];
                }
                try
                {
                    var raw = File.ReadAllText(claimPath);
                    var request = JsonRpcUtil.ParseRequest(raw);
                    if (string.IsNullOrWhiteSpace(request.IdempotencyKey))
                    {
                        request.IdempotencyKey = request.Id;
                    }
                    var authorization = BridgeSecurity.AuthorizeRequest(request, true);
                    if (!authorization.Allowed)
                    {
                        WriteAtomic(Path.Combine(ResultsDirectory, queueKey + ".json"), BridgeSecurity.AuthorizationError(request, authorization));
                        DeleteIfExists(claimPath);
                        DeleteIfExists(leasePath);
                        continue;
                    }
                    if (RequestExecutionStore.IsReplaySafe(request))
                    {
                        var pendingPath = Path.Combine(PendingDirectory, queueKey + ".json");
                        if (!File.Exists(pendingPath))
                        {
                            File.Move(claimPath, pendingPath);
                        }
                        else
                        {
                            DeleteIfExists(claimPath);
                        }
                    }
                    else
                    {
                        var outcome = RequestExecutionStore.Begin(request, raw, Guid.NewGuid().ToString("N"));
                        WriteAtomic(Path.Combine(ResultsDirectory, queueKey + ".json"), outcome.ResponseJson);
                        DeleteIfExists(claimPath);
                    }
                }
                catch (Exception)
                {
                    MoveToDeadLetter(claimPath, queueKey);
                }
                DeleteIfExists(leasePath);
            }
        }

        private static void CleanupResults()
        {
            if (DateTime.UtcNow < nextCleanupUtc)
            {
                return;
            }
            nextCleanupUtc = DateTime.UtcNow.AddMinutes(1);
            var results = new DirectoryInfo(ResultsDirectory).GetFiles("*.json").OrderByDescending(file => file.LastWriteTimeUtc).ToList();
            for (var index = 0; index < results.Count; index++)
            {
                if (index >= MaxRetainedResults || DateTime.UtcNow - results[index].LastWriteTimeUtc > ResultTtl)
                {
                    results[index].Delete();
                }
            }
        }

        private static void MoveToDeadLetter(string claimPath, string queueKey)
        {
            if (!File.Exists(claimPath))
            {
                return;
            }
            var destination = Path.Combine(DeadLetterDirectory, DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture) + "-" + queueKey + ".json");
            File.Move(claimPath, destination);
        }

        private static JObject ReadObject(string path)
        {
            try
            {
                return File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static DateTime ParseUtc(string value)
        {
            return DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
                ? parsed
                : DateTime.MinValue;
        }

        private static void WriteAtomic(string path, string contents)
        {
            AtomicStateFile.WriteAllText(path, contents);
        }

        private static void DeleteIfExists(string path)
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        private static void EnsureDirectories()
        {
            Directory.CreateDirectory(PendingDirectory);
            Directory.CreateDirectory(ProcessingDirectory);
            Directory.CreateDirectory(ResultsDirectory);
            Directory.CreateDirectory(CancellationDirectory);
            Directory.CreateDirectory(DeadLetterDirectory);
        }
    }
}
