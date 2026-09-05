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

        internal static IDisposable BeginBackupRetentionLease()
        {
            Interlocked.Increment(ref activeBackupRetentionLeases);
            return new BackupRetentionLease();
        }

        public static ScriptSnapshot Read(string fullPath)
        {
            var bytes = File.Exists(fullPath) ? File.ReadAllBytes(fullPath) : Array.Empty<byte>();
            var encoding = DetectEncoding(bytes);
            var content = encoding.Encoding.GetString(bytes, encoding.PreambleLength, bytes.Length - encoding.PreambleLength);
            return new ScriptSnapshot
            {
                Exists = File.Exists(fullPath),
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

            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            var temporaryPath = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            WriteFlushed(temporaryPath, afterBytes);
            try
            {
                if (before.Exists)
                {
                    var siblingBackup = fullPath + "." + Guid.NewGuid().ToString("N") + ".ghost-backup";
                    File.Replace(temporaryPath, fullPath, siblingBackup);
                    receipt.BackupPath = RetainBackup(siblingBackup, assetPath);
                }
                else
                {
                    File.Move(temporaryPath, fullPath);
                }
            }
            catch (PlatformNotSupportedException)
            {
                receipt.AtomicReplace = false;
                if (before.Exists)
                {
                    receipt.BackupPath = RetainBackupBytes(before.Bytes, assetPath);
                    File.Delete(fullPath);
                }

                File.Move(temporaryPath, fullPath);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }

            receipt.AfterSha256 = Hash(File.ReadAllBytes(fullPath));
            TrimBackups();
            return receipt;
        }

        public static ScriptMutationReceipt Delete(string fullPath, string assetPath, string expectedSha256, bool dryRun)
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

            receipt.BackupPath = NewBackupPath(assetPath, ".cs");
            Directory.CreateDirectory(Path.GetDirectoryName(receipt.BackupPath));
            File.Move(fullPath, receipt.BackupPath);
            var metaPath = fullPath + ".meta";
            if (File.Exists(metaPath))
            {
                receipt.BackupMetaPath = receipt.BackupPath + ".meta";
                File.Move(metaPath, receipt.BackupMetaPath);
            }

            TrimBackups();
            return receipt;
        }

        public static ScriptMutationReceipt Restore(string fullPath, string assetPath, string backupPath, string backupMetaPath, string expectedCurrentSha256)
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

            var restoredBytes = File.ReadAllBytes(backupPath);
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
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            var temporaryPath = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            WriteFlushed(temporaryPath, restoredBytes);
            try
            {
                if (current.Exists)
                {
                    var siblingBackup = fullPath + "." + Guid.NewGuid().ToString("N") + ".ghost-backup";
                    File.Replace(temporaryPath, fullPath, siblingBackup);
                    receipt.BackupPath = RetainBackup(siblingBackup, assetPath);
                }
                else
                {
                    File.Move(temporaryPath, fullPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }

            if (!string.IsNullOrWhiteSpace(backupMetaPath))
            {
                File.Copy(backupMetaPath, fullPath + ".meta", true);
            }

            return receipt;
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
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        private static string RetainBackup(string siblingBackup, string assetPath)
        {
            var destination = NewBackupPath(assetPath, ".cs");
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.Move(siblingBackup, destination);
            return destination;
        }

        private static string RetainBackupBytes(byte[] bytes, string assetPath)
        {
            var destination = NewBackupPath(assetPath, ".cs");
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            WriteFlushed(destination, bytes);
            return destination;
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

            var files = new DirectoryInfo(backupRoot).GetFiles().OrderByDescending(file => file.LastWriteTimeUtc).ToList();
            foreach (var file in files.Skip(MaxBackups))
            {
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
                    TrimBackups();
                }
            }
        }

        private static bool IsBackupPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            var root = Path.GetFullPath(BackupRoot()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var candidate = Path.GetFullPath(path);
            return candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }

        private static string BackupRoot()
        {
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

        public static ScriptMutationReceipt Failure(string code, string message, string path, string currentSha256)
        {
            return new ScriptMutationReceipt
            {
                Ok = false,
                Path = path,
                BeforeSha256 = currentSha256,
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
