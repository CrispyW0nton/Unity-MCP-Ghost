using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class ScenarioBridgeController
    {
        private const int MaxSourceMutations = 20;
        private const int MaxSourceCharacters = 1024 * 1024;
        private static readonly string TransactionRoot = Path.Combine(BridgeSecurity.StateRoot, "scenario-transactions");

        public static string CaptureEditorState()
        {
            var setup = EditorSceneManager.GetSceneManagerSetup();
            var selected = Selection.objects
                .Where(item => item != null)
                .Select(item => GlobalObjectId.GetGlobalObjectIdSlow(item).ToString())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToArray();
            return new JObject
            {
                ["ok"] = true,
                ["projectId"] = BridgeSecurity.ProjectId,
                ["editorInstanceId"] = BridgeSecurity.EditorInstanceId,
                ["playMode"] = JObject.Parse(PlayModeController.Get()),
                ["sceneSetup"] = new JArray(setup.Select(item => new JObject
                {
                    ["path"] = item.path,
                    ["isLoaded"] = item.isLoaded,
                    ["isActive"] = item.isActive
                })),
                ["dirtyScenes"] = new JArray(LoadedScenes().Where(scene => scene.isDirty).Select(SceneIdentifier)),
                ["selectionGlobalObjectIds"] = new JArray(selected)
            }.ToString(Formatting.None);
        }

        public static string RestoreEditorState(string json)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isPlaying)
            {
                return Failure("EDITOR_RESTORE_REQUIRES_STOPPED_PLAY_MODE", "Editor state can only be restored after Play mode is fully stopped.");
            }

            var root = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var snapshot = root["snapshot"] as JObject;
            if (snapshot == null)
            {
                return Failure("EDITOR_SNAPSHOT_REQUIRED", "editor.restore_snapshot requires a captured snapshot object.");
            }

            var dirty = LoadedScenes().Where(scene => scene.isDirty).Select(SceneIdentifier).ToArray();
            if (dirty.Length > 0)
            {
                return new JObject
                {
                    ["ok"] = false,
                    ["error"] = new JObject
                    {
                        ["code"] = "EDITOR_RESTORE_DIRTY_SCENE_CONFLICT",
                        ["message"] = "Restoring the scene setup would discard modified scenes.",
                        ["scenes"] = new JArray(dirty)
                    }
                }.ToString(Formatting.None);
            }

            var setupJson = snapshot["sceneSetup"] as JArray ?? new JArray();
            var setup = setupJson.OfType<JObject>().Select(item => new SceneSetup
            {
                path = item.Value<string>("path") ?? string.Empty,
                isLoaded = item.Value<bool?>("isLoaded") ?? true,
                isActive = item.Value<bool?>("isActive") ?? false
            }).ToArray();
            if (setup.Length > 0)
            {
                EditorSceneManager.RestoreSceneManagerSetup(setup);
            }

            var restoredSelection = new List<UnityEngine.Object>();
            foreach (var value in (snapshot["selectionGlobalObjectIds"] as JArray ?? new JArray()).Values<string>())
            {
                if (GlobalObjectId.TryParse(value, out var globalId))
                {
                    var resolved = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalId);
                    if (resolved != null)
                    {
                        restoredSelection.Add(resolved);
                    }
                }
            }
            Selection.objects = restoredSelection.ToArray();
            var restored = JObject.Parse(CaptureEditorState());
            restored["restored"] = true;
            return restored.ToString(Formatting.None);
        }

        public static string ApplySources(string json)
        {
            var root = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var transactionId = ValidateTransactionId(root.Value<string>("transactionId") ?? Guid.NewGuid().ToString("N"));
            var requests = root["mutations"] as JArray ?? new JArray();
            if (requests.Count == 0 || requests.Count > MaxSourceMutations)
            {
                return Failure("INVALID_SCENARIO_MUTATION_COUNT", "A scenario requires between 1 and " + MaxSourceMutations + " source mutations.");
            }

            var prepared = new List<PreparedMutation>();
            var uniquePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var characters = 0;
            foreach (var item in requests.OfType<JObject>())
            {
                var path = EnsureScriptPath(item.Value<string>("path") ?? string.Empty);
                if (!uniquePaths.Add(path))
                {
                    return Failure("DUPLICATE_SCENARIO_SOURCE", "A scenario may mutate each source path only once: " + path);
                }
                var content = item.Value<string>("content") ?? string.Empty;
                characters += content.Length;
                if (characters > MaxSourceCharacters)
                {
                    return Failure("SCENARIO_SOURCE_LIMIT_EXCEEDED", "Scenario source mutations exceed the one-megacharacter limit.");
                }
                var fullPath = ProjectPathPolicy.FullAssetPath(path);
                var before = ScriptFileTransaction.Read(fullPath);
                var expected = item.Value<string>("expectedSha256") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(expected) || !string.Equals(expected, before.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    return new JObject
                    {
                        ["ok"] = false,
                        ["error"] = new JObject
                        {
                            ["code"] = "SCRIPT_HASH_MISMATCH",
                            ["message"] = "Scenario preflight found a stale or missing expected hash for " + path + ".",
                            ["path"] = path,
                            ["currentSha256"] = before.Sha256
                        }
                    }.ToString(Formatting.None);
                }
                var parent = Path.GetDirectoryName(fullPath);
                if (string.IsNullOrWhiteSpace(parent) || !Directory.Exists(parent))
                {
                    return Failure("SCENARIO_SOURCE_PARENT_NOT_FOUND", "The source parent directory does not exist: " + path);
                }
                prepared.Add(new PreparedMutation(path, fullPath, content, expected));
            }
            if (prepared.Count != requests.Count)
            {
                return Failure("INVALID_SCENARIO_MUTATION", "Every source mutation must be a JSON object.");
            }

            var receipts = new List<ScriptMutationReceipt>();
            var transaction = new JObject
            {
                ["schemaVersion"] = 1,
                ["transactionId"] = transactionId,
                ["status"] = "applying",
                ["receipts"] = new JArray(),
                ["updatedUtc"] = DateTime.UtcNow.ToString("O")
            };
            SaveTransaction(transactionId, transaction);
            try
            {
                foreach (var mutation in prepared)
                {
                    var receipt = ScriptFileTransaction.Write(mutation.FullPath, mutation.AssetPath, mutation.Content, mutation.ExpectedSha256, false);
                    if (!receipt.Ok)
                    {
                        throw new ScenarioMutationException(receipt.Error?["code"]?.Value<string>() ?? "SCENARIO_SOURCE_APPLY_FAILED", receipt.Error?["message"]?.Value<string>() ?? "Scenario source mutation failed.");
                    }
                    receipts.Add(receipt);
                    transaction["receipts"] = new JArray(receipts.Select(ReceiptJson));
                    transaction["updatedUtc"] = DateTime.UtcNow.ToString("O");
                    SaveTransaction(transactionId, transaction);
                }
            }
            catch (Exception exception)
            {
                var rollback = RestoreReceipts(receipts, false);
                var rollbackGeneration = 0;
                if (receipts.Count > 0 && rollback.All(item => item.Value<bool?>("ok") == true))
                {
                    rollbackGeneration = CompileDiagnosticBuffer.RequestGeneration("scenario.source_apply.rollback");
                    AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
                }
                transaction["status"] = "applyFailed";
                transaction["rollback"] = new JArray(rollback);
                transaction["rollbackCompileGeneration"] = rollbackGeneration > 0 ? (JToken)rollbackGeneration : null;
                transaction["updatedUtc"] = DateTime.UtcNow.ToString("O");
                SaveTransaction(transactionId, transaction);
                return new JObject
                {
                    ["ok"] = false,
                    ["transactionId"] = transactionId,
                    ["error"] = new JObject
                    {
                        ["code"] = exception is ScenarioMutationException typed ? typed.Code : "SCENARIO_SOURCE_APPLY_FAILED",
                        ["message"] = exception.Message
                    },
                    ["rollback"] = new JArray(rollback),
                    ["rollbackCompileGeneration"] = rollbackGeneration > 0 ? (JToken)rollbackGeneration : null
                }.ToString(Formatting.None);
            }

            var generation = CompileDiagnosticBuffer.RequestGeneration("scenario.source_apply");
            transaction["status"] = "applied";
            transaction["requestedCompileGeneration"] = generation;
            transaction["updatedUtc"] = DateTime.UtcNow.ToString("O");
            SaveTransaction(transactionId, transaction);
            AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            return new JObject
            {
                ["ok"] = true,
                ["transactionId"] = transactionId,
                ["requestedCompileGeneration"] = generation,
                ["receipts"] = new JArray(receipts.Select(ReceiptJson)),
                ["refreshCount"] = 1
            }.ToString(Formatting.None);
        }

        public static string RestoreSources(string json)
        {
            var root = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var transactionId = string.IsNullOrWhiteSpace(root.Value<string>("transactionId"))
                ? string.Empty
                : ValidateTransactionId(root.Value<string>("transactionId"));
            var transaction = string.IsNullOrEmpty(transactionId) ? null : LoadTransaction(transactionId);
            if (transaction != null && string.Equals(transaction.Value<string>("status"), "restored", StringComparison.Ordinal))
            {
                return new JObject
                {
                    ["ok"] = true,
                    ["transactionId"] = transactionId,
                    ["status"] = "restored",
                    ["requestedCompileGeneration"] = transaction["restoreCompileGeneration"],
                    ["receipts"] = transaction["receipts"] ?? new JArray(),
                    ["outcomes"] = transaction["restoreOutcomes"] ?? new JArray(),
                    ["refreshCount"] = 0,
                    ["replayed"] = true
                }.ToString(Formatting.None);
            }
            var receiptArray = root["receipts"] as JArray;
            if ((receiptArray == null || receiptArray.Count == 0) && transaction != null)
            {
                receiptArray = transaction["receipts"] as JArray;
            }
            var receipts = (receiptArray ?? new JArray()).OfType<JObject>().ToArray();
            if (receipts.Length == 0)
            {
                return Failure("SCENARIO_RECEIPTS_REQUIRED", "scenario.source_restore requires mutation receipts.");
            }

            if (transaction != null)
            {
                transaction["status"] = "restoring";
                transaction["updatedUtc"] = DateTime.UtcNow.ToString("O");
                SaveTransaction(transactionId, transaction);
            }
            var outcomes = RestoreReceiptObjects(receipts, false);
            var ok = outcomes.All(item => item.Value<bool?>("ok") == true);
            var generation = 0;
            if (ok)
            {
                generation = CompileDiagnosticBuffer.RequestGeneration("scenario.source_restore");
            }
            var response = new JObject
            {
                ["ok"] = ok,
                ["transactionId"] = string.IsNullOrEmpty(transactionId) ? null : transactionId,
                ["status"] = ok ? "restored" : "restoreFailed",
                ["requestedCompileGeneration"] = generation > 0 ? (JToken)generation : null,
                ["receipts"] = new JArray(receipts),
                ["outcomes"] = new JArray(outcomes),
                ["refreshCount"] = ok ? 1 : 0,
                ["error"] = ok ? null : new JObject
                {
                    ["code"] = "SCENARIO_RESTORE_FAILED",
                    ["message"] = "One or more source files could not be restored byte-identically."
                }
            };
            if (transaction != null)
            {
                transaction["status"] = ok ? "restored" : "restoreFailed";
                transaction["restoreOutcomes"] = new JArray(outcomes);
                transaction["restoreCompileGeneration"] = generation > 0 ? (JToken)generation : null;
                transaction["updatedUtc"] = DateTime.UtcNow.ToString("O");
                SaveTransaction(transactionId, transaction);
            }
            if (ok)
            {
                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            }
            return response.ToString(Formatting.None);
        }

        public static string CompleteSources(string json)
        {
            var root = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var transactionId = string.IsNullOrWhiteSpace(root.Value<string>("transactionId"))
                ? string.Empty
                : ValidateTransactionId(root.Value<string>("transactionId"));
            var transaction = string.IsNullOrEmpty(transactionId) ? null : LoadTransaction(transactionId);
            var receipts = new List<JObject>((root["receipts"] as JArray ?? new JArray()).OfType<JObject>());
            if (transaction != null)
            {
                receipts.AddRange((transaction["receipts"] as JArray ?? new JArray()).OfType<JObject>());
                receipts.AddRange((transaction["restoreOutcomes"] as JArray ?? new JArray()).OfType<JObject>());
            }
            var removed = new JArray();
            foreach (var receipt in receipts)
            {
                foreach (var property in new[] { "backupPath", "backupMetaPath", "restorationBackupPath", "restorationBackupMetaPath" })
                {
                    var path = receipt.Value<string>(property) ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(path))
                    {
                        removed.Add(new JObject { ["path"] = path, ["removed"] = ScriptFileTransaction.DiscardBackup(path) });
                    }
                }
            }
            if (!string.IsNullOrEmpty(transactionId))
            {
                DeleteTransaction(transactionId);
            }
            return new JObject { ["ok"] = true, ["transactionId"] = string.IsNullOrEmpty(transactionId) ? null : transactionId, ["removed"] = removed }.ToString(Formatting.None);
        }

        public static string GetSourceTransaction(string json)
        {
            var root = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var transactionId = ValidateTransactionId(root.Value<string>("transactionId") ?? string.Empty);
            var transaction = LoadTransaction(transactionId);
            return transaction == null
                ? Failure("SCENARIO_TRANSACTION_NOT_FOUND", "Scenario source transaction was not found: " + transactionId)
                : new JObject { ["ok"] = true, ["transaction"] = transaction }.ToString(Formatting.None);
        }

        public static string InspectRuntime(string json, bool assertion)
        {
            var request = JObject.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var gameObject = ResolveGameObject(request);
            var expectedExists = request.Value<bool?>("exists") ?? true;
            if (gameObject == null)
            {
                return RuntimeResult(!expectedExists, assertion, request, null, null, null).ToString(Formatting.None);
            }

            Component component = null;
            SerializedProperty property = null;
            var componentType = request.Value<string>("component") ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(componentType))
            {
                component = gameObject.GetComponents<Component>().FirstOrDefault(item => item != null
                    && (string.Equals(item.GetType().Name, componentType, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(item.GetType().FullName, componentType, StringComparison.OrdinalIgnoreCase)));
            }
            var propertyPath = request.Value<string>("propertyPath") ?? string.Empty;
            if (component != null && !string.IsNullOrWhiteSpace(propertyPath))
            {
                property = new SerializedObject(component).FindProperty(propertyPath);
            }

            var matched = expectedExists;
            if (request["activeSelf"] != null)
            {
                matched &= gameObject.activeSelf == request.Value<bool>("activeSelf");
            }
            if (!string.IsNullOrWhiteSpace(componentType))
            {
                matched &= component != null;
            }
            if (!string.IsNullOrWhiteSpace(propertyPath))
            {
                matched &= property != null;
            }
            var observed = property == null ? null : SerializedValue(property);
            if (request["equals"] != null)
            {
                matched &= JToken.DeepEquals(observed ?? JValue.CreateNull(), request["equals"]);
            }
            var contains = request.Value<string>("contains") ?? string.Empty;
            if (!string.IsNullOrEmpty(contains))
            {
                matched &= observed != null && observed.ToString().IndexOf(contains, StringComparison.Ordinal) >= 0;
            }
            return RuntimeResult(matched, assertion, request, gameObject, component, observed).ToString(Formatting.None);
        }

        private static JObject RuntimeResult(bool matched, bool assertion, JObject request, GameObject gameObject, Component component, JToken observed)
        {
            var value = new JObject
            {
                ["ok"] = !assertion || matched,
                ["matched"] = matched,
                ["selector"] = new JObject
                {
                    ["hierarchyPath"] = request.Value<string>("hierarchyPath"),
                    ["name"] = request.Value<string>("name")
                },
                ["exists"] = gameObject != null,
                ["instanceId"] = gameObject == null ? null : (JToken)gameObject.GetInstanceID(),
                ["hierarchyPath"] = gameObject == null ? null : HierarchyPath(gameObject.transform),
                ["activeSelf"] = gameObject == null ? null : (JToken)gameObject.activeSelf,
                ["activeInHierarchy"] = gameObject == null ? null : (JToken)gameObject.activeInHierarchy,
                ["component"] = component == null ? null : component.GetType().FullName,
                ["componentInstanceId"] = component == null ? null : (JToken)component.GetInstanceID(),
                ["propertyPath"] = request.Value<string>("propertyPath"),
                ["observed"] = observed
            };
            if (assertion && !matched)
            {
                value["error"] = new JObject
                {
                    ["code"] = "RUNTIME_ASSERTION_FAILED",
                    ["message"] = "The selected runtime object/component/property did not match the declared expectation."
                };
            }
            return value;
        }

        private static JToken SerializedValue(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    return property.boolValue;
                case SerializedPropertyType.Integer:
                case SerializedPropertyType.Enum:
                case SerializedPropertyType.LayerMask:
                    return property.intValue;
                case SerializedPropertyType.Float:
                    return property.doubleValue;
                case SerializedPropertyType.String:
                    return property.stringValue;
                case SerializedPropertyType.ObjectReference:
                    return property.objectReferenceValue == null ? JValue.CreateNull() : new JValue(property.objectReferenceValue.name);
                default:
                    return property.propertyType.ToString();
            }
        }

        private static GameObject ResolveGameObject(JObject request)
        {
            var path = request.Value<string>("hierarchyPath") ?? string.Empty;
            var name = request.Value<string>("name") ?? string.Empty;
            var objects = Resources.FindObjectsOfTypeAll<GameObject>().Where(item => item.scene.IsValid() && item.scene.isLoaded);
            if (!string.IsNullOrWhiteSpace(path))
            {
                return objects.FirstOrDefault(item => string.Equals(HierarchyPath(item.transform), path, StringComparison.Ordinal));
            }
            return string.IsNullOrWhiteSpace(name) ? null : objects.FirstOrDefault(item => string.Equals(item.name, name, StringComparison.Ordinal));
        }

        private static string HierarchyPath(Transform transform)
        {
            var value = transform.name;
            while (transform.parent != null)
            {
                transform = transform.parent;
                value = transform.name + "/" + value;
            }
            return value;
        }

        private static List<JObject> RestoreReceipts(IEnumerable<ScriptMutationReceipt> receipts, bool discardBackups)
        {
            return RestoreReceiptObjects(receipts.Select(ReceiptJson), discardBackups);
        }

        private static List<JObject> RestoreReceiptObjects(IEnumerable<JObject> receipts, bool discardBackups)
        {
            var outcomes = new List<JObject>();
            foreach (var receipt in receipts.Reverse())
            {
                var path = EnsureScriptPath(receipt.Value<string>("path") ?? string.Empty);
                var fullPath = ProjectPathPolicy.FullAssetPath(path);
                var afterHash = receipt.Value<string>("afterSha256") ?? string.Empty;
                var current = ScriptFileTransaction.Read(fullPath);
                var beforeHash = receipt.Value<string>("beforeSha256") ?? string.Empty;
                var originalExists = receipt.Value<bool?>("created") != true;
                if (current.Exists == originalExists && string.Equals(current.Sha256, beforeHash, StringComparison.OrdinalIgnoreCase))
                {
                    outcomes.Add(new JObject
                    {
                        ["ok"] = true,
                        ["path"] = path,
                        ["beforeSha256"] = afterHash,
                        ["afterSha256"] = beforeHash,
                        ["restoredSha256"] = beforeHash,
                        ["restored"] = true,
                        ["alreadyRestored"] = true
                    });
                    continue;
                }
                if (!string.Equals(current.Sha256, afterHash, StringComparison.OrdinalIgnoreCase))
                {
                    outcomes.Add(new JObject
                    {
                        ["ok"] = false,
                        ["path"] = path,
                        ["error"] = new JObject { ["code"] = "SCRIPT_HASH_MISMATCH", ["message"] = "Source changed after scenario mutation.", ["currentSha256"] = current.Sha256 }
                    });
                    continue;
                }

                JObject outcome;
                if (receipt.Value<bool?>("created") == true)
                {
                    if (File.Exists(fullPath)) File.Delete(fullPath);
                    if (File.Exists(fullPath + ".meta")) File.Delete(fullPath + ".meta");
                    outcome = new JObject { ["ok"] = !File.Exists(fullPath), ["path"] = path, ["restoredSha256"] = receipt.Value<string>("beforeSha256") ?? string.Empty };
                }
                else
                {
                    var restored = ScriptFileTransaction.Restore(
                        fullPath,
                        path,
                        receipt.Value<string>("backupPath") ?? string.Empty,
                        receipt.Value<string>("backupMetaPath") ?? string.Empty,
                        afterHash);
                    outcome = ReceiptJson(restored);
                    receipt["restorationBackupPath"] = restored.BackupPath;
                    receipt["restorationBackupMetaPath"] = restored.BackupMetaPath;
                }
                outcomes.Add(outcome);
                if (discardBackups && outcome.Value<bool?>("ok") == true)
                {
                    ScriptFileTransaction.DiscardBackup(receipt.Value<string>("backupPath") ?? string.Empty);
                    ScriptFileTransaction.DiscardBackup(receipt.Value<string>("backupMetaPath") ?? string.Empty);
                    ScriptFileTransaction.DiscardBackup(receipt.Value<string>("restorationBackupPath") ?? string.Empty);
                    ScriptFileTransaction.DiscardBackup(receipt.Value<string>("restorationBackupMetaPath") ?? string.Empty);
                }
            }
            return outcomes;
        }

        private static JObject ReceiptJson(ScriptMutationReceipt receipt)
        {
            return JObject.FromObject(receipt, JsonSerializer.CreateDefault());
        }

        private static string EnsureScriptPath(string value)
        {
            var path = ProjectPathPolicy.NormalizeAssetPath(value);
            if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                throw new ProjectPathException("SCRIPT_PATH_REQUIRED", "Scenario source mutations must target .cs files under Assets: " + value);
            }
            return path;
        }

        private static IEnumerable<Scene> LoadedScenes()
        {
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                if (scene.isLoaded) yield return scene;
            }
        }

        private static string SceneIdentifier(Scene scene)
        {
            return string.IsNullOrWhiteSpace(scene.path) ? scene.name : scene.path;
        }

        private static string Failure(string code, string message)
        {
            return new JObject
            {
                ["ok"] = false,
                ["error"] = new JObject { ["code"] = code, ["message"] = message }
            }.ToString(Formatting.None);
        }

        private static string ValidateTransactionId(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 200 || value.Any(character => !(char.IsLetterOrDigit(character) || character == '-' || character == '_' || character == '.' || character == ':')))
            {
                throw new InvalidOperationException("Scenario transactionId is missing or malformed.");
            }
            return value;
        }

        private static string TransactionPath(string transactionId)
        {
            using (var sha256 = SHA256.Create())
            {
                var hash = string.Concat(sha256.ComputeHash(Encoding.UTF8.GetBytes(transactionId)).Select(value => value.ToString("x2")));
                return Path.Combine(TransactionRoot, hash + ".json");
            }
        }

        private static JObject LoadTransaction(string transactionId)
        {
            var path = TransactionPath(transactionId);
            try
            {
                return File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : null;
            }
            catch
            {
                return null;
            }
        }

        private static void SaveTransaction(string transactionId, JObject value)
        {
            Directory.CreateDirectory(TransactionRoot);
            var path = TransactionPath(transactionId);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, value.ToString(Formatting.Indented), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                try
                {
                    File.Replace(temporary, path, null);
                    return;
                }
                catch (IOException)
                {
                    File.Delete(path);
                }
            }
            File.Move(temporary, path);
        }

        private static void DeleteTransaction(string transactionId)
        {
            var path = TransactionPath(transactionId);
            if (File.Exists(path)) File.Delete(path);
        }

        private sealed class PreparedMutation
        {
            public PreparedMutation(string assetPath, string fullPath, string content, string expectedSha256)
            {
                AssetPath = assetPath;
                FullPath = fullPath;
                Content = content;
                ExpectedSha256 = expectedSha256;
            }

            public string AssetPath { get; }
            public string FullPath { get; }
            public string Content { get; }
            public string ExpectedSha256 { get; }
        }

        private sealed class ScenarioMutationException : Exception
        {
            public ScenarioMutationException(string code, string message) : base(message)
            {
                Code = code;
            }

            public string Code { get; }
        }
    }
}
