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
  private static string HandlePlayerBuild(UnityMcpRequest request)
  {
   var name=JsonRpcUtil.ReadString(request.RawJson,"buildName","");
   var scene=ProjectPathPolicy.NormalizeAssetPath(JsonRpcUtil.ReadString(request.RawJson,"scene",""));
   var targetName=JsonRpcUtil.ReadString(request.RawJson,"target","StandaloneWindows64");
   if(targetName!="StandaloneWindows64"&&targetName!="iOS")throw new ArgumentException("Unsupported build target");
   var target=targetName=="iOS"?BuildTarget.iOS:BuildTarget.StandaloneWindows64;
   if(!BuildPipeline.IsBuildTargetSupported(BuildPipeline.GetBuildTargetGroup(target),target))throw new InvalidOperationException("Matching build support module is not installed");
   if(target==BuildTarget.iOS&&EditorUserBuildSettings.activeBuildTarget!=target)throw new InvalidOperationException("Open the editor with active iOS platform before exporting");
   if(!Regex.IsMatch(name,"^[a-zA-Z0-9_-]{1,64}$"))throw new ArgumentException("Invalid build name");
   if(!scene.EndsWith(".unity",StringComparison.OrdinalIgnoreCase)||!AssetDatabase.LoadAssetAtPath<SceneAsset>(scene))throw new ArgumentException("Existing scene required");
   if(EditorApplication.isPlayingOrWillChangePlaymode||EditorApplication.isCompiling||EditorApplication.isUpdating)throw new InvalidOperationException("Editor must be idle");
   for(int i=0;i<EditorSceneManager.sceneCount;i++)if(EditorSceneManager.GetSceneAt(i).isDirty)throw new InvalidOperationException("Save scenes before building");
   var output=ProjectPathPolicy.RequireUnderProjectRoot(Path.Combine("Builds",name));
   if(Directory.Exists(output)||File.Exists(output))throw new IOException("Build output already exists; choose a new build name");
   bool dryRun=JsonRpcUtil.ReadBool(request.RawJson,"dryRun",true);
   var location=target==BuildTarget.iOS?output:Path.Combine(output,"DolphinCove.exe");
   var result=new JObject{["ok"]=true,["dryRun"]=dryRun,["outputPath"]=location,["scene"]=scene,["target"]=targetName};
   if(!dryRun){Directory.CreateDirectory(output);var report=BuildPipeline.BuildPlayer(new BuildPlayerOptions{scenes=new[]{scene},locationPathName=location,target=target,options=BuildOptions.None});result["ok"]=report.summary.result==BuildResult.Succeeded;result["result"]=report.summary.result.ToString();result["errors"]=(int)report.summary.totalErrors;result["warnings"]=(int)report.summary.totalWarnings;result["bytes"]=(long)report.summary.totalSize;}
   return result.ToString(Newtonsoft.Json.Formatting.None);
  }
 }
}
