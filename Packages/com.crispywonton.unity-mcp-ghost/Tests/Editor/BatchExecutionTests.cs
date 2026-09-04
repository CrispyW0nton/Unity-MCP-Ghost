using System;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
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
                        Operation("gameobject.set_transform", new JObject { ["instanceId"] = gameObject.GetInstanceID(), ["x"] = 9, ["y"] = 8, ["z"] = 7 }),
                        Operation("component.add", new JObject { ["instanceId"] = gameObject.GetInstanceID(), ["type"] = "UnityEngine.Transform" })
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
                        Operation("gameobject.delete", new JObject { ["instanceId"] = gameObject.GetInstanceID() })
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
                        Operation("component.add", new JObject { ["instanceId"] = gameObject.GetInstanceID(), ["type"] = "UnityEngine.Transform" })
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
