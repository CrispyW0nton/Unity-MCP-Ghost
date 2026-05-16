using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class DurableCommandQueue
    {
        private static readonly CommandRegistry Commands = new CommandRegistry();
        private static double nextPollTime;

        static DurableCommandQueue()
        {
            EnsureDirectories();
            EditorApplication.update -= Poll;
            EditorApplication.update += Poll;
        }

        public static string QueueRoot
        {
            get
            {
                return Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "UnityMcpGhost", "queue"));
            }
        }

        public static string PendingDirectory
        {
            get { return Path.Combine(QueueRoot, "pending"); }
        }

        public static string ResultsDirectory
        {
            get { return Path.Combine(QueueRoot, "results"); }
        }

        public static string StatusJson()
        {
            EnsureDirectories();
            return "{"
                + "\"queueRoot\":\"" + JsonRpcUtil.Escape(QueueRoot) + "\","
                + "\"pendingCount\":" + Directory.GetFiles(PendingDirectory, "*.json").Length + ","
                + "\"resultCount\":" + Directory.GetFiles(ResultsDirectory, "*.json").Length
                + "}";
        }

        private static void Poll()
        {
            if (EditorApplication.timeSinceStartup < nextPollTime)
            {
                return;
            }

            nextPollTime = EditorApplication.timeSinceStartup + 0.25d;
            EnsureDirectories();

            foreach (var path in Directory.GetFiles(PendingDirectory, "*.json"))
            {
                ProcessFile(path);
            }
        }

        private static void ProcessFile(string path)
        {
            string json;
            try
            {
                json = File.ReadAllText(path);
            }
            catch (IOException)
            {
                return;
            }

            var request = JsonRpcUtil.ParseRequest(json);
            if (string.IsNullOrEmpty(request.Id))
            {
                request.Id = Path.GetFileNameWithoutExtension(path);
            }

            var response = Commands.Execute(request);
            var resultPath = Path.Combine(ResultsDirectory, request.Id + ".json");
            var tempPath = resultPath + ".tmp";
            File.WriteAllText(tempPath, response);
            if (File.Exists(resultPath))
            {
                File.Delete(resultPath);
            }

            File.Move(tempPath, resultPath);
            File.Delete(path);
        }

        private static void EnsureDirectories()
        {
            Directory.CreateDirectory(PendingDirectory);
            Directory.CreateDirectory(ResultsDirectory);
        }
    }
}
