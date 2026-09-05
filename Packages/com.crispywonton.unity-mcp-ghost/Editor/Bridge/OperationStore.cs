using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class OperationStore
    {
        private const int MaxRetainedOperations = 1000;
        private static readonly TimeSpan Retention = TimeSpan.FromHours(24);
        private static readonly Dictionary<string, LiveOperation> Operations = new Dictionary<string, LiveOperation>();
        private static readonly object Sync = new object();

        internal static string RootOverrideForTests;

        public static string Register(string kind, string label, Func<string> readJson)
        {
            var id = Guid.NewGuid().ToString("N");
            Register(id, kind, label, readJson);
            return id;
        }

        public static void Register(string id, string kind, string label, Func<string> readJson)
        {
            Register(id, kind, label, readJson, null, false);
        }

        public static void Register(string id, string kind, string label, Func<string> readJson, Action cancel, bool cancellationSafe)
        {
            if (string.IsNullOrWhiteSpace(id) || readJson == null)
            {
                throw new ArgumentException("Durable operations require an id and state reader.");
            }
            lock (Sync)
            {
                EnsureDirectory();
                Operations[id] = new LiveOperation
                {
                    Kind = kind ?? string.Empty,
                    Label = label ?? string.Empty,
                    ReadJson = readJson,
                    Cancel = cancel,
                    CancellationSafe = cancellationSafe
                };
                var now = DateTime.UtcNow;
                Save(new OperationRecord
                {
                    OperationId = id,
                    Kind = kind ?? string.Empty,
                    Label = label ?? string.Empty,
                    Status = "running",
                    State = new JObject { ["status"] = "running" },
                    CreatedUtc = FormatUtc(now),
                    UpdatedUtc = FormatUtc(now),
                    CancellationSupported = cancel != null || cancellationSafe
                });
                Cleanup();
            }
        }

        public static string Read(string id)
        {
            lock (Sync)
            {
                var record = Refresh(id);
                return Envelope(record).ToString(Formatting.None);
            }
        }

        public static string Cancel(string id)
        {
            lock (Sync)
            {
                var record = Refresh(id);
                if (IsTerminal(record.Status))
                {
                    return Envelope(record).ToString(Formatting.None);
                }

                record.CancelRequested = true;
                record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                if (Operations.TryGetValue(id, out var live) && live.Cancel != null)
                {
                    try
                    {
                        live.Cancel();
                        record.Status = "cancelling";
                        record.State = new JObject { ["status"] = "cancelling", ["cancelRequested"] = true };
                    }
                    catch (Exception exception)
                    {
                        record.Status = "outcomeUnknown";
                        record.State = OutcomeUnknownState("Cancellation raced with the underlying operation: " + exception.Message);
                    }
                }
                else if (Operations.TryGetValue(id, out live) && live.CancellationSafe)
                {
                    record.Status = "cancelled";
                    record.State = new JObject
                    {
                        ["ok"] = false,
                        ["status"] = "cancelled",
                        ["cancelRequested"] = true,
                        ["error"] = new JObject { ["code"] = "OPERATION_CANCELLED", ["message"] = "Operation polling was cancelled before further work." }
                    };
                    record.CompletedUtc = FormatUtc(DateTime.UtcNow);
                    Operations.Remove(id);
                }
                else
                {
                    record.Status = "outcomeUnknown";
                    record.State = OutcomeUnknownState("The operation cannot prove whether cancellation reached the underlying Unity subsystem.");
                    record.CompletedUtc = FormatUtc(DateTime.UtcNow);
                    Operations.Remove(id);
                }
                Save(record);
                return Envelope(record).ToString(Formatting.None);
            }
        }

        public static void Update(string id, string stateJson)
        {
            lock (Sync)
            {
                var record = Load(PathFor(id));
                if (record == null)
                {
                    return;
                }
                try
                {
                    record.State = JObject.Parse(stateJson);
                    record.Status = record.State.Value<string>("status") ?? record.Status;
                    record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                    if (IsTerminal(record.Status))
                    {
                        record.CompletedUtc = record.UpdatedUtc;
                        Operations.Remove(id);
                    }
                    Save(record);
                }
                catch (JsonException)
                {
                    // Preserve the last valid durable state if a subsystem emits malformed state.
                }
            }
        }

        public static string List()
        {
            lock (Sync)
            {
                EnsureDirectory();
                foreach (var id in Operations.Keys.ToArray())
                {
                    Refresh(id);
                }
                var records = Directory.GetFiles(Root(), "*.operation.json")
                    .Select(Load)
                    .Where(record => record != null)
                    .OrderByDescending(record => ParseUtc(record.UpdatedUtc))
                    .Take(MaxRetainedOperations)
                    .ToList();
                foreach (var record in records.Where(record => !IsTerminal(record.Status) && !Operations.ContainsKey(record.OperationId)))
                {
                    record.Status = "outcomeUnknown";
                    record.State = OutcomeUnknownState("Unity reloaded before the operation's in-memory subsystem handle reached a terminal result.");
                    record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                    record.CompletedUtc = record.UpdatedUtc;
                    Save(record);
                }
                return new JObject
                {
                    ["ok"] = true,
                    ["operations"] = new JArray(records.Select(Summary)),
                    ["count"] = records.Count,
                    ["retentionHours"] = Retention.TotalHours
                }.ToString(Formatting.None);
            }
        }

        private static OperationRecord Refresh(string id)
        {
            if (string.IsNullOrWhiteSpace(id))
            {
                throw new InvalidOperationException("operationId is required.");
            }
            EnsureDirectory();
            var record = Load(PathFor(id));
            if (record == null)
            {
                throw new InvalidOperationException("Unknown Ghost operation: " + id);
            }

            if (Operations.TryGetValue(id, out var live))
            {
                try
                {
                    var state = JObject.Parse(live.ReadJson());
                    record.State = state;
                    record.Status = state.Value<string>("status") ?? "running";
                    record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                    if (IsTerminal(record.Status))
                    {
                        record.CompletedUtc = FormatUtc(DateTime.UtcNow);
                        Operations.Remove(id);
                    }
                    Save(record);
                }
                catch (Exception exception)
                {
                    record.Status = "failed";
                    record.State = new JObject
                    {
                        ["ok"] = false,
                        ["status"] = "failed",
                        ["error"] = new JObject { ["code"] = "OPERATION_STATE_READ_FAILED", ["message"] = exception.Message }
                    };
                    record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                    record.CompletedUtc = record.UpdatedUtc;
                    Operations.Remove(id);
                    Save(record);
                }
            }
            else if (!IsTerminal(record.Status))
            {
                record.Status = "outcomeUnknown";
                record.State = OutcomeUnknownState("Unity reloaded before the operation's in-memory subsystem handle reached a terminal result.");
                record.UpdatedUtc = FormatUtc(DateTime.UtcNow);
                record.CompletedUtc = record.UpdatedUtc;
                Save(record);
            }
            return record;
        }

        private static JObject Envelope(OperationRecord record)
        {
            return new JObject
            {
                ["ok"] = record.Status == "running" || record.Status == "cancelling" || record.Status == "success",
                ["operationId"] = record.OperationId,
                ["kind"] = record.Kind,
                ["label"] = record.Label,
                ["status"] = record.Status,
                ["createdUtc"] = record.CreatedUtc,
                ["updatedUtc"] = record.UpdatedUtc,
                ["completedUtc"] = string.IsNullOrEmpty(record.CompletedUtc) ? JValue.CreateNull() : new JValue(record.CompletedUtc),
                ["cancelRequested"] = record.CancelRequested,
                ["cancellationSupported"] = record.CancellationSupported,
                ["state"] = record.State ?? new JObject { ["status"] = record.Status }
            };
        }

        private static JObject Summary(OperationRecord record)
        {
            return new JObject
            {
                ["operationId"] = record.OperationId,
                ["kind"] = record.Kind,
                ["label"] = record.Label,
                ["status"] = record.Status,
                ["updatedUtc"] = record.UpdatedUtc,
                ["cancelRequested"] = record.CancelRequested
            };
        }

        private static JObject OutcomeUnknownState(string message)
        {
            return new JObject
            {
                ["ok"] = false,
                ["status"] = "outcomeUnknown",
                ["outcomeUnknown"] = true,
                ["error"] = new JObject { ["code"] = "OPERATION_OUTCOME_UNKNOWN", ["message"] = message }
            };
        }

        private static bool IsTerminal(string status)
        {
            switch ((status ?? string.Empty).ToLowerInvariant())
            {
                case "success":
                case "failed":
                case "timeout":
                case "cancelled":
                case "canceled":
                case "outcomeunknown":
                    return true;
                default:
                    return false;
            }
        }

        private static void Cleanup()
        {
            var now = DateTime.UtcNow;
            var records = Directory.GetFiles(Root(), "*.operation.json")
                .Select(path => new { Path = path, Record = Load(path) })
                .Where(item => item.Record != null)
                .OrderByDescending(item => ParseUtc(item.Record.UpdatedUtc))
                .ToList();
            for (var index = 0; index < records.Count; index++)
            {
                if (!IsTerminal(records[index].Record.Status))
                {
                    continue;
                }
                if (index >= MaxRetainedOperations || now - ParseUtc(records[index].Record.CompletedUtc) > Retention)
                {
                    File.Delete(records[index].Path);
                }
            }
        }

        private static void Save(OperationRecord record)
        {
            AtomicStateFile.WriteAllText(PathFor(record.OperationId), JsonConvert.SerializeObject(record, Formatting.Indented));
        }

        private static OperationRecord Load(string path)
        {
            try
            {
                return File.Exists(path) ? JsonConvert.DeserializeObject<OperationRecord>(File.ReadAllText(path)) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string PathFor(string id)
        {
            using (var sha256 = SHA256.Create())
            {
                var key = string.Concat(sha256.ComputeHash(Encoding.UTF8.GetBytes(id ?? string.Empty)).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
                return Path.Combine(Root(), key + ".operation.json");
            }
        }

        private static void EnsureDirectory()
        {
            Directory.CreateDirectory(Root());
        }

        private static string Root()
        {
            if (!string.IsNullOrWhiteSpace(RootOverrideForTests))
            {
                return Path.GetFullPath(RootOverrideForTests);
            }
            return Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Library", "UnityMcpGhost", "operations");
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

        internal static void ClearForTests()
        {
            lock (Sync)
            {
                Operations.Clear();
                RootOverrideForTests = null;
            }
        }

        internal static void ClearLiveForTests()
        {
            lock (Sync)
            {
                Operations.Clear();
            }
        }

        private sealed class LiveOperation
        {
            public string Kind;
            public string Label;
            public Func<string> ReadJson;
            public Action Cancel;
            public bool CancellationSafe;
        }

        private sealed class OperationRecord
        {
            public string OperationId = string.Empty;
            public string Kind = string.Empty;
            public string Label = string.Empty;
            public string Status = string.Empty;
            public JObject State = new JObject();
            public string CreatedUtc = string.Empty;
            public string UpdatedUtc = string.Empty;
            public string CompletedUtc = string.Empty;
            public bool CancelRequested;
            public bool CancellationSupported;
        }
    }
}
