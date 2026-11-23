using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    // Project setup operations that course and prototype projects need before any gameplay work:
    // Player settings (product name, default resolution), named layers and tags, texture import
    // settings for UI sprites, and importing a local .unitypackage asset pack.
    internal sealed partial class CommandRegistry
    {
        private static readonly string[] FullScreenModeNames = { "ExclusiveFullScreen", "FullScreenWindow", "MaximizedWindow", "Windowed" };

        private static JObject ProjectSetupParams(UnityMcpRequest request)
        {
            return string.IsNullOrWhiteSpace(request.RawJson) ? new JObject() : JObject.Parse(request.RawJson);
        }

        private static string HandleProjectSettingsSet(UnityMcpRequest request)
        {
            var input = ProjectSetupParams(request);
            var dryRun = input.Value<bool?>("dryRun") ?? false;
            var before = PlayerSettingsSnapshot();
            var planned = new JObject();

            var productName = input.Value<string>("productName");
            var companyName = input.Value<string>("companyName");
            var width = input.Value<int?>("defaultScreenWidth");
            var height = input.Value<int?>("defaultScreenHeight");
            var fullScreenMode = input.Value<string>("fullScreenMode");
            var runInBackground = input.Value<bool?>("runInBackground");

            if (productName != null)
            {
                if (productName.Trim().Length == 0 || productName.Length > 128) throw new ArgumentException("productName must be 1-128 characters");
                planned["productName"] = productName;
            }
            if (companyName != null)
            {
                if (companyName.Trim().Length == 0 || companyName.Length > 128) throw new ArgumentException("companyName must be 1-128 characters");
                planned["companyName"] = companyName;
            }
            if (width.HasValue || height.HasValue)
            {
                if (!width.HasValue || !height.HasValue) throw new ArgumentException("defaultScreenWidth and defaultScreenHeight must be set together");
                if (width.Value < 320 || width.Value > 7680 || height.Value < 240 || height.Value > 4320) throw new ArgumentException("Resolution must be between 320x240 and 7680x4320");
                planned["defaultScreenWidth"] = width.Value;
                planned["defaultScreenHeight"] = height.Value;
            }
            if (fullScreenMode != null)
            {
                if (Array.IndexOf(FullScreenModeNames, fullScreenMode) < 0) throw new ArgumentException("fullScreenMode must be one of " + string.Join(", ", FullScreenModeNames));
                planned["fullScreenMode"] = fullScreenMode;
            }
            if (runInBackground.HasValue)
            {
                planned["runInBackground"] = runInBackground.Value;
            }
            if (planned.Count == 0) throw new ArgumentException("No project settings were supplied");

            if (dryRun)
            {
                return new JObject { ["ok"] = true, ["dryRun"] = true, ["before"] = before, ["planned"] = planned }.ToString(Newtonsoft.Json.Formatting.None);
            }

            if (productName != null) PlayerSettings.productName = productName;
            if (companyName != null) PlayerSettings.companyName = companyName;
            if (width.HasValue)
            {
                PlayerSettings.defaultScreenWidth = width.Value;
                PlayerSettings.defaultScreenHeight = height.Value;
            }
            if (fullScreenMode != null) PlayerSettings.fullScreenMode = (FullScreenMode)Enum.Parse(typeof(FullScreenMode), fullScreenMode);
            if (runInBackground.HasValue) PlayerSettings.runInBackground = runInBackground.Value;
            AssetDatabase.SaveAssets();
            return new JObject { ["ok"] = true, ["before"] = before, ["after"] = PlayerSettingsSnapshot() }.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static JObject PlayerSettingsSnapshot()
        {
            return new JObject
            {
                ["productName"] = PlayerSettings.productName,
                ["companyName"] = PlayerSettings.companyName,
                ["defaultScreenWidth"] = PlayerSettings.defaultScreenWidth,
                ["defaultScreenHeight"] = PlayerSettings.defaultScreenHeight,
                ["fullScreenMode"] = PlayerSettings.fullScreenMode.ToString(),
                ["runInBackground"] = PlayerSettings.runInBackground
            };
        }

        private static string HandleProjectLayersSet(UnityMcpRequest request)
        {
            var input = ProjectSetupParams(request);
            var dryRun = input.Value<bool?>("dryRun") ?? false;
            var tagManager = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset")[0]);
            var layerProperty = tagManager.FindProperty("layers");
            var tagProperty = tagManager.FindProperty("tags");
            var changes = new JArray();

            foreach (var item in input["layers"] as JArray ?? new JArray())
            {
                var index = item.Value<int?>("index") ?? -1;
                var name = item.Value<string>("name") ?? string.Empty;
                // Layers 0-5 are reserved by Unity; user layers are 6-31 (3 is unnamed but kept builtin)
                if (index < 6 || index > 31) throw new ArgumentException("Layer index must be a user layer between 6 and 31");
                if (name.Trim().Length == 0 || name.Length > 64) throw new ArgumentException("Layer name must be 1-64 characters");
                var current = layerProperty.GetArrayElementAtIndex(index).stringValue;
                var existing = LayerMask.NameToLayer(name);
                if (existing >= 0 && existing != index) throw new InvalidOperationException("Layer '" + name + "' already exists at index " + existing);
                if (!string.IsNullOrEmpty(current) && current != name && !(item.Value<bool?>("replace") ?? false))
                {
                    throw new InvalidOperationException("Layer " + index + " is already named '" + current + "'; pass replace=true to rename it");
                }
                changes.Add(new JObject { ["kind"] = "layer", ["index"] = index, ["from"] = current, ["to"] = name });
                if (!dryRun) layerProperty.GetArrayElementAtIndex(index).stringValue = name;
            }

            var existingTags = new HashSet<string>(UnityEditorInternal.InternalEditorUtility.tags, StringComparer.Ordinal);
            foreach (var item in input["tags"] as JArray ?? new JArray())
            {
                var name = item.Value<string>("name") ?? string.Empty;
                if (name.Trim().Length == 0 || name.Length > 64) throw new ArgumentException("Tag name must be 1-64 characters");
                if (existingTags.Contains(name)) continue;
                changes.Add(new JObject { ["kind"] = "tag", ["to"] = name });
                existingTags.Add(name);
                if (!dryRun)
                {
                    tagProperty.InsertArrayElementAtIndex(tagProperty.arraySize);
                    tagProperty.GetArrayElementAtIndex(tagProperty.arraySize - 1).stringValue = name;
                }
            }
            if (changes.Count == 0 && (input["layers"] == null && input["tags"] == null)) throw new ArgumentException("Supply layers and/or tags");

            if (!dryRun)
            {
                tagManager.ApplyModifiedPropertiesWithoutUndo();
                AssetDatabase.SaveAssets();
            }
            return new JObject { ["ok"] = true, ["dryRun"] = dryRun, ["changes"] = changes }.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static string HandleAssetTextureImportSet(UnityMcpRequest request)
        {
            var input = ProjectSetupParams(request);
            var dryRun = input.Value<bool?>("dryRun") ?? false;
            var path = NormalizeAssetPath(input.Value<string>("path") ?? string.Empty);
            var paths = new List<string>();
            if (AssetDatabase.IsValidFolder(path))
            {
                foreach (var guid in AssetDatabase.FindAssets("t:Texture2D", new[] { path })) paths.Add(AssetDatabase.GUIDToAssetPath(guid));
            }
            else
            {
                EnsureAssetExists(path);
                paths.Add(path);
            }
            if (paths.Count > 500) throw new InvalidOperationException("Refusing to reimport more than 500 textures in one call");

            var textureType = input.Value<string>("textureType");
            var filterMode = input.Value<string>("filterMode");
            var mipmaps = input.Value<bool?>("mipmaps");
            var alpha = input.Value<bool?>("alphaIsTransparency");
            var aniso = input.Value<int?>("anisoLevel");
            var maxSize = input.Value<int?>("maxSize");
            if (textureType != null && textureType != "Default" && textureType != "Sprite" && textureType != "NormalMap") throw new ArgumentException("textureType must be Default, Sprite or NormalMap");
            if (filterMode != null && filterMode != "Point" && filterMode != "Bilinear" && filterMode != "Trilinear") throw new ArgumentException("filterMode must be Point, Bilinear or Trilinear");
            if (aniso.HasValue && (aniso.Value < 0 || aniso.Value > 16)) throw new ArgumentException("anisoLevel must be 0-16");
            if (maxSize.HasValue && Array.IndexOf(new[] { 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384 }, maxSize.Value) < 0) throw new ArgumentException("maxSize must be a power of two from 32 to 16384");

            var results = new JArray();
            foreach (var texturePath in paths)
            {
                var importer = AssetImporter.GetAtPath(texturePath) as TextureImporter;
                if (importer == null) continue;
                results.Add(new JObject { ["path"] = texturePath, ["textureType"] = importer.textureType.ToString(), ["filterMode"] = importer.filterMode.ToString() });
                if (dryRun) continue;
                if (textureType == "Sprite") { importer.textureType = TextureImporterType.Sprite; importer.spriteImportMode = SpriteImportMode.Single; }
                if (textureType == "Default") importer.textureType = TextureImporterType.Default;
                if (textureType == "NormalMap") importer.textureType = TextureImporterType.NormalMap;
                if (filterMode != null) importer.filterMode = (FilterMode)Enum.Parse(typeof(FilterMode), filterMode);
                if (mipmaps.HasValue) importer.mipmapEnabled = mipmaps.Value;
                if (alpha.HasValue) importer.alphaIsTransparency = alpha.Value;
                if (aniso.HasValue) importer.anisoLevel = aniso.Value;
                if (maxSize.HasValue) importer.maxTextureSize = maxSize.Value;
                importer.SaveAndReimport();
            }
            return new JObject { ["ok"] = true, ["dryRun"] = dryRun, ["count"] = results.Count, ["textures"] = results }.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static string HandleAssetImportUnityPackage(UnityMcpRequest request)
        {
            var input = ProjectSetupParams(request);
            var dryRun = input.Value<bool?>("dryRun") ?? true;
            var packagePath = input.Value<string>("packagePath") ?? string.Empty;
            if (!Path.IsPathRooted(packagePath)) throw new ArgumentException("packagePath must be an absolute path to a local .unitypackage file");
            if (!packagePath.EndsWith(".unitypackage", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Only .unitypackage files can be imported");
            var file = new FileInfo(packagePath);
            if (!file.Exists) throw new FileNotFoundException("Package not found", packagePath);
            if (file.Length > 2L * 1024 * 1024 * 1024) throw new InvalidOperationException("Package is larger than 2 GB");
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) throw new InvalidOperationException("Editor must be idle and out of Play mode");

            var result = new JObject { ["ok"] = true, ["dryRun"] = dryRun, ["packagePath"] = file.FullName, ["bytes"] = file.Length };
            if (dryRun) return result.ToString(Newtonsoft.Json.Formatting.None);

            // Non-interactive import; Unity queues it and then refreshes and recompiles on its own.
            AssetDatabase.ImportPackage(file.FullName, false);
            result["queued"] = true;
            result["next"] = "Wait for compile_wait / editor_state to report idle, then asset_find under the package's root folder.";
            return result.ToString(Newtonsoft.Json.Formatting.None);
        }
    }
}
