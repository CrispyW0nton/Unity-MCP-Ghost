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
        private string HandleBatchExecute(UnityMcpRequest request)
        {
            var operations = JsonRpcUtil.ReadObjectArray(request.RawJson, "operations");
            var dryRun = JsonRpcUtil.ReadBool(request.RawJson, "dryRun", false);
            var failFast = JsonRpcUtil.ReadBool(request.RawJson, "failFast", true);
            if (operations.Count == 0 || operations.Count > 100)
            {
                return BatchFailure("BATCH_SIZE_INVALID", "batch.execute requires between 1 and 100 operations.", null, null);
            }

            var plans = new List<BatchOperationPlan>();
            var maximumRisk = "read-only";
            var containsNonRollbackable = false;
            for (var index = 0; index < operations.Count; index++)
            {
                var operation = operations[index];
                var method = JsonRpcUtil.ReadString(operation, "method", string.Empty);
                if (string.IsNullOrWhiteSpace(method) || method == "batch.execute" || !handlers.ContainsKey(method))
                {
                    return BatchFailure("BATCH_VALIDATION_FAILED", "Batch item " + index + " has an unknown or forbidden method: " + method, maximumRisk, null);
                }

                var policy = ResolveBatchPolicy(method);
                if (policy == null)
                {
                    return BatchFailure("BATCH_POLICY_MISSING", "Batch item " + index + " is not explicitly approved for batched execution: " + method, maximumRisk, null);
                }
                var paramsJson = JsonRpcUtil.ReadObject(operation, "params");
                plans.Add(new BatchOperationPlan
                {
                    Index = index,
                    Method = method,
                    ParamsJson = paramsJson,
                    Required = JsonRpcUtil.ReadBool(operation, "required", true),
                    Policy = policy
                });
                maximumRisk = MaximumRisk(maximumRisk, policy.Risk);
                containsNonRollbackable |= policy.Mutates && !policy.Rollbackable;
            }

            var acceptedRisk = JsonRpcUtil.ReadString(request.RawJson, "acceptedRisk", string.Empty);
            var acceptNonRollbackable = JsonRpcUtil.ReadBool(request.RawJson, "acceptNonRollbackable", false);
            if (!dryRun && (containsNonRollbackable || RiskRank(maximumRisk) >= RiskRank("destructive")) && !string.Equals(acceptedRisk, maximumRisk, StringComparison.Ordinal))
            {
                return BatchFailure("BATCH_RISK_NOT_ACCEPTED", "Batch maximum risk is " + maximumRisk + "; acceptedRisk must match it exactly.", maximumRisk, null);
            }
            if (!dryRun && containsNonRollbackable && !acceptNonRollbackable)
            {
                return BatchFailure("BATCH_NON_ROLLBACKABLE_NOT_ACCEPTED", "Batch contains non-rollbackable mutations; set acceptNonRollbackable=true only after reviewing every resolved operation.", maximumRisk, null);
            }

            var preflight = new JArray();
            foreach (var plan in plans)
            {
                if (!plan.Policy.Mutates)
                {
                    preflight.Add(new JObject
                    {
                        ["index"] = plan.Index,
                        ["method"] = plan.Method,
                        ["ok"] = true,
                        ["risk"] = plan.Policy.Risk,
                        ["readOnly"] = true
                    });
                    continue;
                }

                if (!plan.Policy.SupportsDryRun)
                {
                    return BatchFailure("BATCH_PREFLIGHT_UNSUPPORTED", "Batch item " + plan.Index + " cannot be safely preflighted: " + plan.Method, maximumRisk, preflight);
                }

                try
                {
                    var previewJson = ExecuteResult(new UnityMcpRequest
                    {
                        Id = request.Id + ":preflight:" + plan.Index,
                        Method = plan.Method,
                        RawJson = JsonRpcUtil.AddBoolProperty(plan.ParamsJson, "dryRun", true)
                    });
                    var preview = JObject.Parse(previewJson);
                    var previewOk = preview.Value<bool?>("ok") == true;
                    preflight.Add(new JObject
                    {
                        ["index"] = plan.Index,
                        ["method"] = plan.Method,
                        ["ok"] = previewOk,
                        ["risk"] = plan.Policy.Risk,
                        ["preview"] = preview
                    });
                    if (!previewOk)
                    {
                        return BatchFailure("BATCH_PREFLIGHT_FAILED", "Batch item " + plan.Index + " returned a failed preflight result.", maximumRisk, preflight);
                    }
                }
                catch (Exception exception)
                {
                    preflight.Add(BatchItemFailure(plan, "BATCH_PREFLIGHT_FAILED", exception.Message));
                    return BatchFailure("BATCH_PREFLIGHT_FAILED", "Batch item " + plan.Index + " failed preflight: " + exception.Message, maximumRisk, preflight);
                }
            }

            if (dryRun)
            {
                return new JObject
                {
                    ["ok"] = true,
                    ["dryRun"] = true,
                    ["maximumRisk"] = maximumRisk,
                    ["containsNonRollbackable"] = containsNonRollbackable,
                    ["preflight"] = preflight,
                    ["results"] = new JArray()
                }.ToString(Formatting.None);
            }

            using (ScriptFileTransaction.BeginBackupRetentionLease())
            {
                var results = new JArray();
                var rollbackRecords = new List<JObject>();
                var undoGroup = -1;
                if (plans.Exists(plan => plan.Policy.Undoable))
                {
                    Undo.IncrementCurrentGroup();
                    Undo.SetCurrentGroupName("MCP: Transactional Batch");
                    undoGroup = Undo.GetCurrentGroup();
                }

                var requiredFailure = false;
                foreach (var plan in plans)
                {
                    JObject item;
                    try
                    {
                        var result = JObject.Parse(ExecuteResult(new UnityMcpRequest
                        {
                            Id = request.Id + ":" + plan.Index,
                            Method = plan.Method,
                            RawJson = plan.ParamsJson
                        }));
                        var itemOk = result.Value<bool?>("ok") == true;
                        item = new JObject
                        {
                            ["index"] = plan.Index,
                            ["method"] = plan.Method,
                            ["required"] = plan.Required,
                            ["risk"] = plan.Policy.Risk,
                            ["ok"] = itemOk,
                            ["result"] = result
                        };
                        if (itemOk && plan.Policy.TransactionalFile)
                        {
                            rollbackRecords.Add(new JObject
                            {
                                ["kind"] = "script",
                                ["index"] = plan.Index,
                                ["method"] = plan.Method,
                                ["result"] = result
                            });
                        }
                        else if (itemOk && plan.Policy.Undoable)
                        {
                            rollbackRecords.Add(new JObject
                            {
                                ["kind"] = "undo",
                                ["index"] = plan.Index,
                                ["method"] = plan.Method,
                                ["result"] = result
                            });
                        }
                        else if (itemOk && plan.Policy.Mutates && !plan.Policy.Rollbackable)
                        {
                            rollbackRecords.Add(new JObject
                            {
                                ["kind"] = "non-rollbackable",
                                ["index"] = plan.Index,
                                ["method"] = plan.Method,
                                ["risk"] = plan.Policy.Risk,
                                ["result"] = result
                            });
                        }
                        if (!itemOk && plan.Required)
                        {
                            requiredFailure = true;
                        }
                    }
                    catch (Exception exception)
                    {
                        item = BatchItemFailure(plan, "BATCH_ITEM_FAILED", exception.Message);
                        requiredFailure |= plan.Required;
                    }

                    results.Add(item);
                    if (requiredFailure && failFast)
                    {
                        break;
                    }
                }

                if (requiredFailure)
                {
                    var rollback = RollbackBatch(undoGroup, rollbackRecords);
                    var rollbackOk = rollback.Value<bool?>("ok") == true;
                    return new JObject
                    {
                        ["ok"] = false,
                        ["error"] = new JObject
                        {
                            ["code"] = rollbackOk ? "BATCH_REQUIRED_OPERATION_FAILED" : "BATCH_ROLLBACK_INCOMPLETE",
                            ["message"] = rollbackOk ? "A required batch item failed; completed mutations were rolled back." : "A required batch item failed and rollback was incomplete."
                        },
                        ["maximumRisk"] = maximumRisk,
                        ["containsNonRollbackable"] = containsNonRollbackable,
                        ["failFast"] = failFast,
                        ["preflight"] = preflight,
                        ["results"] = results,
                        ["rollback"] = rollback
                    }.ToString(Formatting.None);
                }

                if (undoGroup >= 0)
                {
                    Undo.CollapseUndoOperations(undoGroup);
                }
                return new JObject
                {
                    ["ok"] = true,
                    ["maximumRisk"] = maximumRisk,
                    ["containsNonRollbackable"] = containsNonRollbackable,
                    ["failFast"] = failFast,
                    ["preflight"] = preflight,
                    ["results"] = results,
                    ["rollback"] = null
                }.ToString(Formatting.None);
            }
        }

        private static JObject BatchItemFailure(BatchOperationPlan plan, string code, string message)
        {
            return new JObject
            {
                ["index"] = plan.Index,
                ["method"] = plan.Method,
                ["required"] = plan.Required,
                ["risk"] = plan.Policy.Risk,
                ["ok"] = false,
                ["error"] = new JObject
                {
                    ["code"] = code,
                    ["message"] = message
                }
            };
        }

        private static string BatchFailure(string code, string message, string maximumRisk, JToken preflight)
        {
            return new JObject
            {
                ["ok"] = false,
                ["error"] = new JObject
                {
                    ["code"] = code,
                    ["message"] = message
                },
                ["maximumRisk"] = maximumRisk,
                ["preflight"] = preflight ?? new JArray(),
                ["results"] = new JArray(),
                ["rollback"] = null
            }.ToString(Formatting.None);
        }

        private static JObject RollbackBatch(int undoGroup, List<JObject> rollbackRecords)
        {
            var outcomes = new JArray();
            var ok = true;
            var refreshedScripts = false;
            var undoOk = true;
            for (var index = rollbackRecords.Count - 1; index >= 0; index--)
            {
                var record = rollbackRecords[index];
                var kind = record.Value<string>("kind") ?? string.Empty;
                var method = record.Value<string>("method") ?? string.Empty;
                if (kind == "non-rollbackable")
                {
                    ok = false;
                    outcomes.Add(new JObject
                    {
                        ["ok"] = false,
                        ["index"] = record["index"],
                        ["method"] = method,
                        ["action"] = "non-rollbackable-mutation",
                        ["error"] = new JObject
                        {
                            ["code"] = "BATCH_NON_ROLLBACKABLE_EXECUTED",
                            ["message"] = "The accepted operation completed before the required failure and has no safe compensating action."
                        }
                    });
                    continue;
                }

                if (kind == "undo")
                {
                    try
                    {
                        var operationUndoGroup = record["result"]?["undoGroupId"]?.Value<int?>();
                        if (!operationUndoGroup.HasValue)
                        {
                            throw new InvalidOperationException("Undoable operation returned no undoGroupId.");
                        }
                        Undo.RevertAllDownToGroup(operationUndoGroup.Value);
                        outcomes.Add(new JObject
                        {
                            ["ok"] = true,
                            ["index"] = record["index"],
                            ["method"] = method,
                            ["action"] = "unity-undo",
                            ["undoGroupId"] = operationUndoGroup.Value
                        });
                    }
                    catch (Exception exception)
                    {
                        undoOk = false;
                        ok = false;
                        outcomes.Add(new JObject
                        {
                            ["ok"] = false,
                            ["index"] = record["index"],
                            ["method"] = method,
                            ["action"] = "unity-undo",
                            ["error"] = new JObject { ["code"] = "BATCH_UNDO_ROLLBACK_FAILED", ["message"] = exception.Message }
                        });
                    }
                    continue;
                }

                var transaction = (JObject)record["result"];
                var path = transaction.Value<string>("path") ?? string.Empty;
                try
                {
                    var fullPath = FullAssetPath(path);
                    var current = ScriptFileTransaction.Read(fullPath);
                    var created = transaction.Value<bool?>("created") == true;
                    var deleted = transaction.Value<bool?>("deleted") == true;
                    var backupPath = transaction.Value<string>("backupPath") ?? string.Empty;
                    var backupMetaPath = transaction.Value<string>("backupMetaPath") ?? string.Empty;
                    var expectedAfter = transaction.Value<string>("afterSha256") ?? string.Empty;
                    if (created && string.IsNullOrEmpty(backupPath))
                    {
                        if (!current.Exists || !string.Equals(current.Sha256, expectedAfter, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("Created script no longer matches its transaction receipt.");
                        }

                        File.Delete(fullPath);
                        if (File.Exists(fullPath + ".meta"))
                        {
                            File.Delete(fullPath + ".meta");
                        }
                        outcomes.Add(new JObject { ["ok"] = true, ["index"] = record["index"], ["method"] = method, ["path"] = path, ["action"] = "delete-created" });
                    }
                    else
                    {
                        if (deleted && current.Exists)
                        {
                            throw new InvalidOperationException("Deleted script path was recreated after the batch mutation.");
                        }

                        var restored = ScriptFileTransaction.Restore(fullPath, path, backupPath, backupMetaPath, deleted ? string.Empty : expectedAfter);
                        var outcome = JObject.Parse(ScriptFileTransaction.ToJson(restored));
                        outcome["index"] = record["index"];
                        outcome["method"] = method;
                        outcome["path"] = path;
                        if (!restored.Ok)
                        {
                            ok = false;
                            outcomes.Add(outcome);
                            continue;
                        }

                        ScriptFileTransaction.DiscardBackup(backupPath);
                        ScriptFileTransaction.DiscardBackup(backupMetaPath);
                        ScriptFileTransaction.DiscardBackup(restored.BackupPath);
                        ScriptFileTransaction.DiscardBackup(restored.BackupMetaPath);
                        outcomes.Add(outcome);
                    }
                    refreshedScripts = true;
                }
                catch (Exception exception)
                {
                    ok = false;
                    outcomes.Add(new JObject
                    {
                        ["ok"] = false,
                        ["index"] = record["index"],
                        ["method"] = method,
                        ["path"] = path,
                        ["error"] = new JObject
                        {
                            ["code"] = "BATCH_SCRIPT_ROLLBACK_FAILED",
                            ["message"] = exception.Message
                        }
                    });
                }
            }

            if (undoGroup >= 0)
            {
                try
                {
                    // A handler can fail after registering Undo work but before it returns a receipt.
                    // Reverting to the batch root clears any such tail without touching pre-batch history.
                    Undo.RevertAllDownToGroup(undoGroup);
                }
                catch (Exception exception)
                {
                    undoOk = false;
                    ok = false;
                    outcomes.Add(new JObject
                    {
                        ["ok"] = false,
                        ["action"] = "unity-undo",
                        ["error"] = new JObject { ["code"] = "BATCH_UNDO_ROLLBACK_FAILED", ["message"] = exception.Message }
                    });
                }
            }

            var rollbackGeneration = 0;
            if (refreshedScripts)
            {
                rollbackGeneration = CompileDiagnosticBuffer.RequestGeneration("batch.rollback");
                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            }
            return new JObject
            {
                ["ok"] = ok,
                ["unityUndoGroup"] = undoGroup >= 0 ? new JValue(undoGroup) : JValue.CreateNull(),
                ["unityUndoOk"] = undoOk,
                ["scriptRollbackGeneration"] = rollbackGeneration > 0 ? new JValue(rollbackGeneration) : JValue.CreateNull(),
                ["outcomes"] = outcomes
            };
        }

        private static BatchOperationPolicy ResolveBatchPolicy(string method)
        {
            if (method.StartsWith("gameobject.", StringComparison.Ordinal) || method.StartsWith("component.", StringComparison.Ordinal) || method == "prefab.instantiate")
            {
                var readOnly = method == "gameobject.find" || method == "gameobject.get" || method == "component.get";
                var destructive = method == "gameobject.delete" || method == "component.remove";
                return new BatchOperationPolicy(readOnly ? "read-only" : destructive ? "destructive" : "safe-write", !readOnly, !readOnly, true, false);
            }
            if (method.StartsWith("script.", StringComparison.Ordinal))
            {
                if (method == "script.read" || method == "script.validate")
                {
                    return new BatchOperationPolicy("read-only", false, false, true, false);
                }
                if (method == "script.transaction_complete" || method == "script.restore")
                {
                    return new BatchOperationPolicy("code-write", true, false, false, false);
                }
                return new BatchOperationPolicy(method == "script.delete" ? "destructive" : "code-write", true, false, true, true);
            }
            if (method == "package.add" || method == "package.remove")
            {
                return new BatchOperationPolicy("external", true, false, true, false);
            }
            if (method.StartsWith("asset.", StringComparison.Ordinal) || method.StartsWith("scene.", StringComparison.Ordinal) || method == "prefab.create")
            {
                var readOnly = method == "asset.find" || method == "scene.get_hierarchy" || method == "scene.list_open" || method == "scene.get_setup";
                var destructive = method == "asset.delete" || method == "scene.unload";
                return new BatchOperationPolicy(readOnly ? "read-only" : destructive ? "destructive" : "asset-write", !readOnly, false, true, false);
            }
            if (method == "screenshot.capture" || method == "screenshot.diff" || method == "screenshot.baselines_cleanup")
            {
                return new BatchOperationPolicy("asset-write", true, false, true, false);
            }
            if (method == "tests.run")
            {
                return new BatchOperationPolicy("safe-write", true, false, true, false);
            }
            if (method == "ping" || method == "health" || method == "editor.get_state"
                || method == "console.get_logs" || method == "console.diagnostics_get" || method == "console.query" || method == "console.assert"
                || method == "compile.diagnostics_get" || method == "compile.status_get" || method == "play_mode.get" || method == "input.status"
                || method == "operation.get" || method == "operation.list" || method == "screenshot.baselines_list"
                || method.StartsWith("semantic.", StringComparison.Ordinal) || method == "prefab.references_trace")
            {
                return new BatchOperationPolicy("read-only", false, false, true, false);
            }
            return null;
        }

        private static string MaximumRisk(string left, string right)
        {
            return RiskRank(left) >= RiskRank(right) ? left : right;
        }

        private static int RiskRank(string risk)
        {
            switch (risk)
            {
                case "safe-write": return 1;
                case "asset-write": return 2;
                case "code-write": return 3;
                case "destructive": return 4;
                case "external": return 5;
                case "arbitrary-code": return 6;
                default: return 0;
            }
        }

        private sealed class BatchOperationPlan
        {
            public int Index;
            public string Method = string.Empty;
            public string ParamsJson = "{}";
            public bool Required;
            public BatchOperationPolicy Policy;
        }

        private sealed class BatchOperationPolicy
        {
            public BatchOperationPolicy(string risk, bool mutates, bool undoable, bool supportsDryRun, bool transactionalFile)
            {
                Risk = risk;
                Mutates = mutates;
                Undoable = undoable;
                SupportsDryRun = supportsDryRun;
                TransactionalFile = transactionalFile;
            }

            public string Risk { get; }
            public bool Mutates { get; }
            public bool Undoable { get; }
            public bool SupportsDryRun { get; }
            public bool TransactionalFile { get; }
            public bool Rollbackable => Undoable || TransactionalFile;
        }

    }
}
