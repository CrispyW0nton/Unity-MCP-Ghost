using System;
using System.Diagnostics;
using System.IO;
using NUnit.Framework;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class ProjectPathPolicyTests
    {
        [TestCase("Assets/../ProjectSettings/ProjectSettings.asset")]
        [TestCase("Assets/../../outside.txt")]
        [TestCase("AssetsSibling/file.txt")]
        [TestCase("Packages/package.json")]
        public void RejectsAssetPathEscapes(string path)
        {
            var exception = Assert.Throws<ProjectPathException>(() => ProjectPathPolicy.NormalizeAssetPath(path));

            Assert.That(exception.Code, Is.EqualTo("PATH_OUTSIDE_ASSETS"));
        }

        [Test]
        public void AcceptsUnicodeAndSpacesWithoutLosingCanonicalBoundary()
        {
            var assetPath = ProjectPathPolicy.NormalizeAssetPath("Assets/Ghost Tests/Ünicode Script.cs");
            var fullPath = ProjectPathPolicy.FullAssetPath(assetPath);

            Assert.That(assetPath, Is.EqualTo("Assets/Ghost Tests/Ünicode Script.cs"));
            Assert.That(fullPath, Does.StartWith(ProjectPathPolicy.AssetsRoot));
        }

        [Test]
        public void ProjectRootRejectsAbsoluteOutsidePath()
        {
            var outside = Path.Combine(Path.GetTempPath(), "UnityMcpGhost-Outside-" + Guid.NewGuid().ToString("N"));
            var exception = Assert.Throws<ProjectPathException>(() => ProjectPathPolicy.RequireUnderProjectRoot(outside));

            Assert.That(exception.Code, Is.EqualTo("PATH_OUTSIDE_PROJECT"));
        }

        [Test]
        public void RejectsSymlinkOrJunctionEscape()
        {
            var testRoot = Path.Combine(ProjectPathPolicy.ProjectRoot, "Library", "UnityMcpGhost", "path-policy-tests", Guid.NewGuid().ToString("N"));
            var outside = Path.Combine(Path.GetTempPath(), "UnityMcpGhost-ReparseTarget-" + Guid.NewGuid().ToString("N"));
            var link = Path.Combine(testRoot, "linked-outside");
            Directory.CreateDirectory(testRoot);
            Directory.CreateDirectory(outside);
            try
            {
                var start = Application.platform == RuntimePlatform.WindowsEditor
                    ? new ProcessStartInfo("cmd.exe", "/c mklink /J " + Quote(link) + " " + Quote(outside))
                    : new ProcessStartInfo("/bin/ln", "-s " + Quote(outside) + " " + Quote(link));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                using (var process = Process.Start(start))
                {
                    Assert.That(process, Is.Not.Null);
                    Assert.That(process.WaitForExit(10000), Is.True);
                    Assert.That(process.ExitCode, Is.Zero);
                }

                var exception = Assert.Throws<ProjectPathException>(() => ProjectPathPolicy.RequireUnderProjectRoot(Path.Combine(link, "outside.txt")));
                Assert.That(exception.Code, Is.EqualTo("REPARSE_POINT_FORBIDDEN"));
            }
            finally
            {
                if (Directory.Exists(link))
                {
                    Directory.Delete(link);
                }
                if (Directory.Exists(testRoot))
                {
                    Directory.Delete(testRoot, true);
                }
                if (Directory.Exists(outside))
                {
                    Directory.Delete(outside, true);
                }
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
