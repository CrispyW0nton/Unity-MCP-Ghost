using System;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
namespace CrispyWonton.UnityMcpGhost.Editor
{
 internal sealed partial class CommandRegistry
 {
  // The executable is named after the project's product name (falling back to the build name)
  private static string ExecutableName(string buildName)
  {
   var product=Regex.Replace(PlayerSettings.productName??"","[^A-Za-z0-9 _-]","").Trim();
   return product.Length>0&&product.Length<=64?product:buildName;
  }
  private static string HandlePlayerBuild(UnityMcpRequest request)
  {
   var name=JsonRpcUtil.ReadString(request.RawJson,"buildName","");
   var scene=ProjectPathPolicy.NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson,"scene",""));
   var targetName=JsonRpcUtil.ReadString(request.RawJson,"target","StandaloneWindows64");
   if(targetName!="StandaloneWindows64"&&targetName!="iOS"&&targetName!="WebGL")throw new ArgumentException("Unsupported build target");
   var target=targetName=="iOS"?BuildTarget.iOS:targetName=="WebGL"?BuildTarget.WebGL:BuildTarget.StandaloneWindows64;
   if(!BuildPipeline.IsBuildTargetSupported(BuildPipeline.GetBuildTargetGroup(target),target))throw new InvalidOperationException("Matching build support module is not installed");
   if(target!=BuildTarget.StandaloneWindows64&&EditorUserBuildSettings.activeBuildTarget!=target)throw new InvalidOperationException("Open the editor with the matching active platform (-buildTarget "+targetName+") before building");
   if(!Regex.IsMatch(name,"^[a-zA-Z0-9_-]{1,64}$"))throw new ArgumentException("Invalid build name");
   if(!scene.EndsWith(".unity",StringComparison.OrdinalIgnoreCase)||!AssetDatabase.LoadAssetAtPath<SceneAsset>(scene))throw new ArgumentException("Existing scene required");
   if(EditorApplication.isPlayingOrWillChangePlaymode||EditorApplication.isCompiling||EditorApplication.isUpdating)throw new InvalidOperationException("Editor must be idle");
   for(int i=0;i<EditorSceneManager.sceneCount;i++)if(EditorSceneManager.GetSceneAt(i).isDirty)throw new InvalidOperationException("Save scenes before building");
   var output=ProjectPathPolicy.RequireUnderProjectRoot(Path.Combine("Builds",name));
   if(Directory.Exists(output)||File.Exists(output))throw new IOException("Build output already exists; choose a new build name");
   bool dryRun=JsonRpcUtil.ReadBool(request.RawJson,"dryRun",true);
   var location=target==BuildTarget.StandaloneWindows64?Path.Combine(output,ExecutableName(name)+".exe"):output;
   var result=new JObject{["ok"]=true,["dryRun"]=dryRun,["outputPath"]=location,["scene"]=scene,["target"]=targetName};
   if(!dryRun){Directory.CreateDirectory(output);var report=BuildPipeline.BuildPlayer(new BuildPlayerOptions{scenes=new[]{scene},locationPathName=location,target=target,options=BuildOptions.None});result["ok"]=report.summary.result==BuildResult.Succeeded;result["result"]=report.summary.result.ToString();result["errors"]=(int)report.summary.totalErrors;result["warnings"]=(int)report.summary.totalWarnings;result["bytes"]=(long)report.summary.totalSize;}
   return result.ToString(Newtonsoft.Json.Formatting.None);
  }
 }
}
