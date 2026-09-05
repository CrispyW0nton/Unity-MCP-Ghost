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
        private static string HandleSemanticAssetReferencesTrace(UnityMcpRequest request)
        {
            var path = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var guid = JsonRpcUtil.ReadString(request.RawJson, "guid", string.Empty);
            if (!string.IsNullOrEmpty(path))
            {
                path = NormalizeAssetPath(path);
                EnsureAssetExists(path);
                guid = AssetDatabase.AssetPathToGUID(path);
            }

            if (string.IsNullOrEmpty(guid))
            {
                throw new InvalidOperationException("semantic.asset_references_trace requires either path or guid.");
            }

            if (string.IsNullOrEmpty(path))
            {
                path = AssetDatabase.GUIDToAssetPath(guid);
            }

            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            var includeSelf = JsonRpcUtil.ReadBool(request.RawJson, "includeSelf", false);
            var extensions = ReadReferenceExtensions(JsonRpcUtil.ReadString(request.RawJson, "extensions", string.Empty));
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"target\":");
            AppendAssetSummary(builder, guid, path);
            builder.Append(",\"source\":\"guid-text-scan\",\"references\":[");

            var count = 0;
            var scanned = 0;
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var files = Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories);
            foreach (var fullPath in files)
            {
                if (count >= limit)
                {
                    break;
                }

                var extension = Path.GetExtension(fullPath);
                if (string.IsNullOrEmpty(extension) || !extensions.Contains(extension))
                {
                    continue;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (!includeSelf && string.Equals(assetPath, path, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                scanned++;
                string text;
                try
                {
                    text = File.ReadAllText(fullPath);
                }
                catch
                {
                    continue;
                }

                if (text.IndexOf(guid, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendAssetReference(builder, assetPath, extension);
                count++;
            }

            builder.Append("],\"referenceCount\":");
            builder.Append(count);
            builder.Append(",\"scannedCount\":");
            builder.Append(scanned);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(count >= limit));
            builder.Append("}");
            return builder.ToString();
        }

        private static string HandleSemanticUnityEventBindingsFind(UnityMcpRequest request)
        {
            var methodName = JsonRpcUtil.ReadString(request.RawJson, "methodName", string.Empty);
            var targetType = JsonRpcUtil.ReadString(request.RawJson, "targetType", string.Empty);
            var assetPath = JsonRpcUtil.ReadString(request.RawJson, "assetPath", string.Empty);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            var extensions = ReadReferenceExtensions(JsonRpcUtil.ReadString(request.RawJson, "extensions", ".prefab,.unity,.asset"));
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"unity-event-yaml-scan\",\"methodName\":\"");
            builder.Append(JsonRpcUtil.Escape(methodName));
            builder.Append("\",\"targetType\":\"");
            builder.Append(JsonRpcUtil.Escape(targetType));
            builder.Append("\",\"bindings\":[");

            var count = 0;
            var scanned = 0;
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var files = string.IsNullOrEmpty(assetPath)
                ? Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories)
                : new[] { FullAssetPath(NormalizeAssetPath(assetPath)) };

            foreach (var fullPath in files)
            {
                if (count >= limit)
                {
                    break;
                }

                var extension = Path.GetExtension(fullPath);
                if (string.IsNullOrEmpty(extension) || !extensions.Contains(extension))
                {
                    continue;
                }

                var currentAssetPath = ToAssetPath(projectRoot, fullPath);
                if (!string.IsNullOrEmpty(assetPath))
                {
                    EnsureAssetExists(currentAssetPath);
                }

                string text;
                try
                {
                    text = File.ReadAllText(fullPath);
                }
                catch
                {
                    continue;
                }

                scanned++;
                count = AppendUnityEventBindings(builder, text, currentAssetPath, extension, methodName, targetType, count, limit);
            }

            builder.Append("],\"bindingCount\":");
            builder.Append(count);
            builder.Append(",\"scannedCount\":");
            builder.Append(scanned);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(count >= limit));
            builder.Append("}");
            return builder.ToString();
        }

        private static string HandleSemanticAnimatorAnalyze(UnityMcpRequest request)
        {
            var path = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            if (!path.EndsWith(".controller", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".overrideController", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("semantic.animator_analyze requires a .controller or .overrideController asset path.");
            }

            EnsureAssetExists(path);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            var text = File.ReadAllText(FullAssetPath(path));
            var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var guid = AssetDatabase.AssetPathToGUID(path);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"animator-controller-yaml-scan\",\"target\":");
            AppendAssetSummary(builder, guid, path);
            builder.Append(",\"parameters\":[");
            var parameterCount = AppendAnimatorParameters(builder, lines, limit);
            builder.Append("],\"stateMachines\":[");
            var stateMachineCount = AppendAnimatorBlocks(builder, lines, "AnimatorStateMachine:", false, limit);
            builder.Append("],\"states\":[");
            var stateCount = AppendAnimatorBlocks(builder, lines, "AnimatorState:", false, limit);
            builder.Append("],\"transitions\":[");
            var transitionCount = AppendAnimatorBlocks(builder, lines, "AnimatorStateTransition:", true, limit);
            builder.Append("],\"summary\":{\"parameterCount\":");
            builder.Append(parameterCount);
            builder.Append(",\"stateMachineCount\":");
            builder.Append(stateMachineCount);
            builder.Append(",\"stateCount\":");
            builder.Append(stateCount);
            builder.Append(",\"transitionCount\":");
            builder.Append(transitionCount);
            builder.Append("}}");
            return builder.ToString();
        }

        private static string HandleSemanticMetaIntegrityCheck(UnityMcpRequest request)
        {
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            var includeMetaOnly = JsonRpcUtil.ReadBool(request.RawJson, "includeMetaOnly", true);
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var seenGuids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var issueCount = 0;
            var scannedAssets = 0;
            var scannedMetas = 0;
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"asset-meta-guid-scan\",\"issues\":[");

            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
            {
                if (issueCount >= limit)
                {
                    break;
                }

                if (fullPath.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipMetaAuditPath(assetPath))
                {
                    continue;
                }

                scannedAssets++;
                var metaPath = fullPath + ".meta";
                if (!File.Exists(metaPath))
                {
                    AppendMetaIssue(builder, ref issueCount, "missing-meta", assetPath, string.Empty, string.Empty);
                    continue;
                }

                scannedMetas++;
                var guid = ReadMetaGuid(metaPath);
                if (string.IsNullOrEmpty(guid))
                {
                    AppendMetaIssue(builder, ref issueCount, "missing-guid", assetPath, ToAssetPath(projectRoot, metaPath), string.Empty);
                    continue;
                }

                string existingPath;
                if (seenGuids.TryGetValue(guid, out existingPath))
                {
                    AppendMetaIssue(builder, ref issueCount, "duplicate-guid", assetPath, ToAssetPath(projectRoot, metaPath), guid, existingPath);
                    continue;
                }

                seenGuids[guid] = assetPath;
            }

            if (includeMetaOnly && issueCount < limit)
            {
                foreach (var metaPath in Directory.GetFiles(Application.dataPath, "*.meta", SearchOption.AllDirectories))
                {
                    if (issueCount >= limit)
                    {
                        break;
                    }

                    var assetFullPath = metaPath.Substring(0, metaPath.Length - ".meta".Length);
                    if (File.Exists(assetFullPath) || Directory.Exists(assetFullPath))
                    {
                        continue;
                    }

                    AppendMetaIssue(builder, ref issueCount, "orphan-meta", ToAssetPath(projectRoot, assetFullPath), ToAssetPath(projectRoot, metaPath), ReadMetaGuid(metaPath));
                }
            }

            builder.Append("],\"issueCount\":");
            builder.Append(issueCount);
            builder.Append(",\"scannedAssetCount\":");
            builder.Append(scannedAssets);
            builder.Append(",\"scannedMetaCount\":");
            builder.Append(scannedMetas);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(issueCount >= limit));
            builder.Append("}");
            return builder.ToString();
        }

        private static string HandleSemanticUnusedAssetsFind(UnityMcpRequest request)
        {
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            var extensions = ReadReferenceExtensions(JsonRpcUtil.ReadString(request.RawJson, "extensions", ".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss"));
            var candidateExtensions = ReadReferenceExtensions(JsonRpcUtil.ReadString(request.RawJson, "candidateExtensions", ".prefab,.mat,.asset,.controller,.overrideController,.anim,.png,.jpg,.jpeg,.tga,.psd,.fbx,.obj,.wav,.mp3,.ogg,.shadergraph,.renderTexture,.uxml,.uss"));
            var includeScripts = JsonRpcUtil.ReadBool(request.RawJson, "includeScripts", false);
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var referencedGuids = BuildReferencedGuidSet(projectRoot, extensions);
            var count = 0;
            var scanned = 0;
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"guid-reference-scan\",\"candidates\":[");

            foreach (var guid in AssetDatabase.FindAssets(string.Empty))
            {
                if (count >= limit)
                {
                    break;
                }

                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path) || AssetDatabase.IsValidFolder(path))
                {
                    continue;
                }

                if (ShouldSkipUnusedCandidate(path, candidateExtensions, includeScripts))
                {
                    continue;
                }

                scanned++;
                if (referencedGuids.Contains(guid))
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendUnusedAssetCandidate(builder, guid, path);
                count++;
            }

            builder.Append("],\"candidateCount\":");
            builder.Append(count);
            builder.Append(",\"scannedCandidateCount\":");
            builder.Append(scanned);
            builder.Append(",\"referencedGuidCount\":");
            builder.Append(referencedGuids.Count);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(count >= limit));
            builder.Append(",\"note\":\"Candidates are conservative GUID-scan results; verify addressables, resources, runtime loads, and external importer manifests before deletion.\"}");
            return builder.ToString();
        }

        private static string HandleSemanticClassImpactAnalyze(UnityMcpRequest request)
        {
            var path = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var className = JsonRpcUtil.ReadString(request.RawJson, "className", string.Empty);
            var methodName = JsonRpcUtil.ReadString(request.RawJson, "methodName", string.Empty);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 200), 2000));

            if (!string.IsNullOrEmpty(path))
            {
                path = EnsureScriptPath(path);
                EnsureAssetExists(path);
            }
            else if (!string.IsNullOrEmpty(className))
            {
                path = FindScriptPathForClass(className);
            }

            if (string.IsNullOrEmpty(path))
            {
                throw new InvalidOperationException("semantic.class_impact_analyze requires path or className.");
            }

            if (string.IsNullOrEmpty(className))
            {
                className = Path.GetFileNameWithoutExtension(path);
            }

            var guid = AssetDatabase.AssetPathToGUID(path);
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"csharp-text-impact-scan\",\"target\":");
            AppendAssetSummary(builder, guid, path);
            builder.Append(",\"className\":\"");
            builder.Append(JsonRpcUtil.Escape(className));
            builder.Append("\",\"methodName\":\"");
            builder.Append(JsonRpcUtil.Escape(methodName));
            builder.Append("\",\"scriptReferences\":[");

            var scriptReferenceCount = AppendScriptReferences(builder, projectRoot, path, className, methodName, limit);
            builder.Append("],\"assetReferences\":[");
            var assetReferenceCount = AppendGuidReferences(builder, projectRoot, guid, path, ReadReferenceExtensions(".prefab,.unity,.asset,.controller,.overrideController"), limit, false);
            builder.Append("],\"suggestedTests\":[");
            var suggestedTestCount = AppendSuggestedTests(builder, projectRoot, className, methodName, limit);
            builder.Append("],\"summary\":{\"scriptReferenceCount\":");
            builder.Append(scriptReferenceCount);
            builder.Append(",\"assetReferenceCount\":");
            builder.Append(assetReferenceCount);
            builder.Append(",\"suggestedTestCount\":");
            builder.Append(suggestedTestCount);
            builder.Append("},\"note\":\"Text scan impact analysis; verify dynamic reflection, serialized strings, addressables, and generated code before risky refactors.\"}");
            return builder.ToString();
        }

        private static string HandleSemanticCallPathFind(UnityMcpRequest request)
        {
            var fromMethod = JsonRpcUtil.ReadString(request.RawJson, "fromMethod", string.Empty);
            var toMethod = JsonRpcUtil.ReadString(request.RawJson, "toMethod", string.Empty);
            var maxDepth = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "maxDepth", 6), 12));
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 20), 100));
            if (string.IsNullOrEmpty(fromMethod) || string.IsNullOrEmpty(toMethod))
            {
                throw new InvalidOperationException("semantic.call_path_find requires fromMethod and toMethod.");
            }

            var methods = BuildMethodIndex();
            var path = FindCallPath(methods, fromMethod, toMethod, maxDepth);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"csharp-text-call-graph\",\"fromMethod\":\"");
            builder.Append(JsonRpcUtil.Escape(fromMethod));
            builder.Append("\",\"toMethod\":\"");
            builder.Append(JsonRpcUtil.Escape(toMethod));
            builder.Append("\",\"maxDepth\":");
            builder.Append(maxDepth);
            builder.Append(",\"pathFound\":");
            builder.Append(Bool(path.Count > 0));
            builder.Append(",\"path\":[");

            for (var index = 0; index < path.Count && index < limit; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                AppendMethodNode(builder, path[index]);
            }

            builder.Append("],\"indexedMethodCount\":");
            builder.Append(methods.Count);
            builder.Append(",\"note\":\"Lightweight text call graph; overloads, delegates, reflection, events, and virtual dispatch require review.\"}");
            return builder.ToString();
        }

        private static string HandleSemanticLintUnityRun(UnityMcpRequest request)
        {
            var path = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var rules = ReadRuleSet(JsonRpcUtil.ReadString(request.RawJson, "rules", string.Empty));
            var includeAssetRules = JsonRpcUtil.ReadBool(request.RawJson, "includeAssetRules", true);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 500), 5000));
            if (!string.IsNullOrEmpty(path))
            {
                path = EnsureScriptPath(path);
                EnsureAssetExists(path);
            }

            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var builder = new StringBuilder();
            var count = 0;
            var scannedScripts = 0;
            builder.Append("{\"ok\":true,\"source\":\"unity-specific-lint-scan\",\"diagnostics\":[");

            var scriptFiles = string.IsNullOrEmpty(path)
                ? Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories)
                : new[] { FullAssetPath(path) };
            foreach (var fullPath in scriptFiles)
            {
                if (count >= limit)
                {
                    break;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipLintScript(assetPath))
                {
                    continue;
                }

                scannedScripts++;
                count = AppendScriptLintDiagnostics(builder, fullPath, assetPath, rules, count, limit);
            }

            var scannedAssetCandidates = 0;
            if (includeAssetRules && string.IsNullOrEmpty(path) && count < limit)
            {
                count = AppendAssetLintDiagnostics(builder, projectRoot, rules, count, limit, out scannedAssetCandidates);
            }

            builder.Append("],\"diagnosticCount\":");
            builder.Append(count);
            builder.Append(",\"scannedScriptCount\":");
            builder.Append(scannedScripts);
            builder.Append(",\"scannedAssetCandidateCount\":");
            builder.Append(scannedAssetCandidates);
            builder.Append(",\"truncated\":");
            builder.Append(Bool(count >= limit));
            builder.Append(",\"note\":\"Unity-specific lint uses deterministic source and GUID scans; review generated code, dynamic runtime loads, and project conventions before applying broad refactors.\"}");
            return builder.ToString();
        }

        private static string HandleSemanticProjectIndexSummary(UnityMcpRequest request)
        {
            var includeDiagnostics = JsonRpcUtil.ReadBool(request.RawJson, "includeDiagnostics", true);
            var limit = Math.Max(10, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 200), 2000));
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var activeScene = SceneManager.GetActiveScene();
            var assetCategoryCounts = NewAssetCategoryCounts();
            var topFolders = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var resourceAssetCount = 0;
            var streamingAssetCount = 0;
            var editorAssetCount = 0;
            var testAssetCount = 0;
            var addressableHintCount = 0;
            var packageAssetCount = 0;
            var assetCount = 0;

            foreach (var guid in AssetDatabase.FindAssets(string.Empty))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                var normalizedAssetPath = path.Replace("\\", "/");
                if (!normalizedAssetPath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) && !string.Equals(normalizedAssetPath, "Assets", StringComparison.OrdinalIgnoreCase))
                {
                    if (normalizedAssetPath.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase))
                    {
                        packageAssetCount++;
                    }

                    continue;
                }

                if (AssetDatabase.IsValidFolder(path))
                {
                    Increment(assetCategoryCounts, "folders");
                    IncrementTopFolder(topFolders, path);
                    continue;
                }

                assetCount++;
                IncrementTopFolder(topFolders, path);
                IncrementAssetCategory(assetCategoryCounts, path);
                var normalized = normalizedAssetPath;
                if (normalized.StartsWith("Assets/Resources/", StringComparison.OrdinalIgnoreCase) || normalized.Contains("/Resources/", StringComparison.OrdinalIgnoreCase))
                {
                    resourceAssetCount++;
                }

                if (normalized.StartsWith("Assets/StreamingAssets/", StringComparison.OrdinalIgnoreCase) || normalized.Contains("/StreamingAssets/", StringComparison.OrdinalIgnoreCase))
                {
                    streamingAssetCount++;
                }

                if (normalized.Contains("/Editor/", StringComparison.OrdinalIgnoreCase))
                {
                    editorAssetCount++;
                }

                if (normalized.Contains("/Tests/", StringComparison.OrdinalIgnoreCase) || normalized.Contains("/Test/", StringComparison.OrdinalIgnoreCase))
                {
                    testAssetCount++;
                }

                if (normalized.Contains("Addressable", StringComparison.OrdinalIgnoreCase))
                {
                    addressableHintCount++;
                }
            }

            var scriptStats = BuildScriptIndexStats(projectRoot, limit);
            var serializedStats = BuildSerializedIndexStats(projectRoot, limit);
            var metaIssueCount = includeDiagnostics ? CountMetaIssues(projectRoot, limit) : 0;
            var unusedSampleCount = includeDiagnostics ? CountUnusedAssetCandidates(projectRoot, limit) : 0;
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"semantic-project-index-summary\",\"project\":{\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(Application.productName));
            builder.Append("\",\"unityVersion\":\"");
            builder.Append(JsonRpcUtil.Escape(Application.unityVersion));
            builder.Append("\",\"projectPath\":\"");
            builder.Append(JsonRpcUtil.Escape(projectRoot));
            builder.Append("\",\"activeBuildTarget\":\"");
            builder.Append(EditorUserBuildSettings.activeBuildTarget);
            builder.Append("\"},\"activeScene\":{\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(activeScene.name));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(activeScene.path));
            builder.Append("\",\"isDirty\":");
            builder.Append(Bool(activeScene.isDirty));
            builder.Append("},\"counts\":{\"assets\":{\"total\":");
            builder.Append(assetCount);
            AppendAssetCategoryCounts(builder, assetCategoryCounts);
            builder.Append(",\"resources\":");
            builder.Append(resourceAssetCount);
            builder.Append(",\"streamingAssets\":");
            builder.Append(streamingAssetCount);
            builder.Append(",\"editorAssets\":");
            builder.Append(editorAssetCount);
            builder.Append(",\"testAssets\":");
            builder.Append(testAssetCount);
            builder.Append(",\"addressableHints\":");
            builder.Append(addressableHintCount);
            builder.Append(",\"packageAssetsExcluded\":");
            builder.Append(packageAssetCount);
            builder.Append("},\"scripts\":");
            AppendScriptIndexStats(builder, scriptStats);
            builder.Append(",\"serializedUnity\":");
            AppendSerializedIndexStats(builder, serializedStats);
            builder.Append(",\"diagnostics\":{\"metaIssueCount\":");
            builder.Append(metaIssueCount);
            builder.Append(",\"unusedAssetSampleCount\":");
            builder.Append(unusedSampleCount);
            builder.Append(",\"sampleLimit\":");
            builder.Append(limit);
            builder.Append("}},\"topFolders\":");
            AppendTopCounts(builder, topFolders, Math.Min(10, limit));
            builder.Append(",\"gameDevDomains\":{");
            builder.Append("\"hasScenes\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "scenes") > 0));
            builder.Append(",\"hasPrefabs\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "prefabs") > 0));
            builder.Append(",\"has2DAssets\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "spritesAndTextures") > 0));
            builder.Append(",\"has3DAssets\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "models") > 0));
            builder.Append(",\"hasAnimation\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "animations") + CountValue(assetCategoryCounts, "animatorControllers") > 0));
            builder.Append(",\"hasAudio\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "audio") > 0));
            builder.Append(",\"hasUI\":");
            builder.Append(Bool(CountValue(assetCategoryCounts, "uiDocuments") > 0 || scriptStats.UiHintCount > 0));
            builder.Append(",\"hasTests\":");
            builder.Append(Bool(testAssetCount > 0 || scriptStats.TestScriptCount > 0));
            builder.Append(",\"usesResourcesFolder\":");
            builder.Append(Bool(resourceAssetCount > 0));
            builder.Append("},\"riskSignals\":{\"resourcesLoadLines\":");
            builder.Append(scriptStats.ResourcesLoadLineCount);
            builder.Append(",\"sendMessageLines\":");
            builder.Append(scriptStats.SendMessageLineCount);
            builder.Append(",\"hotLookupLines\":");
            builder.Append(scriptStats.HotLookupLineCount);
            builder.Append(",\"unityEventBindingCount\":");
            builder.Append(serializedStats.UnityEventBindingCount);
            builder.Append("},\"recommendedNextTools\":[");
            builder.Append("\"console_diagnostics_get\",");
            builder.Append("\"lint_unity_run\",");
            builder.Append("\"unity_event_bindings_find\",");
            builder.Append("\"prefab_references_trace\",");
            builder.Append("\"class_impact_analyze\",");
            builder.Append("\"unused_assets_find\"");
            builder.Append("],\"note\":\"Read-only summary intended as the first semantic resource for game-development agents; counts are deterministic scans and samples, not destructive cleanup advice.\"}");
            return builder.ToString();
        }

        private static string HandleSemanticTestScopeSuggest(UnityMcpRequest request)
        {
            var path = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var className = JsonRpcUtil.ReadString(request.RawJson, "className", string.Empty);
            var methodName = JsonRpcUtil.ReadString(request.RawJson, "methodName", string.Empty);
            var includePlayMode = JsonRpcUtil.ReadBool(request.RawJson, "includePlayMode", true);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 20), 200));

            if (!string.IsNullOrEmpty(path))
            {
                path = EnsureScriptPath(path);
                EnsureAssetExists(path);
            }
            else if (!string.IsNullOrEmpty(className))
            {
                path = FindScriptPathForClass(className);
            }

            if (string.IsNullOrEmpty(path))
            {
                throw new InvalidOperationException("semantic.test_scope_suggest requires path or className.");
            }

            if (string.IsNullOrEmpty(className))
            {
                className = Path.GetFileNameWithoutExtension(path);
            }

            var guid = AssetDatabase.AssetPathToGUID(path);
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var scriptReferenceCount = CountScriptSymbolReferences(projectRoot, path, className, methodName, limit * 5);
            var serializedReferenceCount = CountGuidReferenceFiles(projectRoot, guid, path, ReadReferenceExtensions(".prefab,.unity,.asset,.controller,.overrideController"), limit * 5, false);
            var suggestions = BuildTestScopeSuggestions(projectRoot, path, className, methodName, includePlayMode, limit);
            var risk = DetermineTestScopeRisk(scriptReferenceCount, serializedReferenceCount, suggestions.Count);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"source\":\"semantic-test-scope-scan\",\"target\":");
            AppendAssetSummary(builder, guid, path);
            builder.Append(",\"className\":\"");
            builder.Append(JsonRpcUtil.Escape(className));
            builder.Append("\",\"methodName\":\"");
            builder.Append(JsonRpcUtil.Escape(methodName));
            builder.Append("\",\"impact\":{\"scriptReferenceCount\":");
            builder.Append(scriptReferenceCount);
            builder.Append(",\"serializedReferenceCount\":");
            builder.Append(serializedReferenceCount);
            builder.Append(",\"risk\":\"");
            builder.Append(risk);
            builder.Append("\"},\"suggestedTests\":[");
            for (var index = 0; index < suggestions.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                AppendTestScopeSuggestion(builder, suggestions[index]);
            }

            builder.Append("],\"validationPlan\":[");
            AppendValidationStep(builder, "script_validate", "{\"path\":\"" + JsonRpcUtil.Escape(path) + "\"}", "Validate the changed C# file before asking Unity to run scenes or tests.");
            builder.Append(",");
            AppendValidationStep(builder, "lint_unity_run", "{\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"includeAssetRules\":false}", "Catch Unity-specific gameplay risks close to the changed script.");
            builder.Append(",");
            AppendValidationStep(builder, "compile_wait", "{\"timeoutMs\":30000}", "Wait for Unity compilation before reading diagnostics.");
            if (suggestions.Count > 0)
            {
                builder.Append(",");
                AppendValidationStep(builder, "tests_run", "{\"mode\":\"" + JsonRpcUtil.Escape(PreferredTestMode(suggestions)) + "\",\"filter\":\"" + JsonRpcUtil.Escape(PreferredTestFilter(suggestions)) + "\",\"dryRun\":true}", "Dry-run the most relevant test filter before executing it.");
            }

            if (serializedReferenceCount > 0 && includePlayMode)
            {
                builder.Append(",");
                AppendValidationStep(builder, "tests_run", "{\"mode\":\"playmode\",\"dryRun\":true}", "Serialized scene/prefab references mean PlayMode smoke coverage may be needed.");
            }

            builder.Append("],\"manualChecks\":[");
            builder.Append("\"Inspect UnityEvent bindings before renaming public methods or serialized fields.\",");
            builder.Append("\"Trace prefab references before deleting or moving scripts used by imported KOTOR assets.\",");
            builder.Append("\"Capture a screenshot after scene-facing changes to verify visible regressions.\"");
            builder.Append("],\"note\":\"Suggestions are deterministic source/path heuristics; use them to choose a focused validation path, not as proof that broader QA is unnecessary.\"}");
            return builder.ToString();
        }

    }
}
