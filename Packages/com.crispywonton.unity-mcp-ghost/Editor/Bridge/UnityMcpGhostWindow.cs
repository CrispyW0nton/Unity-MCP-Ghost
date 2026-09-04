using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed class UnityMcpGhostWindow : EditorWindow
    {
        private static readonly UnityMcpGhostServer Server = UnityMcpGhostServer.Shared;
        private int port = UnityMcpGhostConfig.DefaultPort;
        private int webSocketPort;
        private bool allowDestructive;
        private bool allowPackageNetwork;
        private bool allowArbitraryCode;
        private bool allowReflection;

        [MenuItem("Window/Unity MCP Ghost")]
        public static void Open()
        {
            GetWindow<UnityMcpGhostWindow>("Unity MCP Ghost");
        }

        private void OnEnable()
        {
            var settings = BridgeSecurity.Settings;
            port = settings.Port;
            webSocketPort = settings.WebSocketPort;
            allowDestructive = settings.AllowDestructive;
            allowPackageNetwork = settings.AllowPackageNetwork;
            allowArbitraryCode = settings.AllowArbitraryCode;
            allowReflection = settings.AllowReflection;
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Unity MCP Ghost", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            using (new EditorGUI.DisabledScope(Server.IsRunning))
            {
                port = EditorGUILayout.IntField("Bridge Port", port);
                webSocketPort = EditorGUILayout.IntField("WebSocket Port", webSocketPort);
            }

            EditorGUILayout.LabelField("Status", Server.IsRunning ? "Running" : "Stopped");
            EditorGUILayout.LabelField("HTTP Endpoint", "http://127.0.0.1:" + port + UnityMcpGhostConfig.WebSocketPath);
            EditorGUILayout.LabelField("WebSocket Endpoint", "ws://127.0.0.1:" + webSocketPort + UnityMcpGhostConfig.WebSocketPath);
            EditorGUILayout.LabelField("Connected Clients", Server.ClientCount.ToString());
            EditorGUILayout.LabelField("Project ID", BridgeSecurity.ProjectId);
            EditorGUILayout.LabelField("Editor Instance", BridgeSecurity.EditorInstanceId);
            EditorGUILayout.LabelField("Token File", BridgeSecurity.TokenPath);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Explicit Capability Opt-ins", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            allowDestructive = EditorGUILayout.Toggle("Destructive", allowDestructive);
            allowPackageNetwork = EditorGUILayout.Toggle("Package / Network", allowPackageNetwork);
            allowArbitraryCode = EditorGUILayout.Toggle("Arbitrary Code", allowArbitraryCode);
            allowReflection = EditorGUILayout.Toggle("Reflection", allowReflection);
            if (EditorGUI.EndChangeCheck())
            {
                SaveSettings();
            }
            EditorGUILayout.HelpBox("All high-risk capability classes default to disabled. Enabling them authorizes authenticated local clients for this project; arbitrary code is not sandboxed.", MessageType.Warning);

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Start Bridge"))
                {
                    SaveSettings();
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
                    + "      \"args\": [\"dist/index.js\", \"--transport\", \"stdio\", \"--unity-project-path\", \""
                    + JsonRpcUtil.Escape(ProjectPathPolicy.ProjectRoot.Replace("\\", "/"))
                    + "\", \"--unity-editor-id\", \""
                    + BridgeSecurity.EditorInstanceId
                    + "\", \"--unity-token-file\", \""
                    + JsonRpcUtil.Escape(BridgeSecurity.TokenPath.Replace("\\", "/"))
                    + "\", \"--unity-host\", \"127.0.0.1\", \"--unity-port\", \""
                    + port
                    + "\", \"--unity-websocket-port\", \""
                    + webSocketPort
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
            var commandHistory = Server.CommandHistory.Count == 0
                ? "None"
                : string.Join("\n", Server.CommandHistory);
            EditorGUILayout.HelpBox(commandHistory, MessageType.None);

            EditorGUILayout.LabelField("Last Error", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(string.IsNullOrEmpty(Server.LastError) ? "None" : Server.LastError, string.IsNullOrEmpty(Server.LastError) ? MessageType.None : MessageType.Error);
        }

        private void SaveSettings()
        {
            var settings = BridgeSecurity.Settings;
            settings.Port = port;
            settings.WebSocketPort = webSocketPort;
            settings.AllowDestructive = allowDestructive;
            settings.AllowPackageNetwork = allowPackageNetwork;
            settings.AllowArbitraryCode = allowArbitraryCode;
            settings.AllowReflection = allowReflection;
            BridgeSecurity.SaveSettings(settings);
        }
    }
}
