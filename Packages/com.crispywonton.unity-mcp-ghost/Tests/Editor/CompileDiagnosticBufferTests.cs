using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor.Compilation;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class CompileDiagnosticBufferTests
    {
        [SetUp]
        public void SetUp()
        {
            CompileDiagnosticBuffer.ResetForTests();
        }

        [Test]
        public void RequestedGeneration_DoesNotSucceedBeforeCompilationStarts()
        {
            var generation = CompileDiagnosticBuffer.RequestGeneration("Assets/CourseScript.cs");

            var state = JObject.Parse(CompileDiagnosticBuffer.WaitState(generation, false));

            Assert.That(state["status"].Value<string>(), Is.EqualTo("waiting"));
            Assert.That(state["observed"].Value<bool>(), Is.False);
        }

        [Test]
        public void CleanGeneration_DoesNotReturnHistoricalErrors()
        {
            var failingGeneration = CompileDiagnosticBuffer.RequestGeneration("Assets/Old.cs");
            CompileDiagnosticBuffer.BeginCompilationForTests();
            CompileDiagnosticBuffer.AddDiagnosticForTests(
                failingGeneration,
                "Assembly-CSharp.dll",
                CompilerMessageType.Error,
                "Assets/Old.cs",
                3,
                7,
                "error CS1002: ; expected");
            CompileDiagnosticBuffer.CompleteCompilationForTests();

            var cleanGeneration = CompileDiagnosticBuffer.RequestGeneration("Assets/New.cs");
            CompileDiagnosticBuffer.BeginCompilationForTests();
            CompileDiagnosticBuffer.CompleteCompilationForTests();

            var diagnostics = JObject.Parse(CompileDiagnosticBuffer.Diagnostics("error", 100, "", cleanGeneration));
            var state = JObject.Parse(CompileDiagnosticBuffer.WaitState(cleanGeneration, false));

            Assert.That(diagnostics["diagnostics"], Is.Empty);
            Assert.That(state["status"].Value<string>(), Is.EqualTo("success"));
            Assert.That(state["diagnostics"], Is.Empty);
        }

        [Test]
        public void FailedGeneration_IncludesCompleteStructuredDiagnostics()
        {
            var generation = CompileDiagnosticBuffer.RequestGeneration("Assets/Broken.cs");
            CompileDiagnosticBuffer.BeginCompilationForTests();
            CompileDiagnosticBuffer.AddDiagnosticForTests(
                generation,
                "Assembly-CSharp.dll",
                CompilerMessageType.Error,
                "Assets/Broken.cs",
                10,
                4,
                "error CS0103: The name 'score' does not exist");
            CompileDiagnosticBuffer.CompleteCompilationForTests();

            var state = JObject.Parse(CompileDiagnosticBuffer.WaitState(generation, false));
            var diagnostic = state["diagnostics"][0];

            Assert.That(state["status"].Value<string>(), Is.EqualTo("failed"));
            Assert.That(diagnostic["generation"].Value<int>(), Is.EqualTo(generation));
            Assert.That(diagnostic["assembly"].Value<string>(), Is.EqualTo("Assembly-CSharp.dll"));
            Assert.That(diagnostic["severity"].Value<string>(), Is.EqualTo("error"));
            Assert.That(diagnostic["file"].Value<string>(), Is.EqualTo("Assets/Broken.cs"));
            Assert.That(diagnostic["line"].Value<int>(), Is.EqualTo(10));
            Assert.That(diagnostic["column"].Value<int>(), Is.EqualTo(4));
            Assert.That(diagnostic["timestampUtc"].Value<string>(), Is.Not.Empty);
        }

        [Test]
        public void EvictedErrorStillKeepsGenerationFailed()
        {
            var generation = CompileDiagnosticBuffer.RequestGeneration("Assets/Noisy.cs");
            CompileDiagnosticBuffer.BeginCompilationForTests();
            CompileDiagnosticBuffer.AddNoisyDiagnosticsForTests(generation, 1000);
            CompileDiagnosticBuffer.CompleteCompilationForTests();

            var state = JObject.Parse(CompileDiagnosticBuffer.WaitState(generation, false));

            Assert.That(state["status"].Value<string>(), Is.EqualTo("failed"));
            Assert.That(state["errorCount"].Value<int>(), Is.EqualTo(1));
            Assert.That(state["diagnosticsTruncated"].Value<bool>(), Is.True);
        }

        [Test]
        public void DiagnosticsOnlyReportsTruncationWhenAnExtraMatchExists()
        {
            var generation = CompileDiagnosticBuffer.RequestGeneration("Assets/Limit.cs");
            CompileDiagnosticBuffer.BeginCompilationForTests();
            CompileDiagnosticBuffer.AddDiagnosticForTests(generation, "Assembly-CSharp.dll", CompilerMessageType.Warning, "Assets/Limit.cs", 1, 1, "warning one");
            CompileDiagnosticBuffer.AddDiagnosticForTests(generation, "Assembly-CSharp.dll", CompilerMessageType.Warning, "Assets/Limit.cs", 2, 1, "warning two");

            var exact = JObject.Parse(CompileDiagnosticBuffer.Diagnostics("warning", 2, "", generation));
            CompileDiagnosticBuffer.AddDiagnosticForTests(generation, "Assembly-CSharp.dll", CompilerMessageType.Warning, "Assets/Limit.cs", 3, 1, "warning three");
            var overflow = JObject.Parse(CompileDiagnosticBuffer.Diagnostics("warning", 2, "", generation));

            Assert.That(exact["truncated"].Value<bool>(), Is.False);
            Assert.That(overflow["truncated"].Value<bool>(), Is.True);
        }
    }
}
