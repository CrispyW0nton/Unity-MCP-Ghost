using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class ConsoleLogBuffer
    {
        private const int MaxEntries = 1000;
        private const int MaxMarks = 100;
        private static readonly string StatePath = Path.Combine(BridgeSecurity.StateRoot, "console-buffer.json");
        private static readonly object Sync = new object();
        private static readonly List<Entry> Entries = new List<Entry>();
        private static readonly List<Mark> Marks = new List<Mark>();
        private static int nextSequence = 1;
        private static int generation = 1;
        private static int droppedThroughSequence;

        static ConsoleLogBuffer()
        {
            Load();
            Application.logMessageReceivedThreaded -= HandleLogMessage;
            Application.logMessageReceivedThreaded += HandleLogMessage;
        }

        public static string Read(string severity, int limit)
        {
            var query = new ConsoleQuery { Severity = severity, Limit = limit, MinimumCount = 0, FailOnUnexpectedErrors = false };
            var result = QueryEntries(query);
            result["source"] = "persistent-bridge-buffer";
            result["logs"] = result["entries"];
            result.Remove("entries");
            return result.ToString(Formatting.None);
        }

        public static string Diagnostics(string severity, int limit, string pathFilter)
        {
            var query = new ConsoleQuery { Severity = severity, File = pathFilter, Limit = limit, MinimumCount = 0, FailOnUnexpectedErrors = false };
            var result = QueryEntries(query);
            result["source"] = "persistent-bridge-buffer";
            result["diagnostics"] = result["entries"];
            result.Remove("entries");
            return result.ToString(Formatting.None);
        }

        public static string Clear()
        {
            bool unityConsoleCleared;
            string warning = null;
            lock (Sync)
            {
                Entries.Clear();
                Marks.Clear();
                droppedThroughSequence = nextSequence - 1;
                generation++;
                SaveLocked();
            }

            try
            {
                var logEntries = typeof(EditorWindow).Assembly.GetType("UnityEditor.LogEntries", false);
                var clear = logEntries?.GetMethod("Clear", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (clear == null)
                {
                    throw new MissingMethodException("UnityEditor.LogEntries.Clear is unavailable.");
                }
                clear.Invoke(null, null);
                unityConsoleCleared = true;
            }
            catch (Exception exception)
            {
                unityConsoleCleared = false;
                warning = "The Ghost buffer was cleared, but Unity's visible Console could not be cleared: " + exception.GetBaseException().Message;
            }

            var mark = CreateMark("after-clear");
            var value = new JObject
            {
                ["ok"] = true,
                ["generation"] = generation,
                ["boundary"] = mark.Token,
                ["unityConsoleCleared"] = unityConsoleCleared
            };
            if (!string.IsNullOrWhiteSpace(warning))
            {
                value["warnings"] = new JArray(warning);
            }
            return value.ToString(Formatting.None);
        }

        public static string MarkBoundary(string label)
        {
            var mark = CreateMark(label);
            return new JObject
            {
                ["ok"] = true,
                ["boundary"] = mark.Token,
                ["label"] = mark.Label,
                ["sequence"] = mark.Sequence,
                ["generation"] = mark.Generation,
                ["timestampUtc"] = mark.TimestampUtc
            }.ToString(Formatting.None);
        }

        public static string Query(string json, bool assertion)
        {
            JObject result;
            try
            {
                result = QueryEntries(ConsoleQuery.FromJson(json));
            }
            catch (ConsoleQueryException exception)
            {
                return Failure(exception.Code, exception.Message);
            }

            if (assertion && result["matched"]?.Value<bool>() != true)
            {
                result["ok"] = false;
                result["error"] = new JObject
                {
                    ["code"] = "CONSOLE_ASSERTION_FAILED",
                    ["message"] = "Console entries did not satisfy the requested count/filter or contained unexpected errors."
                };
            }
            return result.ToString(Formatting.None);
        }

        internal static void ResetForTests()
        {
            lock (Sync)
            {
                Entries.Clear();
                Marks.Clear();
                nextSequence = 1;
                generation = 1;
                droppedThroughSequence = 0;
                SaveLocked();
            }
        }

        internal static void AddForTests(string message, LogType type, string stackTrace = "")
        {
            HandleLogMessage(message, stackTrace, type);
        }

        internal static void AddNoisyEntriesForTests(int benignCount)
        {
            lock (Sync)
            {
                Entries.Add(new Entry
                {
                    Sequence = nextSequence++,
                    Generation = generation,
                    TimestampUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                    Type = LogType.Error,
                    Message = "evicted failure",
                    StackTrace = string.Empty
                });
                for (var index = 0; index < benignCount; index++)
                {
                    Entries.Add(new Entry
                    {
                        Sequence = nextSequence++,
                        Generation = generation,
                        TimestampUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                        Type = LogType.Log,
                        Message = "noise-" + index,
                        StackTrace = string.Empty
                    });
                }
                if (Entries.Count > MaxEntries)
                {
                    var removeCount = Entries.Count - MaxEntries;
                    droppedThroughSequence = Math.Max(droppedThroughSequence, Entries[removeCount - 1].Sequence);
                    Entries.RemoveRange(0, removeCount);
                }
                SaveLocked();
            }
        }

        private static Mark CreateMark(string label)
        {
            lock (Sync)
            {
                var mark = new Mark
                {
                    Token = Guid.NewGuid().ToString("N"),
                    Label = label ?? string.Empty,
                    Sequence = nextSequence - 1,
                    Generation = generation,
                    TimestampUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)
                };
                Marks.Add(mark);
                if (Marks.Count > MaxMarks)
                {
                    Marks.RemoveRange(0, Marks.Count - MaxMarks);
                }
                SaveLocked();
                return mark;
            }
        }

        private static JObject QueryEntries(ConsoleQuery query)
        {
            lock (Sync)
            {
                var boundarySequence = 0;
                var boundaryGeneration = 0;
                if (!string.IsNullOrWhiteSpace(query.Boundary))
                {
                    var mark = Marks.FirstOrDefault(item => string.Equals(item.Token, query.Boundary, StringComparison.Ordinal));
                    if (mark == null)
                    {
                        throw new ConsoleQueryException("CONSOLE_BOUNDARY_NOT_FOUND", "Console boundary is unknown or no longer retained: " + query.Boundary);
                    }
                    boundarySequence = mark.Sequence;
                    boundaryGeneration = mark.Generation;
                }

                if (query.FailOnUnexpectedErrors && boundarySequence < droppedThroughSequence)
                {
                    throw new ConsoleQueryException(
                        "CONSOLE_BOUNDARY_TRUNCATED",
                        "Console entries after the requested boundary were evicted; the assertion cannot be evaluated truthfully.");
                }

                Regex messageRegex = null;
                if (!string.IsNullOrWhiteSpace(query.Regex))
                {
                    try
                    {
                        messageRegex = new Regex(query.Regex, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
                    }
                    catch (ArgumentException exception)
                    {
                        throw new ConsoleQueryException("INVALID_CONSOLE_REGEX", exception.Message);
                    }
                }

                var candidates = Entries.Where(entry => entry.Sequence > boundarySequence
                    && (query.Generation <= 0 || entry.Generation == query.Generation)
                    && (boundaryGeneration <= 0 || entry.Generation >= boundaryGeneration)).ToArray();
                var matching = candidates.Where(entry => Matches(entry, query, messageRegex)).ToArray();
                var unexpectedErrors = query.FailOnUnexpectedErrors
                    ? candidates.Where(entry => IsError(entry.Type) && !matching.Contains(entry)).ToArray()
                    : Array.Empty<Entry>();
                var countMatched = query.Count.HasValue
                    ? matching.Length == query.Count.Value
                    : matching.Length >= query.MinimumCount && matching.Length <= query.MaximumCount;
                var limit = Math.Max(1, Math.Min(query.Limit, MaxEntries));
                return new JObject
                {
                    ["ok"] = true,
                    ["matched"] = countMatched && unexpectedErrors.Length == 0,
                    ["boundary"] = string.IsNullOrWhiteSpace(query.Boundary) ? null : query.Boundary,
                    ["generation"] = generation,
                    ["count"] = matching.Length,
                    ["expectedCount"] = query.Count.HasValue ? (JToken)query.Count.Value : null,
                    ["minimumCount"] = query.MinimumCount,
                    ["maximumCount"] = query.MaximumCount == int.MaxValue ? null : (JToken)query.MaximumCount,
                    ["entries"] = new JArray(matching.Take(limit).Select(ToJson)),
                    ["unexpectedErrors"] = new JArray(unexpectedErrors.Take(limit).Select(ToJson)),
                    ["truncated"] = matching.Length > limit || unexpectedErrors.Length > limit,
                    ["retainedEntryCount"] = Entries.Count,
                    ["droppedThroughSequence"] = droppedThroughSequence
                };
            }
        }

        private static bool Matches(Entry entry, ConsoleQuery query, Regex regex)
        {
            if (!MatchesSeverity(entry.Type, query.Severity))
            {
                return false;
            }
            if (!string.IsNullOrEmpty(query.Exact) && !string.Equals(entry.Message, query.Exact, StringComparison.Ordinal))
            {
                return false;
            }
            if (!string.IsNullOrEmpty(query.Contains) && entry.Message.IndexOf(query.Contains, StringComparison.Ordinal) < 0)
            {
                return false;
            }
            if (regex != null && !regex.IsMatch(entry.Message ?? string.Empty))
            {
                return false;
            }
            var location = ReadLocation(entry.Message + "\n" + entry.StackTrace);
            if (!string.IsNullOrWhiteSpace(query.File)
                && (string.IsNullOrWhiteSpace(location.Path) || location.Path.Replace('\\', '/').IndexOf(query.File.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase) < 0))
            {
                return false;
            }
            return query.Line <= 0 || location.Line == query.Line;
        }

        private static bool MatchesSeverity(LogType type, string severity)
        {
            var normalized = string.IsNullOrWhiteSpace(severity) ? "all" : severity.ToLowerInvariant();
            if (normalized == "all")
            {
                return true;
            }
            if (normalized == "error")
            {
                return IsError(type);
            }
            if (normalized == "warning")
            {
                return type == LogType.Warning;
            }
            return type == LogType.Log;
        }

        private static bool IsError(LogType type)
        {
            return type == LogType.Error || type == LogType.Assert || type == LogType.Exception;
        }

        private static void HandleLogMessage(string condition, string stackTrace, LogType type)
        {
            lock (Sync)
            {
                Entries.Add(new Entry
                {
                    Sequence = nextSequence++,
                    Generation = generation,
                    TimestampUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                    Type = type,
                    Message = condition ?? string.Empty,
                    StackTrace = stackTrace ?? string.Empty
                });
                if (Entries.Count > MaxEntries)
                {
                    var removeCount = Entries.Count - MaxEntries;
                    droppedThroughSequence = Math.Max(droppedThroughSequence, Entries[removeCount - 1].Sequence);
                    Entries.RemoveRange(0, removeCount);
                }
                try
                {
                    SaveLocked();
                }
                catch
                {
                    // Logging must never recursively create another Unity log entry.
                }
            }
        }

        private static JObject ToJson(Entry entry)
        {
            var location = ReadLocation(entry.Message + "\n" + entry.StackTrace);
            return new JObject
            {
                ["sequence"] = entry.Sequence,
                ["generation"] = entry.Generation,
                ["timestampUtc"] = entry.TimestampUtc,
                ["severity"] = IsError(entry.Type) ? "error" : entry.Type == LogType.Warning ? "warning" : "log",
                ["type"] = entry.Type.ToString(),
                ["message"] = entry.Message,
                ["file"] = location.Path ?? string.Empty,
                ["line"] = location.Line,
                ["column"] = location.Column,
                ["stackTrace"] = entry.StackTrace
            };
        }

        private static Location ReadLocation(string value)
        {
            var source = value ?? string.Empty;
            var compiler = Regex.Match(source, @"(?<path>Assets[^\r\n\(]+\.cs)\((?<line>\d+),(?<column>\d+)\)");
            if (compiler.Success)
            {
                return LocationFromMatch(compiler, true);
            }

            var stack = Regex.Match(source, @"(?:\(at\s+)?(?<path>Assets[^\r\n:]+\.cs):(?<line>\d+)\)?");
            return stack.Success ? LocationFromMatch(stack, false) : new Location();
        }

        private static Location LocationFromMatch(Match match, bool hasColumn)
        {
            return new Location
            {
                Path = match.Groups["path"].Value.Replace('\\', '/'),
                Line = int.Parse(match.Groups["line"].Value, CultureInfo.InvariantCulture),
                Column = hasColumn ? int.Parse(match.Groups["column"].Value, CultureInfo.InvariantCulture) : 0
            };
        }

        private static string Failure(string code, string message)
        {
            return new JObject
            {
                ["ok"] = false,
                ["error"] = new JObject { ["code"] = code, ["message"] = message }
            }.ToString(Formatting.None);
        }

        private static void Load()
        {
            lock (Sync)
            {
                try
                {
                    if (!File.Exists(StatePath))
                    {
                        return;
                    }
                    var state = JsonConvert.DeserializeObject<PersistedState>(File.ReadAllText(StatePath));
                    if (state == null)
                    {
                        return;
                    }
                    Entries.AddRange((state.Entries ?? new List<Entry>()).Skip(Math.Max(0, (state.Entries ?? new List<Entry>()).Count - MaxEntries)));
                    Marks.AddRange((state.Marks ?? new List<Mark>()).Skip(Math.Max(0, (state.Marks ?? new List<Mark>()).Count - MaxMarks)));
                    nextSequence = Math.Max(state.NextSequence, Entries.Count == 0 ? 1 : Entries.Max(entry => entry.Sequence) + 1);
                    generation = Math.Max(1, state.Generation);
                    droppedThroughSequence = Math.Max(0, state.DroppedThroughSequence);
                }
                catch
                {
                    Entries.Clear();
                    Marks.Clear();
                    nextSequence = 1;
                    generation = 1;
                    droppedThroughSequence = 0;
                }
            }
        }

        private static void SaveLocked()
        {
            AtomicStateFile.WriteAllText(StatePath, JsonConvert.SerializeObject(new PersistedState
            {
                NextSequence = nextSequence,
                Generation = generation,
                DroppedThroughSequence = droppedThroughSequence,
                Entries = Entries,
                Marks = Marks
            }));
        }

        [Serializable]
        private sealed class PersistedState
        {
            public int NextSequence = 1;
            public int Generation = 1;
            public int DroppedThroughSequence;
            public List<Entry> Entries = new List<Entry>();
            public List<Mark> Marks = new List<Mark>();
        }

        [Serializable]
        private sealed class Entry
        {
            public int Sequence;
            public int Generation;
            public string TimestampUtc;
            public LogType Type;
            public string Message;
            public string StackTrace;
        }

        [Serializable]
        private sealed class Mark
        {
            public string Token;
            public string Label;
            public int Sequence;
            public int Generation;
            public string TimestampUtc;
        }

        private sealed class ConsoleQuery
        {
            public string Boundary = string.Empty;
            public int Generation;
            public string Severity = "all";
            public string Exact = string.Empty;
            public string Contains = string.Empty;
            public string Regex = string.Empty;
            public string File = string.Empty;
            public int Line;
            public int? Count;
            public int MinimumCount = 1;
            public int MaximumCount = int.MaxValue;
            public int Limit = 200;
            public bool FailOnUnexpectedErrors = true;

            public static ConsoleQuery FromJson(string json)
            {
                var count = JsonRpcUtil.ReadInt(json, "count", -1);
                return new ConsoleQuery
                {
                    Boundary = JsonRpcUtil.ReadString(json, "boundary", string.Empty),
                    Generation = JsonRpcUtil.ReadInt(json, "generation", 0),
                    Severity = JsonRpcUtil.ReadString(json, "severity", "all"),
                    Exact = JsonRpcUtil.ReadString(json, "exact", string.Empty),
                    Contains = JsonRpcUtil.ReadString(json, "contains", string.Empty),
                    Regex = JsonRpcUtil.ReadString(json, "regex", string.Empty),
                    File = JsonRpcUtil.ReadString(json, "file", string.Empty),
                    Line = JsonRpcUtil.ReadInt(json, "line", 0),
                    Count = count >= 0 ? (int?)count : null,
                    MinimumCount = Math.Max(0, JsonRpcUtil.ReadInt(json, "minimumCount", 1)),
                    MaximumCount = Math.Max(0, JsonRpcUtil.ReadInt(json, "maximumCount", int.MaxValue)),
                    Limit = JsonRpcUtil.ReadInt(json, "limit", 200),
                    FailOnUnexpectedErrors = JsonRpcUtil.ReadBool(json, "failOnUnexpectedErrors", true)
                };
            }
        }

        private sealed class ConsoleQueryException : Exception
        {
            public ConsoleQueryException(string code, string message) : base(message)
            {
                Code = code;
            }

            public string Code { get; }
        }

        private struct Location
        {
            public string Path;
            public int Line;
            public int Column;
        }
    }
}
