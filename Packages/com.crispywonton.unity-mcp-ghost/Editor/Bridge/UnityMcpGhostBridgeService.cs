using UnityEditor;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class UnityMcpGhostBridgeService
    {
        private const string AutoStartKey = UnityMcpGhostConfig.PackageName + ".autoStart";

        static UnityMcpGhostBridgeService()
        {
            EditorApplication.delayCall += StartIfEnabled;
        }

        public static void SetAutoStart(bool enabled)
        {
            EditorPrefs.SetBool(AutoStartKey, enabled);
        }

        private static void StartIfEnabled()
        {
            if (!EditorPrefs.GetBool(AutoStartKey, true))
            {
                return;
            }

            UnityMcpGhostServer.Shared.Start(UnityMcpGhostConfig.DefaultPort);
        }
    }
}
