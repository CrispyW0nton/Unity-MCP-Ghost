using System;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
namespace CrispyWonton.UnityMcpGhost.Editor
{
 internal static class GhostTestRunRecovery
 {
  private const string Pending="UnityMcpGhost.PendingTestOperation";
  private const string Runner="UnityMcpGhost.PendingTestRunner";
  internal static void Begin(string operationId){if(!string.IsNullOrEmpty(SessionState.GetString(Pending,"")))throw new InvalidOperationException("A Ghost test run is already pending");SessionState.SetString(Pending,operationId);}
  internal static void RunnerStarted(string guid){SessionState.SetString(Runner,guid);}
  internal static void Finished(string id){if(SessionState.GetString(Pending,"")==id){SessionState.EraseString(Pending);SessionState.EraseString(Runner);}}
  [InitializeOnLoadMethod] private static void Restore()
  {
   var id=SessionState.GetString(Pending,"");if(string.IsNullOrEmpty(id))return;
   var callbacks=new GhostTestRunCallbacks(id);var api=UnityEngine.ScriptableObject.CreateInstance<TestRunnerApi>();api.RegisterCallbacks(callbacks);
   OperationStore.Reattach(id,()=>callbacks.StateJson,()=>{var guid=SessionState.GetString(Runner,"");if(string.IsNullOrEmpty(guid)||!TestRunnerApi.CancelTestRun(guid))throw new InvalidOperationException("Test runner cancellation could not be confirmed");});
  }
 }
}
