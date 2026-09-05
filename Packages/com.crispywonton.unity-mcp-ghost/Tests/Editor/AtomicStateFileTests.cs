using System;
using System.IO;
using System.Text;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class AtomicStateFileTests
    {
        private string directory;

        [SetUp]
        public void SetUp()
        {
            directory = Path.Combine(Path.GetTempPath(), "gmcp-atomic-state-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
        }

        [TearDown]
        public void TearDown()
        {
            AtomicStateFile.ReplaceOverrideForTests = null;
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }

        [Test]
        public void CreatesUtf8StateWithoutBomAndLeavesNoTemporaryFile()
        {
            var path = Path.Combine(directory, "nested", "state.json");
            const string contents = "{\"message\":\"Unicode: 日本語 🌙\"}";

            AtomicStateFile.WriteAllText(path, contents);

            Assert.That(File.ReadAllBytes(path), Is.EqualTo(new UTF8Encoding(false).GetBytes(contents)));
            Assert.That(Directory.GetFiles(directory, "*.tmp", SearchOption.AllDirectories), Is.Empty);
        }

        [Test]
        public void ReplacesExistingStateAndLeavesNoTemporaryFile()
        {
            var path = Path.Combine(directory, "state.json");
            File.WriteAllText(path, "original");

            AtomicStateFile.WriteAllText(path, "replacement");

            Assert.That(File.ReadAllText(path), Is.EqualTo("replacement"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [Test]
        public void TransientReplacementFailureRetriesTheSameFlushedTemporaryFileWithoutDeletingTheDestination()
        {
            var path = Path.Combine(directory, "state.json");
            File.WriteAllText(path, "original");
            var attempts = 0;
            string firstTemporary = null;
            AtomicStateFile.ReplaceOverrideForTests = (source, destination) =>
            {
                attempts++;
                if (firstTemporary == null) firstTemporary = source;
                Assert.That(source, Is.EqualTo(firstTemporary));
                Assert.That(File.ReadAllText(destination), Is.EqualTo("original"));
                Assert.That(File.ReadAllText(source), Is.EqualTo("replacement"));
                if (attempts < 3) throw new IOException("injected transient sharing failure");
                File.Replace(source, destination, null);
            };

            AtomicStateFile.WriteAllText(path, "replacement");

            Assert.That(attempts, Is.EqualTo(3));
            Assert.That(File.ReadAllText(path), Is.EqualTo("replacement"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [Test]
        public void WindowsSharingFailureRetriesAfterTheActualReaderCloses()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) Assert.Ignore("Windows sharing semantics require a Windows runner.");
            var path = Path.Combine(directory, "state.json");
            File.WriteAllText(path, "original");
            var attempts = 0;
            AtomicStateFile.ReplaceOverrideForTests = (source, destination) =>
            {
                attempts++;
                if (attempts == 1)
                {
                    using (var reader = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        File.Replace(source, destination, null);
                        Assert.Fail("The actual Windows reader must reject replacement on the first attempt.");
                    }
                }
                File.Replace(source, destination, null);
            };

            AtomicStateFile.WriteAllText(path, "replacement");

            Assert.That(attempts, Is.EqualTo(2));
            Assert.That(File.ReadAllText(path), Is.EqualTo("replacement"));
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty);
        }

        [Test]
        public void WindowsCleanupFailureRetainsBothErrorsAndNeverDeletesThePreviousRecord()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) Assert.Ignore("Windows sharing semantics require a Windows runner.");
            var path = Path.Combine(directory, "state.json");
            File.WriteAllText(path, "original");
            var injected = new UnauthorizedAccessException("injected replacement rejection");
            FileStream lockedTemporary = null;
            AtomicStateFile.ReplaceOverrideForTests = (source, destination) =>
            {
                lockedTemporary = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
                throw injected;
            };
            try
            {
                var failure = Assert.Throws<AggregateException>(() => AtomicStateFile.WriteAllText(path, "replacement"));

                Assert.That(failure.InnerExceptions.Count, Is.EqualTo(2));
                Assert.That(failure.InnerExceptions[0], Is.SameAs(injected));
                Assert.That(failure.InnerExceptions[1], Is.InstanceOf<IOException>());
                Assert.That(File.ReadAllText(path), Is.EqualTo("original"));
                Assert.That(Directory.GetFiles(directory, "*.tmp").Length, Is.EqualTo(1));
            }
            finally
            {
                lockedTemporary?.Dispose();
            }
        }

        [TestCase("io")]
        [TestCase("unsupported")]
        [TestCase("unauthorized")]
        public void FailedReplacementPreservesOriginalBytesAndCleansTemporaryFile(string kind)
        {
            var path = Path.Combine(directory, "state.json");
            var original = Encoding.UTF8.GetBytes("{\"receipt\":\"last known good 🌙\"}");
            File.WriteAllBytes(path, original);
            Exception injected = kind == "io" ? new IOException("injected replacement failure")
                : kind == "unsupported" ? new PlatformNotSupportedException("injected unsupported replacement")
                : (Exception)new UnauthorizedAccessException("injected replacement denial");
            var attempts = 0;
            AtomicStateFile.ReplaceOverrideForTests = (source, destination) => { attempts++; throw injected; };
            Exception observed = null;

            try { AtomicStateFile.WriteAllText(path, "replacement"); }
            catch (Exception exception) { observed = exception; }

            Assert.That(observed, Is.SameAs(injected), "Replacement failures must not be hidden by delete/move fallback.");
            Assert.That(attempts, Is.EqualTo(kind == "io" ? 4 : 1), "Only I/O replacement failures receive a bounded retry.");
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original), "The previous durable receipt must survive byte-identically.");
            Assert.That(Directory.GetFiles(directory, "*.tmp"), Is.Empty, "Failed writes must not leak sibling temporary files.");
        }
    }
}
