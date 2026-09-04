using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class BridgeSecurity
    {
        private const string SessionEditorIdKey = UnityMcpGhostConfig.PackageName + ".editorInstanceId";
        private static readonly object Sync = new object();
        private static string token;
        private static BridgeSettings settings;
        private static string projectId;
        private static string editorInstanceId;

        public static string StateRoot => Path.Combine(ProjectPathPolicy.ProjectRoot, "Library", "UnityMcpGhost");
        public static string TokenPath => Path.Combine(StateRoot, "bridge-token.txt");
        public static string SettingsPath => Path.Combine(StateRoot, "bridge-settings.json");
        public static string IdentityPath => Path.Combine(StateRoot, "bridge-identity.json");
        public static string ProjectId
        {
            get
            {
                EnsureInitialized();
                return projectId;
            }
        }

        public static string EditorInstanceId
        {
            get
            {
                EnsureInitialized();
                return editorInstanceId;
            }
        }

        public static void InitializeOnMainThread()
        {
            lock (Sync)
            {
                if (!string.IsNullOrEmpty(projectId))
                {
                    return;
                }

                ProjectPathPolicy.InitializeOnMainThread();
                projectId = "unity-project-" + Sha256Hex(NormalizeIdentityPath(ProjectPathPolicy.ProjectRoot)).Substring(0, 24);
                editorInstanceId = SessionState.GetString(SessionEditorIdKey, string.Empty);
                if (string.IsNullOrWhiteSpace(editorInstanceId))
                {
                    editorInstanceId = Guid.NewGuid().ToString("N");
                    SessionState.SetString(SessionEditorIdKey, editorInstanceId);
                }

                settings = LoadSettings();
                token = LoadOrCreateToken();
            }
        }

        public static int DeterministicPort
        {
            get
            {
                var bytes = HexToBytes(Sha256Hex(NormalizeIdentityPath(ProjectPathPolicy.ProjectRoot)));
                var value = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
                return UnityMcpGhostConfig.DefaultPort + (int)(value % 1000u);
            }
        }

        public static int DeterministicWebSocketPort
        {
            get
            {
                var bytes = HexToBytes(Sha256Hex(NormalizeIdentityPath(ProjectPathPolicy.ProjectRoot)));
                var value = ((uint)bytes[4] << 24) | ((uint)bytes[5] << 16) | ((uint)bytes[6] << 8) | bytes[7];
                return 16400 + (int)(value % 10000u);
            }
        }

        public static BridgeSettings Settings
        {
            get
            {
                lock (Sync)
                {
                    if (settings == null)
                    {
                        settings = LoadSettings();
                    }
                    return settings.Clone();
                }
            }
        }

        public static string Token
        {
            get
            {
                lock (Sync)
                {
                    if (string.IsNullOrEmpty(token))
                    {
                        token = LoadOrCreateToken();
                    }
                    return token;
                }
            }
        }

        public static void SaveSettings(BridgeSettings value)
        {
            if (value == null)
            {
                throw new ArgumentNullException("value");
            }

            var normalized = value.Clone();
            if (normalized.Port < 1024 || normalized.Port > 65535)
            {
                throw new InvalidOperationException("Bridge port must be between 1024 and 65535.");
            }
            if (normalized.WebSocketPort < 1024 || normalized.WebSocketPort > 65535 || normalized.WebSocketPort == normalized.Port)
            {
                throw new InvalidOperationException("WebSocket port must be between 1024 and 65535 and differ from the HTTP port.");
            }
            normalized.PackageSourceAllowlist = (normalized.PackageSourceAllowlist ?? Array.Empty<string>())
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Select(item => item.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            lock (Sync)
            {
                Directory.CreateDirectory(StateRoot);
                WriteAtomic(SettingsPath, JsonConvert.SerializeObject(normalized, Formatting.Indented));
                settings = normalized;
            }
        }

        public static bool AuthenticateBearer(string authorizationHeader)
        {
            const string prefix = "Bearer ";
            if (string.IsNullOrWhiteSpace(authorizationHeader) || !authorizationHeader.StartsWith(prefix, StringComparison.Ordinal))
            {
                return false;
            }

            return FixedTimeEquals(authorizationHeader.Substring(prefix.Length), Token);
        }

        public static string CreateQueueProof(UnityMcpRequest request)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(Token)))
            {
                return BytesToHex(hmac.ComputeHash(Encoding.UTF8.GetBytes(ProofPayload(request))));
            }
        }

        public static BridgeAuthorizationResult AuthorizeRequest(UnityMcpRequest request, bool requireQueueProof)
        {
            if (request == null)
            {
                return BridgeAuthorizationResult.Deny("INVALID_REQUEST", "Request metadata is unavailable.");
            }
            if (string.IsNullOrWhiteSpace(request.ProjectId))
            {
                return BridgeAuthorizationResult.Deny("PROJECT_ID_REQUIRED", "Every bridge request must pin the selected Unity project ID.");
            }
            if (!FixedTimeEquals(request.ProjectId, ProjectId))
            {
                return BridgeAuthorizationResult.Deny("PROJECT_ID_MISMATCH", "The request is pinned to a different Unity project.");
            }
            if (string.IsNullOrWhiteSpace(request.EditorInstanceId))
            {
                return BridgeAuthorizationResult.Deny("EDITOR_INSTANCE_ID_REQUIRED", "Every bridge request must pin the selected Unity editor instance.");
            }
            if (!FixedTimeEquals(request.EditorInstanceId, EditorInstanceId))
            {
                return BridgeAuthorizationResult.Deny("EDITOR_INSTANCE_ID_MISMATCH", "The request is pinned to a different Unity editor instance.");
            }
            if (requireQueueProof && !FixedTimeEquals(request.AuthProof, CreateQueueProof(request)))
            {
                return BridgeAuthorizationResult.Deny("AUTHENTICATION_FAILED", "The durable queue request proof is missing or invalid.");
            }

            return AuthorizeCapability(request.Method, request.RawJson, Settings);
        }

        public static string AuthorizationError(UnityMcpRequest request, BridgeAuthorizationResult authorization)
        {
            return JsonRpcUtil.Error(request, -32010, authorization.Message, new JObject
            {
                ["code"] = authorization.Code,
                ["projectId"] = ProjectId,
                ["editorInstanceId"] = EditorInstanceId,
                ["outcomeUnknown"] = false
            });
        }

        public static void WriteIdentity(int port, int webSocketPort, bool running)
        {
            var value = new JObject
            {
                ["schemaVersion"] = 1,
                ["projectId"] = ProjectId,
                ["editorInstanceId"] = EditorInstanceId,
                ["projectRoot"] = ProjectPathPolicy.ProjectRoot,
                ["port"] = port,
                ["webSocketPort"] = webSocketPort,
                ["host"] = UnityMcpGhostConfig.DefaultHost,
                ["path"] = UnityMcpGhostConfig.WebSocketPath,
                ["running"] = running,
                ["heartbeatUtc"] = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                ["packageVersion"] = UnityMcpGhostConfig.Version,
                ["unityVersion"] = Application.unityVersion,
                ["tokenFile"] = TokenPath,
                ["capabilities"] = new JObject
                {
                    ["destructive"] = Settings.AllowDestructive,
                    ["packageNetwork"] = Settings.AllowPackageNetwork,
                    ["arbitraryCode"] = Settings.AllowArbitraryCode,
                    ["reflection"] = Settings.AllowReflection
                }
            };
            Directory.CreateDirectory(StateRoot);
            WriteAtomic(IdentityPath, value.ToString(Formatting.Indented));

            var registryDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "UnityMcpGhost",
                "editors",
                ProjectId);
            Directory.CreateDirectory(registryDirectory);
            WriteAtomic(Path.Combine(registryDirectory, EditorInstanceId + ".json"), value.ToString(Formatting.Indented));
        }

        internal static BridgeAuthorizationResult AuthorizeCapability(string method, string parametersJson, BridgeSettings activeSettings)
        {
            var dryRun = JsonRpcUtil.ReadBool(parametersJson, "dryRun", false);
            if (string.Equals(method, "batch.execute", StringComparison.Ordinal))
            {
                foreach (var item in JsonRpcUtil.ReadObjectArray(parametersJson, "operations"))
                {
                    var nestedMethod = JsonRpcUtil.ReadString(item, "method", string.Empty);
                    var nestedParams = JsonRpcUtil.ReadObject(item, "params");
                    if (dryRun)
                    {
                        nestedParams = JsonRpcUtil.AddBoolProperty(nestedParams, "dryRun", true);
                    }
                    var nested = AuthorizeCapability(nestedMethod, nestedParams, activeSettings);
                    if (!nested.Allowed)
                    {
                        return nested;
                    }
                }
                return BridgeAuthorizationResult.Allow();
            }

            if (!dryRun && IsDestructive(method) && !activeSettings.AllowDestructive)
            {
                return BridgeAuthorizationResult.Deny("DESTRUCTIVE_CAPABILITY_DISABLED", "Destructive bridge operations are disabled for this project.");
            }
            if (RequiresPackageCapability(method) && !dryRun && !activeSettings.AllowPackageNetwork)
            {
                return BridgeAuthorizationResult.Deny("PACKAGE_NETWORK_CAPABILITY_DISABLED", "Package and external-network operations are disabled for this project.");
            }
            if (string.Equals(method, "package.add", StringComparison.Ordinal) && !dryRun)
            {
                var packageId = JsonRpcUtil.ReadString(parametersJson, "packageId", string.Empty);
                var allowed = (activeSettings.PackageSourceAllowlist ?? Array.Empty<string>())
                    .Any(prefix => packageId.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
                if (!allowed)
                {
                    return BridgeAuthorizationResult.Deny("PACKAGE_SOURCE_NOT_ALLOWED", "The package source is not on this project's explicit allowlist.");
                }
            }
            if (IsArbitraryCode(method) && !activeSettings.AllowArbitraryCode)
            {
                return BridgeAuthorizationResult.Deny("ARBITRARY_CODE_CAPABILITY_DISABLED", "Arbitrary code execution is disabled for this project.");
            }
            if (IsReflection(method) && !activeSettings.AllowReflection)
            {
                return BridgeAuthorizationResult.Deny("REFLECTION_CAPABILITY_DISABLED", "Reflection operations are disabled for this project.");
            }
            return BridgeAuthorizationResult.Allow();
        }

        private static bool IsDestructive(string method)
        {
            return method == "asset.delete"
                || method == "component.remove"
                || method == "gameobject.delete"
                || method == "script.delete"
                || method == "package.remove"
                || method == "screenshot.baselines_cleanup";
        }

        private static bool RequiresPackageCapability(string method)
        {
            return method == "package.search" || method == "package.add" || method == "package.remove";
        }

        private static bool IsArbitraryCode(string method)
        {
            return method == "script.execute" || method == "editor.execute" || method.StartsWith("arbitrary_code.", StringComparison.Ordinal);
        }

        private static bool IsReflection(string method)
        {
            return method.StartsWith("reflection.", StringComparison.Ordinal);
        }

        private static BridgeSettings LoadSettings()
        {
            Directory.CreateDirectory(StateRoot);
            if (!File.Exists(SettingsPath))
            {
                var defaults = BridgeSettings.CreateDefault(DeterministicPort);
                WriteAtomic(SettingsPath, JsonConvert.SerializeObject(defaults, Formatting.Indented));
                return defaults;
            }

            try
            {
                var loaded = JsonConvert.DeserializeObject<BridgeSettings>(File.ReadAllText(SettingsPath));
                if (loaded == null || loaded.Port < 1024 || loaded.Port > 65535)
                {
                    throw new InvalidDataException("Bridge settings contain an invalid port.");
                }
                if (loaded.WebSocketPort == 0)
                {
                    loaded.WebSocketPort = DeterministicWebSocketPort;
                    WriteAtomic(SettingsPath, JsonConvert.SerializeObject(loaded, Formatting.Indented));
                }
                if (loaded.WebSocketPort < 1024 || loaded.WebSocketPort > 65535 || loaded.WebSocketPort == loaded.Port)
                {
                    throw new InvalidDataException("Bridge settings contain an invalid WebSocket port.");
                }
                loaded.PackageSourceAllowlist = loaded.PackageSourceAllowlist ?? Array.Empty<string>();
                return loaded;
            }
            catch (Exception exception)
            {
                throw new InvalidDataException("Could not load secure bridge settings from " + SettingsPath + ": " + exception.Message, exception);
            }
        }

        private static string LoadOrCreateToken()
        {
            Directory.CreateDirectory(StateRoot);
            if (File.Exists(TokenPath))
            {
                CleanupTokenTemporaryFiles();
                return ReadValidToken();
            }

            var bytes = new byte[32];
            using (var random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            var created = BytesToHex(bytes);
            var temporaryPath = TokenPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(created);
                writer.Flush();
                stream.Flush(true);
            }
            RestrictTokenPermissions(temporaryPath);
            try
            {
                File.Move(temporaryPath, TokenPath);
            }
            catch (IOException)
            {
                File.Delete(temporaryPath);
            }
            RestrictTokenPermissions(TokenPath);
            CleanupTokenTemporaryFiles();
            return ReadValidToken();
        }

        private static void CleanupTokenTemporaryFiles()
        {
            foreach (var path in Directory.GetFiles(StateRoot, "bridge-token.txt.*.tmp", SearchOption.TopDirectoryOnly))
            {
                File.Delete(path);
            }
        }

        private static string ReadValidToken()
        {
            var value = File.ReadAllText(TokenPath).Trim();
            if (value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
            {
                throw new InvalidDataException("The Unity MCP bridge token file is malformed; refusing to replace or use it: " + TokenPath);
            }
            return value.ToLowerInvariant();
        }

        private static void RestrictTokenPermissions(string path)
        {
#if UNITY_EDITOR_WIN
            var identity = string.IsNullOrWhiteSpace(Environment.UserDomainName)
                ? Environment.UserName
                : Environment.UserDomainName + "\\" + Environment.UserName;
            if (string.IsNullOrWhiteSpace(identity) || identity.IndexOf('"') >= 0)
            {
                throw new InvalidOperationException("Could not determine a safe Windows identity for bridge-token ACLs.");
            }
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "icacls.exe"),
                Arguments = QuoteProcessArgument(path) + " /inheritance:r /grant:r " + QuoteProcessArgument(identity + ":(F)"),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                if (process == null || !process.WaitForExit(10000) || process.ExitCode != 0)
                {
                    if (process != null && !process.HasExited)
                    {
                        process.Kill();
                    }
                    throw new InvalidOperationException("Could not set user-only permissions on the Unity MCP bridge token.");
                }
            }
#elif UNITY_EDITOR_OSX || UNITY_EDITOR_LINUX
            if (chmod(path, Convert.ToUInt32("600", 8)) != 0)
            {
                throw new InvalidOperationException("Could not set user-only permissions on the Unity MCP bridge token.");
            }
#endif
        }

        private static string QuoteProcessArgument(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }

