using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed partial class CommandRegistry
    {
        private static string HandleScreenshotCapture(UnityMcpRequest request)
        {
            var superSize = JsonRpcUtil.ReadInt(request.RawJson, "superSize", 1);
            var label = SanitizeFileName(JsonRpcUtil.ReadString(request.RawJson, "label", "ghost"));
            var mode = JsonRpcUtil.ReadString(request.RawJson, "mode", "auto").ToLowerInvariant();
            ScreenshotAllocationPlan allocation;
            try
            {
                allocation = CreateScreenshotAllocationPlan(
                    JsonRpcUtil.ReadInt(request.RawJson, "width", 1280),
                    JsonRpcUtil.ReadInt(request.RawJson, "height", 720),
                    superSize);
            }
            catch (ScreenshotValidationException exception)
            {
                return ScreenshotFailure(exception.Code, exception.Message, null);
            }

            var width = allocation.EffectiveWidth;
            var height = allocation.EffectiveHeight;
            var directory = Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "screenshots");
            var fileName = label + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) + ".png";
            var path = Path.GetFullPath(Path.Combine(directory, fileName));

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"screenshot.capture\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\",\"requestedWidth\":" + allocation.RequestedWidth + ",\"requestedHeight\":" + allocation.RequestedHeight + ",\"effectiveWidth\":" + width + ",\"effectiveHeight\":" + height + ",\"effectivePixels\":" + allocation.EffectivePixels + ",\"estimatedBytes\":" + allocation.EstimatedBytes + ",\"superSize\":" + superSize + "}}";
            }

            Directory.CreateDirectory(directory);
            var camera = ResolveScreenshotCamera(mode);
            if (camera == null)
            {
                throw new InvalidOperationException("No camera is available for screenshot.capture. Use mode=sceneView with an open Scene view or add/tag a MainCamera.");
            }

            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            RenderTexture renderTexture = null;
            Texture2D texture = null;
            try
            {
                renderTexture = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
                texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                if (!renderTexture.Create())
                {
                    return ScreenshotFailure("SCREENSHOT_ALLOCATION_FAILED", "Unity could not allocate the requested render target.", allocation);
                }

                camera.targetTexture = renderTexture;
                RenderTexture.active = renderTexture;
                camera.Render();
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                if (texture != null)
                {
                    UnityEngine.Object.DestroyImmediate(texture);
                }

                if (renderTexture != null)
                {
                    if (renderTexture.IsCreated())
                    {
                        renderTexture.Release();
                    }

                    UnityEngine.Object.DestroyImmediate(renderTexture);
                }
            }

            var info = new FileInfo(path);
            var metadataPath = path + ".json";
            var activeScene = SceneManager.GetActiveScene();
            File.WriteAllText(
                metadataPath,
                "{"
                    + "\"label\":\"" + JsonRpcUtil.Escape(label) + "\","
                    + "\"timestampUtc\":\"" + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture) + "\","
                    + "\"path\":\"" + JsonRpcUtil.Escape(path) + "\","
                    + "\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\","
                    + "\"camera\":\"" + JsonRpcUtil.Escape(camera.name) + "\","
                    + "\"activeScenePath\":\"" + JsonRpcUtil.Escape(activeScene.path) + "\","
                    + "\"activeSceneName\":\"" + JsonRpcUtil.Escape(activeScene.name) + "\","
                    + "\"width\":" + width + ","
                    + "\"height\":" + height + ","
                    + "\"requestedWidth\":" + allocation.RequestedWidth + ","
                    + "\"requestedHeight\":" + allocation.RequestedHeight + ","
                    + "\"effectivePixels\":" + allocation.EffectivePixels + ","
                    + "\"estimatedBytes\":" + allocation.EstimatedBytes + ","
                    + "\"bytes\":" + info.Length + ","
                    + "\"superSize\":" + superSize
                    + "}",
                Encoding.UTF8);

            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"metadataPath\":\"" + JsonRpcUtil.Escape(metadataPath) + "\",\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\",\"camera\":\"" + JsonRpcUtil.Escape(camera.name) + "\",\"requestedWidth\":" + allocation.RequestedWidth + ",\"requestedHeight\":" + allocation.RequestedHeight + ",\"width\":" + width + ",\"height\":" + height + ",\"effectivePixels\":" + allocation.EffectivePixels + ",\"estimatedBytes\":" + allocation.EstimatedBytes + ",\"bytes\":" + info.Length + ",\"superSize\":" + superSize + ",\"comparisonMethod\":\"capture-render-target-rgba32\",\"note\":\"Screenshot rendered synchronously from the selected Unity camera.\"}";
        }

        private static string HandleScreenshotDiff(UnityMcpRequest request)
        {
            var baselinePath = JsonRpcUtil.ReadString(request.RawJson, "baselinePath", string.Empty);
            var currentPath = JsonRpcUtil.ReadString(request.RawJson, "currentPath", string.Empty);
            var threshold = Math.Max(0f, JsonRpcUtil.ReadFloat(request.RawJson, "threshold", 0.02f));
            var maxSamples = Math.Max(100, (int)Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "maxSamples", 20000), MaxScreenshotEffectivePixels));
            var dimensionMode = JsonRpcUtil.ReadString(request.RawJson, "dimensionMode", "reject").ToLowerInvariant();

            if (dimensionMode != "reject" && dimensionMode != "resample-current")
            {
                return ScreenshotFailure("INVALID_SCREENSHOT_DIMENSION_MODE", "dimensionMode must be reject or resample-current.", null);
            }

            if (string.IsNullOrEmpty(baselinePath) || string.IsNullOrEmpty(currentPath))
            {
                throw new InvalidOperationException("screenshot.diff requires baselinePath and currentPath.");
            }

            try
            {
                baselinePath = ProjectPathPolicy.RequireUnderProjectRoot(baselinePath);
                currentPath = ProjectPathPolicy.RequireUnderProjectRoot(currentPath);
            }
            catch (ProjectPathException exception)
            {
                return ScreenshotFailure(exception.Code, exception.Message, null);
            }

            if (!File.Exists(baselinePath))
            {
                throw new InvalidOperationException("Baseline screenshot does not exist: " + baselinePath);
            }

            if (!File.Exists(currentPath))
            {
                throw new InvalidOperationException("Current screenshot does not exist: " + currentPath);
            }

            Texture2D baseline = null;
            Texture2D current = null;
            try
            {
                baseline = LoadScreenshotTexture(baselinePath);
                current = LoadScreenshotTexture(currentPath);
                if ((baseline.width != current.width || baseline.height != current.height) && dimensionMode == "reject")
                {
                    return ScreenshotFailure(
                        "SCREENSHOT_DIMENSION_MISMATCH",
                        "Screenshot dimensions differ. Set dimensionMode=resample-current to compare explicitly.",
                        new
                        {
                            baseline = new { width = baseline.width, height = baseline.height },
                            current = new { width = current.width, height = current.height },
                            comparisonMethod = "rejected-dimension-mismatch"
                        });
                }

                var result = CompareScreenshots(baseline, current, maxSamples, dimensionMode == "resample-current");
                return "{"
                    + "\"ok\":true,"
                    + "\"source\":\"screenshot-pixel-diff\","
                    + "\"baselinePath\":\"" + JsonRpcUtil.Escape(baselinePath) + "\","
                    + "\"currentPath\":\"" + JsonRpcUtil.Escape(currentPath) + "\","
                    + "\"baseline\":{\"width\":" + baseline.width + ",\"height\":" + baseline.height + "},"
                    + "\"current\":{\"width\":" + current.width + ",\"height\":" + current.height + "},"
                    + "\"comparisonWidth\":" + result.ComparisonWidth + ","
                    + "\"comparisonHeight\":" + result.ComparisonHeight + ","
                    + "\"comparisonMethod\":\"" + JsonRpcUtil.Escape(result.ComparisonMethod) + "\","
                    + "\"sampledPixels\":" + result.SampledPixels + ","
                    + "\"totalPixels\":" + ((long)result.ComparisonWidth * result.ComparisonHeight) + ","
                    + "\"approximate\":" + Bool(result.SampledPixels < (long)result.ComparisonWidth * result.ComparisonHeight) + ","
                    + "\"coverageRatio\":" + ((double)result.SampledPixels / Math.Max(1L, (long)result.ComparisonWidth * result.ComparisonHeight)).ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"differentPixels\":" + result.DifferentPixels + ","
                    + "\"differentRatio\":" + result.DifferentRatio.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"meanAbsoluteDifference\":" + result.MeanAbsoluteDifference.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"threshold\":" + threshold.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"withinThreshold\":" + Bool(result.DifferentRatio <= threshold) + ","
                    + "\"note\":\"Pixel diff samples PNG colors; camera timing, async screenshot writes, compression, and dynamic UI may require tolerance.\""
                    + "}";
            }
            catch (ScreenshotValidationException exception)
            {
                return ScreenshotFailure(exception.Code, exception.Message, null);
            }
            finally
            {
                if (baseline != null)
                {
                    UnityEngine.Object.DestroyImmediate(baseline);
                }

                if (current != null)
                {
                    UnityEngine.Object.DestroyImmediate(current);
                }
            }
        }

        private static string HandleScreenshotBaselinesList(UnityMcpRequest request)
        {
            var filter = JsonRpcUtil.ReadString(request.RawJson, "filter", string.Empty);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 50), 500));
            var includeDimensions = JsonRpcUtil.ReadBool(request.RawJson, "includeDimensions", true);
            var directory = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "screenshots"));
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"screenshot-baseline-files\",\"directory\":\"");
            builder.Append(JsonRpcUtil.Escape(directory));
            builder.Append("\",\"filter\":\"");
            builder.Append(JsonRpcUtil.Escape(filter));
            builder.Append("\",\"baselines\":[");

            var count = 0;
            var scanned = 0;
            if (Directory.Exists(directory))
            {
                var files = new List<FileInfo>();
                foreach (var path in Directory.GetFiles(directory, "*.png", SearchOption.TopDirectoryOnly))
                {
                    files.Add(new FileInfo(path));
                }

                files.Sort(delegate (FileInfo left, FileInfo right)
                {
                    return right.LastWriteTimeUtc.CompareTo(left.LastWriteTimeUtc);
                });

                foreach (var file in files)
                {
                    if (count >= limit)
                    {
                        break;
                    }

                    scanned++;
                    var metadataPath = file.FullName + ".json";
                    var metadata = File.Exists(metadataPath) ? File.ReadAllText(metadataPath) : string.Empty;
                    if (!ScreenshotBaselineMatches(file, metadata, filter))
                    {
                        continue;
                    }

                    if (count > 0)
                    {
                        builder.Append(",");
                    }

                    AppendScreenshotBaseline(builder, file, metadataPath, metadata, includeDimensions);
                    count++;
                }
            }

            builder.Append("],\"baselineCount\":");
            builder.Append(count);
            builder.Append(",\"scannedCount\":");
            builder.Append(scanned);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(count >= limit));
            builder.Append(",\"note\":\"Use a returned path as repair_loop_run.screenshotBaselinePath or screenshot_diff.baselinePath.\"}");
            return builder.ToString();
        }

        private static string HandleScreenshotBaselinesCleanup(UnityMcpRequest request)
        {
            var filter = JsonRpcUtil.ReadString(request.RawJson, "filter", string.Empty);
            var olderThanDays = Math.Max(0, JsonRpcUtil.ReadInt(request.RawJson, "olderThanDays", 0));
            var minBytes = Math.Max(0, JsonRpcUtil.ReadInt(request.RawJson, "minBytes", 1));
            var keepNewest = Math.Max(0, JsonRpcUtil.ReadInt(request.RawJson, "keepNewest", 20));
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 100), 1000));
            var includeUnlabeled = JsonRpcUtil.ReadBool(request.RawJson, "includeUnlabeled", true);
            var allowDeleteBaselines = JsonRpcUtil.ReadBool(request.RawJson, "allowDeleteBaselines", false);
            var dryRun = JsonRpcUtil.ReadBool(request.RawJson, "dryRun", true);
            var protectedLabels = ReadRuleSet(JsonRpcUtil.ReadString(request.RawJson, "protectedLabels", string.Empty));
            var cutoffUtc = olderThanDays > 0 ? DateTime.UtcNow.AddDays(-olderThanDays) : DateTime.MinValue;
            var directory = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "screenshots"));
            var files = new List<FileInfo>();
            if (Directory.Exists(directory))
            {
                foreach (var path in Directory.GetFiles(directory, "*.png", SearchOption.TopDirectoryOnly))
                {
                    files.Add(new FileInfo(path));
                }
            }

            files.Sort(delegate (FileInfo left, FileInfo right)
            {
                return right.LastWriteTimeUtc.CompareTo(left.LastWriteTimeUtc);
            });

            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"screenshot-baseline-cleanup\",\"dryRun\":");
            builder.Append(Bool(dryRun));
            builder.Append(",\"directory\":\"");
            builder.Append(JsonRpcUtil.Escape(directory));
            builder.Append("\",\"filter\":\"");
            builder.Append(JsonRpcUtil.Escape(filter));
            builder.Append("\",\"planned\":[");

            var scanned = 0;
            var matched = 0;
            var planned = 0;
            var deleted = 0;
            foreach (var file in files)
            {
                if (planned >= limit)
                {
                    break;
                }

                scanned++;
                var metadataPath = file.FullName + ".json";
                var metadata = File.Exists(metadataPath) ? File.ReadAllText(metadataPath) : string.Empty;
                if (!ScreenshotBaselineMatches(file, metadata, filter))
                {
                    continue;
                }

                var label = JsonRpcUtil.ReadString(metadata, "label", ReadScreenshotLabel(file.Name));
                var protectedReason = ScreenshotCleanupProtectionReason(label, protectedLabels, includeUnlabeled, allowDeleteBaselines);
                if (!string.IsNullOrEmpty(protectedReason))
                {
                    continue;
                }

                var matchIndex = matched;
                matched++;
                var reasons = ScreenshotCleanupReasons(file, matchIndex, keepNewest, olderThanDays, cutoffUtc, minBytes);
                if (string.IsNullOrEmpty(reasons))
                {
                    continue;
                }

                if (planned > 0)
                {
                    builder.Append(",");
                }

                AppendScreenshotCleanupItem(builder, file, metadataPath, metadata, reasons, dryRun);
                planned++;
                if (!dryRun)
                {
                    DeleteScreenshotPair(file.FullName, metadataPath);
                    deleted++;
                }
            }

            builder.Append("],\"scannedCount\":");
            builder.Append(scanned);
            builder.Append(",\"matchedCount\":");
            builder.Append(matched);
            builder.Append(",\"plannedCount\":");
            builder.Append(planned);
            builder.Append(",\"deletedCount\":");
            builder.Append(deleted);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(planned >= limit));
            builder.Append(",\"note\":\"Dry-run by default. Named labels containing 'baseline' and protectedLabels are skipped unless allowDeleteBaselines=true.\"}");
            return builder.ToString();
        }

        internal static ScreenshotAllocationPlan CreateScreenshotAllocationPlan(int requestedWidth, int requestedHeight, int superSize)
        {
            if (requestedWidth <= 0 || requestedHeight <= 0 || superSize <= 0)
            {
                throw new ScreenshotValidationException("INVALID_SCREENSHOT_DIMENSIONS", "width, height, and superSize must be positive integers.");
            }

            if (superSize > 8)
            {
                throw new ScreenshotValidationException("SCREENSHOT_LIMIT_EXCEEDED", "superSize exceeds the supported maximum of 8.");
            }

            var effectiveWidth = (long)requestedWidth * superSize;
            var effectiveHeight = (long)requestedHeight * superSize;
            if (effectiveWidth > MaxScreenshotDimension || effectiveHeight > MaxScreenshotDimension)
            {
                throw new ScreenshotValidationException("SCREENSHOT_LIMIT_EXCEEDED", "Effective screenshot dimensions exceed " + MaxScreenshotDimension + " pixels per axis.");
            }

            var effectivePixels = effectiveWidth * effectiveHeight;
            var estimatedBytes = effectivePixels * 12L;
            if (effectivePixels > MaxScreenshotEffectivePixels || estimatedBytes > MaxScreenshotEstimatedBytes)
            {
                throw new ScreenshotValidationException(
                    "SCREENSHOT_LIMIT_EXCEEDED",
                    "Screenshot allocation exceeds the effective-pixel or estimated-memory limit.");
            }

            return new ScreenshotAllocationPlan
            {
                RequestedWidth = requestedWidth,
                RequestedHeight = requestedHeight,
                SuperSize = superSize,
                EffectiveWidth = (int)effectiveWidth,
                EffectiveHeight = (int)effectiveHeight,
                EffectivePixels = effectivePixels,
                EstimatedBytes = estimatedBytes
            };
        }

        private static string ScreenshotFailure(string code, string message, object details)
        {
            var error = new JObject
            {
                ["code"] = code,
                ["message"] = message
            };
            if (details != null)
            {
                error["data"] = JToken.FromObject(details);
            }

            return new JObject
            {
                ["ok"] = false,
                ["error"] = error
            }.ToString(Formatting.None);
        }

        private static Texture2D LoadScreenshotTexture(string path)
        {
            var info = new FileInfo(path);
            if (info.Length > MaxScreenshotInputBytes)
            {
                throw new ScreenshotValidationException("SCREENSHOT_INPUT_TOO_LARGE", "Screenshot input exceeds the 64 MiB encoded-file limit: " + path);
            }

            int declaredWidth;
            int declaredHeight;
            ReadPngDimensions(path, out declaredWidth, out declaredHeight);
            if (declaredWidth <= 0 || declaredHeight <= 0)
            {
                throw new ScreenshotValidationException("INVALID_SCREENSHOT_IMAGE", "Screenshot is not a supported PNG image: " + path);
            }

            CreateScreenshotAllocationPlan(declaredWidth, declaredHeight, 1);
            var bytes = File.ReadAllBytes(path);
            var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!texture.LoadImage(bytes, false))
            {
                UnityEngine.Object.DestroyImmediate(texture);
                throw new InvalidOperationException("Could not decode PNG screenshot: " + path);
            }

            if (texture.width != declaredWidth || texture.height != declaredHeight)
            {
                UnityEngine.Object.DestroyImmediate(texture);
                throw new ScreenshotValidationException("INVALID_SCREENSHOT_IMAGE", "Decoded screenshot dimensions do not match its PNG header: " + path);
            }

            return texture;
        }

        internal static ScreenshotDiffStats CompareScreenshots(Texture2D baseline, Texture2D current, int maxSamples, bool resampleCurrent)
        {
            if (baseline == null || current == null)
            {
                throw new ArgumentNullException(baseline == null ? "baseline" : "current");
            }

            var dimensionsMatch = baseline.width == current.width && baseline.height == current.height;
            if (!dimensionsMatch && !resampleCurrent)
            {
                throw new ScreenshotValidationException("SCREENSHOT_DIMENSION_MISMATCH", "Screenshot dimensions differ and resampling was not explicitly enabled.");
            }

            var width = baseline.width;
            var height = baseline.height;
            if (width <= 0 || height <= 0)
            {
                throw new ScreenshotValidationException("INVALID_SCREENSHOT_DIMENSIONS", "Screenshots must have positive dimensions.");
            }

            var totalPixels = (long)width * height;
            var sampleLimit = (int)Math.Min(totalPixels, Math.Max(1, maxSamples));
            var sampled = 0;
            var different = 0;
            double totalDifference = 0;
            for (var sampleIndex = 0; sampleIndex < sampleLimit; sampleIndex++)
            {
                var linearIndex = sampleLimit == totalPixels
                    ? sampleIndex
                    : sampleLimit == 1 ? 0L : (long)sampleIndex * (totalPixels - 1) / (sampleLimit - 1);
                var x = (int)(linearIndex % width);
                var y = (int)(linearIndex / width);
                var left = baseline.GetPixel(x, y);
                var right = dimensionsMatch
                    ? current.GetPixel(x, y)
                    : current.GetPixelBilinear((x + 0.5f) / width, (y + 0.5f) / height);
                var difference = (Math.Abs(left.r - right.r) + Math.Abs(left.g - right.g) + Math.Abs(left.b - right.b) + Math.Abs(left.a - right.a)) / 4.0;
                totalDifference += difference;
                if (difference > 0.01)
                {
                    different++;
                }
                sampled++;
            }

            return new ScreenshotDiffStats
            {
                SampledPixels = sampled,
                DifferentPixels = different,
                DifferentRatio = sampled == 0 ? 0f : (float)different / sampled,
                MeanAbsoluteDifference = sampled == 0 ? 0f : (float)(totalDifference / sampled),
                ComparisonWidth = width,
                ComparisonHeight = height,
                ComparisonMethod = sampled == totalPixels
                    ? dimensionsMatch ? "exact-rgba-exact-dimensions" : "exact-rgba-bilinear-current-to-baseline"
                    : dimensionsMatch ? "sampled-rgba-full-domain" : "sampled-rgba-bilinear-full-domain"
            };
        }

        private static string SanitizeFileName(string value)
        {
            var input = string.IsNullOrEmpty(value) ? "ghost" : value;
            var builder = new StringBuilder(input.Length);
            foreach (var character in input)
            {
                if (char.IsLetterOrDigit(character) || character == '-' || character == '_')
                {
                    builder.Append(character);
                }
                else if (char.IsWhiteSpace(character))
                {
                    builder.Append('-');
                }
            }

            return builder.Length == 0 ? "ghost" : builder.ToString();
        }

        private static bool ScreenshotBaselineMatches(FileInfo file, string metadata, string filter)
        {
            if (string.IsNullOrEmpty(filter))
            {
                return true;
            }

            return file.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                || file.FullName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                || (metadata ?? string.Empty).IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string ScreenshotCleanupProtectionReason(string label, HashSet<string> protectedLabels, bool includeUnlabeled, bool allowDeleteBaselines)
        {
            if (string.IsNullOrEmpty(label) && !includeUnlabeled)
            {
                return "unlabeled";
            }

            if (!allowDeleteBaselines && !string.IsNullOrEmpty(label) && label.IndexOf("baseline", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "named-baseline";
            }

            if (!string.IsNullOrEmpty(label) && protectedLabels.Contains(label))
            {
                return "protected-label";
            }

            return string.Empty;
        }

        private static string ScreenshotCleanupReasons(FileInfo file, int matchIndex, int keepNewest, int olderThanDays, DateTime cutoffUtc, int minBytes)
        {
            var reasons = new List<string>();
            if (keepNewest >= 0 && matchIndex >= keepNewest)
            {
                reasons.Add("beyond-keep-newest");
            }

            if (olderThanDays > 0 && file.LastWriteTimeUtc < cutoffUtc)
            {
                reasons.Add("older-than-" + olderThanDays + "-days");
            }

            if (file.Length <= minBytes)
            {
                reasons.Add("empty-or-too-small");
            }

            return string.Join(",", reasons.ToArray());
        }

        private static void AppendScreenshotCleanupItem(StringBuilder builder, FileInfo file, string metadataPath, string metadata, string reasons, bool dryRun)
        {
            builder.Append("{\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(file.FullName));
            builder.Append("\",\"metadataPath\":\"");
            builder.Append(JsonRpcUtil.Escape(File.Exists(metadataPath) ? metadataPath : string.Empty));
            builder.Append("\",\"fileName\":\"");
            builder.Append(JsonRpcUtil.Escape(file.Name));
            builder.Append("\",\"label\":\"");
            builder.Append(JsonRpcUtil.Escape(JsonRpcUtil.ReadString(metadata, "label", ReadScreenshotLabel(file.Name))));
            builder.Append("\",\"bytes\":");
            builder.Append(file.Length);
            builder.Append(",\"lastWriteUtc\":\"");
            builder.Append(file.LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture));
            builder.Append("\",\"reasons\":\"");
            builder.Append(JsonRpcUtil.Escape(reasons));
            builder.Append("\",\"deleted\":");
            builder.Append(Bool(!dryRun));
            builder.Append("}");
        }

        private static void DeleteScreenshotPair(string screenshotPath, string metadataPath)
        {
            if (File.Exists(screenshotPath))
            {
                File.Delete(screenshotPath);
            }

            if (File.Exists(metadataPath))
            {
                File.Delete(metadataPath);
            }
        }

        private static void AppendScreenshotBaseline(StringBuilder builder, FileInfo file, string metadataPath, string metadata, bool includeDimensions)
        {
            var label = JsonRpcUtil.ReadString(metadata, "label", ReadScreenshotLabel(file.Name));
            var timestamp = JsonRpcUtil.ReadString(metadata, "timestampUtc", file.LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture));
            var mode = JsonRpcUtil.ReadString(metadata, "mode", string.Empty);
            var camera = JsonRpcUtil.ReadString(metadata, "camera", string.Empty);
            var activeScenePath = JsonRpcUtil.ReadString(metadata, "activeScenePath", string.Empty);
            var activeSceneName = JsonRpcUtil.ReadString(metadata, "activeSceneName", string.Empty);
            var width = JsonRpcUtil.ReadInt(metadata, "width", 0);
            var height = JsonRpcUtil.ReadInt(metadata, "height", 0);
            if (includeDimensions && (width <= 0 || height <= 0))
            {
                ReadPngDimensions(file.FullName, out width, out height);
            }

            builder.Append("{\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(file.FullName));
            builder.Append("\",\"metadataPath\":\"");
            builder.Append(JsonRpcUtil.Escape(File.Exists(metadataPath) ? metadataPath : string.Empty));
            builder.Append("\",\"fileName\":\"");
            builder.Append(JsonRpcUtil.Escape(file.Name));
            builder.Append("\",\"label\":\"");
            builder.Append(JsonRpcUtil.Escape(label));
            builder.Append("\",\"timestampUtc\":\"");
            builder.Append(JsonRpcUtil.Escape(timestamp));
            builder.Append("\",\"bytes\":");
            builder.Append(file.Length);
            builder.Append(",\"width\":");
            builder.Append(width);
            builder.Append(",\"height\":");
            builder.Append(height);
            builder.Append(",\"mode\":\"");
            builder.Append(JsonRpcUtil.Escape(mode));
            builder.Append("\",\"camera\":\"");
            builder.Append(JsonRpcUtil.Escape(camera));
            builder.Append("\",\"activeScenePath\":\"");
            builder.Append(JsonRpcUtil.Escape(activeScenePath));
            builder.Append("\",\"activeSceneName\":\"");
            builder.Append(JsonRpcUtil.Escape(activeSceneName));
            builder.Append("\"}");
        }

        private static string ReadScreenshotLabel(string fileName)
        {
            var name = Path.GetFileNameWithoutExtension(fileName ?? string.Empty);
            var match = Regex.Match(name, @"^(?<label>.+)-\d{8}-\d{6}(?:-\d{3})?$");
            return match.Success ? match.Groups["label"].Value : name;
        }

        private static void ReadPngDimensions(string path, out int width, out int height)
        {
            width = 0;
            height = 0;
            try
            {
                using (var stream = File.OpenRead(path))
                {
                    var header = new byte[24];
                    if (stream.Read(header, 0, header.Length) != header.Length)
                    {
                        return;
                    }

                    if (header[0] != 137 || header[1] != 80 || header[2] != 78 || header[3] != 71)
                    {
                        return;
                    }

                    width = (header[16] << 24) + (header[17] << 16) + (header[18] << 8) + header[19];
                    height = (header[20] << 24) + (header[21] << 16) + (header[22] << 8) + header[23];
                }
            }
            catch
            {
                width = 0;
                height = 0;
            }
        }

        private static Camera ResolveScreenshotCamera(string mode)
        {
            if (mode == "maincamera" || mode == "game" || mode == "auto")
            {
                var main = Camera.main;
                if (main != null)
                {
                    return main;
                }
            }

            if (mode == "sceneview" || mode == "scene" || mode == "auto")
            {
                var sceneView = SceneView.lastActiveSceneView;
                if (sceneView != null && sceneView.camera != null)
                {
                    return sceneView.camera;
                }
            }

            var anyCamera = UnityEngine.Object.FindObjectOfType<Camera>();
            return anyCamera;
        }

    }
}
