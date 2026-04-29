using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostWindow : EditorWindow
    {
        private static readonly UnityMcpGhostServer Server = new UnityMcpGhostServer();
        private int port = UnityMcpGhostConfig.DefaultPort;

        [MenuItem("Window/Unity MCP Ghost")]
        public static void Open()
        {
            GetWindow<UnityMcpGhostWindow>("Unity MCP Ghost");
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Unity MCP Ghost", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            using (new EditorGUI.DisabledScope(Server.IsRunning))
            {
                port = EditorGUILayout.IntField("Bridge Port", port);
            }

            EditorGUILayout.LabelField("Status", Server.IsRunning ? "Running" : "Stopped");
            EditorGUILayout.LabelField("Endpoint", "ws://127.0.0.1:" + port + UnityMcpGhostConfig.WebSocketPath);

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Start Bridge"))
                {
                    Server.Start(port);
                }

                if (GUILayout.Button("Stop Bridge"))
                {
                    Server.Stop();
                }
            }

            if (GUILayout.Button("Copy Cursor Config Snippet"))
            {
                EditorGUIUtility.systemCopyBuffer =
                    "{\n"
                    + "  \"mcpServers\": {\n"
                    + "    \"unity-mcp-ghost\": {\n"
                    + "      \"command\": \"node\",\n"
                    + "      \"args\": [\"dist/index.js\", \"--transport\", \"stdio\", \"--unity-host\", \"127.0.0.1\", \"--unity-port\", \""
                    + port
                    + "\"]\n"
                    + "    }\n"
                    + "  }\n"
                    + "}";
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Last Request", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(string.IsNullOrEmpty(Server.LastRequest) ? "None" : Server.LastRequest, MessageType.None);

            if (!string.IsNullOrEmpty(Server.LastError))
            {
                EditorGUILayout.LabelField("Last Error", EditorStyles.boldLabel);
                EditorGUILayout.HelpBox(Server.LastError, MessageType.Error);
            }
        }

        private void OnDisable()
        {
            Repaint();
        }
    }
}
