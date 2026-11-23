using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using UnityEditor;

namespace CrispyWonton.UnityMcpGhost.Editor
{
 // Project-declared editor operations.
 // A project opts a static editor method in by marking it with its own attribute named "GhostOperationAttribute"
 // (any namespace) exposing a string "Id" (and optionally "Description"). Only such explicitly marked methods in the
 // project's own assemblies can be listed or invoked: no arbitrary code, no engine or package methods.
 internal sealed partial class CommandRegistry
 {
  private static readonly Regex GhostOperationIdPattern = new Regex("^[A-Za-z][A-Za-z0-9_.]{0,96}$");

  private static bool IsProjectAssembly(Assembly asm)
  {
   var name = asm.GetName().Name ?? "";
   return name.StartsWith("Assembly-CSharp", StringComparison.Ordinal);
  }

  private static List<(string id, string description, MethodInfo method)> FindGhostOperations()
  {
   var found = new List<(string, string, MethodInfo)>();
   foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
   {
    if (!IsProjectAssembly(asm)) continue;
    Type[] types;
    try { types = asm.GetTypes(); }
    catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
    foreach (var t in types)
     foreach (var m in t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
      foreach (var a in m.GetCustomAttributes(false))
      {
       var at = a.GetType();
       if (at.Name != "GhostOperationAttribute") continue;
       var id = at.GetProperty("Id")?.GetValue(a) as string;
       var desc = at.GetProperty("Description")?.GetValue(a) as string ?? "";
       if (!string.IsNullOrEmpty(id) && GhostOperationIdPattern.IsMatch(id)) found.Add((id, desc, m));
      }
   }
   return found;
  }

  private static string HandleEditorOperationsList(UnityMcpRequest request)
  {
   var arr = new JArray();
   foreach (var op in FindGhostOperations())
    arr.Add(new JObject { ["id"] = op.id, ["description"] = op.description, ["method"] = op.method.DeclaringType.FullName + "." + op.method.Name, ["takesArgs"] = op.method.GetParameters().Length == 1 });
   return new JObject { ["ok"] = true, ["operations"] = arr }.ToString(Newtonsoft.Json.Formatting.None);
  }

  private static string HandleEditorInvoke(UnityMcpRequest request)
  {
   var id = JsonRpcUtil.ReadString(request.RawJson, "operation", "");
   var args = JsonRpcUtil.ReadString(request.RawJson, "args", "");
   bool dryRun = JsonRpcUtil.ReadBool(request.RawJson, "dryRun", true);
   if (!GhostOperationIdPattern.IsMatch(id)) throw new ArgumentException("Invalid operation id");
   var matches = FindGhostOperations().Where(o => o.id == id).ToList();
   if (matches.Count == 0) throw new ArgumentException("Unknown operation: " + id);
   if (matches.Count > 1) throw new InvalidOperationException("Ambiguous operation id: " + id);
   var m = matches[0].method;
   var ps = m.GetParameters();
   if (ps.Length > 1 || (ps.Length == 1 && ps[0].ParameterType != typeof(string)))
    throw new InvalidOperationException("Operation must take no parameters or a single string");
   if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating)
    throw new InvalidOperationException("Editor must be idle");
   var result = new JObject { ["ok"] = true, ["dryRun"] = dryRun, ["operation"] = id, ["method"] = m.DeclaringType.FullName + "." + m.Name };
   if (!dryRun)
   {
    object ret;
    try { ret = m.Invoke(null, ps.Length == 1 ? new object[] { args } : null); }
    catch (TargetInvocationException e) when (e.InnerException != null) { throw e.InnerException; }
    result["result"] = ret == null ? null : new JValue(ret.ToString());
   }
   return result.ToString(Newtonsoft.Json.Formatting.None);
  }
 }
}
