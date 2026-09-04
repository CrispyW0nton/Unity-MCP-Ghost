using System;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class ScriptFileTransactionTests
    {
        private string directory;
        private string path;

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Directory.GetCurrentDirectory(), "Library", "UnityMcpGhost", "transaction-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "CourseScript.cs");
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void Write_PreservesBomAndNewlinesAndCreatesRecoveryBackup()
        {
            var encoding = new UTF8Encoding(true);
            File.WriteAllBytes(path, encoding.GetPreamble().Concat(encoding.GetBytes("line1\r\nline2\r\n")).ToArray());
            var before = ScriptFileTransaction.Read(path);

            var receipt = ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "line1\nchanged\n", before.Sha256, false);
            var bytes = File.ReadAllBytes(path);

            Assert.That(receipt.Ok, Is.True);
            Assert.That(receipt.AtomicReplace, Is.True);
            Assert.That(receipt.Newline, Is.EqualTo("crlf"));
            Assert.That(bytes.Take(3), Is.EqualTo(new byte[] { 0xef, 0xbb, 0xbf }));
            Assert.That(encoding.GetString(bytes).TrimStart('\ufeff'), Is.EqualTo("line1\r\nchanged\r\n"));
            Assert.That(File.Exists(receipt.BackupPath), Is.True);
            Assert.That(receipt.BeforeSha256, Is.EqualTo(before.Sha256));
            Assert.That(receipt.AfterSha256, Is.EqualTo(ScriptFileTransaction.Read(path).Sha256));
        }

        [Test]
        public void Write_RejectsStaleExpectedHashWithoutChangingBytes()
        {
            File.WriteAllText(path, "original", new UTF8Encoding(false));
            var original = File.ReadAllBytes(path);

            var receipt = ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "replacement", "stale-hash", false);

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error["code"].Value<string>(), Is.EqualTo("SCRIPT_HASH_MISMATCH"));
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
        }

        [Test]
        public void DryRun_ReturnsUnifiedDiffWithoutMutation()
        {
            File.WriteAllText(path, "before\n", new UTF8Encoding(false));
            var original = File.ReadAllBytes(path);

            var receipt = ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after\n", string.Empty, true);

            Assert.That(receipt.DryRun, Is.True);
            Assert.That(receipt.Diff, Does.Contain("--- a/Assets/CourseScript.cs"));
            Assert.That(receipt.Diff, Does.Contain("+++ b/Assets/CourseScript.cs"));
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
        }

        [Test]
        public void DeletedUtf16Script_RestoresByteIdentically()
        {
            var encoding = new UnicodeEncoding(false, true);
            var original = encoding.GetPreamble().Concat(encoding.GetBytes("score = 1;\r\n")).ToArray();
            File.WriteAllBytes(path, original);

            var deleted = ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", ScriptFileTransaction.Read(path).Sha256, false);
            var restored = ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", deleted.BackupPath, deleted.BackupMetaPath, string.Empty);

            Assert.That(deleted.Ok, Is.True);
            Assert.That(restored.Ok, Is.True);
            Assert.That(restored.Restored, Is.True);
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
        }

        [Test]
        public void Restore_RejectsInvalidMetadataBackupBeforeChangingSource()
        {
            File.WriteAllText(path, "original", new UTF8Encoding(false));
            var write = ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "current", string.Empty, false);
            var current = File.ReadAllBytes(path);

            var restored = ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", write.BackupPath, Path.Combine(directory, "outside.meta"), write.AfterSha256);

            Assert.That(restored.Ok, Is.False);
            Assert.That(restored.Error["code"].Value<string>(), Is.EqualTo("SCRIPT_BACKUP_META_NOT_FOUND"));
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(current));
        }

        [Test]
        public void DeleteDryRun_TruncatesOversizedDiff()
        {
            File.WriteAllText(path, new string('x', 70 * 1024), new UTF8Encoding(false));

            var receipt = ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", string.Empty, true);

            Assert.That(receipt.Ok, Is.True);
            Assert.That(receipt.DiffTruncated, Is.True);
            Assert.That(receipt.Diff.Length, Is.EqualTo(64 * 1024));
            Assert.That(File.Exists(path), Is.True);
        }
    }
}
