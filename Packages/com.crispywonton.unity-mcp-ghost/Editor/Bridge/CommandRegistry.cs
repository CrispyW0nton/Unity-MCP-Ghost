using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.SceneManagement;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class CommandRegistry
    {
        private readonly Dictionary<string, Func<UnityMcpRequest, string>> handlers = new Dictionary<string, Func<UnityMcpRequest, string>>();

        public CommandRegistry()
        {
            Register("ping", HandlePing);
            Register("health", HandleHealth);
            Register("editor.get_state", HandleEditorState);
            Register("console.get_logs", HandleConsoleLogs);
            Register("console.diagnostics_get", HandleConsoleDiagnostics);
            Register("compile.diagnostics_get", HandleCompileDiagnostics);
            Register("scene.get_hierarchy", HandleSceneHierarchy);
            Register("scene.create", HandleSceneCreate);
            Register("scene.open", HandleSceneOpen);
            Register("scene.save", HandleSceneSave);
            Register("scene.save_all", HandleSceneSaveAll);
            Register("scene.list_open", HandleSceneListOpen);
            Register("scene.get_setup", HandleSceneGetSetup);
            Register("scene.set_active", HandleSceneSetActive);
            Register("scene.unload", HandleSceneUnload);
            Register("gameobject.create", HandleGameObjectCreate);
            Register("gameobject.create_primitive", HandleGameObjectCreatePrimitive);
            Register("gameobject.set_transform", HandleGameObjectSetTransform);
            Register("gameobject.find", HandleGameObjectFind);
            Register("gameobject.get", HandleGameObjectGet);
            Register("gameobject.delete", HandleGameObjectDelete);
            Register("gameobject.duplicate", HandleGameObjectDuplicate);
            Register("gameobject.set_parent", HandleGameObjectSetParent);
            Register("component.add", HandleComponentAdd);
            Register("component.get", HandleComponentGet);
            Register("component.modify", HandleComponentModify);
            Register("component.remove", HandleComponentRemove);
            Register("asset.find", HandleAssetFind);
            Register("semantic.asset_references_trace", HandleSemanticAssetReferencesTrace);
            Register("prefab.references_trace", HandleSemanticAssetReferencesTrace);
            Register("semantic.unity_event_bindings_find", HandleSemanticUnityEventBindingsFind);
            Register("semantic.animator_analyze", HandleSemanticAnimatorAnalyze);
            Register("semantic.meta_integrity_check", HandleSemanticMetaIntegrityCheck);
            Register("semantic.unused_assets_find", HandleSemanticUnusedAssetsFind);
            Register("semantic.class_impact_analyze", HandleSemanticClassImpactAnalyze);
            Register("semantic.call_path_find", HandleSemanticCallPathFind);
            Register("semantic.lint_unity_run", HandleSemanticLintUnityRun);
            Register("semantic.project_index_summary", HandleSemanticProjectIndexSummary);
            Register("semantic.test_scope_suggest", HandleSemanticTestScopeSuggest);
            Register("asset.create_folder", HandleAssetCreateFolder);
            Register("asset.move", HandleAssetMove);
            Register("asset.copy", HandleAssetCopy);
            Register("asset.delete", HandleAssetDelete);
            Register("asset.refresh", HandleAssetRefresh);
            Register("script.read", HandleScriptRead);
            Register("script.create", HandleScriptCreate);
            Register("script.write", HandleScriptWrite);
            Register("script.apply_edits", HandleScriptApplyEdits);
            Register("script.delete", HandleScriptDelete);
            Register("script.validate", HandleScriptValidate);
            Register("package.list", HandlePackageList);
            Register("package.search", HandlePackageSearch);
            Register("package.add", HandlePackageAdd);
            Register("package.remove", HandlePackageRemove);
            Register("operation.get", HandleOperationGet);
            Register("operation.list", HandleOperationList);
            Register("compile.wait", HandleCompileWait);
            Register("tests.run", HandleTestsRun);
            Register("prefab.create", HandlePrefabCreate);
            Register("prefab.instantiate", HandlePrefabInstantiate);
            Register("screenshot.capture", HandleScreenshotCapture);
            Register("screenshot.diff", HandleScreenshotDiff);
            Register("batch.execute", HandleBatchExecute);
        }

        public string Execute(UnityMcpRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.Method))
            {
                return JsonRpcUtil.Error(request != null ? request.Id : string.Empty, -32600, "Invalid JSON-RPC request.");
            }

            if (!handlers.TryGetValue(request.Method, out var handler))
            {
                return JsonRpcUtil.Error(request.Id, -32601, "Unknown Unity MCP command: " + request.Method);
            }

            try
            {
                return JsonRpcUtil.Success(request.Id, ExecuteResult(request));
            }
            catch (Exception exception)
            {
                return JsonRpcUtil.Error(request.Id, -32000, exception.Message);
            }
        }

        private string ExecuteResult(UnityMcpRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.Method))
            {
                throw new InvalidOperationException("Invalid JSON-RPC request.");
            }

            if (!handlers.TryGetValue(request.Method, out var handler))
            {
                throw new InvalidOperationException("Unknown Unity MCP command: " + request.Method);
            }

            return handler(request);
        }

        private void Register(string method, Func<UnityMcpRequest, string> handler)
        {
            handlers[method] = handler;
        }

        private static string HandlePing(UnityMcpRequest request)
        {
            return "{\"ok\":true,\"package\":\"" + UnityMcpGhostConfig.PackageName + "\",\"version\":\"" + UnityMcpGhostConfig.Version + "\"}";
        }

        private static string HandleHealth(UnityMcpRequest request)
        {
            var activeScene = SceneManager.GetActiveScene();
            return "{"
                + "\"ok\":true,"
                + "\"package\":\"" + UnityMcpGhostConfig.PackageName + "\","
                + "\"version\":\"" + UnityMcpGhostConfig.Version + "\","
                + "\"unityVersion\":\"" + JsonRpcUtil.Escape(Application.unityVersion) + "\","
                + "\"projectPath\":\"" + JsonRpcUtil.Escape(Application.dataPath) + "\","
                + "\"activeScenePath\":\"" + JsonRpcUtil.Escape(activeScene.path) + "\","
                + "\"isCompiling\":" + Bool(EditorApplication.isCompiling) + ","
                + "\"isPlaying\":" + Bool(EditorApplication.isPlaying) + ","
                + "\"isPaused\":" + Bool(EditorApplication.isPaused) + ","
                + "\"durableQueue\":" + DurableCommandQueue.StatusJson()
                + "}";
        }

        private static string HandleEditorState(UnityMcpRequest request)
        {
            var activeScene = SceneManager.GetActiveScene();
            return "{"
                + "\"ok\":true,"
                + "\"isCompiling\":" + Bool(EditorApplication.isCompiling) + ","
                + "\"isPlaying\":" + Bool(EditorApplication.isPlaying) + ","
                + "\"isPaused\":" + Bool(EditorApplication.isPaused) + ","
                + "\"isUpdating\":" + Bool(EditorApplication.isUpdating) + ","
                + "\"activeScenePath\":\"" + JsonRpcUtil.Escape(activeScene.path) + "\","
                + "\"activeSceneName\":\"" + JsonRpcUtil.Escape(activeScene.name) + "\","
                + "\"activeBuildTarget\":\"" + EditorUserBuildSettings.activeBuildTarget + "\","
                + "\"unityVersion\":\"" + JsonRpcUtil.Escape(Application.unityVersion) + "\","
                + "\"projectPath\":\"" + JsonRpcUtil.Escape(Application.dataPath) + "\""
                + "}";
        }

        private static string HandleConsoleLogs(UnityMcpRequest request)
        {
            var severity = JsonRpcUtil.ReadString(request.RawJson, "severity", "all");
            var limit = JsonRpcUtil.ReadInt(request.RawJson, "limit", 200);
            return ConsoleLogBuffer.Read(severity, limit);
        }

        private static string HandleConsoleDiagnostics(UnityMcpRequest request)
        {
            var severity = JsonRpcUtil.ReadString(request.RawJson, "severity", "error");
            var limit = JsonRpcUtil.ReadInt(request.RawJson, "limit", 200);
            var pathFilter = JsonRpcUtil.ReadString(request.RawJson, "pathFilter", string.Empty);
            return ConsoleLogBuffer.Diagnostics(severity, limit, pathFilter);
        }

        private static string HandleCompileDiagnostics(UnityMcpRequest request)
        {
            var severity = JsonRpcUtil.ReadString(request.RawJson, "severity", "error");
            var limit = JsonRpcUtil.ReadInt(request.RawJson, "limit", 200);
            var pathFilter = JsonRpcUtil.ReadString(request.RawJson, "pathFilter", string.Empty);
            return CompileDiagnosticBuffer.Diagnostics(severity, limit, pathFilter);
        }

        private static string HandleSceneHierarchy(UnityMcpRequest request)
        {
            var scene = SceneManager.GetActiveScene();
            var includeInactive = JsonRpcUtil.ReadBool(request.RawJson, "includeInactive", true);
            var maxDepth = JsonRpcUtil.ReadInt(request.RawJson, "maxDepth", 32);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"scene\":\"");
            builder.Append(JsonRpcUtil.Escape(scene.path));
            builder.Append("\",\"roots\":[");

            var roots = scene.GetRootGameObjects();
            var rootCount = 0;
            for (var index = 0; index < roots.Length; index++)
            {
                if (!includeInactive && !roots[index].activeInHierarchy)
                {
                    continue;
                }

                if (rootCount > 0)
                {
                    builder.Append(",");
                }

                AppendGameObject(builder, roots[index], 0, maxDepth, includeInactive);
                rootCount++;
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleSceneCreate(UnityMcpRequest request)
        {
            var setupValue = JsonRpcUtil.ReadString(request.RawJson, "setup", "default");
            var modeValue = JsonRpcUtil.ReadString(request.RawJson, "mode", "single");
            var setup = string.Equals(setupValue, "empty", StringComparison.OrdinalIgnoreCase)
                ? NewSceneSetup.EmptyScene
                : NewSceneSetup.DefaultGameObjects;
            var mode = string.Equals(modeValue, "additive", StringComparison.OrdinalIgnoreCase)
                ? NewSceneMode.Additive
                : NewSceneMode.Single;

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.create\",\"setup\":\"" + JsonRpcUtil.Escape(setupValue) + "\",\"mode\":\"" + JsonRpcUtil.Escape(modeValue) + "\"}}";
            }

            var scene = EditorSceneManager.NewScene(setup, mode);
            return SceneResult(scene);
        }

        private static string HandleSceneOpen(UnityMcpRequest request)
        {
            var path = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var modeValue = JsonRpcUtil.ReadString(request.RawJson, "mode", "single");
            var mode = string.Equals(modeValue, "additive", StringComparison.OrdinalIgnoreCase)
                ? OpenSceneMode.Additive
                : OpenSceneMode.Single;

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.open\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"mode\":\"" + JsonRpcUtil.Escape(modeValue) + "\"}}";
            }

            var scene = EditorSceneManager.OpenScene(path, mode);
            return SceneResult(scene);
        }

        private static string HandleSceneSave(UnityMcpRequest request)
        {
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                var active = SceneManager.GetActiveScene();
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.save\",\"scenePath\":\"" + JsonRpcUtil.Escape(active.path) + "\"}}";
            }

            var scene = SceneManager.GetActiveScene();
            var saved = EditorSceneManager.SaveScene(scene);
            return "{\"ok\":" + Bool(saved) + ",\"scenePath\":\"" + JsonRpcUtil.Escape(scene.path) + "\"}";
        }

        private static string HandleSceneSaveAll(UnityMcpRequest request)
        {
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.save_all\",\"openSceneCount\":" + SceneManager.sceneCount + "}}";
            }

            var saved = EditorSceneManager.SaveOpenScenes();
            return "{\"ok\":" + Bool(saved) + ",\"openSceneCount\":" + SceneManager.sceneCount + "}";
        }

        private static string HandleSceneListOpen(UnityMcpRequest request)
        {
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"scenes\":[");

            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                var scene = SceneManager.GetSceneAt(index);
                AppendScene(builder, scene);
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleSceneGetSetup(UnityMcpRequest request)
        {
            var setup = EditorSceneManager.GetSceneManagerSetup();
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"setup\":[");

            for (var index = 0; index < setup.Length; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"path\":\"");
                builder.Append(JsonRpcUtil.Escape(setup[index].path));
                builder.Append("\",\"isLoaded\":");
                builder.Append(Bool(setup[index].isLoaded));
                builder.Append(",\"isActive\":");
                builder.Append(Bool(setup[index].isActive));
                builder.Append("}");
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleSceneSetActive(UnityMcpRequest request)
        {
            var scene = ResolveOpenScene(request);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.set_active\",\"scene\":\"" + JsonRpcUtil.Escape(scene.path) + "\"}}";
            }

            var changed = SceneManager.SetActiveScene(scene);
            return "{\"ok\":" + Bool(changed) + ",\"scene\":" + SceneObjectJson(scene) + "}";
        }

        private static string HandleSceneUnload(UnityMcpRequest request)
        {
            var scene = ResolveOpenScene(request);
            var removeScene = JsonRpcUtil.ReadBool(request.RawJson, "removeScene", true);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.unload\",\"scene\":\"" + JsonRpcUtil.Escape(scene.path) + "\",\"removeScene\":" + Bool(removeScene) + "}}";
            }

            var closed = EditorSceneManager.CloseScene(scene, removeScene);
            return "{\"ok\":" + Bool(closed) + ",\"scenePath\":\"" + JsonRpcUtil.Escape(scene.path) + "\"}";
        }

        private static string HandleGameObjectCreate(UnityMcpRequest request)
        {
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", "GameObject");
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return PlannedGameObjectMutation("gameobject.create", name, request);
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Create GameObject");
            var undoGroupId = Undo.GetCurrentGroup();

            var gameObject = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(gameObject, "MCP: Create GameObject");
            SetTransformFromRequest(gameObject, request);

            return GameObjectResult(gameObject, undoGroupId);
        }

        private static string HandleGameObjectCreatePrimitive(UnityMcpRequest request)
        {
            var primitiveName = JsonRpcUtil.ReadString(request.RawJson, "primitive", "Cube");
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", primitiveName);
            var primitiveType = ParsePrimitiveType(primitiveName);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return PlannedGameObjectMutation("gameobject.create_primitive", name, request, primitiveType.ToString());
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Create Primitive");
            var undoGroupId = Undo.GetCurrentGroup();

            var gameObject = GameObject.CreatePrimitive(primitiveType);
            gameObject.name = name;
            Undo.RegisterCreatedObjectUndo(gameObject, "MCP: Create Primitive");
            SetTransformFromRequest(gameObject, request);

            return GameObjectResult(gameObject, undoGroupId);
        }

        private static string HandleGameObjectSetTransform(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var gameObject = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return PlannedGameObjectMutation("gameobject.set_transform", gameObject.name, request);
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Set Transform");
            var undoGroupId = Undo.GetCurrentGroup();
            Undo.RecordObject(gameObject.transform, "MCP: Set Transform");
            SetTransformFromRequest(gameObject, request);
            return GameObjectResult(gameObject, undoGroupId);
        }

        private static string HandleGameObjectFind(UnityMcpRequest request)
        {
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", string.Empty);
            var includeInactive = JsonRpcUtil.ReadBool(request.RawJson, "includeInactive", true);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"matches\":[");

            var allObjects = Resources.FindObjectsOfTypeAll<GameObject>();
            var count = 0;
            foreach (var gameObject in allObjects)
            {
                if (!includeInactive && !gameObject.activeInHierarchy)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(name) && gameObject.name.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendGameObjectSummary(builder, gameObject);
                count++;
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleGameObjectGet(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var gameObject = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            return GameObjectResult(gameObject, null);
        }

        private static string HandleGameObjectDelete(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var gameObject = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"gameobject.delete\",\"instanceId\":" + instanceId + ",\"name\":\"" + JsonRpcUtil.Escape(gameObject.name) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Delete GameObject");
            var undoGroupId = Undo.GetCurrentGroup();
            var name = gameObject.name;
            Undo.DestroyObjectImmediate(gameObject);
            return "{\"ok\":true,\"deleted\":{\"name\":\"" + JsonRpcUtil.Escape(name) + "\",\"instanceId\":" + instanceId + "},\"undoGroupId\":" + undoGroupId + "}";
        }

        private static string HandleGameObjectDuplicate(UnityMcpRequest request)
        {
            var original = ResolveGameObject(JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0));
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", original.name + " Copy");
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"gameobject.duplicate\",\"sourceInstanceId\":" + original.GetInstanceID() + ",\"name\":\"" + JsonRpcUtil.Escape(name) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Duplicate GameObject");
            var undoGroupId = Undo.GetCurrentGroup();
            var duplicate = UnityEngine.Object.Instantiate(original, original.transform.parent);
            duplicate.name = name;
            Undo.RegisterCreatedObjectUndo(duplicate, "MCP: Duplicate GameObject");
            return GameObjectResult(duplicate, undoGroupId);
        }

        private static string HandleGameObjectSetParent(UnityMcpRequest request)
        {
            var child = ResolveGameObject(JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0));
            var parentInstanceId = JsonRpcUtil.ReadInt(request.RawJson, "parentInstanceId", 0);
            var parent = parentInstanceId == 0 ? null : ResolveGameObject(parentInstanceId);
            var worldPositionStays = JsonRpcUtil.ReadBool(request.RawJson, "worldPositionStays", true);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"gameobject.set_parent\",\"child\":\"" + JsonRpcUtil.Escape(child.name) + "\",\"parent\":\"" + JsonRpcUtil.Escape(parent == null ? string.Empty : parent.name) + "\",\"worldPositionStays\":" + Bool(worldPositionStays) + "}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Set Parent");
            var undoGroupId = Undo.GetCurrentGroup();
            Undo.SetTransformParent(child.transform, parent == null ? null : parent.transform, "MCP: Set Parent");
            if (!worldPositionStays)
            {
                Undo.RecordObject(child.transform, "MCP: Reset Local Transform");
                child.transform.localPosition = Vector3.zero;
                child.transform.localRotation = Quaternion.identity;
                child.transform.localScale = Vector3.one;
            }

            return GameObjectResult(child, undoGroupId);
        }

        private static string HandleComponentAdd(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var typeName = JsonRpcUtil.ReadString(request.RawJson, "type", string.Empty);
            var gameObject = ResolveGameObject(instanceId);
            var componentType = ResolveComponentType(typeName);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"component.add\",\"gameObject\":\"" + JsonRpcUtil.Escape(gameObject.name) + "\",\"type\":\"" + JsonRpcUtil.Escape(componentType.FullName) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Add Component");
            var undoGroupId = Undo.GetCurrentGroup();
            var component = Undo.AddComponent(gameObject, componentType);
            return ComponentResult(component, undoGroupId, 80);
        }

        private static string HandleComponentGet(UnityMcpRequest request)
        {
            var componentInstanceId = JsonRpcUtil.ReadInt(request.RawJson, "componentInstanceId", 0);
            var maxProperties = JsonRpcUtil.ReadInt(request.RawJson, "maxProperties", 80);
            if (componentInstanceId != 0)
            {
                return ComponentResult(ResolveComponent(componentInstanceId), null, maxProperties);
            }

            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var typeName = JsonRpcUtil.ReadString(request.RawJson, "type", string.Empty);
            var gameObject = ResolveGameObject(instanceId);
            var components = gameObject.GetComponents<Component>();
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"gameObject\":\"");
            builder.Append(JsonRpcUtil.Escape(gameObject.name));
            builder.Append("\",\"instanceId\":");
            builder.Append(gameObject.GetInstanceID());
            builder.Append(",\"components\":[");

            var count = 0;
            foreach (var component in components)
            {
                if (component == null)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(typeName) && component.GetType().Name.IndexOf(typeName, StringComparison.OrdinalIgnoreCase) < 0 && component.GetType().FullName.IndexOf(typeName, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendComponentSummary(builder, component);
                count++;
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleComponentModify(UnityMcpRequest request)
        {
            var component = ResolveComponentFromRequest(request);
            var propertyPath = JsonRpcUtil.ReadString(request.RawJson, "propertyPath", string.Empty);
            if (string.IsNullOrEmpty(propertyPath))
            {
                throw new InvalidOperationException("component.modify requires propertyPath.");
            }

            var serializedObject = new SerializedObject(component);
            var property = serializedObject.FindProperty(propertyPath);
            if (property == null)
            {
                throw new InvalidOperationException("Could not find serialized property: " + propertyPath);
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"component.modify\",\"componentInstanceId\":" + component.GetInstanceID() + ",\"type\":\"" + JsonRpcUtil.Escape(component.GetType().FullName) + "\",\"propertyPath\":\"" + JsonRpcUtil.Escape(propertyPath) + "\",\"currentValue\":\"" + JsonRpcUtil.Escape(PropertyValueAsString(property)) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Modify Component");
            var undoGroupId = Undo.GetCurrentGroup();
            Undo.RecordObject(component, "MCP: Modify Component");
            SetSerializedPropertyValue(property, request.RawJson);
            serializedObject.ApplyModifiedProperties();
            EditorUtility.SetDirty(component);
            return ComponentResult(component, undoGroupId, 80);
        }

        private static string HandleComponentRemove(UnityMcpRequest request)
        {
            var component = ResolveComponent(JsonRpcUtil.ReadInt(request.RawJson, "componentInstanceId", 0));
            if (component is Transform)
            {
                throw new InvalidOperationException("Cannot remove Transform components.");
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"component.remove\",\"componentInstanceId\":" + component.GetInstanceID() + ",\"type\":\"" + JsonRpcUtil.Escape(component.GetType().FullName) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Remove Component");
            var undoGroupId = Undo.GetCurrentGroup();
            var type = component.GetType().FullName;
            var componentId = component.GetInstanceID();
            Undo.DestroyObjectImmediate(component);
            return "{\"ok\":true,\"removed\":{\"componentInstanceId\":" + componentId + ",\"type\":\"" + JsonRpcUtil.Escape(type) + "\"},\"undoGroupId\":" + undoGroupId + "}";
        }

        private static string HandleAssetFind(UnityMcpRequest request)
        {
            var query = JsonRpcUtil.ReadString(request.RawJson, "query", string.Empty);
            var type = JsonRpcUtil.ReadString(request.RawJson, "type", string.Empty);
            var label = JsonRpcUtil.ReadString(request.RawJson, "label", string.Empty);
            var limit = Math.Max(1, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "limit", 100), 500));
            var filter = BuildAssetFilter(query, type, label);
            var guids = AssetDatabase.FindAssets(filter);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"filter\":\"");
            builder.Append(JsonRpcUtil.Escape(filter));
            builder.Append("\",\"assets\":[");

            var count = 0;
            foreach (var guid in guids)
            {
                if (count >= limit)
                {
                    break;
                }

                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendAssetSummary(builder, guid, path);
                count++;
            }

            builder.Append("]}");
            return builder.ToString();
        }

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

        private static string HandleAssetCreateFolder(UnityMcpRequest request)
        {
            var parentPath = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "parentPath", "Assets"));
            var folderName = JsonRpcUtil.ReadString(request.RawJson, "folderName", string.Empty);
            if (string.IsNullOrEmpty(folderName))
            {
                throw new InvalidOperationException("asset.create_folder requires folderName.");
            }

            var plannedPath = NormalizeAssetPath(parentPath + "/" + folderName);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"asset.create_folder\",\"path\":\"" + JsonRpcUtil.Escape(plannedPath) + "\"}}";
            }

            var guid = AssetDatabase.CreateFolder(parentPath, folderName);
            var path = AssetDatabase.GUIDToAssetPath(guid);
            return "{\"ok\":true,\"guid\":\"" + JsonRpcUtil.Escape(guid) + "\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\"}";
        }

        private static string HandleAssetRefresh(UnityMcpRequest request)
        {
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"asset.refresh\"}}";
            }

            AssetDatabase.Refresh();
            return "{\"ok\":true,\"refreshed\":true}";
        }

        private static string HandleAssetMove(UnityMcpRequest request)
        {
            var fromPath = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "fromPath", string.Empty));
            var toPath = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "toPath", string.Empty));
            EnsureAssetExists(fromPath);
            EnsureAssetParentFolder(toPath);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"asset.move\",\"fromPath\":\"" + JsonRpcUtil.Escape(fromPath) + "\",\"toPath\":\"" + JsonRpcUtil.Escape(toPath) + "\"}}";
            }

            var error = AssetDatabase.MoveAsset(fromPath, toPath);
            if (!string.IsNullOrEmpty(error))
            {
                throw new InvalidOperationException(error);
            }

            var guid = AssetDatabase.AssetPathToGUID(toPath);
            return "{\"ok\":true,\"fromPath\":\"" + JsonRpcUtil.Escape(fromPath) + "\",\"path\":\"" + JsonRpcUtil.Escape(toPath) + "\",\"guid\":\"" + JsonRpcUtil.Escape(guid) + "\"}";
        }

        private static string HandleAssetCopy(UnityMcpRequest request)
        {
            var fromPath = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "fromPath", string.Empty));
            var toPath = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "toPath", string.Empty));
            EnsureAssetExists(fromPath);
            EnsureAssetParentFolder(toPath);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"asset.copy\",\"fromPath\":\"" + JsonRpcUtil.Escape(fromPath) + "\",\"toPath\":\"" + JsonRpcUtil.Escape(toPath) + "\"}}";
            }

            if (!AssetDatabase.CopyAsset(fromPath, toPath))
            {
                throw new InvalidOperationException("Unity failed to copy asset from " + fromPath + " to " + toPath);
            }

            AssetDatabase.ImportAsset(toPath);
            var guid = AssetDatabase.AssetPathToGUID(toPath);
            return "{\"ok\":true,\"fromPath\":\"" + JsonRpcUtil.Escape(fromPath) + "\",\"path\":\"" + JsonRpcUtil.Escape(toPath) + "\",\"guid\":\"" + JsonRpcUtil.Escape(guid) + "\"}";
        }

        private static string HandleAssetDelete(UnityMcpRequest request)
        {
            var path = NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var moveToTrash = JsonRpcUtil.ReadBool(request.RawJson, "moveToTrash", true);
            EnsureAssetExists(path);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"asset.delete\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"moveToTrash\":" + Bool(moveToTrash) + "}}";
            }

            var deleted = moveToTrash ? AssetDatabase.MoveAssetToTrash(path) : AssetDatabase.DeleteAsset(path);
            return "{\"ok\":" + Bool(deleted) + ",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"moveToTrash\":" + Bool(moveToTrash) + "}";
        }

        private static string HandleScriptRead(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            EnsureAssetExists(path);
            var fullPath = FullAssetPath(path);
            var content = File.ReadAllText(fullPath);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"content\":\"" + JsonRpcUtil.Escape(content) + "\"}";
        }

        private static string HandleScriptCreate(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var overwrite = JsonRpcUtil.ReadBool(request.RawJson, "overwrite", false);
            var contents = JsonRpcUtil.ReadString(request.RawJson, "content", string.Empty);
            if (string.IsNullOrEmpty(contents))
            {
                var className = JsonRpcUtil.ReadString(request.RawJson, "className", Path.GetFileNameWithoutExtension(path));
                var namespaceName = JsonRpcUtil.ReadString(request.RawJson, "namespace", string.Empty);
                contents = BuildScriptTemplate(className, namespaceName);
            }

            return WriteScript(path, contents, overwrite, JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false), "script.create");
        }

        private static string HandleScriptWrite(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var overwrite = JsonRpcUtil.ReadBool(request.RawJson, "overwrite", true);
            var contents = JsonRpcUtil.ReadString(request.RawJson, "content", string.Empty);
            return WriteScript(path, contents, overwrite, JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false), "script.write");
        }

        private static string HandleScriptApplyEdits(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            EnsureAssetExists(path);
            var edits = JsonRpcUtil.ReadObjectArray(request.RawJson, "edits");
            if (edits.Count == 0)
            {
                throw new InvalidOperationException("script.apply_edits requires at least one edit.");
            }

            var fullPath = FullAssetPath(path);
            var original = File.ReadAllText(fullPath);
            var ranges = new List<TextEditRange>();
            for (var index = 0; index < edits.Count; index++)
            {
                var editJson = edits[index];
                var range = new TextEditRange
                {
                    StartLine = JsonRpcUtil.ReadInt(editJson, "startLine", 0),
                    StartColumn = JsonRpcUtil.ReadInt(editJson, "startColumn", 0),
                    EndLine = JsonRpcUtil.ReadInt(editJson, "endLine", 0),
                    EndColumn = JsonRpcUtil.ReadInt(editJson, "endColumn", 0),
                    Text = JsonRpcUtil.ReadString(editJson, "text", string.Empty)
                };
                range.StartOffset = TextOffset(original, range.StartLine, range.StartColumn);
                range.EndOffset = TextOffset(original, range.EndLine, range.EndColumn);
                if (range.EndOffset < range.StartOffset)
                {
                    throw new InvalidOperationException("script.apply_edits edit end is before start at index " + index);
                }

                ranges.Add(range);
            }

            ranges.Sort((left, right) => right.StartOffset.CompareTo(left.StartOffset));
            for (var index = 1; index < ranges.Count; index++)
            {
                if (ranges[index].EndOffset > ranges[index - 1].StartOffset)
                {
                    throw new InvalidOperationException("script.apply_edits does not allow overlapping edits.");
                }
            }

            var updated = original;
            foreach (var range in ranges)
            {
                updated = updated.Substring(0, range.StartOffset) + range.Text + updated.Substring(range.EndOffset);
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"script.apply_edits\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"editCount\":" + ranges.Count + ",\"originalBytes\":" + Encoding.UTF8.GetByteCount(original) + ",\"updatedBytes\":" + Encoding.UTF8.GetByteCount(updated) + "}}";
            }

            File.WriteAllText(fullPath, updated, Encoding.UTF8);
            AssetDatabase.ImportAsset(path);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"editCount\":" + ranges.Count + ",\"originalBytes\":" + Encoding.UTF8.GetByteCount(original) + ",\"updatedBytes\":" + Encoding.UTF8.GetByteCount(updated) + "}";
        }

        private static string HandleScriptDelete(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            EnsureAssetExists(path);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"script.delete\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\"}}";
            }

            var deleted = AssetDatabase.MoveAssetToTrash(path);
            return "{\"ok\":" + Bool(deleted) + ",\"path\":\"" + JsonRpcUtil.Escape(path) + "\"}";
        }

        private static string HandleScriptValidate(UnityMcpRequest request)
        {
            var path = EnsureScriptPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            EnsureAssetExists(path);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"script.validate\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\"}}";
            }

            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            var diagnostics = ConsoleLogBuffer.Diagnostics("error", JsonRpcUtil.ReadInt(request.RawJson, "limit", 100), path);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"isCompiling\":" + Bool(EditorApplication.isCompiling) + ",\"result\":" + diagnostics + "}";
        }

        private static string HandlePackageList(UnityMcpRequest request)
        {
            var includeIndirect = JsonRpcUtil.ReadBool(request.RawJson, "includeIndirect", true);
            var includeOffline = JsonRpcUtil.ReadBool(request.RawJson, "includeOffline", true);
            var requestHandle = Client.List(includeIndirect, includeOffline);
            var id = OperationStore.Register("package", "package.list", () => PackageListState(requestHandle));
            return OperationStarted(id, "package.list");
        }

        private static string HandlePackageSearch(UnityMcpRequest request)
        {
            var query = JsonRpcUtil.ReadString(request.RawJson, "query", string.Empty);
            var requestHandle = string.IsNullOrEmpty(query) ? Client.SearchAll() : Client.Search(query);
            var id = OperationStore.Register("package", "package.search " + query, () => PackageSearchState(requestHandle));
            return OperationStarted(id, "package.search");
        }

        private static string HandlePackageAdd(UnityMcpRequest request)
        {
            var packageId = JsonRpcUtil.ReadString(request.RawJson, "packageId", string.Empty);
            if (string.IsNullOrEmpty(packageId))
            {
                throw new InvalidOperationException("package.add requires packageId.");
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"package.add\",\"packageId\":\"" + JsonRpcUtil.Escape(packageId) + "\"}}";
            }

            var requestHandle = Client.Add(packageId);
            var id = OperationStore.Register("package", "package.add " + packageId, () => PackageAddState(requestHandle));
            return OperationStarted(id, "package.add");
        }

        private static string HandlePackageRemove(UnityMcpRequest request)
        {
            var packageName = JsonRpcUtil.ReadString(request.RawJson, "packageName", string.Empty);
            if (string.IsNullOrEmpty(packageName))
            {
                throw new InvalidOperationException("package.remove requires packageName.");
            }

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"package.remove\",\"packageName\":\"" + JsonRpcUtil.Escape(packageName) + "\"}}";
            }

            var requestHandle = Client.Remove(packageName);
            var id = OperationStore.Register("package", "package.remove " + packageName, () => PackageRemoveState(requestHandle, packageName));
            return OperationStarted(id, "package.remove");
        }

        private static string HandleOperationGet(UnityMcpRequest request)
        {
            return OperationStore.Read(JsonRpcUtil.ReadString(request.RawJson, "operationId", string.Empty));
        }

        private static string HandleOperationList(UnityMcpRequest request)
        {
            return OperationStore.List();
        }

        private static string HandleCompileWait(UnityMcpRequest request)
        {
            var timeoutMs = Math.Max(1000, JsonRpcUtil.ReadInt(request.RawJson, "timeoutMs", 30000));
            var startedAt = DateTime.UtcNow;
            var deadline = startedAt.AddMilliseconds(timeoutMs);
            var id = OperationStore.Register("compile", "compile.wait", () => CompileWaitState(startedAt, deadline));
            return OperationStarted(id, "compile.wait");
        }

        private static string HandleTestsRun(UnityMcpRequest request)
        {
            var mode = JsonRpcUtil.ReadString(request.RawJson, "mode", "editmode");
            var filterText = JsonRpcUtil.ReadString(request.RawJson, "filter", string.Empty);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"tests.run\",\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\",\"filter\":\"" + JsonRpcUtil.Escape(filterText) + "\"}}";
            }

            var operationId = Guid.NewGuid().ToString("N");
            var callbacks = new GhostTestRunCallbacks(operationId);
            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(callbacks);

            var testMode = string.Equals(mode, "playmode", StringComparison.OrdinalIgnoreCase)
                ? TestMode.PlayMode
                : TestMode.EditMode;
            var filter = new Filter
            {
                testMode = testMode
            };
            if (!string.IsNullOrEmpty(filterText))
            {
                filter.testNames = new[] { filterText };
            }

            OperationStore.Register(operationId, "tests", "tests.run " + mode, () => callbacks.StateJson);
            api.Execute(new ExecutionSettings(filter));
            return OperationStarted(operationId, "tests.run");
        }

        private static string HandlePrefabCreate(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var path = EnsurePrefabPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var connect = JsonRpcUtil.ReadBool(request.RawJson, "connect", true);
            var gameObject = ResolveGameObject(instanceId);

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"prefab.create\",\"gameObject\":\"" + JsonRpcUtil.Escape(gameObject.name) + "\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"connect\":" + Bool(connect) + "}}";
            }

            EnsureAssetParentFolder(path);
            GameObject prefab;
            if (connect)
            {
                prefab = PrefabUtility.SaveAsPrefabAssetAndConnect(gameObject, path, InteractionMode.UserAction);
            }
            else
            {
                prefab = PrefabUtility.SaveAsPrefabAsset(gameObject, path);
            }

            if (prefab == null)
            {
                throw new InvalidOperationException("Unity failed to create prefab at " + path);
            }

            var guid = AssetDatabase.AssetPathToGUID(path);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"guid\":\"" + JsonRpcUtil.Escape(guid) + "\",\"name\":\"" + JsonRpcUtil.Escape(prefab.name) + "\"}";
        }

        private static string HandlePrefabInstantiate(UnityMcpRequest request)
        {
            var path = EnsurePrefabPath(JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null)
            {
                throw new InvalidOperationException("Could not load prefab at " + path);
            }

            var name = JsonRpcUtil.ReadString(request.RawJson, "name", prefab.name);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{"
                    + "\"ok\":true,"
                    + "\"dryRun\":true,"
                    + "\"planned\":{"
                    + "\"action\":\"prefab.instantiate\","
                    + "\"path\":\"" + JsonRpcUtil.Escape(path) + "\","
                    + "\"name\":\"" + JsonRpcUtil.Escape(name) + "\","
                    + "\"position\":{\"x\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "x", 0)) + ",\"y\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "y", 0)) + ",\"z\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "z", 0)) + "}"
                    + "}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Instantiate Prefab");
            var undoGroupId = Undo.GetCurrentGroup();
            var instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            if (instance == null)
            {
                throw new InvalidOperationException("Unity failed to instantiate prefab at " + path);
            }

            instance.name = name;
            Undo.RegisterCreatedObjectUndo(instance, "MCP: Instantiate Prefab");
            SetTransformFromRequest(instance, request);
            return GameObjectResult(instance, undoGroupId);
        }

        private string HandleBatchExecute(UnityMcpRequest request)
        {
            var operations = JsonRpcUtil.ReadObjectArray(request.RawJson, "operations");
            var dryRun = JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false);
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"results\":[");

            for (var index = 0; index < operations.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                var operation = operations[index];
                var method = JsonRpcUtil.ReadString(operation, "method", string.Empty);
                var paramsJson = JsonRpcUtil.ReadObject(operation, "params");
                if (dryRun)
                {
                    paramsJson = JsonRpcUtil.AddBoolProperty(paramsJson, "dryRun", true);
                }

                try
                {
                    var result = ExecuteResult(new UnityMcpRequest
                    {
                        Id = request.Id + ":" + index,
                        Method = method,
                        RawJson = paramsJson
                    });

                    builder.Append("{\"ok\":true,\"method\":\"");
                    builder.Append(JsonRpcUtil.Escape(method));
                    builder.Append("\",\"result\":");
                    builder.Append(result);
                    builder.Append("}");
                }
                catch (Exception exception)
                {
                    builder.Append("{\"ok\":false,\"method\":\"");
                    builder.Append(JsonRpcUtil.Escape(method));
                    builder.Append("\",\"error\":\"");
                    builder.Append(JsonRpcUtil.Escape(exception.Message));
                    builder.Append("\"}");
                }
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleScreenshotCapture(UnityMcpRequest request)
        {
            var superSize = JsonRpcUtil.ReadInt(request.RawJson, "superSize", 1);
            var label = SanitizeFileName(JsonRpcUtil.ReadString(request.RawJson, "label", "ghost"));
            var mode = JsonRpcUtil.ReadString(request.RawJson, "mode", "auto").ToLowerInvariant();
            var width = Math.Max(1, JsonRpcUtil.ReadInt(request.RawJson, "width", 1280) * Math.Max(1, superSize));
            var height = Math.Max(1, JsonRpcUtil.ReadInt(request.RawJson, "height", 720) * Math.Max(1, superSize));
            var directory = Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "screenshots");
            var fileName = label + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".png";
            var path = Path.GetFullPath(Path.Combine(directory, fileName));

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"screenshot.capture\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\",\"width\":" + width + ",\"height\":" + height + ",\"superSize\":" + superSize + "}}";
            }

            Directory.CreateDirectory(directory);
            var camera = ResolveScreenshotCamera(mode);
            if (camera == null)
            {
                throw new InvalidOperationException("No camera is available for screenshot.capture. Use mode=sceneView with an open Scene view or add/tag a MainCamera.");
            }

            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            var renderTexture = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
            try
            {
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
                UnityEngine.Object.DestroyImmediate(texture);
                UnityEngine.Object.DestroyImmediate(renderTexture);
            }

            var info = new FileInfo(path);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"mode\":\"" + JsonRpcUtil.Escape(mode) + "\",\"camera\":\"" + JsonRpcUtil.Escape(camera.name) + "\",\"width\":" + width + ",\"height\":" + height + ",\"bytes\":" + info.Length + ",\"superSize\":" + superSize + ",\"note\":\"Screenshot rendered synchronously from the selected Unity camera.\"}";
        }

        private static string HandleScreenshotDiff(UnityMcpRequest request)
        {
            var baselinePath = JsonRpcUtil.ReadString(request.RawJson, "baselinePath", string.Empty);
            var currentPath = JsonRpcUtil.ReadString(request.RawJson, "currentPath", string.Empty);
            var threshold = Math.Max(0f, JsonRpcUtil.ReadFloat(request.RawJson, "threshold", 0.02f));
            var maxSamples = Math.Max(100, Math.Min(JsonRpcUtil.ReadInt(request.RawJson, "maxSamples", 20000), 200000));

            if (string.IsNullOrEmpty(baselinePath) || string.IsNullOrEmpty(currentPath))
            {
                throw new InvalidOperationException("screenshot.diff requires baselinePath and currentPath.");
            }

            if (!File.Exists(baselinePath))
            {
                throw new InvalidOperationException("Baseline screenshot does not exist: " + baselinePath);
            }

            if (!File.Exists(currentPath))
            {
                throw new InvalidOperationException("Current screenshot does not exist: " + currentPath);
            }

            var baseline = LoadScreenshotTexture(baselinePath);
            var current = LoadScreenshotTexture(currentPath);
            try
            {
                var result = CompareScreenshots(baseline, current, maxSamples);
                return "{"
                    + "\"ok\":true,"
                    + "\"source\":\"screenshot-pixel-diff\","
                    + "\"baselinePath\":\"" + JsonRpcUtil.Escape(baselinePath) + "\","
                    + "\"currentPath\":\"" + JsonRpcUtil.Escape(currentPath) + "\","
                    + "\"baseline\":{\"width\":" + baseline.width + ",\"height\":" + baseline.height + "},"
                    + "\"current\":{\"width\":" + current.width + ",\"height\":" + current.height + "},"
                    + "\"sampledPixels\":" + result.SampledPixels + ","
                    + "\"differentPixels\":" + result.DifferentPixels + ","
                    + "\"differentRatio\":" + result.DifferentRatio.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"meanAbsoluteDifference\":" + result.MeanAbsoluteDifference.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"threshold\":" + threshold.ToString("0.######", CultureInfo.InvariantCulture) + ","
                    + "\"withinThreshold\":" + Bool(result.DifferentRatio <= threshold) + ","
                    + "\"note\":\"Pixel diff samples PNG colors; camera timing, async screenshot writes, compression, and dynamic UI may require tolerance.\""
                    + "}";
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(baseline);
                UnityEngine.Object.DestroyImmediate(current);
            }
        }

        private static void AppendGameObject(StringBuilder builder, GameObject gameObject, int depth, int maxDepth, bool includeInactive)
        {
            builder.Append("{\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(gameObject.name));
            builder.Append("\",\"instanceId\":");
            builder.Append(gameObject.GetInstanceID());
            builder.Append(",\"activeSelf\":");
            builder.Append(Bool(gameObject.activeSelf));
            builder.Append(",\"depth\":");
            builder.Append(depth);
            builder.Append(",\"children\":[");

            var transform = gameObject.transform;
            var childCount = 0;
            for (var index = 0; index < transform.childCount && depth < maxDepth; index++)
            {
                var child = transform.GetChild(index).gameObject;
                if (!includeInactive && !child.activeInHierarchy)
                {
                    continue;
                }

                if (childCount > 0)
                {
                    builder.Append(",");
                }

                AppendGameObject(builder, child, depth + 1, maxDepth, includeInactive);
                childCount++;
            }

            builder.Append("]}");
        }

        private static string Bool(bool value)
        {
            return value ? "true" : "false";
        }

        private static PrimitiveType ParsePrimitiveType(string value)
        {
            return (PrimitiveType)Enum.Parse(typeof(PrimitiveType), value, true);
        }

        private static void SetTransformFromRequest(GameObject gameObject, UnityMcpRequest request)
        {
            var transform = gameObject.transform;
            transform.position = new Vector3(
                JsonRpcUtil.ReadFloat(request.RawJson, "x", transform.position.x),
                JsonRpcUtil.ReadFloat(request.RawJson, "y", transform.position.y),
                JsonRpcUtil.ReadFloat(request.RawJson, "z", transform.position.z));
            transform.eulerAngles = new Vector3(
                JsonRpcUtil.ReadFloat(request.RawJson, "rotationX", transform.eulerAngles.x),
                JsonRpcUtil.ReadFloat(request.RawJson, "rotationY", transform.eulerAngles.y),
                JsonRpcUtil.ReadFloat(request.RawJson, "rotationZ", transform.eulerAngles.z));
            transform.localScale = new Vector3(
                JsonRpcUtil.ReadFloat(request.RawJson, "scaleX", transform.localScale.x),
                JsonRpcUtil.ReadFloat(request.RawJson, "scaleY", transform.localScale.y),
                JsonRpcUtil.ReadFloat(request.RawJson, "scaleZ", transform.localScale.z));
        }

        private static string GameObjectResult(GameObject gameObject, int? undoGroupId)
        {
            return "{"
                + "\"ok\":true,"
                + "\"name\":\"" + JsonRpcUtil.Escape(gameObject.name) + "\","
                + "\"instanceId\":" + gameObject.GetInstanceID() + ","
                + "\"scenePath\":\"" + JsonRpcUtil.Escape(gameObject.scene.path) + "\","
                + "\"activeSelf\":" + Bool(gameObject.activeSelf) + ","
                + "\"undoGroupId\":" + (undoGroupId.HasValue ? undoGroupId.Value.ToString(CultureInfo.InvariantCulture) : "null") + ","
                + "\"position\":{\"x\":" + Float(gameObject.transform.position.x) + ",\"y\":" + Float(gameObject.transform.position.y) + ",\"z\":" + Float(gameObject.transform.position.z) + "},"
                + "\"rotation\":{\"x\":" + Float(gameObject.transform.eulerAngles.x) + ",\"y\":" + Float(gameObject.transform.eulerAngles.y) + ",\"z\":" + Float(gameObject.transform.eulerAngles.z) + "},"
                + "\"scale\":{\"x\":" + Float(gameObject.transform.localScale.x) + ",\"y\":" + Float(gameObject.transform.localScale.y) + ",\"z\":" + Float(gameObject.transform.localScale.z) + "}"
                + "}";
        }

        private static void AppendScene(StringBuilder builder, Scene scene)
        {
            builder.Append(SceneObjectJson(scene));
        }

        private static string SceneResult(Scene scene)
        {
            return "{\"ok\":true,\"scene\":" + SceneObjectJson(scene) + "}";
        }

        private static string SceneObjectJson(Scene scene)
        {
            return "{\"name\":\""
                + JsonRpcUtil.Escape(scene.name)
                + "\",\"path\":\""
                + JsonRpcUtil.Escape(scene.path)
                + "\",\"isLoaded\":"
                + Bool(scene.isLoaded)
                + ",\"isDirty\":"
                + Bool(scene.isDirty)
                + ",\"rootCount\":"
                + scene.rootCount
                + "}";
        }

        private static Scene ResolveOpenScene(UnityMcpRequest request)
        {
            var path = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", string.Empty);

            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                if (!string.IsNullOrEmpty(path) && string.Equals(scene.path, path, StringComparison.OrdinalIgnoreCase))
                {
                    return scene;
                }

                if (!string.IsNullOrEmpty(name) && string.Equals(scene.name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return scene;
                }
            }

            throw new InvalidOperationException("Could not resolve open scene by path or name.");
        }

        private static void AppendGameObjectSummary(StringBuilder builder, GameObject gameObject)
        {
            builder.Append("{\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(gameObject.name));
            builder.Append("\",\"instanceId\":");
            builder.Append(gameObject.GetInstanceID());
            builder.Append(",\"scenePath\":\"");
            builder.Append(JsonRpcUtil.Escape(gameObject.scene.path));
            builder.Append("\",\"activeSelf\":");
            builder.Append(Bool(gameObject.activeSelf));
            builder.Append("}");
        }

        private static GameObject ResolveGameObject(int instanceId)
        {
            var gameObject = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            return gameObject;
        }

        private static Component ResolveComponent(int componentInstanceId)
        {
            var component = EditorUtility.InstanceIDToObject(componentInstanceId) as Component;
            if (component == null)
            {
                throw new InvalidOperationException("Could not resolve Component instanceId: " + componentInstanceId);
            }

            return component;
        }

        private static Component ResolveComponentFromRequest(UnityMcpRequest request)
        {
            var componentInstanceId = JsonRpcUtil.ReadInt(request.RawJson, "componentInstanceId", 0);
            if (componentInstanceId != 0)
            {
                return ResolveComponent(componentInstanceId);
            }

            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var typeName = JsonRpcUtil.ReadString(request.RawJson, "type", string.Empty);
            var gameObject = ResolveGameObject(instanceId);
            if (string.IsNullOrEmpty(typeName))
            {
                throw new InvalidOperationException("Component type is required when componentInstanceId is not provided.");
            }

            var componentType = ResolveComponentType(typeName);
            var component = gameObject.GetComponent(componentType);
            if (component == null)
            {
                throw new InvalidOperationException("GameObject '" + gameObject.name + "' does not have component " + componentType.FullName);
            }

            return component;
        }

        private static Type ResolveComponentType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName))
            {
                throw new InvalidOperationException("Component type is required.");
            }

            var candidates = new[]
            {
                typeName,
                "UnityEngine." + typeName + ", UnityEngine",
                "UnityEngine." + typeName + ", UnityEngine.CoreModule",
                "UnityEngine.UI." + typeName + ", UnityEngine.UI"
            };

            foreach (var candidate in candidates)
            {
                var directType = Type.GetType(candidate);
                if (directType != null && typeof(Component).IsAssignableFrom(directType))
                {
                    return directType;
                }
            }

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException exception)
                {
                    types = exception.Types;
                }

                foreach (var type in types)
                {
                    if (type == null || !typeof(Component).IsAssignableFrom(type))
                    {
                        continue;
                    }

                    if (string.Equals(type.Name, typeName, StringComparison.OrdinalIgnoreCase) || string.Equals(type.FullName, typeName, StringComparison.OrdinalIgnoreCase))
                    {
                        return type;
                    }
                }
            }

            throw new InvalidOperationException("Could not resolve Unity component type: " + typeName);
        }

        private static string ComponentResult(Component component, int? undoGroupId, int maxProperties)
        {
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"component\":");
            AppendComponentSummary(builder, component);
            builder.Append(",\"undoGroupId\":");
            builder.Append(undoGroupId.HasValue ? undoGroupId.Value.ToString(CultureInfo.InvariantCulture) : "null");
            builder.Append(",\"properties\":[");
            AppendSerializedProperties(builder, component, Math.Max(1, Math.Min(maxProperties, 200)));
            builder.Append("]}");
            return builder.ToString();
        }

        private static void AppendComponentSummary(StringBuilder builder, Component component)
        {
            builder.Append("{\"type\":\"");
            builder.Append(JsonRpcUtil.Escape(component.GetType().FullName));
            builder.Append("\",\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(component.GetType().Name));
            builder.Append("\",\"componentInstanceId\":");
            builder.Append(component.GetInstanceID());
            builder.Append(",\"gameObjectInstanceId\":");
            builder.Append(component.gameObject.GetInstanceID());
            builder.Append(",\"gameObject\":\"");
            builder.Append(JsonRpcUtil.Escape(component.gameObject.name));
            builder.Append("\"}");
        }

        private static void AppendSerializedProperties(StringBuilder builder, Component component, int maxProperties)
        {
            var serializedObject = new SerializedObject(component);
            var iterator = serializedObject.GetIterator();
            var enterChildren = true;
            var count = 0;

            while (iterator.NextVisible(enterChildren) && count < maxProperties)
            {
                enterChildren = false;
                if (count > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"path\":\"");
                builder.Append(JsonRpcUtil.Escape(iterator.propertyPath));
                builder.Append("\",\"displayName\":\"");
                builder.Append(JsonRpcUtil.Escape(iterator.displayName));
                builder.Append("\",\"type\":\"");
                builder.Append(iterator.propertyType);
                builder.Append("\",\"value\":\"");
                builder.Append(JsonRpcUtil.Escape(PropertyValueAsString(iterator)));
                builder.Append("\"}");
                count++;
            }
        }

        private static string PropertyValueAsString(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return property.intValue.ToString(CultureInfo.InvariantCulture);
                case SerializedPropertyType.Boolean:
                    return Bool(property.boolValue);
                case SerializedPropertyType.Float:
                    return Float(property.floatValue);
                case SerializedPropertyType.String:
                    return property.stringValue;
                case SerializedPropertyType.Color:
                    return property.colorValue.ToString();
                case SerializedPropertyType.ObjectReference:
                    return property.objectReferenceValue == null ? "null" : property.objectReferenceValue.name;
                case SerializedPropertyType.Vector2:
                    return property.vector2Value.ToString();
                case SerializedPropertyType.Vector3:
                    return property.vector3Value.ToString();
                case SerializedPropertyType.Enum:
                    return property.enumDisplayNames[property.enumValueIndex];
                default:
                    return property.type;
            }
        }

        private static void SetSerializedPropertyValue(SerializedProperty property, string json)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    property.intValue = JsonRpcUtil.ReadInt(json, "value", property.intValue);
                    return;
                case SerializedPropertyType.Boolean:
                    property.boolValue = JsonRpcUtil.ReadBool(json, "value", property.boolValue);
                    return;
                case SerializedPropertyType.Float:
                    property.floatValue = JsonRpcUtil.ReadFloat(json, "value", property.floatValue);
                    return;
                case SerializedPropertyType.String:
                    property.stringValue = JsonRpcUtil.ReadString(json, "value", property.stringValue);
                    return;
                case SerializedPropertyType.Vector3:
                    property.vector3Value = new Vector3(
                        JsonRpcUtil.ReadFloat(json, "x", property.vector3Value.x),
                        JsonRpcUtil.ReadFloat(json, "y", property.vector3Value.y),
                        JsonRpcUtil.ReadFloat(json, "z", property.vector3Value.z));
                    return;
                case SerializedPropertyType.Vector2:
                    property.vector2Value = new Vector2(
                        JsonRpcUtil.ReadFloat(json, "x", property.vector2Value.x),
                        JsonRpcUtil.ReadFloat(json, "y", property.vector2Value.y));
                    return;
                case SerializedPropertyType.Enum:
                    property.enumValueIndex = JsonRpcUtil.ReadInt(json, "value", property.enumValueIndex);
                    return;
                default:
                    throw new InvalidOperationException("Unsupported serialized property type for modification: " + property.propertyType);
            }
        }

        private static string BuildAssetFilter(string query, string type, string label)
        {
            var builder = new StringBuilder();
            if (!string.IsNullOrEmpty(query))
            {
                builder.Append(query);
            }

            if (!string.IsNullOrEmpty(type))
            {
                if (builder.Length > 0)
                {
                    builder.Append(" ");
                }

                builder.Append("t:");
                builder.Append(type);
            }

            if (!string.IsNullOrEmpty(label))
            {
                if (builder.Length > 0)
                {
                    builder.Append(" ");
                }

                builder.Append("l:");
                builder.Append(label);
            }

            return builder.ToString();
        }

        private static void AppendAssetSummary(StringBuilder builder, string guid, string path)
        {
            var type = AssetDatabase.GetMainAssetTypeAtPath(path);
            builder.Append("{\"guid\":\"");
            builder.Append(JsonRpcUtil.Escape(guid));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(path));
            builder.Append("\",\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(Path.GetFileNameWithoutExtension(path)));
            builder.Append("\",\"type\":\"");
            builder.Append(JsonRpcUtil.Escape(type == null ? string.Empty : type.FullName));
            builder.Append("\"}");
        }

        private static void AppendAssetReference(StringBuilder builder, string path, string extension)
        {
            var guid = AssetDatabase.AssetPathToGUID(path);
            var type = AssetDatabase.GetMainAssetTypeAtPath(path);
            builder.Append("{\"guid\":\"");
            builder.Append(JsonRpcUtil.Escape(guid));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(path));
            builder.Append("\",\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(Path.GetFileNameWithoutExtension(path)));
            builder.Append("\",\"extension\":\"");
            builder.Append(JsonRpcUtil.Escape(extension));
            builder.Append("\",\"type\":\"");
            builder.Append(JsonRpcUtil.Escape(type == null ? string.Empty : type.FullName));
            builder.Append("\"}");
        }

        private static void AppendUnusedAssetCandidate(StringBuilder builder, string guid, string path)
        {
            var type = AssetDatabase.GetMainAssetTypeAtPath(path);
            var fullPath = FullAssetPath(path);
            builder.Append("{\"guid\":\"");
            builder.Append(JsonRpcUtil.Escape(guid));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(path));
            builder.Append("\",\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(Path.GetFileNameWithoutExtension(path)));
            builder.Append("\",\"extension\":\"");
            builder.Append(JsonRpcUtil.Escape(Path.GetExtension(path)));
            builder.Append("\",\"type\":\"");
            builder.Append(JsonRpcUtil.Escape(type == null ? string.Empty : type.FullName));
            builder.Append("\",\"sizeBytes\":");
            builder.Append(File.Exists(fullPath) ? new FileInfo(fullPath).Length : 0);
            builder.Append(",\"risk\":\"review-before-delete\"}");
        }

        private static int AppendScriptReferences(StringBuilder builder, string projectRoot, string targetPath, string className, string methodName, int limit)
        {
            var count = 0;
            var classRegex = string.IsNullOrEmpty(className) ? null : new Regex(@"\b" + Regex.Escape(className) + @"\b");
            var methodRegex = string.IsNullOrEmpty(methodName) ? null : new Regex(@"\b" + Regex.Escape(methodName) + @"\s*\(");
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                if (count >= limit)
                {
                    break;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (string.Equals(assetPath, targetPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var lines = File.ReadAllLines(fullPath);
                for (var index = 0; index < lines.Length && count < limit; index++)
                {
                    var line = lines[index];
                    var matchType = string.Empty;
                    if (classRegex != null && classRegex.IsMatch(line))
                    {
                        matchType = "class";
                    }

                    if (methodRegex != null && methodRegex.IsMatch(line))
                    {
                        matchType = string.IsNullOrEmpty(matchType) ? "method" : "class+method";
                    }

                    if (string.IsNullOrEmpty(matchType))
                    {
                        continue;
                    }

                    if (count > 0)
                    {
                        builder.Append(",");
                    }

                    AppendScriptReference(builder, assetPath, index + 1, matchType, line.Trim());
                    count++;
                }
            }

            return count;
        }

        private static void AppendScriptReference(StringBuilder builder, string path, int line, string matchType, string snippet)
        {
            builder.Append("{\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(path));
            builder.Append("\",\"line\":");
            builder.Append(line);
            builder.Append(",\"matchType\":\"");
            builder.Append(JsonRpcUtil.Escape(matchType));
            builder.Append("\",\"snippet\":\"");
            builder.Append(JsonRpcUtil.Escape(snippet.Length > 240 ? snippet.Substring(0, 240) : snippet));
            builder.Append("\"}");
        }

        private static int AppendGuidReferences(StringBuilder builder, string projectRoot, string guid, string targetPath, HashSet<string> extensions, int limit, bool includeSelf)
        {
            var count = 0;
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
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
                if (!includeSelf && string.Equals(assetPath, targetPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
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

            return count;
        }

        private static int AppendSuggestedTests(StringBuilder builder, string projectRoot, string className, string methodName, int limit)
        {
            var count = 0;
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                if (count >= limit)
                {
                    break;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (assetPath.IndexOf("Test", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
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

                if (!string.IsNullOrEmpty(className) && text.IndexOf(className, StringComparison.Ordinal) < 0
                    && !string.IsNullOrEmpty(methodName) && text.IndexOf(methodName, StringComparison.Ordinal) < 0)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(className) && text.IndexOf(className, StringComparison.Ordinal) < 0 && string.IsNullOrEmpty(methodName))
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"path\":\"");
                builder.Append(JsonRpcUtil.Escape(assetPath));
                builder.Append("\",\"reason\":\"references target symbol or sits in a test path\"}");
                count++;
            }

            return count;
        }

        private static int AppendScriptLintDiagnostics(StringBuilder builder, string fullPath, string assetPath, HashSet<string> rules, int count, int limit)
        {
            var text = File.ReadAllText(fullPath);
            var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var hotMethodRanges = FindHotUnityMethodRanges(text);
            for (var index = 0; index < lines.Length && count < limit; index++)
            {
                var line = lines[index];
                var lineNumber = index + 1;
                if (IsRuleEnabled(rules, "UNI-PERF-001") && IsInAnyRange(lineNumber, hotMethodRanges)
                    && (line.Contains("GetComponent<") || line.Contains(".GetComponent<") || line.Contains("GetComponentInChildren<") || line.Contains("GetComponentInParent<")))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-PERF-001", "warning", assetPath, lineNumber, "Component lookup inside Update/FixedUpdate/LateUpdate.", "Cache component references in Awake/Start or assign them via the Inspector.", line);
                }

                if (IsRuleEnabled(rules, "UNI-PERF-002") && IsInAnyRange(lineNumber, hotMethodRanges)
                    && (line.Contains("FindObjectOfType") || line.Contains("FindFirstObjectByType") || line.Contains("GameObject.Find(")))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-PERF-002", "warning", assetPath, lineNumber, "Scene-wide lookup inside a per-frame Unity method.", "Cache references, use serialized fields, or inject dependencies before runtime update loops.", line);
                }

                if (IsRuleEnabled(rules, "UNI-ASYNC-001") && Regex.IsMatch(line, @"StartCoroutine\s*\(\s*"""))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-ASYNC-001", "info", assetPath, lineNumber, "String-based coroutine start is fragile under refactors.", "Use StartCoroutine(MethodName()) or store the IEnumerator explicitly.", line);
                }

                if (IsRuleEnabled(rules, "UNI-MSG-001") && line.Contains("SendMessage("))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-MSG-001", "warning", assetPath, lineNumber, "SendMessage is reflection-like and bypasses static analysis.", "Prefer direct interfaces, events, UnityEvents, or cached component method calls.", line);
                }

                if (IsRuleEnabled(rules, "UNI-ASSET-LOAD-001") && line.Contains("Resources.Load"))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-ASSET-LOAD-001", "info", assetPath, lineNumber, "Resources.Load makes asset dependencies invisible to addressable/build analysis.", "Consider serialized references, Addressables, or an explicit content registry for production assets.", line);
                }
            }

            return count;
        }

        private static int AppendAssetLintDiagnostics(StringBuilder builder, string projectRoot, HashSet<string> rules, int count, int limit, out int scannedCandidates)
        {
            scannedCandidates = 0;
            if (IsRuleEnabled(rules, "UNI-ASSET-001"))
            {
                count = AppendMetaLintDiagnostics(builder, projectRoot, count, limit);
            }

            if (count < limit && IsRuleEnabled(rules, "UNI-ASSET-002"))
            {
                count = AppendUnusedAssetLintDiagnostics(builder, projectRoot, count, limit, out scannedCandidates);
            }

            return count;
        }

        private static int AppendMetaLintDiagnostics(StringBuilder builder, string projectRoot, int count, int limit)
        {
            var seenGuids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
            {
                if (count >= limit)
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

                var metaPath = fullPath + ".meta";
                if (!File.Exists(metaPath))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-ASSET-001", "error", assetPath, 0, "Asset is missing its .meta file.", "Restore or regenerate the .meta file before moving or committing this asset.", string.Empty);
                    continue;
                }

                var guid = ReadMetaGuid(metaPath);
                if (string.IsNullOrEmpty(guid))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-ASSET-001", "error", ToAssetPath(projectRoot, metaPath), 0, "Meta file has no GUID.", "Regenerate the .meta file or repair it before Unity references break.", string.Empty);
                    continue;
                }

                string existingPath;
                if (seenGuids.TryGetValue(guid, out existingPath))
                {
                    AppendLintDiagnostic(builder, ref count, "UNI-ASSET-001", "error", ToAssetPath(projectRoot, metaPath), 0, "Duplicate Unity GUID also used by " + existingPath + ".", "Regenerate one of the duplicate .meta files to avoid broken references.", guid);
                    continue;
                }

                seenGuids[guid] = assetPath;
            }

            return count;
        }

        private static int AppendUnusedAssetLintDiagnostics(StringBuilder builder, string projectRoot, int count, int limit, out int scannedCandidates)
        {
            scannedCandidates = 0;
            var referencedGuids = BuildReferencedGuidSet(projectRoot, ReadReferenceExtensions(".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss"));
            var candidateExtensions = ReadReferenceExtensions(".prefab,.mat,.asset,.controller,.overrideController,.anim,.png,.jpg,.jpeg,.tga,.psd,.fbx,.obj,.wav,.mp3,.ogg,.shadergraph,.renderTexture,.uxml,.uss");
            foreach (var guid in AssetDatabase.FindAssets(string.Empty))
            {
                if (count >= limit)
                {
                    break;
                }

                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path) || AssetDatabase.IsValidFolder(path) || ShouldSkipUnusedCandidate(path, candidateExtensions, false))
                {
                    continue;
                }

                scannedCandidates++;
                if (referencedGuids.Contains(guid))
                {
                    continue;
                }

                AppendLintDiagnostic(builder, ref count, "UNI-ASSET-002", "info", path, 0, "Asset has no serialized GUID references in scanned assets.", "Review dynamic loads, Addressables, import manifests, and Resources before deleting.", guid);
            }

            return count;
        }

        private static void AppendLintDiagnostic(StringBuilder builder, ref int count, string ruleId, string severity, string path, int line, string message, string recommendation, string snippet)
        {
            if (count > 0)
            {
                builder.Append(",");
            }

            builder.Append("{\"ruleId\":\"");
            builder.Append(JsonRpcUtil.Escape(ruleId));
            builder.Append("\",\"severity\":\"");
            builder.Append(JsonRpcUtil.Escape(severity));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(path));
            builder.Append("\",\"line\":");
            builder.Append(line);
            builder.Append(",\"message\":\"");
            builder.Append(JsonRpcUtil.Escape(message));
            builder.Append("\",\"recommendation\":\"");
            builder.Append(JsonRpcUtil.Escape(recommendation));
            builder.Append("\",\"snippet\":\"");
            var cleanSnippet = (snippet ?? string.Empty).Trim();
            builder.Append(JsonRpcUtil.Escape(cleanSnippet.Length > 240 ? cleanSnippet.Substring(0, 240) : cleanSnippet));
            builder.Append("\"}");
            count++;
        }

        private static List<Tuple<int, int>> FindHotUnityMethodRanges(string text)
        {
            var ranges = new List<Tuple<int, int>>();
            var regex = new Regex(@"\b(void|IEnumerator)\s+(Update|FixedUpdate|LateUpdate)\s*\([^)]*\)\s*\{");
            foreach (Match match in regex.Matches(text ?? string.Empty))
            {
                var openBrace = text.IndexOf('{', match.Index + match.Length - 1);
                var closeBrace = FindMatchingBrace(text, openBrace);
                if (openBrace >= 0 && closeBrace > openBrace)
                {
                    ranges.Add(Tuple.Create(CountLines(text, openBrace), CountLines(text, closeBrace)));
                }
            }

            return ranges;
        }

        private static bool IsInAnyRange(int line, List<Tuple<int, int>> ranges)
        {
            foreach (var range in ranges)
            {
                if (line >= range.Item1 && line <= range.Item2)
                {
                    return true;
                }
            }

            return false;
        }

        private static HashSet<string> ReadRuleSet(string csv)
        {
            var rules = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var part in (csv ?? string.Empty).Split(','))
            {
                var rule = part.Trim();
                if (!string.IsNullOrEmpty(rule))
                {
                    rules.Add(rule);
                }
            }

            return rules;
        }

        private static bool IsRuleEnabled(HashSet<string> rules, string ruleId)
        {
            return rules.Count == 0 || rules.Contains(ruleId);
        }

        private static bool ShouldSkipLintScript(string assetPath)
        {
            var normalized = (assetPath ?? string.Empty).Replace("\\", "/");
            return normalized.Contains("/Library/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Temp/", StringComparison.OrdinalIgnoreCase)
                || normalized.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase)
                || normalized.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase);
        }

        private static Dictionary<string, int> NewAssetCategoryCounts()
        {
            return new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                { "folders", 0 },
                { "scenes", 0 },
                { "prefabs", 0 },
                { "scripts", 0 },
                { "materials", 0 },
                { "models", 0 },
                { "spritesAndTextures", 0 },
                { "audio", 0 },
                { "animatorControllers", 0 },
                { "animations", 0 },
                { "shaders", 0 },
                { "shaderGraphs", 0 },
                { "scriptableAssets", 0 },
                { "uiDocuments", 0 },
                { "other", 0 }
            };
        }

        private static void IncrementAssetCategory(Dictionary<string, int> counts, string path)
        {
            var extension = Path.GetExtension(path ?? string.Empty).ToLowerInvariant();
            switch (extension)
            {
                case ".unity":
                    Increment(counts, "scenes");
                    break;
                case ".prefab":
                    Increment(counts, "prefabs");
                    break;
                case ".cs":
                    Increment(counts, "scripts");
                    break;
                case ".mat":
                    Increment(counts, "materials");
                    break;
                case ".fbx":
                case ".obj":
                case ".blend":
                case ".dae":
                case ".3ds":
                    Increment(counts, "models");
                    break;
                case ".png":
                case ".jpg":
                case ".jpeg":
                case ".tga":
                case ".psd":
                case ".tif":
                case ".tiff":
                case ".exr":
                    Increment(counts, "spritesAndTextures");
                    break;
                case ".wav":
                case ".mp3":
                case ".ogg":
                case ".aiff":
                    Increment(counts, "audio");
                    break;
                case ".controller":
                case ".overridecontroller":
                    Increment(counts, "animatorControllers");
                    break;
                case ".anim":
                case ".playable":
                    Increment(counts, "animations");
                    break;
                case ".shader":
                case ".cginc":
                case ".hlsl":
                    Increment(counts, "shaders");
                    break;
                case ".shadergraph":
                case ".shadersubgraph":
                    Increment(counts, "shaderGraphs");
                    break;
                case ".asset":
                    Increment(counts, "scriptableAssets");
                    break;
                case ".uxml":
                case ".uss":
                    Increment(counts, "uiDocuments");
                    break;
                default:
                    Increment(counts, "other");
                    break;
            }
        }

        private static void Increment(Dictionary<string, int> counts, string key)
        {
            counts[key] = CountValue(counts, key) + 1;
        }

        private static int CountValue(Dictionary<string, int> counts, string key)
        {
            int value;
            return counts != null && counts.TryGetValue(key, out value) ? value : 0;
        }

        private static void IncrementTopFolder(Dictionary<string, int> counts, string assetPath)
        {
            var normalized = NormalizeAssetPath(assetPath);
            if (!normalized.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var remainder = normalized.Substring("Assets/".Length);
            var slash = remainder.IndexOf('/');
            var folder = slash >= 0 ? remainder.Substring(0, slash) : "(root)";
            if (string.IsNullOrEmpty(folder))
            {
                folder = "(root)";
            }

            Increment(counts, folder);
        }

        private static void AppendAssetCategoryCounts(StringBuilder builder, Dictionary<string, int> counts)
        {
            builder.Append(",\"folders\":");
            builder.Append(CountValue(counts, "folders"));
            builder.Append(",\"scenes\":");
            builder.Append(CountValue(counts, "scenes"));
            builder.Append(",\"prefabs\":");
            builder.Append(CountValue(counts, "prefabs"));
            builder.Append(",\"scripts\":");
            builder.Append(CountValue(counts, "scripts"));
            builder.Append(",\"materials\":");
            builder.Append(CountValue(counts, "materials"));
            builder.Append(",\"models\":");
            builder.Append(CountValue(counts, "models"));
            builder.Append(",\"spritesAndTextures\":");
            builder.Append(CountValue(counts, "spritesAndTextures"));
            builder.Append(",\"audio\":");
            builder.Append(CountValue(counts, "audio"));
            builder.Append(",\"animatorControllers\":");
            builder.Append(CountValue(counts, "animatorControllers"));
            builder.Append(",\"animations\":");
            builder.Append(CountValue(counts, "animations"));
            builder.Append(",\"shaders\":");
            builder.Append(CountValue(counts, "shaders"));
            builder.Append(",\"shaderGraphs\":");
            builder.Append(CountValue(counts, "shaderGraphs"));
            builder.Append(",\"scriptableAssets\":");
            builder.Append(CountValue(counts, "scriptableAssets"));
            builder.Append(",\"uiDocuments\":");
            builder.Append(CountValue(counts, "uiDocuments"));
            builder.Append(",\"other\":");
            builder.Append(CountValue(counts, "other"));
        }

        private static ScriptIndexStats BuildScriptIndexStats(string projectRoot, int limit)
        {
            var stats = new ScriptIndexStats();
            var typeRegex = new Regex(@"\b(class|struct|interface|enum)\s+[A-Za-z_][A-Za-z0-9_]*");
            var namespaceRegex = new Regex(@"\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)");
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipLintScript(assetPath))
                {
                    continue;
                }

                stats.ScriptCount++;
                var normalized = assetPath.Replace("\\", "/");
                if (normalized.Contains("/Editor/", StringComparison.OrdinalIgnoreCase))
                {
                    stats.EditorScriptCount++;
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

                stats.TypeDeclarationCount += typeRegex.Matches(text).Count;
                stats.MonoBehaviourCount += Regex.Matches(text, @":\s*[^{}\n;]*\bMonoBehaviour\b").Count;
                stats.ScriptableObjectCount += Regex.Matches(text, @":\s*[^{}\n;]*\bScriptableObject\b").Count;
                stats.ResourcesLoadLineCount += Regex.Matches(text, @"\bResources\.Load\b").Count;
                stats.SendMessageLineCount += Regex.Matches(text, @"\bSendMessage\s*\(").Count;
                stats.UiHintCount += Regex.Matches(text, @"\b(Canvas|RectTransform|VisualElement|UIDocument|Button|TextMeshProUGUI)\b").Count;
                if (text.Contains("NUnit.Framework") || text.Contains("UnityEngine.TestTools") || text.Contains("[Test]") || text.Contains("[UnityTest]") || normalized.Contains("/Tests/", StringComparison.OrdinalIgnoreCase))
                {
                    stats.TestScriptCount++;
                }

                var hotRanges = FindHotUnityMethodRanges(text);
                if (hotRanges.Count > 0)
                {
                    var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
                    for (var index = 0; index < lines.Length; index++)
                    {
                        var lineNumber = index + 1;
                        if (!IsInAnyRange(lineNumber, hotRanges))
                        {
                            continue;
                        }

                        var line = lines[index];
                        if (line.Contains("GetComponent<") || line.Contains(".GetComponent<") || line.Contains("FindObjectOfType") || line.Contains("FindFirstObjectByType") || line.Contains("GameObject.Find("))
                        {
                            stats.HotLookupLineCount++;
                        }
                    }
                }

                foreach (Match match in namespaceRegex.Matches(text))
                {
                    if (stats.Namespaces.Count >= limit)
                    {
                        break;
                    }

                    stats.Namespaces.Add(match.Groups[1].Value);
                }
            }

            return stats;
        }

        private static SerializedIndexStats BuildSerializedIndexStats(string projectRoot, int limit)
        {
            var stats = new SerializedIndexStats();
            var extensions = ReadReferenceExtensions(".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss");
            var guidRegex = new Regex(@"guid:\s*(?<guid>[0-9a-fA-F]{32})");
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
            {
                var extension = Path.GetExtension(fullPath);
                if (string.IsNullOrEmpty(extension) || !extensions.Contains(extension))
                {
                    continue;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipMetaAuditPath(assetPath))
                {
                    continue;
                }

                stats.ScannedFileCount++;
                string text;
                try
                {
                    text = File.ReadAllText(fullPath);
                }
                catch
                {
                    continue;
                }

                stats.GuidReferenceCount += guidRegex.Matches(text).Count;
                stats.UnityEventBindingCount += CountYamlMethodBindings(text);
            }

            return stats;
        }

        private static int CountYamlMethodBindings(string text)
        {
            var count = 0;
            var lines = (text ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            for (var index = 0; index < lines.Length; index++)
            {
                var method = ReadYamlValue(lines[index], "m_MethodName:");
                if (!string.IsNullOrEmpty(method))
                {
                    count++;
                }
            }

            return count;
        }

        private static int CountMetaIssues(string projectRoot, int limit)
        {
            var seenGuids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var count = 0;
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
            {
                if (count >= limit)
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

                var metaPath = fullPath + ".meta";
                if (!File.Exists(metaPath))
                {
                    count++;
                    continue;
                }

                var guid = ReadMetaGuid(metaPath);
                if (string.IsNullOrEmpty(guid))
                {
                    count++;
                    continue;
                }

                string existingPath;
                if (seenGuids.TryGetValue(guid, out existingPath))
                {
                    count++;
                    continue;
                }

                seenGuids[guid] = assetPath;
            }

            return count;
        }

        private static int CountUnusedAssetCandidates(string projectRoot, int limit)
        {
            var referencedGuids = BuildReferencedGuidSet(projectRoot, ReadReferenceExtensions(".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss"));
            var candidateExtensions = ReadReferenceExtensions(".prefab,.mat,.asset,.controller,.overrideController,.anim,.png,.jpg,.jpeg,.tga,.psd,.fbx,.obj,.wav,.mp3,.ogg,.shadergraph,.renderTexture,.uxml,.uss");
            var count = 0;
            foreach (var guid in AssetDatabase.FindAssets(string.Empty))
            {
                if (count >= limit)
                {
                    break;
                }

                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path) || AssetDatabase.IsValidFolder(path) || ShouldSkipUnusedCandidate(path, candidateExtensions, false))
                {
                    continue;
                }

                if (!referencedGuids.Contains(guid))
                {
                    count++;
                }
            }

            return count;
        }

        private static void AppendScriptIndexStats(StringBuilder builder, ScriptIndexStats stats)
        {
            builder.Append("{\"scriptCount\":");
            builder.Append(stats.ScriptCount);
            builder.Append(",\"typeDeclarationCount\":");
            builder.Append(stats.TypeDeclarationCount);
            builder.Append(",\"monoBehaviourCount\":");
            builder.Append(stats.MonoBehaviourCount);
            builder.Append(",\"scriptableObjectCount\":");
            builder.Append(stats.ScriptableObjectCount);
            builder.Append(",\"editorScriptCount\":");
            builder.Append(stats.EditorScriptCount);
            builder.Append(",\"testScriptCount\":");
            builder.Append(stats.TestScriptCount);
            builder.Append(",\"namespaceCount\":");
            builder.Append(stats.Namespaces.Count);
            builder.Append("}");
        }

        private static void AppendSerializedIndexStats(StringBuilder builder, SerializedIndexStats stats)
        {
            builder.Append("{\"scannedFileCount\":");
            builder.Append(stats.ScannedFileCount);
            builder.Append(",\"guidReferenceCount\":");
            builder.Append(stats.GuidReferenceCount);
            builder.Append(",\"unityEventBindingCount\":");
            builder.Append(stats.UnityEventBindingCount);
            builder.Append("}");
        }

        private static void AppendTopCounts(StringBuilder builder, Dictionary<string, int> counts, int limit)
        {
            var entries = new List<KeyValuePair<string, int>>(counts);
            entries.Sort(delegate (KeyValuePair<string, int> left, KeyValuePair<string, int> right)
            {
                var countCompare = right.Value.CompareTo(left.Value);
                return countCompare != 0 ? countCompare : string.Compare(left.Key, right.Key, StringComparison.OrdinalIgnoreCase);
            });

            builder.Append("[");
            for (var index = 0; index < entries.Count && index < limit; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"folder\":\"");
                builder.Append(JsonRpcUtil.Escape(entries[index].Key));
                builder.Append("\",\"count\":");
                builder.Append(entries[index].Value);
                builder.Append("}");
            }

            builder.Append("]");
        }

        private static int CountScriptSymbolReferences(string projectRoot, string targetPath, string className, string methodName, int limit)
        {
            var count = 0;
            var classRegex = string.IsNullOrEmpty(className) ? null : new Regex(@"\b" + Regex.Escape(className) + @"\b");
            var methodRegex = string.IsNullOrEmpty(methodName) ? null : new Regex(@"\b" + Regex.Escape(methodName) + @"\s*\(");
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                if (count >= limit)
                {
                    break;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipLintScript(assetPath) || string.Equals(assetPath, targetPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
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

                if (classRegex != null && classRegex.IsMatch(text))
                {
                    count++;
                }

                if (count < limit && methodRegex != null && methodRegex.IsMatch(text))
                {
                    count++;
                }
            }

            return count;
        }

        private static int CountGuidReferenceFiles(string projectRoot, string guid, string targetPath, HashSet<string> extensions, int limit, bool includeSelf)
        {
            if (string.IsNullOrEmpty(guid))
            {
                return 0;
            }

            var count = 0;
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
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
                if (!includeSelf && string.Equals(assetPath, targetPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
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

                if (text.IndexOf(guid, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    count++;
                }
            }

            return count;
        }

        private static List<TestScopeSuggestion> BuildTestScopeSuggestions(string projectRoot, string targetPath, string className, string methodName, bool includePlayMode, int limit)
        {
            var suggestions = new List<TestScopeSuggestion>();
            var targetFolder = ReadTopFolder(targetPath);
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipLintScript(assetPath))
                {
                    continue;
                }

                var normalized = assetPath.Replace("\\", "/");
                var looksLikeTest = normalized.Contains("/Tests/", StringComparison.OrdinalIgnoreCase)
                    || normalized.Contains("/Test/", StringComparison.OrdinalIgnoreCase)
                    || normalized.IndexOf("Test", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!looksLikeTest)
                {
                    continue;
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

                var score = 0;
                var reasons = new List<string>();
                if (text.Contains("NUnit.Framework") || text.Contains("UnityEngine.TestTools") || text.Contains("[Test]") || text.Contains("[UnityTest]"))
                {
                    score += 2;
                    reasons.Add("contains Unity/NUnit test markers");
                }

                if (!string.IsNullOrEmpty(className) && text.IndexOf(className, StringComparison.Ordinal) >= 0)
                {
                    score += 8;
                    reasons.Add("references target class");
                }

                if (!string.IsNullOrEmpty(methodName) && text.IndexOf(methodName, StringComparison.Ordinal) >= 0)
                {
                    score += 5;
                    reasons.Add("references target method");
                }

                if (!string.IsNullOrEmpty(targetFolder) && normalized.IndexOf("/" + targetFolder + "/", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    score += 2;
                    reasons.Add("shares top-level content folder");
                }

                if (score <= 0)
                {
                    continue;
                }

                var mode = normalized.IndexOf("PlayMode", StringComparison.OrdinalIgnoreCase) >= 0 || text.Contains("[UnityTest]") ? "playmode" : "editmode";
                if (!includePlayMode && mode == "playmode")
                {
                    continue;
                }

                suggestions.Add(new TestScopeSuggestion
                {
                    Path = assetPath,
                    Mode = mode,
                    Filter = Path.GetFileNameWithoutExtension(assetPath),
                    Score = score,
                    Reasons = reasons
                });
            }

            suggestions.Sort(delegate (TestScopeSuggestion left, TestScopeSuggestion right)
            {
                var scoreCompare = right.Score.CompareTo(left.Score);
                return scoreCompare != 0 ? scoreCompare : string.Compare(left.Path, right.Path, StringComparison.OrdinalIgnoreCase);
            });

            if (suggestions.Count > limit)
            {
                suggestions.RemoveRange(limit, suggestions.Count - limit);
            }

            return suggestions;
        }

        private static string ReadTopFolder(string assetPath)
        {
            var normalized = NormalizeAssetPath(assetPath);
            if (!normalized.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var remainder = normalized.Substring("Assets/".Length);
            var slash = remainder.IndexOf('/');
            return slash >= 0 ? remainder.Substring(0, slash) : string.Empty;
        }

        private static string DetermineTestScopeRisk(int scriptReferenceCount, int serializedReferenceCount, int suggestedTestCount)
        {
            var score = 0;
            if (scriptReferenceCount > 20)
            {
                score += 2;
            }
            else if (scriptReferenceCount > 0)
            {
                score += 1;
            }

            if (serializedReferenceCount > 10)
            {
                score += 2;
            }
            else if (serializedReferenceCount > 0)
            {
                score += 1;
            }

            if (suggestedTestCount == 0)
            {
                score += 2;
            }

            if (score >= 4)
            {
                return "high";
            }

            return score >= 2 ? "medium" : "low";
        }

        private static void AppendTestScopeSuggestion(StringBuilder builder, TestScopeSuggestion suggestion)
        {
            builder.Append("{\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(suggestion.Path));
            builder.Append("\",\"mode\":\"");
            builder.Append(JsonRpcUtil.Escape(suggestion.Mode));
            builder.Append("\",\"filter\":\"");
            builder.Append(JsonRpcUtil.Escape(suggestion.Filter));
            builder.Append("\",\"score\":");
            builder.Append(suggestion.Score);
            builder.Append(",\"reasons\":[");
            for (var index = 0; index < suggestion.Reasons.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                builder.Append("\"");
                builder.Append(JsonRpcUtil.Escape(suggestion.Reasons[index]));
                builder.Append("\"");
            }

            builder.Append("]}");
        }

        private static void AppendValidationStep(StringBuilder builder, string tool, string argumentsJson, string reason)
        {
            builder.Append("{\"tool\":\"");
            builder.Append(JsonRpcUtil.Escape(tool));
            builder.Append("\",\"arguments\":");
            builder.Append(argumentsJson);
            builder.Append(",\"reason\":\"");
            builder.Append(JsonRpcUtil.Escape(reason));
            builder.Append("\"}");
        }

        private static string PreferredTestMode(List<TestScopeSuggestion> suggestions)
        {
            foreach (var suggestion in suggestions)
            {
                if (suggestion.Mode == "editmode")
                {
                    return "editmode";
                }
            }

            return suggestions.Count > 0 ? suggestions[0].Mode : "editmode";
        }

        private static string PreferredTestFilter(List<TestScopeSuggestion> suggestions)
        {
            return suggestions.Count > 0 ? suggestions[0].Filter : string.Empty;
        }

        private static Texture2D LoadScreenshotTexture(string path)
        {
            var bytes = File.ReadAllBytes(path);
            var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!texture.LoadImage(bytes, false))
            {
                UnityEngine.Object.DestroyImmediate(texture);
                throw new InvalidOperationException("Could not decode PNG screenshot: " + path);
            }

            return texture;
        }

        private static ScreenshotDiffStats CompareScreenshots(Texture2D baseline, Texture2D current, int maxSamples)
        {
            var width = Math.Min(baseline.width, current.width);
            var height = Math.Min(baseline.height, current.height);
            if (width <= 0 || height <= 0)
            {
                throw new InvalidOperationException("Screenshots have no overlapping pixel area.");
            }

            var totalPixels = width * height;
            var step = Math.Max(1, (int)Math.Sqrt(Math.Max(1, totalPixels / Math.Max(1, maxSamples))));
            var sampled = 0;
            var different = 0;
            double totalDifference = 0;
            for (var y = 0; y < height; y += step)
            {
                for (var x = 0; x < width; x += step)
                {
                    var left = baseline.GetPixel(x, y);
                    var right = current.GetPixel(x, y);
                    var difference = (Math.Abs(left.r - right.r) + Math.Abs(left.g - right.g) + Math.Abs(left.b - right.b) + Math.Abs(left.a - right.a)) / 4.0;
                    totalDifference += difference;
                    if (difference > 0.01)
                    {
                        different++;
                    }

                    sampled++;
                    if (sampled >= maxSamples)
                    {
                        break;
                    }
                }

                if (sampled >= maxSamples)
                {
                    break;
                }
            }

            return new ScreenshotDiffStats
            {
                SampledPixels = sampled,
                DifferentPixels = different,
                DifferentRatio = sampled == 0 ? 0f : (float)different / sampled,
                MeanAbsoluteDifference = sampled == 0 ? 0f : (float)(totalDifference / sampled)
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

        private static string FindScriptPathForClass(string className)
        {
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var classRegex = new Regex(@"\b(class|struct|interface|enum)\s+" + Regex.Escape(className) + @"\b");
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (string.Equals(Path.GetFileNameWithoutExtension(assetPath), className, StringComparison.OrdinalIgnoreCase))
                {
                    return assetPath;
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

                if (classRegex.IsMatch(text))
                {
                    return assetPath;
                }
            }

            return string.Empty;
        }

        private static void AppendMetaIssue(StringBuilder builder, ref int issueCount, string kind, string assetPath, string metaPath, string guid, string duplicateOf = "")
        {
            if (issueCount > 0)
            {
                builder.Append(",");
            }

            builder.Append("{\"kind\":\"");
            builder.Append(JsonRpcUtil.Escape(kind));
            builder.Append("\",\"assetPath\":\"");
            builder.Append(JsonRpcUtil.Escape(assetPath));
            builder.Append("\",\"metaPath\":\"");
            builder.Append(JsonRpcUtil.Escape(metaPath));
            builder.Append("\",\"guid\":\"");
            builder.Append(JsonRpcUtil.Escape(guid));
            builder.Append("\",\"duplicateOf\":\"");
            builder.Append(JsonRpcUtil.Escape(duplicateOf));
            builder.Append("\"}");
            issueCount++;
        }

        private static HashSet<string> BuildReferencedGuidSet(string projectRoot, HashSet<string> extensions)
        {
            var referenced = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var guidRegex = new Regex(@"guid:\s*(?<guid>[0-9a-fA-F]{32})", RegexOptions.Compiled);
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.*", SearchOption.AllDirectories))
            {
                var extension = Path.GetExtension(fullPath);
                if (string.IsNullOrEmpty(extension) || !extensions.Contains(extension))
                {
                    continue;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                if (ShouldSkipMetaAuditPath(assetPath))
                {
                    continue;
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

                foreach (Match match in guidRegex.Matches(text))
                {
                    referenced.Add(match.Groups["guid"].Value);
                }
            }

            return referenced;
        }

        private static string ReadMetaGuid(string metaPath)
        {
            try
            {
                foreach (var line in File.ReadLines(metaPath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.StartsWith("guid:", StringComparison.Ordinal))
                    {
                        return trimmed.Substring("guid:".Length).Trim();
                    }
                }
            }
            catch
            {
                return string.Empty;
            }

            return string.Empty;
        }

        private static bool ShouldSkipMetaAuditPath(string assetPath)
        {
            var normalized = (assetPath ?? string.Empty).Replace("\\", "/");
            return normalized.Contains("/Library/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Temp/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Obj/", StringComparison.OrdinalIgnoreCase);
        }

        private static bool ShouldSkipUnusedCandidate(string path, HashSet<string> candidateExtensions, bool includeScripts)
        {
            var extension = Path.GetExtension(path);
            if (string.IsNullOrEmpty(extension) || !candidateExtensions.Contains(extension))
            {
                return true;
            }

            if (!includeScripts && extension.Equals(".cs", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            var normalized = path.Replace("\\", "/");
            if (normalized.StartsWith("Assets/Resources/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Resources/", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("Assets/StreamingAssets/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Editor/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/Gizmos/", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return false;
        }

        private static int AppendUnityEventBindings(
            StringBuilder builder,
            string text,
            string assetPath,
            string extension,
            string methodName,
            string targetType,
            int count,
            int limit)
        {
            var lines = (text ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            for (var index = 0; index < lines.Length && count < limit; index++)
            {
                var method = ReadYamlValue(lines[index], "m_MethodName:");
                if (string.IsNullOrEmpty(method))
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(methodName) && !string.Equals(method, methodName, StringComparison.Ordinal))
                {
                    continue;
                }

                var assemblyType = FindNearbyYamlValue(lines, index, "m_TargetAssemblyTypeName:", 30, 8);
                if (!string.IsNullOrEmpty(targetType) && assemblyType.IndexOf(targetType, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                AppendUnityEventBinding(
                    builder,
                    assetPath,
                    extension,
                    method,
                    assemblyType,
                    FindNearbyYamlValue(lines, index, "m_Target:", 30, 8),
                    FindNearbyYamlValue(lines, index, "m_Mode:", 4, 8),
                    FindUnityEventPropertyName(lines, index),
                    index + 1);
                count++;
            }

            return count;
        }

        private static void AppendUnityEventBinding(
            StringBuilder builder,
            string assetPath,
            string extension,
            string methodName,
            string assemblyType,
            string targetReference,
            string mode,
            string eventProperty,
            int line)
        {
            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            var type = AssetDatabase.GetMainAssetTypeAtPath(assetPath);
            builder.Append("{\"assetGuid\":\"");
            builder.Append(JsonRpcUtil.Escape(guid));
            builder.Append("\",\"assetPath\":\"");
            builder.Append(JsonRpcUtil.Escape(assetPath));
            builder.Append("\",\"assetName\":\"");
            builder.Append(JsonRpcUtil.Escape(Path.GetFileNameWithoutExtension(assetPath)));
            builder.Append("\",\"assetExtension\":\"");
            builder.Append(JsonRpcUtil.Escape(extension));
            builder.Append("\",\"assetType\":\"");
            builder.Append(JsonRpcUtil.Escape(type == null ? string.Empty : type.FullName));
            builder.Append("\",\"eventProperty\":\"");
            builder.Append(JsonRpcUtil.Escape(eventProperty));
            builder.Append("\",\"methodName\":\"");
            builder.Append(JsonRpcUtil.Escape(methodName));
            builder.Append("\",\"targetAssemblyTypeName\":\"");
            builder.Append(JsonRpcUtil.Escape(assemblyType));
            builder.Append("\",\"targetReference\":\"");
            builder.Append(JsonRpcUtil.Escape(targetReference));
            builder.Append("\",\"mode\":\"");
            builder.Append(JsonRpcUtil.Escape(mode));
            builder.Append("\",\"line\":");
            builder.Append(line);
            builder.Append("}");
        }

        private static int AppendAnimatorParameters(StringBuilder builder, string[] lines, int limit)
        {
            var count = 0;
            var inParameters = false;
            for (var index = 0; index < lines.Length && count < limit; index++)
            {
                var trimmed = (lines[index] ?? string.Empty).Trim();
                if (trimmed == "m_AnimatorParameters:")
                {
                    inParameters = true;
                    continue;
                }

                if (!inParameters)
                {
                    continue;
                }

                if (trimmed == "m_AnimatorLayers:" || trimmed.StartsWith("--- ", StringComparison.Ordinal))
                {
                    break;
                }

                var name = ReadYamlValue(lines[index], "m_Name:");
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"name\":\"");
                builder.Append(JsonRpcUtil.Escape(name));
                builder.Append("\",\"type\":\"");
                builder.Append(JsonRpcUtil.Escape(AnimatorParameterTypeName(FindNearbyYamlValue(lines, index, "m_Type:", 0, 8))));
                builder.Append("\",\"defaultFloat\":\"");
                builder.Append(JsonRpcUtil.Escape(FindNearbyYamlValue(lines, index, "m_DefaultFloat:", 0, 8)));
                builder.Append("\",\"defaultInt\":\"");
                builder.Append(JsonRpcUtil.Escape(FindNearbyYamlValue(lines, index, "m_DefaultInt:", 0, 8)));
                builder.Append("\",\"defaultBool\":\"");
                builder.Append(JsonRpcUtil.Escape(FindNearbyYamlValue(lines, index, "m_DefaultBool:", 0, 8)));
                builder.Append("\"}");
                count++;
            }

            return count;
        }

        private static int AppendAnimatorBlocks(StringBuilder builder, string[] lines, string blockType, bool includeConditions, int limit)
        {
            var count = 0;
            for (var index = 0; index < lines.Length && count < limit; index++)
            {
                if ((lines[index] ?? string.Empty).Trim() != blockType)
                {
                    continue;
                }

                var end = FindYamlBlockEnd(lines, index + 1);
                if (count > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"fileId\":\"");
                builder.Append(JsonRpcUtil.Escape(FindYamlObjectFileId(lines, index)));
                builder.Append("\",\"name\":\"");
                builder.Append(JsonRpcUtil.Escape(FindBlockYamlValue(lines, index, end, "m_Name:")));
                builder.Append("\"");

                if (blockType == "AnimatorState:")
                {
                    builder.Append(",\"speed\":\"");
                    builder.Append(JsonRpcUtil.Escape(FindBlockYamlValue(lines, index, end, "m_Speed:")));
                    builder.Append("\",\"motion\":\"");
                    builder.Append(JsonRpcUtil.Escape(FindBlockYamlValue(lines, index, end, "m_Motion:")));
                    builder.Append("\"");
                }

                if (includeConditions)
                {
                    builder.Append(",\"destinationState\":\"");
                    builder.Append(JsonRpcUtil.Escape(FindBlockYamlValue(lines, index, end, "m_DstState:")));
                    builder.Append("\",\"conditions\":[");
                    AppendAnimatorConditions(builder, lines, index, end);
                    builder.Append("]");
                }

                builder.Append("}");
                count++;
                index = end;
            }

            return count;
        }

        private static void AppendAnimatorConditions(StringBuilder builder, string[] lines, int start, int end)
        {
            var count = 0;
            for (var index = start; index <= end; index++)
            {
                var parameter = ReadYamlValue(lines[index], "m_ConditionEvent:");
                if (string.IsNullOrEmpty(parameter))
                {
                    continue;
                }

                if (count > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{\"parameter\":\"");
                builder.Append(JsonRpcUtil.Escape(parameter));
                builder.Append("\",\"mode\":\"");
                builder.Append(JsonRpcUtil.Escape(AnimatorConditionModeName(FindNearbyYamlValue(lines, index, "m_ConditionMode:", 4, 4))));
                builder.Append("\",\"threshold\":\"");
                builder.Append(JsonRpcUtil.Escape(FindNearbyYamlValue(lines, index, "m_EventTreshold:", 4, 4)));
                builder.Append("\"}");
                count++;
            }
        }

        private static List<MethodNode> BuildMethodIndex()
        {
            var methods = new List<MethodNode>();
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var declarationRegex = new Regex(@"(?<prefix>\b(public|private|protected|internal|static|virtual|override|async|sealed|new|extern|partial)\s+)+(?:[\w<>\[\],\s\.]+\s+)(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(where\s+[^{]+)?\{", RegexOptions.Multiline);
            foreach (var fullPath in Directory.GetFiles(Application.dataPath, "*.cs", SearchOption.AllDirectories))
            {
                string text;
                try
                {
                    text = File.ReadAllText(fullPath);
                }
                catch
                {
                    continue;
                }

                var assetPath = ToAssetPath(projectRoot, fullPath);
                foreach (Match match in declarationRegex.Matches(text))
                {
                    var methodName = match.Groups["name"].Value;
                    if (IsIgnoredCallName(methodName))
                    {
                        continue;
                    }

                    var openBrace = text.IndexOf('{', match.Index + match.Length - 1);
                    var closeBrace = FindMatchingBrace(text, openBrace);
                    if (openBrace < 0 || closeBrace <= openBrace)
                    {
                        continue;
                    }

                    var className = FindNearestClassName(text, match.Index);
                    var node = new MethodNode
                    {
                        MethodName = methodName,
                        ClassName = className,
                        FullName = string.IsNullOrEmpty(className) ? methodName : className + "." + methodName,
                        Path = assetPath,
                        Line = CountLines(text, match.Index),
                        Calls = ExtractCalls(text.Substring(openBrace + 1, closeBrace - openBrace - 1))
                    };
                    methods.Add(node);
                }
            }

            return methods;
        }

        private static List<MethodNode> FindCallPath(List<MethodNode> methods, string fromMethod, string toMethod, int maxDepth)
        {
            var starts = new List<MethodNode>();
            foreach (var method in methods)
            {
                if (MatchesMethodQuery(method, fromMethod))
                {
                    starts.Add(method);
                }
            }

            var visited = new HashSet<string>(StringComparer.Ordinal);
            var queue = new Queue<List<MethodNode>>();
            foreach (var start in starts)
            {
                queue.Enqueue(new List<MethodNode> { start });
                visited.Add(start.FullName + "@" + start.Path + ":" + start.Line);
            }

            while (queue.Count > 0)
            {
                var path = queue.Dequeue();
                var current = path[path.Count - 1];
                if (MatchesMethodQuery(current, toMethod))
                {
                    return path;
                }

                if (path.Count > maxDepth)
                {
                    continue;
                }

                foreach (var next in methods)
                {
                    if (!current.Calls.Contains(next.MethodName) && !current.Calls.Contains(next.FullName))
                    {
                        continue;
                    }

                    var key = next.FullName + "@" + next.Path + ":" + next.Line;
                    if (visited.Contains(key))
                    {
                        continue;
                    }

                    var nextPath = new List<MethodNode>(path);
                    nextPath.Add(next);
                    queue.Enqueue(nextPath);
                    visited.Add(key);
                }
            }

            return new List<MethodNode>();
        }

        private static void AppendMethodNode(StringBuilder builder, MethodNode node)
        {
            builder.Append("{\"method\":\"");
            builder.Append(JsonRpcUtil.Escape(node.MethodName));
            builder.Append("\",\"className\":\"");
            builder.Append(JsonRpcUtil.Escape(node.ClassName));
            builder.Append("\",\"fullName\":\"");
            builder.Append(JsonRpcUtil.Escape(node.FullName));
            builder.Append("\",\"path\":\"");
            builder.Append(JsonRpcUtil.Escape(node.Path));
            builder.Append("\",\"line\":");
            builder.Append(node.Line);
            builder.Append(",\"calls\":[");
            var index = 0;
            foreach (var call in node.Calls)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                builder.Append("\"");
                builder.Append(JsonRpcUtil.Escape(call));
                builder.Append("\"");
                index++;
            }

            builder.Append("]}");
        }

        private static bool MatchesMethodQuery(MethodNode node, string query)
        {
            return string.Equals(node.MethodName, query, StringComparison.Ordinal)
                || string.Equals(node.FullName, query, StringComparison.Ordinal)
                || node.FullName.EndsWith("." + query, StringComparison.Ordinal);
        }

        private static int FindMatchingBrace(string text, int openBrace)
        {
            if (openBrace < 0)
            {
                return -1;
            }

            var depth = 0;
            var inString = false;
            var escaped = false;
            for (var index = openBrace; index < text.Length; index++)
            {
                var character = text[index];
                if (inString)
                {
                    if (escaped)
                    {
                        escaped = false;
                    }
                    else if (character == '\\')
                    {
                        escaped = true;
                    }
                    else if (character == '"')
                    {
                        inString = false;
                    }

                    continue;
                }

                if (character == '"')
                {
                    inString = true;
                    continue;
                }

                if (character == '{')
                {
                    depth++;
                }
                else if (character == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return index;
                    }
                }
            }

            return -1;
        }

        private static string FindNearestClassName(string text, int beforeIndex)
        {
            var classRegex = new Regex(@"\b(class|struct|interface)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\b");
            var className = string.Empty;
            foreach (Match match in classRegex.Matches(text.Substring(0, Math.Max(0, beforeIndex))))
            {
                var openBrace = text.IndexOf('{', match.Index + match.Length);
                var closeBrace = FindMatchingBrace(text, openBrace);
                if (openBrace >= 0 && openBrace < beforeIndex && closeBrace > beforeIndex)
                {
                    className = match.Groups["name"].Value;
                }
            }

            return className;
        }

        private static int CountLines(string text, int beforeIndex)
        {
            var line = 1;
            var max = Math.Min(beforeIndex, text.Length);
            for (var index = 0; index < max; index++)
            {
                if (text[index] == '\n')
                {
                    line++;
                }
            }

            return line;
        }

        private static HashSet<string> ExtractCalls(string body)
        {
            var calls = new HashSet<string>(StringComparer.Ordinal);
            var callRegex = new Regex(@"\b(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(");
            foreach (Match match in callRegex.Matches(body ?? string.Empty))
            {
                var name = match.Groups["name"].Value;
                if (!IsIgnoredCallName(name))
                {
                    calls.Add(name);
                }
            }

            return calls;
        }

        private static bool IsIgnoredCallName(string name)
        {
            switch (name)
            {
                case "if":
                case "for":
                case "foreach":
                case "while":
                case "switch":
                case "catch":
                case "using":
                case "lock":
                case "return":
                case "new":
                case "nameof":
                case "typeof":
                case "sizeof":
                case "default":
                case "checked":
                case "unchecked":
                    return true;
                default:
                    return false;
            }
        }

        private static string ReadYamlValue(string line, string key)
        {
            var trimmed = (line ?? string.Empty).Trim();
            if (trimmed.StartsWith("- ", StringComparison.Ordinal))
            {
                trimmed = trimmed.Substring(2).TrimStart();
            }

            if (!trimmed.StartsWith(key, StringComparison.Ordinal))
            {
                return string.Empty;
            }

            return trimmed.Substring(key.Length).Trim().Trim('"');
        }

        private static string FindNearbyYamlValue(string[] lines, int index, string key, int back, int forward)
        {
            var start = Math.Max(0, index - back);
            for (var current = index; current >= start; current--)
            {
                var value = ReadYamlValue(lines[current], key);
                if (!string.IsNullOrEmpty(value))
                {
                    return value;
                }
            }

            var end = Math.Min(lines.Length - 1, index + forward);
            for (var current = index + 1; current <= end; current++)
            {
                var value = ReadYamlValue(lines[current], key);
                if (!string.IsNullOrEmpty(value))
                {
                    return value;
                }
            }

            return string.Empty;
        }

        private static string FindYamlObjectFileId(string[] lines, int index)
        {
            for (var current = index; current >= 0 && current >= index - 2; current--)
            {
                var match = Regex.Match(lines[current] ?? string.Empty, @"&(?<id>-?\d+)");
                if (match.Success)
                {
                    return match.Groups["id"].Value;
                }
            }

            return string.Empty;
        }

        private static int FindYamlBlockEnd(string[] lines, int start)
        {
            for (var index = start; index < lines.Length; index++)
            {
                if ((lines[index] ?? string.Empty).StartsWith("--- ", StringComparison.Ordinal))
                {
                    return Math.Max(start, index - 1);
                }
            }

            return lines.Length - 1;
        }

        private static string FindBlockYamlValue(string[] lines, int start, int end, string key)
        {
            for (var index = start; index <= end; index++)
            {
                var value = ReadYamlValue(lines[index], key);
                if (!string.IsNullOrEmpty(value))
                {
                    return value;
                }
            }

            return string.Empty;
        }

        private static string AnimatorParameterTypeName(string value)
        {
            if (value == "1")
            {
                return "Float";
            }

            if (value == "3")
            {
                return "Int";
            }

            if (value == "4")
            {
                return "Bool";
            }

            if (value == "9")
            {
                return "Trigger";
            }

            return value;
        }

        private static string AnimatorConditionModeName(string value)
        {
            if (value == "1")
            {
                return "If";
            }

            if (value == "2")
            {
                return "IfNot";
            }

            if (value == "3")
            {
                return "Greater";
            }

            if (value == "4")
            {
                return "Less";
            }

            if (value == "6")
            {
                return "Equals";
            }

            if (value == "7")
            {
                return "NotEqual";
            }

            return value;
        }

        private static string FindUnityEventPropertyName(string[] lines, int index)
        {
            var start = Math.Max(0, index - 80);
            for (var current = index; current >= start; current--)
            {
                var trimmed = (lines[current] ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("-", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!trimmed.EndsWith(":", StringComparison.Ordinal))
                {
                    continue;
                }

                var candidate = trimmed.TrimEnd(':');
                if (candidate == "m_PersistentCalls" || candidate == "m_Calls" || candidate == "m_Arguments")
                {
                    continue;
                }

                if (Regex.IsMatch(candidate, @"^m_[A-Za-z0-9_]+$"))
                {
                    return candidate;
                }
            }

            return string.Empty;
        }

        private static HashSet<string> ReadReferenceExtensions(string csv)
        {
            var extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var raw = string.IsNullOrEmpty(csv)
                ? ".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef"
                : csv;
            foreach (var part in raw.Split(','))
            {
                var extension = part.Trim();
                if (string.IsNullOrEmpty(extension))
                {
                    continue;
                }

                if (!extension.StartsWith(".", StringComparison.Ordinal))
                {
                    extension = "." + extension;
                }

                extensions.Add(extension);
            }

            return extensions;
        }

        private static string ToAssetPath(string projectRoot, string fullPath)
        {
            var relative = fullPath.Substring(projectRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return relative.Replace("\\", "/");
        }

        private static string NormalizeAssetPath(string path)
        {
            var normalized = (path ?? string.Empty).Replace("\\", "/").Trim();
            if (!normalized.StartsWith("Assets", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Asset paths must be under Assets/: " + path);
            }

            return normalized.TrimEnd('/');
        }

        private static string EnsureScriptPath(string path)
        {
            var normalized = NormalizeAssetPath(path);
            if (!normalized.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                normalized += ".cs";
            }

            return normalized;
        }

        private static string EnsurePrefabPath(string path)
        {
            var normalized = NormalizeAssetPath(path);
            if (!normalized.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                normalized += ".prefab";
            }

            return normalized;
        }

        private static void EnsureAssetParentFolder(string assetPath)
        {
            var parent = Path.GetDirectoryName(assetPath);
            if (string.IsNullOrEmpty(parent))
            {
                return;
            }

            parent = parent.Replace("\\", "/");
            if (!AssetDatabase.IsValidFolder(parent))
            {
                throw new InvalidOperationException("Asset folder does not exist: " + parent);
            }
        }

        private static void EnsureAssetExists(string assetPath)
        {
            if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(assetPath)))
            {
                throw new InvalidOperationException("Asset does not exist: " + assetPath);
            }
        }

        private static string FullAssetPath(string assetPath)
        {
            var relative = NormalizeAssetPath(assetPath).Substring("Assets".Length).TrimStart('/');
            return Path.Combine(Application.dataPath, relative.Replace("/", Path.DirectorySeparatorChar.ToString()));
        }

        private static string WriteScript(string path, string contents, bool overwrite, bool dryRun, string action)
        {
            EnsureAssetParentFolder(path);
            var fullPath = FullAssetPath(path);
            var exists = File.Exists(fullPath);
            if (exists && !overwrite)
            {
                throw new InvalidOperationException("Script already exists and overwrite is false: " + path);
            }

            if (dryRun)
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"" + JsonRpcUtil.Escape(action) + "\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"overwrite\":" + Bool(overwrite) + ",\"bytes\":" + Encoding.UTF8.GetByteCount(contents) + "}}";
            }

            File.WriteAllText(fullPath, contents, Encoding.UTF8);
            AssetDatabase.ImportAsset(path);
            var guid = AssetDatabase.AssetPathToGUID(path);
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"guid\":\"" + JsonRpcUtil.Escape(guid) + "\",\"created\":" + Bool(!exists) + "}";
        }

        private static string BuildScriptTemplate(string className, string namespaceName)
        {
            if (string.IsNullOrEmpty(className))
            {
                throw new InvalidOperationException("script.create requires className when path has no filename.");
            }

            var body = "using UnityEngine;\n\n"
                + "public sealed class " + className + " : MonoBehaviour\n"
                + "{\n"
                + "}\n";
            if (string.IsNullOrEmpty(namespaceName))
            {
                return body;
            }

            return "using UnityEngine;\n\n"
                + "namespace " + namespaceName + "\n"
                + "{\n"
                + "    public sealed class " + className + " : MonoBehaviour\n"
                + "    {\n"
                + "    }\n"
                + "}\n";
        }

        private static int TextOffset(string text, int line, int column)
        {
            if (line < 0 || column < 0)
            {
                throw new InvalidOperationException("Text edit line and column must be zero or greater.");
            }

            var currentLine = 0;
            var currentColumn = 0;
            for (var index = 0; index < text.Length; index++)
            {
                if (currentLine == line && currentColumn == column)
                {
                    return index;
                }

                var character = text[index];
                if (character == '\r')
                {
                    if (index + 1 < text.Length && text[index + 1] == '\n')
                    {
                        index++;
                    }

                    currentLine++;
                    currentColumn = 0;
                    continue;
                }

                if (character == '\n')
                {
                    currentLine++;
                    currentColumn = 0;
                    continue;
                }

                currentColumn++;
            }

            if (currentLine == line && currentColumn == column)
            {
                return text.Length;
            }

            throw new InvalidOperationException("Text edit position is outside the script content: line " + line + ", column " + column);
        }

        private static string OperationStarted(string operationId, string action)
        {
            return "{\"ok\":true,\"operationId\":\"" + JsonRpcUtil.Escape(operationId) + "\",\"status\":\"running\",\"action\":\"" + JsonRpcUtil.Escape(action) + "\"}";
        }

        private static string PackageListState(ListRequest request)
        {
            if (!request.IsCompleted)
            {
                return "{\"status\":\"running\"}";
            }

            if (request.Status == StatusCode.Failure)
            {
                return PackageErrorState(request.Error.message);
            }

            var builder = new StringBuilder();
            builder.Append("{\"status\":\"success\",\"packages\":[");
            var first = true;
            foreach (var package in request.Result)
            {
                if (!first)
                {
                    builder.Append(",");
                }

                first = false;
                AppendPackageInfo(builder, package);
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string PackageSearchState(SearchRequest request)
        {
            if (!request.IsCompleted)
            {
                return "{\"status\":\"running\"}";
            }

            if (request.Status == StatusCode.Failure)
            {
                return PackageErrorState(request.Error.message);
            }

            var builder = new StringBuilder();
            builder.Append("{\"status\":\"success\",\"packages\":[");
            for (var index = 0; index < request.Result.Length; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                AppendPackageInfo(builder, request.Result[index]);
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string PackageAddState(AddRequest request)
        {
            if (!request.IsCompleted)
            {
                return "{\"status\":\"running\"}";
            }

            if (request.Status == StatusCode.Failure)
            {
                return PackageErrorState(request.Error.message);
            }

            var builder = new StringBuilder();
            builder.Append("{\"status\":\"success\",\"package\":");
            AppendPackageInfo(builder, request.Result);
            builder.Append("}");
            return builder.ToString();
        }

        private static string PackageRemoveState(RemoveRequest request, string packageName)
        {
            if (!request.IsCompleted)
            {
                return "{\"status\":\"running\"}";
            }

            if (request.Status == StatusCode.Failure)
            {
                return PackageErrorState(request.Error.message);
            }

            return "{\"status\":\"success\",\"packageName\":\"" + JsonRpcUtil.Escape(packageName) + "\"}";
        }

        private static string PackageErrorState(string message)
        {
            return "{\"status\":\"failed\",\"error\":\"" + JsonRpcUtil.Escape(message) + "\"}";
        }

        private static string CompileWaitState(DateTime startedAt, DateTime deadline)
        {
            var isCompiling = EditorApplication.isCompiling;
            var isUpdating = EditorApplication.isUpdating;
            var status = (!isCompiling && !isUpdating) ? "success" : DateTime.UtcNow > deadline ? "failed" : "running";
            return "{"
                + "\"status\":\"" + status + "\","
                + "\"isCompiling\":" + Bool(isCompiling) + ","
                + "\"isUpdating\":" + Bool(isUpdating) + ","
                + "\"startedAtUtc\":\"" + startedAt.ToString("O", CultureInfo.InvariantCulture) + "\","
                + "\"elapsedMs\":" + (int)(DateTime.UtcNow - startedAt).TotalMilliseconds
                + "}";
        }

        private static void AppendPackageInfo(StringBuilder builder, UnityEditor.PackageManager.PackageInfo package)
        {
            builder.Append("{\"name\":\"");
            builder.Append(JsonRpcUtil.Escape(package.name));
            builder.Append("\",\"displayName\":\"");
            builder.Append(JsonRpcUtil.Escape(package.displayName));
            builder.Append("\",\"version\":\"");
            builder.Append(JsonRpcUtil.Escape(package.version));
            builder.Append("\",\"source\":\"");
            builder.Append(JsonRpcUtil.Escape(package.source.ToString()));
            builder.Append("\",\"resolvedPath\":\"");
            builder.Append(JsonRpcUtil.Escape(package.resolvedPath));
            builder.Append("\"}");
        }

        private static string PlannedGameObjectMutation(string action, string name, UnityMcpRequest request, string primitive = null)
        {
            return "{"
                + "\"ok\":true,"
                + "\"dryRun\":true,"
                + "\"planned\":{"
                + "\"action\":\"" + JsonRpcUtil.Escape(action) + "\","
                + "\"name\":\"" + JsonRpcUtil.Escape(name) + "\","
                + (primitive == null ? string.Empty : "\"primitive\":\"" + JsonRpcUtil.Escape(primitive) + "\",")
                + "\"position\":{\"x\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "x", 0)) + ",\"y\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "y", 0)) + ",\"z\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "z", 0)) + "},"
                + "\"rotation\":{\"x\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "rotationX", 0)) + ",\"y\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "rotationY", 0)) + ",\"z\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "rotationZ", 0)) + "},"
                + "\"scale\":{\"x\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "scaleX", 1)) + ",\"y\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "scaleY", 1)) + ",\"z\":" + Float(JsonRpcUtil.ReadFloat(request.RawJson, "scaleZ", 1)) + "}"
                + "}}";
        }

        private static string Float(float value)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }

    internal sealed class GhostTestRunCallbacks : ICallbacks
    {
        private int total;
        private int passed;
        private int failed;
        private int skipped;

        public GhostTestRunCallbacks(string operationId)
        {
            OperationId = operationId;
            StateJson = "{\"status\":\"running\",\"operationId\":\"" + JsonRpcUtil.Escape(operationId) + "\"}";
        }

        public string OperationId { get; private set; }
        public string StateJson { get; private set; }

        public void RunStarted(ITestAdaptor testsToRun)
        {
            total = testsToRun.TestCaseCount;
            StateJson = "{\"status\":\"running\",\"operationId\":\"" + JsonRpcUtil.Escape(OperationId) + "\",\"total\":" + total + "}";
        }

        public void RunFinished(ITestResultAdaptor result)
        {
            StateJson = "{"
                + "\"status\":\"success\","
                + "\"operationId\":\"" + JsonRpcUtil.Escape(OperationId) + "\","
                + "\"total\":" + total + ","
                + "\"passed\":" + passed + ","
                + "\"failed\":" + failed + ","
                + "\"skipped\":" + skipped + ","
                + "\"duration\":" + result.Duration.ToString("R", CultureInfo.InvariantCulture) + ","
                + "\"resultState\":\"" + JsonRpcUtil.Escape(result.ResultState) + "\","
                + "\"message\":\"" + JsonRpcUtil.Escape(result.Message) + "\""
                + "}";
        }

        public void TestStarted(ITestAdaptor test)
        {
        }

        public void TestFinished(ITestResultAdaptor result)
        {
            if (result.Test == null || !result.Test.IsTestAssembly)
            {
                if (string.Equals(result.ResultState, "Passed", StringComparison.OrdinalIgnoreCase))
                {
                    passed++;
                }
                else if (string.Equals(result.ResultState, "Skipped", StringComparison.OrdinalIgnoreCase))
                {
                    skipped++;
                }
                else if (!string.Equals(result.ResultState, "Inconclusive", StringComparison.OrdinalIgnoreCase))
                {
                    failed++;
                }
            }
        }
    }

    internal sealed class TextEditRange
    {
        public int StartLine;
        public int StartColumn;
        public int EndLine;
        public int EndColumn;
        public int StartOffset;
        public int EndOffset;
        public string Text;
    }

    internal sealed class ScriptIndexStats
    {
        public int ScriptCount;
        public int TypeDeclarationCount;
        public int MonoBehaviourCount;
        public int ScriptableObjectCount;
        public int EditorScriptCount;
        public int TestScriptCount;
        public int ResourcesLoadLineCount;
        public int SendMessageLineCount;
        public int HotLookupLineCount;
        public int UiHintCount;
        public readonly HashSet<string> Namespaces = new HashSet<string>(StringComparer.Ordinal);
    }

    internal sealed class SerializedIndexStats
    {
        public int ScannedFileCount;
        public int GuidReferenceCount;
        public int UnityEventBindingCount;
    }

    internal sealed class TestScopeSuggestion
    {
        public string Path;
        public string Mode;
        public string Filter;
        public int Score;
        public List<string> Reasons;
    }

    internal sealed class ScreenshotDiffStats
    {
        public int SampledPixels;
        public int DifferentPixels;
        public float DifferentRatio;
        public float MeanAbsoluteDifference;
    }

    internal sealed class MethodNode
    {
        public string MethodName;
        public string ClassName;
        public string FullName;
        public string Path;
        public int Line;
        public HashSet<string> Calls;
    }
}
