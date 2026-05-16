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
            var directory = Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "screenshots");
            var fileName = "ghost-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".png";
            var path = Path.GetFullPath(Path.Combine(directory, fileName));

            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"screenshot.capture\",\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"superSize\":" + superSize + "}}";
            }

            Directory.CreateDirectory(directory);
            ScreenCapture.CaptureScreenshot(path, Math.Max(1, superSize));
            return "{\"ok\":true,\"path\":\"" + JsonRpcUtil.Escape(path) + "\",\"superSize\":" + superSize + ",\"note\":\"Unity writes screenshots asynchronously; poll the path if the file is not present immediately.\"}";
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
}
