using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Compilation;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class CompileDiagnosticBuffer
    {
        private const int MaxEntries = 1000;
        private static readonly List<Entry> Entries = new List<Entry>();
        private static int nextSequence = 1;

        static CompileDiagnosticBuffer()
        {
            CompilationPipeline.assemblyCompilationFinished -= HandleAssemblyCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += HandleAssemblyCompilationFinished;
        }

        public static string Diagnostics(string severity, int limit, string pathFilter)
        {
            var normalizedSeverity = string.IsNullOrEmpty(severity) ? "error" : severity.ToLowerInvariant();
            var normalizedPath = NormalizePath(pathFilter ?? string.Empty);
            var max = Math.Max(1, Math.Min(limit, MaxEntries));
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"compilation-pipeline\",\"diagnostics\":[");

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

                    if (!string.IsNullOrEmpty(normalizedPath) && !NormalizePath(entry.File).Contains(normalizedPath))
                    {
                        continue;
                    }

                    if (written > 0)
                    {
                        builder.Append(",");
                    }

                    AppendDiagnostic(builder, entry);
                    written++;
                }
            }

            builder.Append("],\"note\":\"Diagnostics are captured from UnityEditor.Compilation.CompilationPipeline while the Ghost bridge is loaded.\"}");
            return builder.ToString();
        }

        private static void HandleAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            if (messages == null || messages.Length == 0)
            {
                return;
            }

            lock (Entries)
            {
                foreach (var message in messages)
                {
                    Entries.Add(new Entry
                    {
                        Sequence = nextSequence++,
                        UtcTimestamp = DateTime.UtcNow,
                        AssemblyPath = assemblyPath ?? string.Empty,
                        File = NormalizePath(message.file ?? string.Empty),
                        Line = message.line,
                        Column = message.column,
                        Type = message.type,
                        Message = message.message ?? string.Empty
                    });
                }

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

            if (severity == "warning")
            {
                return entry.Type == CompilerMessageType.Warning;
            }

            return entry.Type == CompilerMessageType.Error;
        }

        private static void AppendDiagnostic(StringBuilder builder, Entry entry)
        {
            builder.Append("{\"sequence\":");
            builder.Append(entry.Sequence);
            builder.Append(",\"timestampUtc\":\"");
            builder.Append(entry.UtcTimestamp.ToString("O", CultureInfo.InvariantCulture));
            builder.Append("\",\"severity\":\"");
            builder.Append(entry.Type == CompilerMessageType.Warning ? "warning" : "error");
            builder.Append("\",\"code\":\"");
            builder.Append(JsonRpcUtil.Escape(ReadCode(entry.Message)));
            builder.Append("\",\"message\":\"");
            builder.Append(JsonRpcUtil.Escape(entry.Message));
            builder.Append("\",\"file\":\"");
            builder.Append(JsonRpcUtil.Escape(entry.File));
            builder.Append("\",\"line\":");
            builder.Append(entry.Line);
            builder.Append(",\"column\":");
            builder.Append(entry.Column);
            builder.Append(",\"assemblyPath\":\"");
            builder.Append(JsonRpcUtil.Escape(entry.AssemblyPath));
            builder.Append("\"}");
        }

        private static string ReadCode(string message)
        {
            var match = Regex.Match(message ?? string.Empty, @"\b(CS\d{4})\b");
            return match.Success ? match.Groups[1].Value : string.Empty;
        }

        private static string NormalizePath(string path)
        {
            var normalized = (path ?? string.Empty).Replace("\\", "/");
            var assetsIndex = normalized.IndexOf("/Assets/", StringComparison.OrdinalIgnoreCase);
            if (assetsIndex >= 0)
            {
                return normalized.Substring(assetsIndex + 1);
            }

            return normalized;
        }

        private sealed class Entry
        {
            public int Sequence;
            public DateTime UtcTimestamp;
            public string AssemblyPath;
            public string File;
            public int Line;
            public int Column;
            public CompilerMessageType Type;
            public string Message;
        }
    }
}
