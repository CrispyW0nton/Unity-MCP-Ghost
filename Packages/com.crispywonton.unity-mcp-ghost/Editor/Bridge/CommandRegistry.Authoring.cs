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
            var requestedPath = JsonRpcUtil.ReadString(request.RawJson, "path", string.Empty);
            var normalizedPath = string.IsNullOrWhiteSpace(requestedPath) ? string.Empty : NormalizeAssetPath(requestedPath);
            if (JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false))
            {
                var active = SceneManager.GetActiveScene();
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"scene.save\",\"scenePath\":\"" + JsonRpcUtil.Escape(string.IsNullOrEmpty(normalizedPath) ? active.path : normalizedPath) + "\"}}";
            }

            var scene = SceneManager.GetActiveScene();
            var saved = string.IsNullOrEmpty(normalizedPath) ? EditorSceneManager.SaveScene(scene) : EditorSceneManager.SaveScene(scene, normalizedPath);
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
            var gameObject = ObjectIdentity.Resolve(instanceId) as GameObject;
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
            var gameObject = ObjectIdentity.Resolve(instanceId) as GameObject;
            if (gameObject == null)
            {
                throw new InvalidOperationException("Could not resolve GameObject instanceId: " + instanceId);
            }

            return GameObjectResult(gameObject, null);
        }

        private static string HandleGameObjectDelete(UnityMcpRequest request)
        {
            var instanceId = JsonRpcUtil.ReadInt(request.RawJson, "instanceId", 0);
            var gameObject = ObjectIdentity.Resolve(instanceId) as GameObject;
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
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"gameobject.duplicate\",\"sourceInstanceId\":" + original.GetGhostInstanceId() + ",\"name\":\"" + JsonRpcUtil.Escape(name) + "\"}}";
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
            builder.Append(gameObject.GetGhostInstanceId());
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
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"component.modify\",\"componentInstanceId\":" + component.GetGhostInstanceId() + ",\"type\":\"" + JsonRpcUtil.Escape(component.GetType().FullName) + "\",\"propertyPath\":\"" + JsonRpcUtil.Escape(propertyPath) + "\",\"currentValue\":\"" + JsonRpcUtil.Escape(PropertyValueAsString(property)) + "\"}}";
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
                return "{\"ok\":true,\"dryRun\":true,\"planned\":{\"action\":\"component.remove\",\"componentInstanceId\":" + component.GetGhostInstanceId() + ",\"type\":\"" + JsonRpcUtil.Escape(component.GetType().FullName) + "\"}}";
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("MCP: Remove Component");
            var undoGroupId = Undo.GetCurrentGroup();
            var type = component.GetType().FullName;
            var componentId = component.GetGhostInstanceId();
            Undo.DestroyObjectImmediate(component);
            return "{\"ok\":true,\"removed\":{\"componentInstanceId\":" + componentId + ",\"type\":\"" + JsonRpcUtil.Escape(type) + "\"},\"undoGroupId\":" + undoGroupId + "}";
        }

    }
}
