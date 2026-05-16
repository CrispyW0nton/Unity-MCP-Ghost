using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostWindow : EditorWindow
    {
        private static readonly UnityMcpGhostServer Server = UnityMcpGhostServer.Shared;
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
            EditorGUILayout.LabelField("Connected Clients", Server.ClientCount.ToString());

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Start Bridge"))
                {
                    if (Server.Start(port))
                    {
                        UnityMcpGhostBridgeService.SetAutoStart(true);
                    }
                }

                if (GUILayout.Button("Stop Bridge"))
                {
                    Server.Stop();
                    UnityMcpGhostBridgeService.SetAutoStart(false);
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
            EditorGUILayout.LabelField("Durable Queue", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(Server.QueueStatus, MessageType.None);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Last Request", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(string.IsNullOrEmpty(Server.LastRequest) ? "None" : Server.LastRequest, MessageType.None);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Recent Commands", EditorStyles.boldLabel);
            if (Server.CommandHistory.Count == 0)
            {
                EditorGUILayout.HelpBox("None", MessageType.None);
            }
            else
            {
                foreach (var command in Server.CommandHistory)
                {
                    EditorGUILayout.LabelField(command);
                }
            }

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
