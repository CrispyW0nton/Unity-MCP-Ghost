using UnityEditor;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class UnityMcpGhostBridgeService
    {
        private static double nextHeartbeat;
        private static double nextStartAttempt;

        static UnityMcpGhostBridgeService()
        {
            EditorApplication.delayCall += StartIfEnabled;
            EditorApplication.update -= UpdateHeartbeat;
            EditorApplication.update += UpdateHeartbeat;
        }

        public static void SetAutoStart(bool enabled)
        {
            var settings = BridgeSecurity.Settings;
            settings.AutoStart = enabled;
            BridgeSecurity.SaveSettings(settings);
        }

        private static void StartIfEnabled()
        {
            var settings = BridgeSecurity.Settings;
            if (!settings.AutoStart)
            {
                BridgeSecurity.WriteIdentity(settings.Port, settings.WebSocketPort, false);
                return;
            }

            UnityMcpGhostServer.Shared.Start(settings.Port);
        }

        private static void UpdateHeartbeat()
        {
            var settings = BridgeSecurity.Settings;
            if (settings.AutoStart && !UnityMcpGhostServer.Shared.IsRunning && EditorApplication.timeSinceStartup >= nextStartAttempt)
            {
                nextStartAttempt = EditorApplication.timeSinceStartup + 30d;
                UnityMcpGhostServer.Shared.Start(settings.Port);
            }
            if (EditorApplication.timeSinceStartup < nextHeartbeat)
            {
                return;
            }
            nextHeartbeat = EditorApplication.timeSinceStartup + 5d;
            if (UnityMcpGhostServer.Shared.IsRunning || UnityMcpGhostServer.Shared.StartupFailure != null)
            {
                UnityMcpGhostServer.Shared.Heartbeat();
            }
            else
            {
                BridgeSecurity.WriteIdentity(settings.Port, settings.WebSocketPort, false);
            }
        }
    }
}
