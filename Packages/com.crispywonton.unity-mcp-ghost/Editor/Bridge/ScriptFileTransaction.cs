using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class ScriptFileTransaction
    {
        private const int MaxBackups = 50;
        private const int MaxDiffCharacters = 64 * 1024;
        private static int activeBackupRetentionLeases;
        internal static Action<string, string> BeforeIoForTests;
        internal static string BackupRootForTests;

        internal static IDisposable BeginBackupRetentionLease()
        {
            Interlocked.Increment(ref activeBackupRetentionLeases);
            return new BackupRetentionLease();
        }

        public static ScriptSnapshot Read(string fullPath)
        {
            var file = ReadFile(fullPath);
            var bytes = file.Bytes;
            var encoding = DetectEncoding(bytes);
            var content = encoding.Encoding.GetString(bytes, encoding.PreambleLength, bytes.Length - encoding.PreambleLength);
            return new ScriptSnapshot
            {
                Exists = file.Exists,
                Bytes = bytes,
                Content = content,
                Sha256 = Hash(bytes),
                EncodingName = encoding.Name,
                Newline = DetectNewline(content),
                Encoding = encoding.Encoding,
                EmitPreamble = encoding.PreambleLength > 0
            };
        }

        public static ScriptMutationReceipt Write(string fullPath, string assetPath, string content, string expectedSha256, bool dryRun)
        {
            return Guard(fullPath, assetPath, () => WriteCore(fullPath, assetPath, content, expectedSha256, dryRun));
        }

        private static ScriptMutationReceipt WriteCore(string fullPath, string assetPath, string content, string expectedSha256, bool dryRun)
        {
            var before = Read(fullPath);
            var conflict = ConcurrencyConflict(before, expectedSha256, assetPath);
            if (conflict != null)
            {
                return conflict;
            }

            var newline = before.Exists ? before.Newline : DetectNewline(content);
            var normalizedContent = NormalizeNewlines(content ?? string.Empty, newline);
            var encoding = before.Exists ? before.Encoding : new UTF8Encoding(false);
            var emitPreamble = before.Exists && before.EmitPreamble;
            var afterBytes = Encode(normalizedContent, encoding, emitPreamble);
            var receipt = new ScriptMutationReceipt
            {
                Ok = true,
                DryRun = dryRun,
                Path = assetPath,
                BeforeSha256 = before.Sha256,
                AfterSha256 = Hash(afterBytes),
                BeforeBytes = before.Bytes.Length,
                AfterBytes = afterBytes.Length,
                Encoding = before.Exists ? before.EncodingName : "utf-8",
                Newline = NewlineName(newline),
                Created = !before.Exists
            };
            SetBoundedDiff(receipt, UnifiedDiff(assetPath, before.Content, normalizedContent));
            if (dryRun)
            {
                return receipt;
            }

            return Execute(fullPath, receipt, before, new FileBytes(true, afterBytes), null);
        }

        public static ScriptMutationReceipt Delete(string fullPath, string assetPath, string expectedSha256, bool dryRun)
        {
            return Guard(fullPath, assetPath, () => DeleteCore(fullPath, assetPath, expectedSha256, dryRun));
        }

        private static ScriptMutationReceipt DeleteCore(string fullPath, string assetPath, string expectedSha256, bool dryRun)
        {
            var before = Read(fullPath);
            if (!before.Exists)
            {
                return ScriptMutationReceipt.Failure("SCRIPT_NOT_FOUND", "Script does not exist: " + assetPath, assetPath, before.Sha256);
            }

            var conflict = ConcurrencyConflict(before, expectedSha256, assetPath);
            if (conflict != null)
            {
                return conflict;
            }

            var receipt = new ScriptMutationReceipt
            {
                Ok = true,
                DryRun = dryRun,
                Path = assetPath,
                BeforeSha256 = before.Sha256,
                AfterSha256 = string.Empty,
                BeforeBytes = before.Bytes.Length,
                AfterBytes = 0,
                Encoding = before.EncodingName,
                Newline = NewlineName(before.Newline),
                Deleted = true
            };
            SetBoundedDiff(receipt, UnifiedDiff(assetPath, before.Content, string.Empty));
            if (dryRun)
            {
                return receipt;
            }

            return Execute(fullPath, receipt, before, new FileBytes(false, Array.Empty<byte>()), new FileBytes(false, Array.Empty<byte>()));
        }

        public static ScriptMutationReceipt Restore(string fullPath, string assetPath, string backupPath, string backupMetaPath, string expectedCurrentSha256)
        {
            return Guard(fullPath, assetPath, () => RestoreCore(fullPath, assetPath, backupPath, backupMetaPath, expectedCurrentSha256));
        }

        private static ScriptMutationReceipt RestoreCore(string fullPath, string assetPath, string backupPath, string backupMetaPath, string expectedCurrentSha256)
        {
            if (string.IsNullOrWhiteSpace(backupPath) || !IsBackupPath(backupPath) || !File.Exists(backupPath))
            {
                return ScriptMutationReceipt.Failure("SCRIPT_BACKUP_NOT_FOUND", "Script backup does not exist.", assetPath, File.Exists(fullPath) ? Hash(File.ReadAllBytes(fullPath)) : string.Empty);
            }

            if (!string.IsNullOrWhiteSpace(backupMetaPath) && (!IsBackupPath(backupMetaPath) || !File.Exists(backupMetaPath)))
            {
                return ScriptMutationReceipt.Failure("SCRIPT_BACKUP_META_NOT_FOUND", "Script metadata backup does not exist.", assetPath, File.Exists(fullPath) ? Hash(File.ReadAllBytes(fullPath)) : string.Empty);
            }

            var current = Read(fullPath);
            var conflict = ConcurrencyConflict(current, expectedCurrentSha256, assetPath);
            if (conflict != null)
            {
                return conflict;
            }

            var restoredBytes = ReadRequiredFile(backupPath).Bytes;
            var detection = DetectEncoding(restoredBytes);
            var restoredContent = detection.Encoding.GetString(restoredBytes, detection.PreambleLength, restoredBytes.Length - detection.PreambleLength);
            var receipt = new ScriptMutationReceipt
            {
                Ok = true,
                Path = assetPath,
                BeforeSha256 = current.Sha256,
                AfterSha256 = Hash(restoredBytes),
                RestoredSha256 = Hash(restoredBytes),
                BeforeBytes = current.Bytes.Length,
                AfterBytes = restoredBytes.Length,
                Encoding = detection.Name,
                Newline = NewlineName(DetectNewline(restoredContent)),
                Restored = true,
                Created = !current.Exists
            };
            SetBoundedDiff(receipt, UnifiedDiff(assetPath, current.Content, restoredContent));
            var restoreMetadata = !string.IsNullOrWhiteSpace(backupMetaPath);
            var metadata = restoreMetadata ? ReadRequiredFile(backupMetaPath) : null;
            return Execute(fullPath, receipt, current, new FileBytes(true, restoredBytes), metadata);
        }

        public static bool DiscardBackup(string backupPath)
        {
            if (string.IsNullOrWhiteSpace(backupPath))
            {
                return false;
            }

            if (!IsBackupPath(backupPath))
            {
                throw new InvalidOperationException("Backup path is outside Library/UnityMcpGhost/backups.");
            }

            if (!File.Exists(backupPath))
            {
                return false;
            }

            File.Delete(backupPath);
            return true;
        }

        public static string ToJson(ScriptMutationReceipt receipt)
        {
            var json = JObject.FromObject(receipt, JsonSerializer.CreateDefault());
            return json.ToString(Formatting.None);
        }

        private static ScriptMutationReceipt ConcurrencyConflict(ScriptSnapshot before, string expectedSha256, string assetPath)
        {
            if (string.IsNullOrWhiteSpace(expectedSha256) || string.Equals(expectedSha256, before.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            return ScriptMutationReceipt.Failure(
                "SCRIPT_HASH_MISMATCH",
                "Script changed since the caller read it.",
                assetPath,
                before.Sha256);
        }

        private static byte[] Encode(string content, Encoding encoding, bool emitPreamble)
        {
            var body = encoding.GetBytes(content);
            var preamble = emitPreamble ? encoding.GetPreamble() : Array.Empty<byte>();
            if (preamble.Length == 0)
            {
                return body;
            }

            var bytes = new byte[preamble.Length + body.Length];
            Buffer.BlockCopy(preamble, 0, bytes, 0, preamble.Length);
            Buffer.BlockCopy(body, 0, bytes, preamble.Length, body.Length);
            return bytes;
        }

        private static void WriteFlushed(string path, byte[] bytes)
        {
            ProjectPathPolicy.RequireUnderProjectRoot(path);
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        private static ScriptMutationReceipt Guard(string fullPath, string assetPath, Func<ScriptMutationReceipt> action)
        {
            try { return action(); }
            catch (Exception failure)
            {
                // Execute handles every failure once mutation is possible. This path
                // covers preparation/read failures, which have not changed any file.
                var current = Observe(fullPath);
                var receipt = ScriptMutationReceipt.Failure(FailureCode(failure), failure.Message, assetPath, current?.Sha256);
                receipt.AfterSha256 = current?.Sha256;
                receipt.RestoredSha256 = current?.Sha256;
                receipt.Error["restorationStatus"] = current == null ? "unknown" : "complete";
                return receipt;
            }
        }

        private static ScriptMutationReceipt Execute(string fullPath, ScriptMutationReceipt receipt, ScriptSnapshot before,
            FileBytes targetSource, FileBytes targetMetadata)
        {
            var entries = new List<TransactionFile>();
            var ownedFiles = new List<string>();
            var retainedFiles = new HashSet<string>();
            var recoveryDirectory = string.Empty;
            var preserveRecovery = false;
            try
            {
                ProjectPathPolicy.RequireUnderProjectRoot(fullPath);
                ProjectPathPolicy.RequireUnderProjectRoot(fullPath + ".meta");
                var source = new FileBytes(before.Exists, before.Bytes);
                var metadata = ReadFile(fullPath + ".meta");
                entries.Add(new TransactionFile(fullPath, source, targetSource));
                entries.Add(new TransactionFile(fullPath + ".meta", metadata, targetMetadata ?? metadata));
                foreach (var entry in entries) RequireMatch(entry.Path, entry.Before);

                recoveryDirectory = Path.Combine(BackupRoot(), "recovery-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(recoveryDirectory);
                ProjectPathPolicy.RequireUnderProjectRoot(recoveryDirectory);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                for (var index = 0; index < entries.Count; index++)
                {
                    var entry = entries[index];
                    entry.RecoveryPath = Path.Combine(recoveryDirectory, index == 0 ? "source.cs" : "source.cs.meta");
                    entry.DisplacedPath = Path.Combine(recoveryDirectory, index == 0 ? "displaced.cs" : "displaced.cs.meta");
                    ownedFiles.Add(entry.DisplacedPath);
                    if (entry.Before.Exists)
                    {
                        ownedFiles.Add(entry.RecoveryPath);
                        BeforeIoForTests?.Invoke("prepare-recovery", entry.RecoveryPath);
                        WriteFlushed(entry.RecoveryPath, entry.Before.Bytes);
                        RequireMatch(entry.RecoveryPath, entry.Before);
                    }
                    if (entry.Changes && entry.Target.Exists)
                    {
                        entry.TemporaryPath = TemporaryPath(entry.Path);
                        ownedFiles.Add(entry.TemporaryPath);
                        BeforeIoForTests?.Invoke("prepare-target", entry.TemporaryPath);
                        WriteFlushed(entry.TemporaryPath, entry.Target.Bytes);
                    }
                }

                // Both recovery copies and all replacement bytes are durable before
                // the first mutation. A pair is committed only after verification.
                foreach (var entry in entries)
                {
                    RequireMatch(entry.Path, entry.Before);
                    if (!entry.Changes) continue;
                    BeforeIoForTests?.Invoke(entry.Target.Exists ? (entry.Before.Exists ? "replace" : "create") : "delete", entry.Path);
                    RequireMatch(entry.Path, entry.Before);
                    entry.Attempted = true;
                    ProjectPathPolicy.RequireUnderProjectRoot(entry.DisplacedPath);
                    BeforeIoForTests?.Invoke("mutate", entry.Path);
                    if (!entry.Target.Exists) File.Move(entry.Path, entry.DisplacedPath);
                    else if (entry.Before.Exists) File.Replace(entry.TemporaryPath, entry.Path, entry.DisplacedPath);
                    else File.Move(entry.TemporaryPath, entry.Path);
                    entry.Mutated = true;
                    if (entry.Before.Exists)
                    {
                        var displaced = ReadRequiredFile(entry.DisplacedPath);
                        entry.Rollback = displaced;
                        entry.DisplacedVerified = true;
                        if (!displaced.Matches(entry.Before))
                        {
                            // An edit raced the precondition check. Preserve the
                            // actual displaced bytes and restore those, not stale data.
                            throw new ConcurrentFileChangeException(entry.Path);
                        }
                    }
                    BeforeIoForTests?.Invoke("after-mutation", entry.Path);
                }
                foreach (var entry in entries) RequireMatch(entry.Path, entry.Target);

                var backupPath = NewBackupPath(receipt.Path, ".cs");
                for (var index = 0; index < entries.Count; index++)
                {
                    var entry = entries[index];
                    // Metadata is protected during every transaction, but a later
                    // source-only rollback must preserve intervening metadata edits.
                    if (!entry.Before.Exists || (index == 1 && !entry.Changes)) continue;
                    var destination = index == 0 ? backupPath : backupPath + ".meta";
                    ownedFiles.Add(destination);
                    BeforeIoForTests?.Invoke("retain-backup", destination);
                    ProjectPathPolicy.RequireUnderProjectRoot(destination);
                    // Keep the protected recovery copy until every retention step
                    // has succeeded; a partial publication is still compensatable.
                    WriteFlushed(destination, entry.Before.Bytes);
                    RequireMatch(destination, entry.Before);
                    retainedFiles.Add(destination);
                    if (index == 0) receipt.BackupPath = destination;
                    else receipt.BackupMetaPath = destination;
                }
                foreach (var entry in entries) RequireMatch(entry.Path, entry.Target);
                receipt.AfterSha256 = targetSource.Exists ? targetSource.Sha256 : string.Empty;
                if (receipt.Restored) receipt.RestoredSha256 = receipt.AfterSha256;
            }
            catch (Exception failure)
            {
                var recoveryErrors = new JArray();
                foreach (var entry in entries.AsEnumerable().Reverse())
                {
                    try { Compensate(entry, ownedFiles); }
                    catch (Exception recoveryFailure) { recoveryErrors.Add(new JObject { ["path"] = entry.Path, ["message"] = recoveryFailure.Message }); }
                }
                var actualSource = Observe(fullPath);
                var actualMetadata = Observe(fullPath + ".meta");
                var unverifiedDisplacement = entries.Any(entry => entry.HasUnverifiedDisplacement);
                var complete = !unverifiedDisplacement && recoveryErrors.Count == 0 && entries.Count == 2 && actualSource != null && actualMetadata != null
                    && actualSource.Matches(entries[0].Before) && actualMetadata.Matches(entries[1].Before);
                var status = unverifiedDisplacement || actualSource == null || actualMetadata == null ? "unknown" : complete ? "complete" : "incomplete";
                preserveRecovery = !complete && !string.IsNullOrEmpty(recoveryDirectory);
                retainedFiles.Clear();
                receipt.Ok = false;
                receipt.Created = receipt.Deleted = receipt.Restored = false;
                receipt.AtomicReplace = !(failure is PlatformNotSupportedException);
                receipt.AfterSha256 = actualSource?.Sha256;
                receipt.AfterBytes = actualSource == null ? -1 : actualSource.Bytes.Length;
                receipt.RestoredSha256 = complete ? before.Sha256 : null;
                receipt.BackupPath = preserveRecovery && entries.Count > 0 ? VerifiedRecoveryPath(entries[0]) : string.Empty;
                receipt.BackupMetaPath = preserveRecovery && entries.Count > 1 ? VerifiedRecoveryPath(entries[1]) : string.Empty;
                receipt.Error = new JObject
                {
                    ["code"] = FailureCode(failure),
                    ["message"] = failure.Message + " Restoration: " + status + (preserveRecovery ? ". Recovery files: " + recoveryDirectory : string.Empty),
                    ["restorationStatus"] = status,
                    ["currentSha256"] = actualSource?.Sha256,
                    ["sourceExists"] = actualSource == null ? JValue.CreateNull() : new JValue(actualSource.Exists),
                    ["metadataExists"] = actualMetadata == null ? JValue.CreateNull() : new JValue(actualMetadata.Exists),
                    ["metadataSha256"] = actualMetadata?.Sha256,
                    ["recoveryDirectory"] = preserveRecovery ? recoveryDirectory : string.Empty,
                    ["recoveryErrors"] = recoveryErrors
                };
                if (preserveRecovery)
                {
                    // TrimBackups only visits ordinary files in the backup root.
                    // Incomplete recovery lives in its own directory until handled.
                    var recoveryFiles = new JArray();
                    var recoveryFileStates = new JArray();
                    foreach (var file in ownedFiles.Where(file => Path.GetDirectoryName(file) == recoveryDirectory))
                    {
                        retainedFiles.Add(file);
                        var observed = Observe(file);
                        if (observed != null && !observed.Exists) continue;
                        recoveryFiles.Add(file);
                        recoveryFileStates.Add(new JObject { ["path"] = file, ["sha256"] = observed?.Sha256, ["status"] = observed == null ? "unknown" : "present" });
                    }
                    receipt.Error["recoveryFiles"] = recoveryFiles;
                    receipt.Error["recoveryFileStates"] = recoveryFileStates;
                }
            }
            finally
            {
                foreach (var file in ownedFiles.Where(file => !retainedFiles.Contains(file)))
                {
                    try
                    {
                        ProjectPathPolicy.RequireUnderProjectRoot(file);
                        BeforeIoForTests?.Invoke("cleanup", file);
                        File.Delete(file);
                    }
                    catch (Exception cleanupFailure) { AddCleanupWarning(receipt, file, cleanupFailure); }
                }
                if (!preserveRecovery && !string.IsNullOrEmpty(recoveryDirectory))
                {
                    try { Directory.Delete(ProjectPathPolicy.RequireUnderProjectRoot(recoveryDirectory), false); }
                    catch (Exception cleanupFailure) { AddCleanupWarning(receipt, recoveryDirectory, cleanupFailure); }
                }
            }
            if (receipt.Ok)
            {
                try { TrimBackups(); }
                catch (Exception cleanupFailure) { AddCleanupWarning(receipt, BackupRootUnchecked(), cleanupFailure); }
            }
            return receipt;
        }

        private static void Compensate(TransactionFile entry, List<string> ownedFiles)
        {
            if (!entry.Attempted) return;
            BeforeIoForTests?.Invoke("before-compensate", entry.Path);
            // The live baseline alone cannot prove what a successful mutation
            // displaced. Keep unreadable originals for explicit recovery instead
            // of installing the earlier snapshot as if it were authoritative.
            if (entry.Mutated && entry.Before.Exists && !entry.DisplacedVerified)
                throw new IOException("Displaced contents could not be verified; recovery retained at: " + entry.DisplacedPath);
            var current = ReadFile(entry.Path);
            if (current.Matches(entry.Rollback)) return;
            if (!current.Matches(entry.Target)) throw new ConcurrentFileChangeException(entry.Path);
            var displacedPath = Path.Combine(Path.GetDirectoryName(entry.RecoveryPath), "compensation-" + Guid.NewGuid().ToString("N"));
            ownedFiles.Add(displacedPath);
            ProjectPathPolicy.RequireUnderProjectRoot(displacedPath);
            if (!entry.Rollback.Exists)
            {
                // A newly created file is removed by a rename so a racing edit is
                // recoverable too; never delete a live destination as a fallback.
                BeforeIoForTests?.Invoke("compensate-delete", entry.Path);
                RequireMatch(entry.Path, entry.Target);
                BeforeIoForTests?.Invoke("compensate-mutate", entry.Path);
                File.Move(entry.Path, displacedPath);
            }
            else
            {
                var temporaryPath = TemporaryPath(entry.Path);
                ownedFiles.Add(temporaryPath);
                WriteFlushed(temporaryPath, entry.Rollback.Bytes);
                BeforeIoForTests?.Invoke("compensate-replace", entry.Path);
                RequireMatch(entry.Path, entry.Target);
                BeforeIoForTests?.Invoke("compensate-mutate", entry.Path);
                if (current.Exists) File.Replace(temporaryPath, entry.Path, displacedPath);
                else File.Move(temporaryPath, entry.Path);
            }
            if (current.Exists)
            {
                entry.CompensationDisplacementUnverified = true;
                var displaced = ReadRequiredFile(displacedPath);
                entry.CompensationDisplacementUnverified = false;
                if (!displaced.Matches(current)) throw new ConcurrentFileChangeException(entry.Path);
            }
            RequireMatch(entry.Path, entry.Rollback);
        }

        private static string TemporaryPath(string path) => path + "." + Guid.NewGuid().ToString("N") + ".tmp";

        private static string VerifiedRecoveryPath(TransactionFile entry)
        {
            if (entry.DisplacedVerified)
            {
                var displaced = Observe(entry.DisplacedPath);
                if (displaced != null && displaced.Exists && displaced.Matches(entry.Rollback)) return entry.DisplacedPath;
            }
            var recovery = string.IsNullOrEmpty(entry.RecoveryPath) ? null : Observe(entry.RecoveryPath);
            return recovery != null && recovery.Exists && recovery.Matches(entry.Before) ? entry.RecoveryPath : string.Empty;
        }

        private static void AddCleanupWarning(ScriptMutationReceipt receipt, string path, Exception failure)
        {
            if (receipt.CleanupWarnings == null) receipt.CleanupWarnings = new JArray();
            receipt.CleanupWarnings.Add(new JObject { ["path"] = path, ["message"] = failure.Message });
        }

        private static string FailureCode(Exception failure)
        {
            if (failure is PlatformNotSupportedException) return "SCRIPT_ATOMIC_REPLACE_UNSUPPORTED";
            if (failure is ConcurrentFileChangeException) return "SCRIPT_CONCURRENT_CHANGE";
            if (failure is ProjectPathException) return "SCRIPT_PATH_UNSAFE";
            return "SCRIPT_IO_FAILED";
        }

        private static FileBytes Observe(string path)
        {
            try { return ReadFile(path); }
            catch { return null; }
        }

        private static FileBytes ReadFile(string path)
        {
            try
            {
                ProjectPathPolicy.RequireUnderProjectRoot(path);
                return new FileBytes(true, File.ReadAllBytes(path));
            }
            catch (FileNotFoundException) { return new FileBytes(false, Array.Empty<byte>()); }
            catch (DirectoryNotFoundException) { return new FileBytes(false, Array.Empty<byte>()); }
        }

        private static FileBytes ReadRequiredFile(string path)
        {
            var file = ReadFile(path);
            if (!file.Exists) throw new FileNotFoundException("Recovery file disappeared before restoration.", path);
            return file;
        }

        private static void RequireMatch(string path, FileBytes expected)
        {
            if (!ReadFile(path).Matches(expected)) throw new ConcurrentFileChangeException(path);
        }

        private sealed class ConcurrentFileChangeException : IOException
        {
            public ConcurrentFileChangeException(string path) : base("File changed during the transaction: " + path) { }
        }

        private sealed class FileBytes
        {
            public readonly bool Exists;
            public readonly byte[] Bytes;
            private string sha256;
            public string Sha256 => sha256 ?? (sha256 = Hash(Bytes));
            public FileBytes(bool exists, byte[] bytes) { Exists = exists; Bytes = bytes; }
            public bool Matches(FileBytes other) => Exists == other.Exists && Bytes.SequenceEqual(other.Bytes);
        }

        private sealed class TransactionFile
        {
            public readonly string Path;
            public readonly FileBytes Before;
            public readonly FileBytes Target;
            public FileBytes Rollback;
            public bool Attempted;
            public bool Mutated;
            public bool DisplacedVerified;
            public bool CompensationDisplacementUnverified;
            public string RecoveryPath;
            public string DisplacedPath;
            public string TemporaryPath;
            public bool Changes => !Before.Matches(Target);
            public bool HasUnverifiedDisplacement => (Mutated && Before.Exists && !DisplacedVerified) || CompensationDisplacementUnverified;
            public TransactionFile(string path, FileBytes before, FileBytes target)
            {
                Path = path; Before = before; Rollback = before; Target = target;
            }
        }

        private static string NewBackupPath(string assetPath, string extension)
        {
            var safeName = string.Join("_", assetPath.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries)).Replace('/', '_').Replace('\\', '_');
            return Path.Combine(BackupRoot(), DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture) + "-" + safeName + "-" + Guid.NewGuid().ToString("N") + extension);
        }

        private static void TrimBackups()
        {
            if (Volatile.Read(ref activeBackupRetentionLeases) > 0)
            {
                return;
            }

            var backupRoot = BackupRoot();
            if (!Directory.Exists(backupRoot))
            {
                return;
            }

            var backups = new DirectoryInfo(backupRoot).GetFiles()
                .GroupBy(file => file.Name.EndsWith(".meta", StringComparison.Ordinal) ? file.Name.Substring(0, file.Name.Length - 5) : file.Name)
                .OrderByDescending(group => group.Max(file => file.LastWriteTimeUtc));
            foreach (var file in backups.Skip(MaxBackups).SelectMany(group => group))
            {
                ProjectPathPolicy.RequireUnderProjectRoot(file.FullName);
                file.Delete();
            }
        }

        private sealed class BackupRetentionLease : IDisposable
        {
            private int disposed;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref disposed, 1) != 0)
                {
                    return;
                }

                if (Interlocked.Decrement(ref activeBackupRetentionLeases) == 0)
                {
                    // Retention is housekeeping, not a reason to mask the caller's
                    // transaction failure or replay an already completed mutation.
                    try { TrimBackups(); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    catch (ProjectPathException) { }
                }
            }
        }

        private static bool IsBackupPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            try
            {
                var root = BackupRoot().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                var candidate = ProjectPathPolicy.RequireUnderProjectRoot(path);
                var comparison = UnityEngine.Application.platform == UnityEngine.RuntimePlatform.WindowsEditor
                    || UnityEngine.Application.platform == UnityEngine.RuntimePlatform.OSXEditor
                    ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
                return candidate.StartsWith(root, comparison);
            }
            catch (ProjectPathException) { return false; }
            catch (ArgumentException) { return false; }
        }

        private static string BackupRoot()
        {
            return ProjectPathPolicy.RequireUnderProjectRoot(BackupRootUnchecked());
        }

        private static string BackupRootUnchecked()
        {
            if (BackupRootForTests != null) return BackupRootForTests;
            var projectRoot = Directory.GetParent(UnityEngine.Application.dataPath).FullName;
            return Path.Combine(projectRoot, "Library", "UnityMcpGhost", "backups");
        }

        private static string UnifiedDiff(string assetPath, string before, string after)
        {
            if (string.Equals(before, after, StringComparison.Ordinal))
            {
                return string.Empty;
            }

            var beforeLines = SplitLines(before);
            var afterLines = SplitLines(after);
            var builder = new StringBuilder();
            builder.Append("--- a/").Append(assetPath).Append('\n');
            builder.Append("+++ b/").Append(assetPath).Append('\n');
            builder.Append("@@ -1,").Append(beforeLines.Count).Append(" +1,").Append(afterLines.Count).Append(" @@\n");
            foreach (var line in beforeLines)
            {
                builder.Append('-').Append(line).Append('\n');
            }
            foreach (var line in afterLines)
            {
                builder.Append('+').Append(line).Append('\n');
            }
            return builder.ToString();
        }

        private static void SetBoundedDiff(ScriptMutationReceipt receipt, string diff)
        {
            receipt.DiffTruncated = diff.Length > MaxDiffCharacters;
            receipt.Diff = receipt.DiffTruncated ? diff.Substring(0, MaxDiffCharacters) : diff;
        }

        private static List<string> SplitLines(string value)
        {
            return RegexSplit(value ?? string.Empty).ToList();
        }

        private static string[] RegexSplit(string value)
        {
            return System.Text.RegularExpressions.Regex.Split(value, "\\r\\n|\\n|\\r");
        }

        private static string NormalizeNewlines(string value, string newline)
        {
            return string.Join(newline, RegexSplit(value));
        }

        private static string DetectNewline(string value)
        {
            if ((value ?? string.Empty).Contains("\r\n"))
            {
                return "\r\n";
            }
            if ((value ?? string.Empty).Contains("\n"))
            {
                return "\n";
            }
            if ((value ?? string.Empty).Contains("\r"))
            {
                return "\r";
            }
            return Environment.NewLine;
        }

        private static string NewlineName(string newline)
        {
            return newline == "\r\n" ? "crlf" : newline == "\r" ? "cr" : "lf";
        }

        private static EncodingDetection DetectEncoding(byte[] bytes)
        {
            if (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf)
            {
                return new EncodingDetection(new UTF8Encoding(true), 3, "utf-8-bom");
            }
            if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe)
            {
                return new EncodingDetection(new UnicodeEncoding(false, true), 2, "utf-16-le");
            }
            if (bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff)
            {
                return new EncodingDetection(new UnicodeEncoding(true, true), 2, "utf-16-be");
            }
            return new EncodingDetection(new UTF8Encoding(false, true), 0, "utf-8");
        }

        private static string Hash(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        private sealed class EncodingDetection
        {
            public EncodingDetection(Encoding encoding, int preambleLength, string name)
            {
                Encoding = encoding;
                PreambleLength = preambleLength;
                Name = name;
            }

            public Encoding Encoding { get; }
            public int PreambleLength { get; }
            public string Name { get; }
        }
    }

    internal sealed class ScriptSnapshot
    {
        public bool Exists;
        public byte[] Bytes = Array.Empty<byte>();
        public string Content = string.Empty;
        public string Sha256 = string.Empty;
        public string EncodingName = string.Empty;
        public string Newline = string.Empty;
        public Encoding Encoding = new UTF8Encoding(false);
        public bool EmitPreamble;
    }

    internal sealed class ScriptMutationReceipt
    {
        [JsonProperty("ok")]
        public bool Ok = true;
        [JsonProperty("error")]
        public JObject Error;
        [JsonProperty("dryRun")]
        public bool DryRun;
        [JsonProperty("path")]
        public string Path = string.Empty;
        [JsonProperty("beforeSha256")]
        public string BeforeSha256 = string.Empty;
        [JsonProperty("afterSha256")]
        public string AfterSha256 = string.Empty;
        [JsonProperty("restoredSha256")]
        public string RestoredSha256 = string.Empty;
        [JsonProperty("beforeBytes")]
        public int BeforeBytes;
        [JsonProperty("afterBytes")]
        public int AfterBytes;
        [JsonProperty("encoding")]
        public string Encoding = string.Empty;
        [JsonProperty("newline")]
        public string Newline = string.Empty;
        [JsonProperty("diff")]
        public string Diff = string.Empty;
        [JsonProperty("diffTruncated")]
        public bool DiffTruncated;
        [JsonProperty("backupPath")]
        public string BackupPath = string.Empty;
        [JsonProperty("backupMetaPath")]
        public string BackupMetaPath = string.Empty;
        [JsonProperty("created")]
        public bool Created;
        [JsonProperty("deleted")]
        public bool Deleted;
        [JsonProperty("restored")]
        public bool Restored;
        [JsonProperty("atomicReplace")]
        public bool AtomicReplace = true;
        [JsonProperty("requestedCompileGeneration")]
        public int RequestedCompileGeneration;
        [JsonProperty("cleanupWarnings", NullValueHandling = NullValueHandling.Ignore)]
        public JArray CleanupWarnings;

        public static ScriptMutationReceipt Failure(string code, string message, string path, string currentSha256)
        {
            return new ScriptMutationReceipt
            {
                Ok = false,
                Path = path,
                BeforeSha256 = currentSha256,
                AfterSha256 = currentSha256,
                Error = new JObject
                {
                    ["code"] = code,
                    ["message"] = message,
                    ["currentSha256"] = currentSha256
                }
            };
        }
    }
}
