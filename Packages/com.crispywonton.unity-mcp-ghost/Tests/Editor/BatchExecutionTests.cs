using System;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    [Parallelizable(ParallelScope.None)]
    public sealed class BatchExecutionTests
    {
        [Test]
        public void RejectsUnknownOperationBeforeFirstMutation()
        {
            var name = "GhostBatchPreflight-" + Guid.NewGuid().ToString("N");
            var result = ExecuteBatch(new JObject
            {
                ["operations"] = new JArray
                {
                    Operation("gameobject.create", new JObject { ["name"] = name }),
                    Operation("does.not.exist", new JObject())
                }
            });

            Assert.That(result.Value<bool>("ok"), Is.False);
            Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_VALIDATION_FAILED"));
            Assert.That(GameObject.Find(name), Is.Null);
        }

        [Test]
        public void DryRunOverridesNestedFalseBeforePreflight()
        {
            var name = "GhostBatchNestedDryRun-" + Guid.NewGuid().ToString("N");

            var result = ExecuteBatch(new JObject
            {
                ["dryRun"] = true,
                ["operations"] = new JArray { Operation("gameobject.create", new JObject { ["name"] = name, ["dryRun"] = false }) }
            });

            Assert.That(result.Value<bool>("ok"), Is.True, result.ToString());
            Assert.That(result.Value<bool>("dryRun"), Is.True);
            Assert.That(GameObject.Find(name), Is.Null);
        }

        [Test]
        public void RejectsRegisteredOperationWithoutExplicitBatchPolicy()
        {
            var result = ExecuteBatch(new JObject
            {
                ["operations"] = new JArray { Operation("editor.restore_snapshot", new JObject()) }
            });

            Assert.That(result.Value<bool>("ok"), Is.False);
            Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_POLICY_MISSING"));
        }

        [Test]
        public void RollsBackUndoableMutationAfterExecutionFailure()
        {
            var gameObject = new GameObject("GhostBatchUndo-" + Guid.NewGuid().ToString("N"));
            gameObject.transform.position = new Vector3(1, 2, 3);
            try
            {
                var result = ExecuteBatch(new JObject
                {
                    ["operations"] = new JArray
                    {
                        Operation("gameobject.set_transform", new JObject { ["instanceId"] = gameObject.GetGhostInstanceId(), ["x"] = 9, ["y"] = 8, ["z"] = 7 }),
                        Operation("component.add", new JObject { ["instanceId"] = gameObject.GetGhostInstanceId(), ["type"] = "UnityEngine.Transform" })
                    }
                });

                Assert.That(result.Value<bool>("ok"), Is.False);
                Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_REQUIRED_OPERATION_FAILED"), result.ToString());
                Assert.That(result["rollback"]["ok"].Value<bool>(), Is.True, result.ToString());
                Assert.That(gameObject.transform.position, Is.EqualTo(new Vector3(1, 2, 3)));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void RequiresExactMaximumRiskBeforeDestructiveMutation()
        {
            var gameObject = new GameObject("GhostBatchRisk-" + Guid.NewGuid().ToString("N"));
            try
            {
                var result = ExecuteBatch(new JObject
                {
                    ["acceptedRisk"] = "safe-write",
                    ["operations"] = new JArray
                    {
                        Operation("gameobject.delete", new JObject { ["instanceId"] = gameObject.GetGhostInstanceId() })
                    }
                });

                Assert.That(result.Value<bool>("ok"), Is.False);
                Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_RISK_NOT_ACCEPTED"));
                Assert.That(gameObject, Is.Not.Null);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void ReportsIncompleteRollbackAfterAcceptedNonRollbackableMutation()
        {
            var folderName = "GhostBatchFolder" + Guid.NewGuid().ToString("N");
            var folderPath = "Assets/" + folderName;
            var gameObject = new GameObject("GhostBatchNonRollbackable-" + Guid.NewGuid().ToString("N"));
            try
            {
                var result = ExecuteBatch(new JObject
                {
                    ["acceptedRisk"] = "asset-write",
                    ["acceptNonRollbackable"] = true,
                    ["operations"] = new JArray
                    {
                        Operation("asset.create_folder", new JObject { ["parentPath"] = "Assets", ["folderName"] = folderName }),
                        Operation("component.add", new JObject { ["instanceId"] = gameObject.GetGhostInstanceId(), ["type"] = "UnityEngine.Transform" })
                    }
                });

                Assert.That(result.Value<bool>("ok"), Is.False);
                Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_ROLLBACK_INCOMPLETE"));
                Assert.That(result["rollback"]["ok"].Value<bool>(), Is.False);
                Assert.That(AssetDatabase.IsValidFolder(folderPath), Is.True);
            }
            finally
            {
                AssetDatabase.DeleteAsset(folderPath);
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void FailedScriptRollbackPreservesRecoveryReceiptAndContinuesEarlierRollbacks()
        {
            var folderName = "GB" + Guid.NewGuid().ToString("N");
            var folderPath = "Assets/" + folderName;
            var earlierAssetPath = folderPath + "/Earlier.cs";
            var failedAssetPath = folderPath + "/Failed.cs";
            var earlierPath = ProjectPathPolicy.FullAssetPath(earlierAssetPath);
            var failedPath = ProjectPathPolicy.FullAssetPath(failedAssetPath);
            var backupRoot = Path.Combine(Directory.GetCurrentDirectory(), "Library", folderName);
            var previousBackupRoot = ScriptFileTransaction.BackupRootForTests;
            var previousIoHook = ScriptFileTransaction.BeforeIoForTests;
            var gameObject = new GameObject("GhostBatchRecoveryFailure-" + Guid.NewGuid().ToString("N"));
            const string originalSource = "// original source\n";
            const string changedSource = "// changed source\n";
            const string restoreFailure = "injected batch restoration failure";
            const string cleanupFailure = "injected batch cleanup failure";
            try
            {
                AssetDatabase.CreateFolder("Assets", folderName);
                File.WriteAllText(earlierPath, originalSource, new UTF8Encoding(false));
                File.WriteAllText(failedPath, originalSource, new UTF8Encoding(false));
                AssetDatabase.ImportAsset(earlierAssetPath, ImportAssetOptions.ForceUpdate);
                AssetDatabase.ImportAsset(failedAssetPath, ImportAssetOptions.ForceUpdate);
                var originalHash = ScriptFileTransaction.Read(failedPath).Sha256;
                var metadataHash = ScriptFileTransaction.Read(failedPath + ".meta").Sha256;
                ScriptFileTransaction.BackupRootForTests = backupRoot;
                var sourceMutations = 0;
                var restorationFailed = false;
                string remainingTemporaryPath = null;
                ScriptFileTransaction.BeforeIoForTests = (step, destination) =>
                {
                    if (destination == failedPath && step == "after-mutation" && ++sourceMutations == 2)
                    {
                        restorationFailed = true;
                        throw new IOException(restoreFailure);
                    }
                    if (restorationFailed && destination == failedPath && step == "compensate-replace")
                    {
                        throw new IOException("injected batch compensation failure");
                    }
                    if (restorationFailed && step == "cleanup" && destination.StartsWith(failedPath + ".", StringComparison.Ordinal)
                        && destination.EndsWith(".tmp", StringComparison.Ordinal) && File.Exists(destination))
                    {
                        remainingTemporaryPath = destination;
                        throw new IOException(cleanupFailure);
                    }
                };

                var result = ExecuteBatch(new JObject
                {
                    ["operations"] = new JArray
                    {
                        Operation("script.write", new JObject { ["path"] = earlierAssetPath, ["content"] = changedSource }),
                        Operation("script.write", new JObject { ["path"] = failedAssetPath, ["content"] = changedSource }),
                        Operation("component.add", new JObject { ["instanceId"] = gameObject.GetGhostInstanceId(), ["type"] = "UnityEngine.Transform" })
                    }
                });

                Assert.That(result["results"][0]["ok"].Value<bool>(), Is.True, result.ToString());
                Assert.That(result["results"][1]["ok"].Value<bool>(), Is.True, result.ToString());
                Assert.That(sourceMutations, Is.EqualTo(2), result.ToString());
                Assert.That(result.Value<bool>("ok"), Is.False);
                Assert.That(result["error"]["code"].Value<string>(), Is.EqualTo("BATCH_ROLLBACK_INCOMPLETE"));
                Assert.That(result["rollback"]["ok"].Value<bool>(), Is.False);
                var outcomes = (JArray)result["rollback"]["outcomes"];
                Assert.That(outcomes.Count, Is.EqualTo(2), result.ToString());
                var failed = (JObject)outcomes[0];
                Assert.That(failed.Value<bool>("ok"), Is.False);
                Assert.That(failed.Value<int>("index"), Is.EqualTo(1));
                Assert.That(failed.Value<string>("method"), Is.EqualTo("script.write"));
                Assert.That(failed.Value<string>("path"), Is.EqualTo(failedAssetPath));
                Assert.That(failed["error"]["code"].Value<string>(), Is.EqualTo("SCRIPT_IO_FAILED"), failed.ToString());
                Assert.That(failed["error"]["message"].Value<string>(), Does.Contain(restoreFailure));
                Assert.That(failed["error"]["restorationStatus"].Value<string>(), Is.EqualTo("incomplete"));
                Assert.That(failed.Value<string>("beforeSha256"), Is.EqualTo(result["results"][1]["result"]["afterSha256"].Value<string>()));
                Assert.That(failed.Value<string>("afterSha256"), Is.EqualTo(originalHash));
                Assert.That(failed["restoredSha256"].Type, Is.EqualTo(JTokenType.Null));
                Assert.That(failed.Value<bool>("restored"), Is.False);
                Assert.That(failed["error"]["currentSha256"].Value<string>(), Is.EqualTo(ScriptFileTransaction.Read(failedPath).Sha256));
                Assert.That(failed["error"]["sourceExists"].Value<bool>(), Is.True);
                Assert.That(failed["error"]["metadataExists"].Value<bool>(), Is.True);
                Assert.That(failed["error"]["metadataSha256"].Value<string>(), Is.EqualTo(metadataHash));
                Assert.That(failed["error"]["recoveryErrors"].Any(), Is.True);
                Assert.That(Directory.Exists(failed["error"]["recoveryDirectory"].Value<string>()), Is.True);
                var recoveryFiles = failed["error"]["recoveryFiles"].Values<string>().ToArray();
                Assert.That(recoveryFiles, Does.Contain(failed.Value<string>("backupPath")));
                Assert.That(recoveryFiles, Does.Contain(failed.Value<string>("backupMetaPath")));
                Assert.That(File.ReadAllText(failed.Value<string>("backupPath")), Is.EqualTo(changedSource));
                Assert.That(File.ReadAllText(result["results"][1]["result"]["backupPath"].Value<string>()), Is.EqualTo(originalSource), "The original batch backup must survive failed restoration.");
                var recoveryStates = (JArray)failed["error"]["recoveryFileStates"];
                Assert.That(recoveryStates.Count, Is.EqualTo(recoveryFiles.Length));
                foreach (var state in recoveryStates)
                {
                    var recoveryPath = state.Value<string>("path");
                    Assert.That(recoveryFiles, Does.Contain(recoveryPath));
                    Assert.That(File.Exists(recoveryPath), Is.True);
                    Assert.That(state.Value<string>("status"), Is.EqualTo("present"));
                    Assert.That(state.Value<string>("sha256"), Is.EqualTo(ScriptFileTransaction.Read(recoveryPath).Sha256));
                }
                Assert.That(remainingTemporaryPath, Is.Not.Null);
                Assert.That(File.Exists(remainingTemporaryPath), Is.True);
                Assert.That(failed["cleanupWarnings"].Any(warning => warning.Value<string>("path") == remainingTemporaryPath
                    && warning.Value<string>("message") == cleanupFailure), Is.True);
                Assert.That(outcomes[1]["index"].Value<int>(), Is.EqualTo(0));
                Assert.That(outcomes[1]["ok"].Value<bool>(), Is.True);
                Assert.That(File.ReadAllText(earlierPath), Is.EqualTo(originalSource));
            }
            finally
            {
                ScriptFileTransaction.BeforeIoForTests = previousIoHook;
                ScriptFileTransaction.BackupRootForTests = previousBackupRoot;
                AssetDatabase.DeleteAsset(folderPath);
                UnityEngine.Object.DestroyImmediate(gameObject);
                if (Directory.Exists(backupRoot))
                {
                    var validated = ProjectPathPolicy.RequireUnderProjectRoot(backupRoot);
                    Assert.That(Path.GetFileName(validated), Is.EqualTo(Path.GetFileName(backupRoot)));
                    Directory.Delete(validated, true);
                }
            }
        }

        private static JObject ExecuteBatch(JObject parameters)
        {
            var request = JsonRpcUtil.ParseRequest(new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = 1,
                ["method"] = "batch.execute",
                ["params"] = parameters
            }.ToString(Newtonsoft.Json.Formatting.None));
            var response = JObject.Parse(new CommandRegistry().Execute(request));
            Assert.That(response["error"], Is.Null, response.ToString());
            return (JObject)response["result"];
        }

        private static JObject Operation(string method, JObject parameters)
        {
            return new JObject
            {
                ["method"] = method,
                ["params"] = parameters,
                ["required"] = true
            };
        }
    }
}