#if UNITY_EDITOR_OSX || UNITY_EDITOR_LINUX
        [DllImport("libc", SetLastError = true)]
        private static extern int chmod(string pathname, uint mode);
#endif

        private static string ProofPayload(UnityMcpRequest request)
        {
            return (request.Id ?? string.Empty) + "\n"
                + (request.Method ?? string.Empty) + "\n"
                + request.DeadlineUnixMs.ToString(CultureInfo.InvariantCulture) + "\n"
                + (request.IdempotencyKey ?? string.Empty) + "\n"
                + (request.ProjectId ?? string.Empty) + "\n"
                + (request.EditorInstanceId ?? string.Empty);
        }

        private static bool FixedTimeEquals(string left, string right)
        {
            var leftBytes = Encoding.UTF8.GetBytes(left ?? string.Empty);
            var rightBytes = Encoding.UTF8.GetBytes(right ?? string.Empty);
            var difference = leftBytes.Length ^ rightBytes.Length;
            var length = Math.Max(leftBytes.Length, rightBytes.Length);
            for (var index = 0; index < length; index++)
            {
                var leftValue = index < leftBytes.Length ? leftBytes[index] : (byte)0;
                var rightValue = index < rightBytes.Length ? rightBytes[index] : (byte)0;
                difference |= leftValue ^ rightValue;
            }
            return difference == 0;
        }

        private static void EnsureInitialized()
        {
            if (string.IsNullOrEmpty(projectId))
            {
                InitializeOnMainThread();
            }
        }

        private static string NormalizeIdentityPath(string value)
        {
            var normalized = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Replace('\\', '/');
            return Application.platform == RuntimePlatform.WindowsEditor ? normalized.ToUpperInvariant() : normalized;
        }

        private static string Sha256Hex(string value)
        {
            using (var sha = SHA256.Create())
            {
                return BytesToHex(sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? string.Empty)));
            }
        }

        private static string BytesToHex(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (var value in bytes)
            {
                builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            }
            return builder.ToString();
        }

        private static byte[] HexToBytes(string value)
        {
            var bytes = new byte[value.Length / 2];
            for (var index = 0; index < bytes.Length; index++)
            {
                bytes[index] = byte.Parse(value.Substring(index * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            return bytes;
        }

        private static void WriteAtomic(string path, string contents)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporaryPath, contents ?? string.Empty, new UTF8Encoding(false));
            if (!File.Exists(path))
            {
                File.Move(temporaryPath, path);
                return;
            }
            try
            {
                File.Replace(temporaryPath, path, null);
            }
            catch (PlatformNotSupportedException)
            {
                File.Delete(path);
                File.Move(temporaryPath, path);
            }
            catch (IOException)
            {
                File.Delete(path);
                File.Move(temporaryPath, path);
            }
        }
    }

    [Serializable]
    internal sealed class BridgeSettings
    {
        public int Port;
        public int WebSocketPort;
        public bool AutoStart = true;
        public bool AllowDestructive;
        public bool AllowPackageNetwork;
        public bool AllowArbitraryCode;
        public bool AllowReflection;
        public string[] PackageSourceAllowlist = Array.Empty<string>();

        public static BridgeSettings CreateDefault(int port)
        {
            return new BridgeSettings
            {
                Port = port,
                WebSocketPort = BridgeSecurity.DeterministicWebSocketPort,
                AutoStart = true,
                AllowDestructive = false,
                AllowPackageNetwork = false,
                AllowArbitraryCode = false,
                AllowReflection = false,
                PackageSourceAllowlist = new[] { "com.unity." }
            };
        }

        public BridgeSettings Clone()
        {
            return new BridgeSettings
            {
                Port = Port,
                WebSocketPort = WebSocketPort,
                AutoStart = AutoStart,
                AllowDestructive = AllowDestructive,
                AllowPackageNetwork = AllowPackageNetwork,
                AllowArbitraryCode = AllowArbitraryCode,
                AllowReflection = AllowReflection,
                PackageSourceAllowlist = (PackageSourceAllowlist ?? Array.Empty<string>()).ToArray()
            };
        }
    }

    internal sealed class BridgeAuthorizationResult
    {
        public bool Allowed;
        public string Code;
        public string Message;

        public static BridgeAuthorizationResult Allow()
        {
            return new BridgeAuthorizationResult { Allowed = true, Code = string.Empty, Message = string.Empty };
        }

        public static BridgeAuthorizationResult Deny(string code, string message)
        {
            return new BridgeAuthorizationResult { Allowed = false, Code = code, Message = message };
        }
    }

    internal sealed class BridgeRateLimiter
    {
        private readonly object sync = new object();
        private readonly Queue<DateTime> requests = new Queue<DateTime>();
        private readonly int limit;
        private readonly TimeSpan window;

        public BridgeRateLimiter(int limit, TimeSpan window)
        {
            this.limit = Math.Max(1, limit);
            this.window = window <= TimeSpan.Zero ? TimeSpan.FromSeconds(1) : window;
        }

        public bool TryAcquire(DateTime utcNow)
        {
            lock (sync)
            {
                while (requests.Count > 0 && utcNow - requests.Peek() >= window)
                {
                    requests.Dequeue();
                }
                if (requests.Count >= limit)
                {
                    return false;
                }
                requests.Enqueue(utcNow);
                return true;
            }
        }
    }
}
