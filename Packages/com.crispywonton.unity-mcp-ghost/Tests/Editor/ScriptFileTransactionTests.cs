using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class ScriptFileTransactionTests
    {
        private string directory;
        private string path;
        private readonly List<ScriptMutationReceipt> trackedReceipts = new List<ScriptMutationReceipt>();

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Directory.GetCurrentDirectory(), "Library", "UnityMcpGhost", "transaction-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "CourseScript.cs");
            ScriptFileTransaction.BackupRootForTests = Path.Combine(directory, "backups");
        }

        [TearDown]
        public void TearDown()
        {
            ScriptFileTransaction.BeforeIoForTests = null;
            foreach (var receipt in trackedReceipts)
            {
                ScriptFileTransaction.DiscardBackup(receipt.BackupPath);
                ScriptFileTransaction.DiscardBackup(receipt.BackupMetaPath);
                var recovery = receipt.Error?.Value<string>("recoveryDirectory");
                if (!string.IsNullOrEmpty(recovery) && Directory.Exists(recovery))
                {
                    var validated = ProjectPathPolicy.RequireUnderProjectRoot(recovery);
                    Assert.That(validated, Does.StartWith(directory + Path.DirectorySeparatorChar));
                    Assert.That(Path.GetFileName(validated), Does.StartWith("recovery-"));
                    Directory.Delete(validated, true);
                }
            }
            trackedReceipts.Clear();
            ScriptFileTransaction.BackupRootForTests = null;
            if (Directory.Exists(directory))
            {
                var validated = ProjectPathPolicy.RequireUnderProjectRoot(directory);
                Assert.That(Path.GetDirectoryName(validated), Is.EqualTo(Path.Combine(ProjectPathPolicy.ProjectRoot, "Library", "UnityMcpGhost", "transaction-tests")));
                Directory.Delete(validated, true);
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

        [TestCase(false)]
        [TestCase(true)]
        public void Write_SuccessPreservesExistingMetadataWithoutPublishingMetadataRollback(bool sourceExists)
        {
            if (sourceExists) File.WriteAllText(path, "before", new UTF8Encoding(false));
            var metadata = Encoding.UTF8.GetBytes("guid: existing\r\nimporter: custom\r\n");
            File.WriteAllBytes(path + ".meta", metadata);

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", string.Empty, false));

            Assert.That(receipt.Ok, Is.True);
            Assert.That(receipt.Created, Is.EqualTo(!sourceExists));
            Assert.That(File.ReadAllText(path), Is.EqualTo("after"));
            Assert.That(File.ReadAllBytes(path + ".meta"), Is.EqualTo(metadata));
            Assert.That(receipt.BackupMetaPath, Is.Empty, "Unchanged metadata is not a later rollback instruction.");
            if (sourceExists) Assert.That(File.ReadAllText(receipt.BackupPath), Is.EqualTo("before"));
            else Assert.That(receipt.BackupPath, Is.Empty);
            Assert.That(Directory.GetFiles(ScriptFileTransaction.BackupRootForTests, "*.meta"), Is.Empty);
        }

        [Test]
        public void Write_SourceRollbackPreservesMetadataEditedAfterTheWrite()
        {
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: before", new UTF8Encoding(false));
            var write = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", string.Empty, false));
            Assert.That(write.Ok, Is.True);
            File.WriteAllText(path + ".meta", "guid: external edit", new UTF8Encoding(false));

            var restored = Track(ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", write.BackupPath, write.BackupMetaPath, write.AfterSha256));

            Assert.That(restored.Ok, Is.True);
            Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
            Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: external edit"));
            Assert.That(restored.BackupMetaPath, Is.Empty);
        }

        [Test]
        public void DeleteAndRestore_SuccessMutatesTheRequestedPairAndRetainsTheReplacedPair()
        {
            var source = new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes("original\r\n")).ToArray();
            var metadata = Encoding.UTF8.GetBytes("guid: original\r\n");
            File.WriteAllBytes(path, source);
            File.WriteAllBytes(path + ".meta", metadata);

            var deleted = Track(ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", string.Empty, false));

            Assert.That(deleted.Ok, Is.True);
            Assert.That(deleted.Deleted, Is.True);
            Assert.That(File.Exists(path), Is.False);
            Assert.That(File.Exists(path + ".meta"), Is.False);
            Assert.That(File.ReadAllBytes(deleted.BackupPath), Is.EqualTo(source));
            Assert.That(File.ReadAllBytes(deleted.BackupMetaPath), Is.EqualTo(metadata));
            File.WriteAllText(path, "current source", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: current", new UTF8Encoding(false));

            var restored = Track(ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", deleted.BackupPath, deleted.BackupMetaPath, ScriptFileTransaction.Read(path).Sha256));

            Assert.That(restored.Ok, Is.True);
            Assert.That(restored.Restored, Is.True);
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(source));
            Assert.That(File.ReadAllBytes(path + ".meta"), Is.EqualTo(metadata));
            Assert.That(File.ReadAllText(restored.BackupPath), Is.EqualTo("current source"));
            Assert.That(File.ReadAllText(restored.BackupMetaPath), Is.EqualTo("guid: current"));
        }

        [TestCase(false, false)]
        [TestCase(false, true)]
        [TestCase(true, false)]
        [TestCase(true, true)]
        public void Mutation_UnreadableDisplacedEditIsRetainedEvenWhenLiveBaselineMatches(bool delete, bool restoreBaseline)
        {
            RequireWindowsSharing();
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: before", new UTF8Encoding(false));
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            string displacedPath = null;
            FileStream writer = null;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "prepare-recovery" && destination.EndsWith("source.cs", StringComparison.Ordinal))
                    displacedPath = Path.Combine(Path.GetDirectoryName(destination), "displaced.cs");
                if (step == "mutate" && destination == path) writer = HoldConcurrentWrite(path, "external displaced edit");
                if (step == "before-compensate" && destination == path && restoreBaseline)
                    File.WriteAllText(path, "before", new UTF8Encoding(false));
            };
            ScriptMutationReceipt receipt;
            try
            {
                receipt = Track(delete
                    ? ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", beforeHash, false)
                    : ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));
            }
            finally { writer?.Dispose(); }

            Assert.That(writer, Is.Not.Null, "The writer must race the final precondition check.");
            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.Not.EqualTo("complete"));
            Assert.That(receipt.RestoredSha256, Is.Null);
            Assert.That(File.Exists(displacedPath), Is.True, "Unreadable displaced bytes must survive cleanup.");
            Assert.That(File.ReadAllText(displacedPath), Is.EqualTo("external displaced edit"));
            Assert.That(receipt.Error["recoveryFiles"].Values<string>(), Does.Contain(displacedPath));
            Assert.That(receipt.Error["recoveryFileStates"].Single(item => item.Value<string>("path") == displacedPath).Value<string>("status"), Is.EqualTo("unknown"));
            Assert.That(File.ReadAllText(receipt.BackupMetaPath), Is.EqualTo("guid: before"));
            if (restoreBaseline) Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void Mutation_VerifiedDisplacedEditIsPreferredAsRecoveryAuthority(bool delete)
        {
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "mutate" && destination == path) File.WriteAllText(path, "external displaced edit", new UTF8Encoding(false));
            };

            var receipt = Track(delete
                ? ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", string.Empty, false)
                : ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", string.Empty, false));

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("code"), Is.EqualTo("SCRIPT_CONCURRENT_CHANGE"));
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo("incomplete"));
            Assert.That(File.ReadAllText(path), Is.EqualTo("external displaced edit"));
            Assert.That(File.ReadAllText(receipt.BackupPath), Is.EqualTo("external displaced edit"));
            Assert.That(receipt.Error["recoveryFiles"].Values<string>(), Does.Contain(receipt.BackupPath));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void Compensation_UnreadableDisplacedEditSurvivesCleanup(bool create)
        {
            RequireWindowsSharing();
            if (!create) File.WriteAllText(path, "before", new UTF8Encoding(false));
            FileStream writer = null;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "after-mutation" && destination == path) throw new IOException("force compensation");
                if (step == "compensate-mutate" && destination == path) writer = HoldConcurrentWrite(path, "external compensation edit");
            };
            ScriptMutationReceipt receipt;
            try { receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", string.Empty, false)); }
            finally { writer?.Dispose(); }

            Assert.That(writer, Is.Not.Null);
            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("message"), Does.Contain("force compensation"));
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.Not.EqualTo("complete"));
            Assert.That(receipt.RestoredSha256, Is.Null);
            var displaced = receipt.Error["recoveryFileStates"].Single(item => Path.GetFileName(item.Value<string>("path")).StartsWith("compensation-", StringComparison.Ordinal));
            Assert.That(displaced.Value<string>("status"), Is.EqualTo("unknown"));
            Assert.That(File.ReadAllText(displaced.Value<string>("path")), Is.EqualTo("external compensation edit"));
            Assert.That(File.Exists(path), Is.EqualTo(!create));
            if (!create) Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
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
        public void Delete_LockedMetadataReturnsFailureAndRestoresSourcePair()
        {
            RequireWindowsSharing();
            var original = new UnicodeEncoding(false, true).GetBytes("before\r\n");
            var metadata = Encoding.UTF8.GetBytes("guid: original\r\n");
            File.WriteAllBytes(path, original);
            File.WriteAllBytes(path + ".meta", metadata);
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptMutationReceipt receipt = null;
            Exception failure = null;
            using (var reader = new FileStream(path + ".meta", FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                try { receipt = ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", beforeHash, false); }
                catch (Exception exception) { failure = exception; }
            }

            Assert.That(File.Exists(path), Is.True, "Metadata failure must compensate the source deletion.");
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
            Assert.That(File.ReadAllBytes(path + ".meta"), Is.EqualTo(metadata));
            Assert.That(failure, Is.Null, "I/O failure must become a transaction receipt.");
            AssertCompensated(receipt, beforeHash);
        }

        [Test]
        public void Restore_LockedMetadataReturnsFailureAndRestoresPreCallSourcePair()
        {
            RequireWindowsSharing();
            File.WriteAllText(path, "backup source", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: backup", new UTF8Encoding(false));
            var backup = ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", string.Empty, false);
            var current = Encoding.UTF8.GetBytes("current source\r\n");
            var currentMeta = Encoding.UTF8.GetBytes("guid: current\r\n");
            File.WriteAllBytes(path, current);
            File.WriteAllBytes(path + ".meta", currentMeta);
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptMutationReceipt receipt = null;
            Exception failure = null;
            try
            {
                using (var reader = new FileStream(path + ".meta", FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    try { receipt = ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", backup.BackupPath, backup.BackupMetaPath, beforeHash); }
                    catch (Exception exception) { failure = exception; }
                }

                Assert.That(File.ReadAllBytes(path), Is.EqualTo(current), "Metadata failure must compensate source restoration.");
                Assert.That(File.ReadAllBytes(path + ".meta"), Is.EqualTo(currentMeta));
                Assert.That(failure, Is.Null, "I/O failure must become a transaction receipt.");
                AssertCompensated(receipt, beforeHash);
            }
            finally
            {
                ScriptFileTransaction.DiscardBackup(backup.BackupPath);
                ScriptFileTransaction.DiscardBackup(backup.BackupMetaPath);
                if (receipt != null) ScriptFileTransaction.DiscardBackup(receipt.BackupPath);
                if (receipt != null) ScriptFileTransaction.DiscardBackup(receipt.BackupMetaPath);
            }
        }

        [Test]
        public void DiscardBackup_RejectsJunctionTraversalWithoutDeletingTarget()
        {
            var backupRoot = ScriptFileTransaction.BackupRootForTests;
            Directory.CreateDirectory(backupRoot);
            var link = Path.Combine(backupRoot, "transaction-test-link-" + Guid.NewGuid().ToString("N"));
            var external = Path.Combine(directory, "external.cs");
            File.WriteAllText(external, "keep");
            try
            {
                var start = Environment.OSVersion.Platform == PlatformID.Win32NT
                    ? new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + link + "\" \"" + directory + "\"")
                    : new ProcessStartInfo("/bin/ln", "-s \"" + directory + "\" \"" + link + "\"");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                using (var process = Process.Start(start))
                {
                    Assert.That(process.WaitForExit(10000), Is.True);
                    Assert.That(process.ExitCode, Is.Zero);
                }

                Assert.That(() => ScriptFileTransaction.DiscardBackup(Path.Combine(link, "external.cs")), Throws.Exception);
                Assert.That(File.ReadAllText(external), Is.EqualTo("keep"));
            }
            finally
            {
                if (Directory.Exists(link)) Directory.Delete(link);
            }
        }

        [Test]
        public void Write_UnwritableRetentionDestinationCompensatesAfterAtomicReplacement()
        {
            var original = new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes("before\r\n")).ToArray();
            File.WriteAllBytes(path, original);
            File.WriteAllText(path + ".meta", "guid: before");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            string blockedDestination = null;
            var mutated = false;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "after-mutation" && destination == path) mutated = true;
                if (step == "retain-backup" && blockedDestination == null)
                {
                    blockedDestination = destination;
                    Directory.CreateDirectory(destination);
                }
            };
            try
            {
                var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after\n", beforeHash, false));

                Assert.That(mutated, Is.True, "The regression must fail after the live source was replaced.");
                AssertCompensated(receipt, beforeHash);
                Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
                Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: before"));
                Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
            }
            finally
            {
                if (blockedDestination != null && Directory.Exists(blockedDestination)) Directory.Delete(blockedDestination);
            }
        }

        [Test]
        public void Write_UnsupportedAtomicReplacementFailsClosed()
        {
            File.WriteAllText(path, "before");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            var replacements = 0;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step != "replace") return;
                replacements++;
                throw new PlatformNotSupportedException("atomic replacement unavailable");
            };

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.AtomicReplace, Is.False);
            Assert.That(receipt.Error.Value<string>("code"), Is.EqualTo("SCRIPT_ATOMIC_REPLACE_UNSUPPORTED"));
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo("complete"));
            Assert.That(replacements, Is.EqualTo(1));
            Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
            Assert.That(receipt.AfterSha256, Is.EqualTo(beforeHash));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [Test]
        public void Delete_SecondMetadataRetentionFailureCompensatesBothFilesAndRemovesPublishedSourceBackup()
        {
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: before", new UTF8Encoding(false));
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            string publishedSource = null;
            string blockedMetadata = null;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step != "retain-backup") return;
                if (!destination.EndsWith(".meta", StringComparison.Ordinal)) publishedSource = destination;
                else
                {
                    Assert.That(File.ReadAllText(publishedSource), Is.EqualTo("before"));
                    Assert.That(File.Exists(path), Is.False);
                    Assert.That(File.Exists(path + ".meta"), Is.False);
                    blockedMetadata = destination;
                    Directory.CreateDirectory(destination);
                }
            };
            try
            {
                var receipt = Track(ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", beforeHash, false));

                Assert.That(blockedMetadata, Is.Not.Null, "Failure must occur at the second backup publication.");
                AssertCompensated(receipt, beforeHash);
                Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
                Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: before"));
                Assert.That(File.Exists(publishedSource), Is.False);
                Assert.That(receipt.BackupPath, Is.Empty);
                Assert.That(receipt.BackupMetaPath, Is.Empty);
                Assert.That(Directory.GetFiles(ScriptFileTransaction.BackupRootForTests, "*", SearchOption.AllDirectories), Is.Empty);
                Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
            }
            finally
            {
                if (blockedMetadata != null && Directory.Exists(blockedMetadata)) Directory.Delete(blockedMetadata);
            }
        }

        [TestCase(false)]
        [TestCase(true)]
        public void Create_LaterFailureReturnsToAbsenceAndPreservesExistingMetadata(bool metadataExists)
        {
            if (metadataExists) File.WriteAllText(path + ".meta", "guid: orphan");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "after-mutation") throw new IOException("failure after creating source");
            };

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "new source", beforeHash, false));

            AssertCompensated(receipt, beforeHash);
            Assert.That(File.Exists(path), Is.False);
            Assert.That(File.Exists(path + ".meta"), Is.EqualTo(metadataExists));
            if (metadataExists) Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: orphan"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [TestCase(false, false)]
        [TestCase(false, true)]
        [TestCase(true, false)]
        [TestCase(true, true)]
        public void Restore_LateFailureCompensatesBothFilesIncludingAbsence(bool sourceExists, bool metadataExists)
        {
            File.WriteAllText(path, "backup source");
            File.WriteAllText(path + ".meta", "guid: backup");
            var backup = Track(ScriptFileTransaction.Delete(path, "Assets/CourseScript.cs", string.Empty, false));
            if (sourceExists) File.WriteAllText(path, "current source");
            if (metadataExists) File.WriteAllText(path + ".meta", "guid: current");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "after-mutation" && destination == path + ".meta") throw new IOException("failure after metadata mutation");
            };

            var receipt = Track(ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", backup.BackupPath, backup.BackupMetaPath, beforeHash));

            AssertCompensated(receipt, beforeHash);
            Assert.That(File.Exists(path), Is.EqualTo(sourceExists));
            Assert.That(File.Exists(path + ".meta"), Is.EqualTo(metadataExists));
            if (sourceExists) Assert.That(File.ReadAllText(path), Is.EqualTo("current source"));
            if (metadataExists) Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: current"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [TestCase(false)]
        [TestCase(true)]
        public void Write_BlockedCompensationRetainsRecoveryAndReportsObservedOrUnknownHash(bool denyRead)
        {
            RequireWindowsSharing();
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: before", new UTF8Encoding(false));
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            FileStream lockedSource = null;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "after-mutation" && destination == path)
                {
                    lockedSource = new FileStream(path, FileMode.Open, FileAccess.Read, denyRead ? FileShare.None : FileShare.Read);
                    throw new IOException("original mutation failure");
                }
            };
            ScriptMutationReceipt receipt;
            try { receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false)); }
            finally { lockedSource?.Dispose(); }
            ScriptFileTransaction.BeforeIoForTests = null;

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("code"), Is.EqualTo("SCRIPT_IO_FAILED"));
            Assert.That(receipt.Error.Value<string>("message"), Does.Contain("original mutation failure"));
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo(denyRead ? "unknown" : "incomplete"));
            Assert.That(receipt.AfterSha256, Is.EqualTo(denyRead ? null : ScriptFileTransaction.Read(path).Sha256));
            Assert.That(receipt.RestoredSha256, Is.Null);
            Assert.That(File.ReadAllText(path), Is.EqualTo("after"));
            Assert.That(File.ReadAllText(receipt.BackupPath), Is.EqualTo("before"));
            Assert.That(File.ReadAllText(receipt.BackupMetaPath), Is.EqualTo("guid: before"));
            Assert.That(receipt.Error["recoveryFiles"].Values<string>(), Does.Contain(receipt.BackupPath));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
            using (ScriptFileTransaction.BeginBackupRetentionLease()) { }
            Assert.That(File.Exists(receipt.BackupPath), Is.True, "Ordinary trimming must retain incomplete recovery.");
        }

        [Test]
        public void Write_ConcurrentEditDuringFailureIsPreservedAndReported()
        {
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step != "after-mutation") return;
                File.WriteAllText(path, "external edit", new UTF8Encoding(false));
                throw new IOException("failure after external edit");
            };

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo("incomplete"));
            Assert.That(File.ReadAllText(path), Is.EqualTo("external edit"));
            Assert.That(receipt.AfterSha256, Is.EqualTo(ScriptFileTransaction.Read(path).Sha256));
            Assert.That(receipt.RestoredSha256, Is.Null);
            Assert.That(File.ReadAllText(receipt.BackupPath), Is.EqualTo("before"));
        }

        [Test]
        public void Write_CleanupFailurePreservesOriginalFailureAndReportsRemainingTemporaryFile()
        {
            RequireWindowsSharing();
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            string temporaryPath = null;
            FileStream lockedTemporary = null;
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step == "prepare-target") temporaryPath = destination;
                if (step != "replace") return;
                lockedTemporary = new FileStream(temporaryPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                throw new IOException("original replacement failure");
            };
            ScriptMutationReceipt receipt;
            try { receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false)); }
            finally { lockedTemporary?.Dispose(); }

            AssertCompensated(receipt, beforeHash);
            Assert.That(receipt.Error.Value<string>("message"), Does.Contain("original replacement failure"));
            Assert.That(receipt.CleanupWarnings.Any(item => item.Value<string>("path") == temporaryPath), Is.True);
            Assert.That(File.Exists(temporaryPath), Is.True);
            Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
        }

        [TestCase("prepare-recovery")]
        [TestCase("prepare-target")]
        public void Write_PreparationFailureLeavesPairUnchangedAndNoClaimedRecovery(string failingStep)
        {
            File.WriteAllText(path, "before");
            File.WriteAllText(path + ".meta", "guid: before");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptFileTransaction.BackupRootForTests = Path.Combine(directory, "backups");
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step != failingStep) return;
                File.WriteAllText(destination, "partial prepared bytes");
                throw new IOException("preparation failed");
            };

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));

            AssertCompensated(receipt, beforeHash);
            Assert.That(receipt.BackupPath, Is.Empty);
            Assert.That(receipt.BackupMetaPath, Is.Empty);
            Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
            Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: before"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
            Assert.That(Directory.GetFileSystemEntries(ScriptFileTransaction.BackupRootForTests), Is.Empty);
        }

        [Test]
        public void Write_MetadataReadFailureReturnsUnknownWithoutClaimingRecoveryFiles()
        {
            RequireWindowsSharing();
            File.WriteAllText(path, "before");
            File.WriteAllText(path + ".meta", "guid: before");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptMutationReceipt receipt;
            using (var reader = new FileStream(path + ".meta", FileMode.Open, FileAccess.Read, FileShare.None))
            {
                receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));
            }

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo("unknown"));
            Assert.That(receipt.BackupPath, Is.Empty);
            Assert.That(receipt.BackupMetaPath, Is.Empty);
            Assert.That(receipt.AfterSha256, Is.EqualTo(beforeHash));
            Assert.That(receipt.RestoredSha256, Is.Null);
            Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
            Assert.That(File.ReadAllText(path + ".meta"), Is.EqualTo("guid: before"));
        }

        [Test]
        public void Write_PartialRecoveryPreparationOnlyReportsVerifiedExistingBackups()
        {
            File.WriteAllText(path, "before", new UTF8Encoding(false));
            File.WriteAllText(path + ".meta", "guid: before", new UTF8Encoding(false));
            ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
            {
                if (step != "prepare-recovery" || !destination.EndsWith(".meta", StringComparison.Ordinal)) return;
                File.WriteAllText(path, "external edit", new UTF8Encoding(false));
                throw new IOException("metadata recovery could not be prepared");
            };

            var receipt = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", string.Empty, false));

            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error.Value<string>("restorationStatus"), Is.EqualTo("incomplete"));
            Assert.That(File.ReadAllText(path), Is.EqualTo("external edit"));
            Assert.That(File.ReadAllText(receipt.BackupPath), Is.EqualTo("before"));
            Assert.That(receipt.BackupMetaPath, Is.Empty, "Unprepared metadata must not be advertised as a usable backup.");
            foreach (var recovery in receipt.Error["recoveryFiles"].Values<string>()) Assert.That(File.Exists(recovery), Is.True);
            foreach (var recovery in receipt.Error["recoveryFileStates"])
            {
                Assert.That(ScriptFileTransaction.Read(recovery.Value<string>("path")).Sha256, Is.EqualTo(recovery.Value<string>("sha256")));
            }
        }

        [Test]
        public void BackupRootJunctionRejectsWriteRestoreAndDiscardBeforeMutation()
        {
            var target = Path.Combine(directory, "outside-backups");
            Directory.CreateDirectory(target);
            var link = Path.Combine(directory, "linked-backups");
            var external = Path.Combine(target, "external.cs");
            File.WriteAllText(external, "keep");
            File.WriteAllText(path, "before");
            var beforeHash = ScriptFileTransaction.Read(path).Sha256;
            ScriptFileTransaction.BackupRootForTests = link;
            try
            {
                var start = Environment.OSVersion.Platform == PlatformID.Win32NT
                    ? new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + link + "\" \"" + target + "\"")
                    : new ProcessStartInfo("/bin/ln", "-s \"" + target + "\" \"" + link + "\"");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                using (var process = Process.Start(start))
                {
                    Assert.That(process.WaitForExit(10000), Is.True);
                    Assert.That(process.ExitCode, Is.Zero);
                }

                var written = Track(ScriptFileTransaction.Write(path, "Assets/CourseScript.cs", "after", beforeHash, false));
                var restored = Track(ScriptFileTransaction.Restore(path, "Assets/CourseScript.cs", Path.Combine(link, "external.cs"), string.Empty, beforeHash));

                Assert.That(written.Ok, Is.False);
                Assert.That(written.Error.Value<string>("code"), Is.EqualTo("SCRIPT_PATH_UNSAFE"));
                Assert.That(written.AfterSha256, Is.EqualTo(beforeHash));
                Assert.That(written.BackupPath, Is.Empty);
                Assert.That(restored.Ok, Is.False);
                Assert.That(() => ScriptFileTransaction.DiscardBackup(Path.Combine(link, "external.cs")), Throws.Exception);
                Assert.That(File.ReadAllText(external), Is.EqualTo("keep"));
                Assert.That(File.ReadAllText(path), Is.EqualTo("before"));
                Assert.That(Directory.GetFiles(target).Length, Is.EqualTo(1));
            }
            finally
            {
                if (Directory.Exists(link)) Directory.Delete(link);
            }
        }

        private ScriptMutationReceipt Track(ScriptMutationReceipt receipt)
        {
            trackedReceipts.Add(receipt);
            return receipt;
        }

        private static void RequireWindowsSharing()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) Assert.Ignore("Requires Windows file sharing semantics.");
        }

        private static FileStream HoldConcurrentWrite(string destination, string content)
        {
            var stream = new FileStream(destination, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            try
            {
                var bytes = Encoding.UTF8.GetBytes(content);
                stream.SetLength(0);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
                return stream;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        private static void AssertCompensated(ScriptMutationReceipt receipt, string beforeHash)
        {
            Assert.That(receipt, Is.Not.Null);
            if (receipt == null) return;
            Assert.That(receipt.Ok, Is.False);
            Assert.That(receipt.Error["code"].Value<string>(), Is.EqualTo("SCRIPT_IO_FAILED"));
            Assert.That(receipt.Error["restorationStatus"].Value<string>(), Is.EqualTo("complete"));
            Assert.That(receipt.BeforeSha256, Is.EqualTo(beforeHash));
            Assert.That(receipt.AfterSha256, Is.EqualTo(beforeHash));
            Assert.That(receipt.RestoredSha256, Is.EqualTo(beforeHash));
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

        [Test]
        public void ActiveBatchLeaseProtectsThenPrunesCompanionGroupsFrom51To50()
        {
            var receipts = new System.Collections.Generic.List<ScriptMutationReceipt>();
            try
            {
                using (ScriptFileTransaction.BeginBackupRetentionLease())
                {
                    for (var index = 0; index < 51; index++)
                    {
                        var itemPath = Path.Combine(directory, "CourseScript" + index + ".cs");
                        File.WriteAllText(itemPath, "before", new UTF8Encoding(false));
                        File.WriteAllText(itemPath + ".meta", "guid: " + index, new UTF8Encoding(false));
                        receipts.Add(ScriptFileTransaction.Delete(itemPath, "Assets/CourseScript" + index + ".cs", string.Empty, false));
                    }

                    Assert.That(receipts.All(receipt => receipt.Ok && File.Exists(receipt.BackupPath) && File.Exists(receipt.BackupMetaPath)), Is.True);
                    Assert.That(Directory.GetFiles(ScriptFileTransaction.BackupRootForTests).Length, Is.EqualTo(102));
                }

                Assert.That(receipts.Count(receipt => File.Exists(receipt.BackupPath)), Is.EqualTo(50));
                Assert.That(receipts.All(receipt => File.Exists(receipt.BackupPath) == File.Exists(receipt.BackupMetaPath)), Is.True, "Pruning must remove an entire source/metadata group.");
                Assert.That(Directory.GetFiles(ScriptFileTransaction.BackupRootForTests).Length, Is.EqualTo(100));
            }
            finally
            {
                foreach (var receipt in receipts)
                {
                    ScriptFileTransaction.DiscardBackup(receipt.BackupPath);
                    ScriptFileTransaction.DiscardBackup(receipt.BackupMetaPath);
                }
            }
        }
    }
}
