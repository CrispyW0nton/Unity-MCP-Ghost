using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class CompileDiagnosticBuffer
    {
        private const int MaxGenerations = 50;
        private const int MaxDiagnostics = 1000;
        private static readonly object Gate = new object();
        private static readonly string StatePath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Library", "UnityMcpGhost", "compile-state.json");
        private static CompileState state = Load();

        static CompileDiagnosticBuffer()
        {
            CompilationPipeline.compilationStarted -= HandleCompilationStarted;
            CompilationPipeline.compilationStarted += HandleCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished -= HandleAssemblyCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += HandleAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished -= HandleCompilationFinished;
            CompilationPipeline.compilationFinished += HandleCompilationFinished;
            EditorApplication.delayCall += RecoverAfterReload;
        }

        public static int LatestRequestedGeneration
        {
            get
            {
                lock (Gate)
                {
                    return state.Generations.Count == 0 ? 0 : state.Generations.Max(entry => entry.Generation);
                }
            }
        }

        public static int RequestGeneration(string sourcePath)
        {
            lock (Gate)
            {
                var generation = Math.Max(1, state.NextGeneration++);
                state.Generations.Add(new GenerationRecord
                {
                    Generation = generation,
                    SourcePath = NormalizePath(sourcePath),
                    Status = "waiting",
                    RequestedAtUtc = UtcNow()
                });
                TrimAndSave();
                return generation;
            }
        }

        public static string Diagnostics(string severity, int limit, string pathFilter, int generation = 0)
        {
            var normalizedSeverity = string.IsNullOrEmpty(severity) ? "error" : severity.ToLowerInvariant();
            var normalizedPath = NormalizePath(pathFilter ?? string.Empty);
            var max = Math.Max(1, Math.Min(limit, MaxDiagnostics));

            lock (Gate)
            {
                var matching = state.Generations
                    .Where(entry => generation <= 0 || entry.Generation == generation)
                    .SelectMany(entry => entry.Diagnostics)
                    .Where(entry => MatchesSeverity(entry, normalizedSeverity))
                    .Where(entry => string.IsNullOrEmpty(normalizedPath) || NormalizePath(entry.File).IndexOf(normalizedPath, StringComparison.OrdinalIgnoreCase) >= 0)
                    .OrderByDescending(entry => entry.Sequence)
                    .Take(max + 1)
                    .Select(ToDiagnosticJson)
                    .ToArray();
                var truncated = matching.Length > max;
                var diagnostics = matching.Take(max).ToArray();

                return new JObject
                {
                    ["ok"] = true,
                    ["source"] = "compilation-pipeline",
                    ["generation"] = generation > 0 ? generation : (int?)null,
                    ["diagnostics"] = new JArray(diagnostics),
                    ["truncated"] = truncated,
                    ["note"] = "Diagnostics are scoped to persisted compile/import generations."
                }.ToString(Formatting.None);
            }
        }

        public static string WaitState(int generation, bool timedOut)
        {
            lock (Gate)
            {
                var record = state.Generations.FirstOrDefault(entry => entry.Generation == generation);
                if (record == null)
                {
                    return FailureState("UNKNOWN_COMPILE_GENERATION", "Unknown compile generation: " + generation, generation, "failed");
                }

                if (timedOut && record.Status != "success" && record.Status != "failed")
                {
                    return FailureState("COMPILE_GENERATION_TIMEOUT", "Timed out before compile generation " + generation + " completed.", generation, "timeout", record);
                }

                var response = new JObject
                {
                    ["ok"] = record.Status != "failed",
                    ["status"] = record.Status,
                    ["generation"] = record.Generation,
                    ["observed"] = !string.IsNullOrEmpty(record.ObservedAtUtc),
                    ["requestedAtUtc"] = record.RequestedAtUtc,
                    ["observedAtUtc"] = NullOrString(record.ObservedAtUtc),
                    ["completedAtUtc"] = NullOrString(record.CompletedAtUtc),
                    ["sourcePath"] = record.SourcePath,
                    ["diagnostics"] = new JArray(record.Diagnostics.Select(ToDiagnosticJson)),
                    ["diagnosticsTruncated"] = record.DiagnosticsTruncated,
                    ["errorCount"] = record.ErrorCount
                };

                if (record.Status == "failed")
                {
                    response["error"] = new JObject
                    {
                        ["code"] = "COMPILE_GENERATION_FAILED",
                        ["message"] = "Compile generation " + generation + " completed with compiler errors."
                    };
                }

                return response.ToString(Formatting.None);
            }
        }

        internal static void ResetForTests()
        {
            lock (Gate)
            {
                state = new CompileState();
                Save();
            }
        }

        internal static void BeginCompilationForTests()
        {
            BeginCompilation();
        }

        internal static void CompleteCompilationForTests()
        {
            CompleteCompilation();
        }

        internal static void AddDiagnosticForTests(int generation, string assembly, CompilerMessageType type, string file, int line, int column, string message)
        {
            lock (Gate)
            {
                var record = state.Generations.First(entry => entry.Generation == generation);
                AddDiagnostic(record, assembly, type, file, line, column, message);
                Save();
            }
        }

        internal static void AddNoisyDiagnosticsForTests(int generation, int warningCount)
        {
            lock (Gate)
            {
                var record = state.Generations.First(entry => entry.Generation == generation);
                AddDiagnostic(record, "Assembly-CSharp.dll", CompilerMessageType.Error, "Assets/Noisy.cs", 1, 1, "error CS1002: ; expected");
                for (var index = 0; index < warningCount; index++)
                {
                    AddDiagnostic(record, "Assembly-CSharp.dll", CompilerMessageType.Warning, "Assets/Noisy.cs", index + 2, 1, "warning CS0168: unused");
                }
                TrimAndSave();
            }
        }

        private static void HandleCompilationStarted(object context)
        {
            BeginCompilation();
        }

        private static void BeginCompilation()
        {
            lock (Gate)
            {
                var pending = state.Generations.Where(entry => entry.Status == "waiting").ToList();
                if (pending.Count == 0)
                {
                    var generation = Math.Max(1, state.NextGeneration++);
                    pending.Add(new GenerationRecord
                    {
                        Generation = generation,
                        SourcePath = string.Empty,
                        Status = "waiting",
                        RequestedAtUtc = UtcNow()
                    });
                    state.Generations.Add(pending[0]);
                }

                var observedAt = UtcNow();
                foreach (var record in pending)
                {
                    record.Status = "running";
                    record.ObservedAtUtc = observedAt;
                }

                TrimAndSave();
            }
        }

        private static void HandleAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            lock (Gate)
            {
                var active = state.Generations.Where(entry => entry.Status == "running").ToList();
                if (active.Count == 0)
                {
                    BeginCompilation();
                    active = state.Generations.Where(entry => entry.Status == "running").ToList();
                }

                if (messages != null)
                {
                    foreach (var record in active)
                    {
                        foreach (var message in messages)
                        {
                            AddDiagnostic(record, assemblyPath, message.type, message.file, message.line, message.column, message.message);
                        }
                    }
                }

                TrimAndSave();
            }
        }

        private static void HandleCompilationFinished(object context)
        {
            CompleteCompilation();
        }

        private static void CompleteCompilation()
        {
            lock (Gate)
            {
                var completedAt = UtcNow();
                foreach (var record in state.Generations.Where(entry => entry.Status == "running"))
                {
                    record.CompletedAtUtc = completedAt;
                    record.Status = record.ErrorCount > 0 ? "failed" : "success";
                }

                TrimAndSave();
            }
        }

        private static void RecoverAfterReload()
        {
            if (!EditorApplication.isCompiling)
            {
                CompleteCompilation();
            }
        }

        private static void AddDiagnostic(GenerationRecord record, string assembly, CompilerMessageType type, string file, int line, int column, string message)
        {
            if (type != CompilerMessageType.Warning)
            {
                record.ErrorCount++;
            }
            record.Diagnostics.Add(new DiagnosticRecord
            {
                Sequence = state.NextDiagnosticSequence++,
                Generation = record.Generation,
                TimestampUtc = UtcNow(),
                Assembly = assembly ?? string.Empty,
                Severity = type == CompilerMessageType.Warning ? "warning" : "error",
                Code = ReadCode(message),
                Message = message ?? string.Empty,
                File = NormalizePath(file ?? string.Empty),
                Line = line,
                Column = column
            });
        }

        private static bool MatchesSeverity(DiagnosticRecord entry, string severity)
        {
            return severity == "all" || string.Equals(entry.Severity, severity, StringComparison.OrdinalIgnoreCase);
        }

        private static JObject ToDiagnosticJson(DiagnosticRecord entry)
        {
            return new JObject
            {
                ["sequence"] = entry.Sequence,
                ["generation"] = entry.Generation,
                ["timestampUtc"] = entry.TimestampUtc,
                ["assembly"] = entry.Assembly,
                ["severity"] = entry.Severity,
                ["code"] = entry.Code,
                ["message"] = entry.Message,
                ["file"] = entry.File,
                ["line"] = entry.Line,
                ["column"] = entry.Column
            };
        }

        private static string FailureState(string code, string message, int generation, string status, GenerationRecord record = null)
        {
            return new JObject
            {
                ["ok"] = false,
                ["status"] = status,
                ["generation"] = generation,
                ["observed"] = record != null && !string.IsNullOrEmpty(record.ObservedAtUtc),
                ["diagnostics"] = record == null ? new JArray() : new JArray(record.Diagnostics.Select(ToDiagnosticJson)),
                ["error"] = new JObject { ["code"] = code, ["message"] = message }
            }.ToString(Formatting.None);
        }

        private static JToken NullOrString(string value)
        {
            return string.IsNullOrEmpty(value) ? JValue.CreateNull() : new JValue(value);
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
            return assetsIndex >= 0 ? normalized.Substring(assetsIndex + 1) : normalized;
        }

        private static string UtcNow()
        {
            return DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }

        private static CompileState Load()
        {
            try
            {
                if (File.Exists(StatePath))
                {
                    return JsonConvert.DeserializeObject<CompileState>(File.ReadAllText(StatePath)) ?? new CompileState();
                }
            }
            catch (Exception)
            {
                // A corrupt cache must not prevent Unity from loading. A later save replaces it.
            }

            return new CompileState();
        }

        private static void TrimAndSave()
        {
            if (state.Generations.Count > MaxGenerations)
            {
                state.Generations.RemoveRange(0, state.Generations.Count - MaxGenerations);
            }

            var totalDiagnostics = state.Generations.Sum(entry => entry.Diagnostics.Count);
            while (totalDiagnostics > MaxDiagnostics)
            {
                var oldest = state.Generations.FirstOrDefault(entry => entry.Diagnostics.Count > 0);
                if (oldest == null)
                {
                    break;
                }

                oldest.Diagnostics.RemoveAt(0);
                oldest.DiagnosticsTruncated = true;
                totalDiagnostics--;
            }

            Save();
        }

        private static void Save()
        {
            var directory = Path.GetDirectoryName(StatePath);
            Directory.CreateDirectory(directory);
            var temporaryPath = StatePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporaryPath, JsonConvert.SerializeObject(state, Formatting.Indented));
            if (File.Exists(StatePath))
            {
                try
                {
                    File.Replace(temporaryPath, StatePath, null);
                }
                catch (IOException)
                {
                    File.Delete(StatePath);
                    File.Move(temporaryPath, StatePath);
                }
            }
            else
            {
                File.Move(temporaryPath, StatePath);
            }
        }

        [Serializable]
        private sealed class CompileState
        {
            public int NextGeneration = 1;
            public int NextDiagnosticSequence = 1;
            public List<GenerationRecord> Generations = new List<GenerationRecord>();
        }

        [Serializable]
        private sealed class GenerationRecord
        {
            public int Generation;
            public string SourcePath = string.Empty;
            public string Status = "waiting";
            public string RequestedAtUtc = string.Empty;
            public string ObservedAtUtc = string.Empty;
            public string CompletedAtUtc = string.Empty;
            public int ErrorCount;
            public bool DiagnosticsTruncated;
            public List<DiagnosticRecord> Diagnostics = new List<DiagnosticRecord>();
        }

        [Serializable]
        private sealed class DiagnosticRecord
        {
            public int Sequence;
            public int Generation;
            public string TimestampUtc = string.Empty;
            public string Assembly = string.Empty;
            public string Severity = string.Empty;
            public string Code = string.Empty;
            public string Message = string.Empty;
            public string File = string.Empty;
            public int Line;
            public int Column;
        }
    }
}
