using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class GhostTestRunCallbacksTests
    {
        [TestCase("Passed", 0, "success")]
        [TestCase("Passed", 2, "failed")]
        [TestCase("Failed", 0, "failed")]
        [TestCase("Aborted", 0, "failed")]
        [TestCase("InfrastructureError", 0, "failed")]
        [TestCase("Cancelled", 0, "cancelled")]
        public void ClassifyRunStatus_NeverReportsNonGreenRunsAsSuccess(string resultState, int failed, string expected)
        {
            Assert.That(GhostTestRunCallbacks.ClassifyRunStatus(resultState, failed), Is.EqualTo(expected));
        }
    }
}
