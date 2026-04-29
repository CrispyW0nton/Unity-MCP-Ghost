using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
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
            Register("editor.get_state", HandleEditorState);
            Register("console.get_logs", HandleConsoleLogs);
            Register("scene.get_hierarchy", HandleSceneHierarchy);
            Register("scene.save", HandleSceneSave);
            Register("gameobject.create", HandleGameObjectCreate);
            Register("gameobject.create_primitive", HandleGameObjectCreatePrimitive);
            Register("gameobject.set_transform", HandleGameObjectSetTransform);
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
                return JsonRpcUtil.Success(request.Id, handler(request));
            }
            catch (Exception exception)
            {
                return JsonRpcUtil.Error(request.Id, -32000, exception.Message);
            }
        }

        private void Register(string method, Func<UnityMcpRequest, string> handler)
        {
            handlers[method] = handler;
        }

        private static string HandlePing(UnityMcpRequest request)
        {
            return "{\"ok\":true,\"package\":\"" + UnityMcpGhostConfig.PackageName + "\",\"version\":\"" + UnityMcpGhostConfig.Version + "\"}";
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
            return "{\"ok\":true,\"logs\":[],\"note\":\"Console log collection will be implemented with the diagnostics subsystem.\"}";
        }

        private static string HandleSceneHierarchy(UnityMcpRequest request)
        {
            var scene = SceneManager.GetActiveScene();
            var builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"scene\":\"");
            builder.Append(JsonRpcUtil.Escape(scene.path));
            builder.Append("\",\"roots\":[");

            var roots = scene.GetRootGameObjects();
            for (var index = 0; index < roots.Length; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                AppendGameObject(builder, roots[index], 0);
            }

            builder.Append("]}");
            return builder.ToString();
        }

        private static string HandleSceneSave(UnityMcpRequest request)
        {
            var scene = SceneManager.GetActiveScene();
            var saved = EditorSceneManager.SaveScene(scene);
            return "{\"ok\":" + Bool(saved) + ",\"scenePath\":\"" + JsonRpcUtil.Escape(scene.path) + "\"}";
        }

        private static string HandleGameObjectCreate(UnityMcpRequest request)
        {
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", "GameObject");
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Create GameObject");

            var gameObject = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(gameObject, "MCP: Create GameObject");
            SetTransformFromRequest(gameObject, request);

            return GameObjectResult(gameObject);
        }

        private static string HandleGameObjectCreatePrimitive(UnityMcpRequest request)
        {
            var primitiveName = JsonRpcUtil.ReadString(request.RawJson, "primitive", "Cube");
            var name = JsonRpcUtil.ReadString(request.RawJson, "name", primitiveName);
            var primitiveType = ParsePrimitiveType(primitiveName);

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Create Primitive");

            var gameObject = GameObject.CreatePrimitive(primitiveType);
            gameObject.name = name;
            Undo.RegisterCreatedObjectUndo(gameObject, "MCP: Create Primitive");
            SetTransformFromRequest(gameObject, request);

            return GameObjectResult(gameObject);
        }

        private static string HandleGameObjectSetTransform(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var gameObject = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            Undo.RecordObject(gameObject.transform, "MCP: Set Transform");
            SetTransformFromRequest(gameObject, request);
            return GameObjectResult(gameObject);
        }

        private static void AppendGameObject(StringBuilder builder, GameObject gameObject, int depth)
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
            for (var index = 0; index < transform.childCount; index++)
            {
                if (index > 0)
                {
                    builder.Append(",");
                }

                AppendGameObject(builder, transform.GetChild(index).gameObject, depth + 1);
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

        private static string GameObjectResult(GameObject gameObject)
        {
            return "{"
                + "\"ok\":true,"
                + "\"name\":\"" + JsonRpcUtil.Escape(gameObject.name) + "\","
                + "\"instanceId\":" + gameObject.GetInstanceID() + ","
                + "\"scenePath\":\"" + JsonRpcUtil.Escape(gameObject.scene.path) + "\","
                + "\"position\":{\"x\":" + gameObject.transform.position.x + ",\"y\":" + gameObject.transform.position.y + ",\"z\":" + gameObject.transform.position.z + "}"
                + "}";
        }
    }
}
