using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class ScreenshotSafetyTests
    {
        [Test]
        public void AllocationPlanReportsEffectiveDimensionsAndMemory()
        {
            var plan = CommandRegistry.CreateScreenshotAllocationPlan(1280, 720, 2);

            Assert.That(plan.EffectiveWidth, Is.EqualTo(2560));
            Assert.That(plan.EffectiveHeight, Is.EqualTo(1440));
            Assert.That(plan.EffectivePixels, Is.EqualTo(3686400));
            Assert.That(plan.EstimatedBytes, Is.EqualTo(44236800));
        }

        [TestCase(0, 720, 1, "INVALID_SCREENSHOT_DIMENSIONS")]
        [TestCase(1280, 720, 9, "SCREENSHOT_LIMIT_EXCEEDED")]
        [TestCase(5000, 4000, 1, "SCREENSHOT_LIMIT_EXCEEDED")]
        [TestCase(4097, 1080, 2, "SCREENSHOT_LIMIT_EXCEEDED")]
        public void AllocationPlanRejectsInvalidOrUnsafeRequests(int width, int height, int superSize, string expectedCode)
        {
            var exception = Assert.Throws<ScreenshotValidationException>(() => CommandRegistry.CreateScreenshotAllocationPlan(width, height, superSize));

            Assert.That(exception.Code, Is.EqualTo(expectedCode));
        }

        [Test]
        public void PixelComparisonRejectsDimensionMismatchUnlessExplicitlyResampled()
        {
            var baseline = SolidTexture(4, 4, Color.red);
            var current = SolidTexture(2, 2, Color.red);
            try
            {
                var exception = Assert.Throws<ScreenshotValidationException>(() => CommandRegistry.CompareScreenshots(baseline, current, 100, false));
                Assert.That(exception.Code, Is.EqualTo("SCREENSHOT_DIMENSION_MISMATCH"));

                var stats = CommandRegistry.CompareScreenshots(baseline, current, 100, true);
                Assert.That(stats.ComparisonWidth, Is.EqualTo(4));
                Assert.That(stats.ComparisonHeight, Is.EqualTo(4));
                Assert.That(stats.ComparisonMethod, Is.EqualTo("sampled-rgba-bilinear-current-to-baseline"));
                Assert.That(stats.DifferentPixels, Is.Zero);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(baseline);
                UnityEngine.Object.DestroyImmediate(current);
            }
        }

        [Test]
        public void RegistryReturnsStableErrorForDimensionMismatch()
        {
            var directory = Path.Combine(Path.GetTempPath(), "UnityMcpGhost-ScreenshotTests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            var baselinePath = Path.Combine(directory, "baseline.png");
            var currentPath = Path.Combine(directory, "current.png");
            WriteTexture(baselinePath, 4, 4, Color.blue);
            WriteTexture(currentPath, 2, 2, Color.blue);
            try
            {
                var requestJson = new JObject
                {
                    ["jsonrpc"] = "2.0",
                    ["id"] = 1,
                    ["method"] = "screenshot.diff",
                    ["params"] = new JObject
                    {
                        ["baselinePath"] = baselinePath,
                        ["currentPath"] = currentPath,
                        ["dimensionMode"] = "reject"
                    }
                }.ToString();

                var response = JObject.Parse(new CommandRegistry().Execute(JsonRpcUtil.ParseRequest(requestJson)));

                Assert.That(response["result"]["ok"].Value<bool>(), Is.False, response.ToString());
                Assert.That(response["result"]["error"]["code"].Value<string>(), Is.EqualTo("SCREENSHOT_DIMENSION_MISMATCH"));
                Assert.That(response["result"]["error"]["data"]["comparisonMethod"].Value<string>(), Is.EqualTo("rejected-dimension-mismatch"));
            }
            finally
            {
                if (Directory.Exists(directory))
                {
                    Directory.Delete(directory, true);
                }
            }
        }

        private static Texture2D SolidTexture(int width, int height, Color color)
        {
            var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
            var colors = new Color[width * height];
            for (var index = 0; index < colors.Length; index++)
            {
                colors[index] = color;
            }

            texture.SetPixels(colors);
            texture.Apply();
            return texture;
        }

        private static void WriteTexture(string path, int width, int height, Color color)
        {
            var texture = SolidTexture(width, height, color);
            try
            {
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(texture);
            }
        }
    }
}
