using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class ConsoleLogBuffer
    {
        private const int MaxEntries = 1000;
        private static readonly List<Entry> Entries = new List<Entry>();
        private static int nextSequence = 1;

        static ConsoleLogBuffer()
        {
            Application.logMessageReceived -= HandleLogMessage;
            Application.logMessageReceived += HandleLogMessage;
        }

        public static string Read(string severity, int limit)
        {
            var normalizedSeverity = string.IsNullOrEmpty(severity) ? "all" : severity.ToLowerInvariant();
            var max = Math.Max(1, Math.Min(limit, MaxEntries));
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"bridge-session\",\"logs\":[");

            var written = 0;
            lock (Entries)
            {
                for (var index = Entries.Count - 1; index >= 0 && written < max; index--)
                {
                    var entry = Entries[index];
                    if (!MatchesSeverity(entry, normalizedSeverity))
                    {
                        continue;
                    }

                    if (written > 0)
                    {
                        builder.Append(",");
                    }

                    AppendEntry(builder, entry);
                    written++;
                }
            }

            builder.Append("],\"note\":\"Logs are captured while the Unity MCP Ghost bridge is loaded; historical Unity Console entries from before load may not be available.\"}");
            return builder.ToString();
        }

        private static void HandleLogMessage(string condition, string stackTrace, LogType type)
        {
            lock (Entries)
            {
                Entries.Add(new Entry
                {
                    Sequence = nextSequence++,
                    UtcTimestamp = DateTime.UtcNow,
                    Type = type,
                    Message = condition ?? string.Empty,
                    StackTrace = stackTrace ?? string.Empty
                });

                if (Entries.Count > MaxEntries)
                {
                    Entries.RemoveRange(0, Entries.Count - MaxEntries);
                }
            }
        }

        private static bool MatchesSeverity(Entry entry, string severity)
        {
            if (severity == "all")
            {
                return true;
            }

            if (severity == "error")
            {
                return entry.Type == LogType.Error || entry.Type == LogType.Assert || entry.Type == LogType.Exception;
            }

            if (severity == "warning")
            {
                return entry.Type == LogType.Warning;
            }

            return entry.Type == LogType.Log;
        }

        private static void AppendEntry(StringBuilder builder, Entry entry)
        {
            builder.Append("{\"sequence\":");
            builder.Append(entry.Sequence);
            builder.Append(",\"timestampUtc\":\"");
            builder.Append(entry.UtcTimestamp.ToString("O", CultureInfo.InvariantCulture));
            builder.Append("\",\"type\":\"");
            builder.Append(entry.Type);
            builder.Append("\",\"message\":\"");
            builder.Append(JsonRpcUtil.Escape(entry.Message));
            builder.Append("\",\"stackTrace\":\"");
            builder.Append(JsonRpcUtil.Escape(entry.StackTrace));
            builder.Append("\"}");
        }

        private sealed class Entry
        {
            public int Sequence;
            public DateTime UtcTimestamp;
            public LogType Type;
            public string Message;
            public string StackTrace;
        }
    }
}
