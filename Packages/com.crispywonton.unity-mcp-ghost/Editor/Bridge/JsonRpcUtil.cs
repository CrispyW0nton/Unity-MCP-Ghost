using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class JsonRpcUtil
    {
        public const int MaxRequestCharacters = 1024 * 1024;

        private static readonly JsonLoadSettings StrictLoadSettings = new JsonLoadSettings
        {
            CommentHandling = CommentHandling.Ignore,
            DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
            LineInfoHandling = LineInfoHandling.Load
        };

        public static UnityMcpRequest ParseRequest(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                throw new JsonRpcProtocolException(-32700, "Parse error: request body is empty.");
            }

            if (json.Length > MaxRequestCharacters)
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: request body exceeds the configured limit.");
            }

            JObject root;
            try
            {
                var token = JToken.Parse(json, StrictLoadSettings);
                root = token as JObject;
                if (root == null)
                {
                    throw new JsonRpcProtocolException(-32600, "Invalid request: the JSON-RPC envelope must be an object.");
                }
            }
            catch (JsonRpcProtocolException)
            {
                throw;
            }
            catch (JsonException exception)
            {
                throw new JsonRpcProtocolException(-32700, "Parse error: " + exception.Message);
            }

            var idToken = root["id"];
            var idJson = "null";
            var id = string.Empty;
            if (idToken != null && idToken.Type != JTokenType.Null)
            {
                if (idToken.Type != JTokenType.String && idToken.Type != JTokenType.Integer && idToken.Type != JTokenType.Float)
                {
                    throw new JsonRpcProtocolException(-32600, "Invalid request: id must be a string, number, or null.");
                }

                idJson = idToken.ToString(Formatting.None);
                id = idToken.Type == JTokenType.String ? idToken.Value<string>() : idJson;
            }

            var version = root["jsonrpc"];
            if (version == null || version.Type != JTokenType.String || !string.Equals(version.Value<string>(), "2.0", StringComparison.Ordinal))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: jsonrpc must be exactly '2.0'.", idJson);
            }

            var methodToken = root["method"];
            if (methodToken == null || methodToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(methodToken.Value<string>()))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: method must be a non-empty string.", idJson);
            }

            var paramsToken = root["params"];
            if (paramsToken != null && paramsToken.Type != JTokenType.Object && paramsToken.Type != JTokenType.Null)
            {
                throw new JsonRpcProtocolException(-32602, "Invalid params: Ghost operations require an object.", idJson);
            }

            var deadlineToken = root["deadlineUnixMs"];
            if (deadlineToken != null && deadlineToken.Type != JTokenType.Integer)
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: deadlineUnixMs must be an integer.", idJson);
            }
            if (deadlineToken != null && (deadlineToken.Value<long>() < 0 || deadlineToken.Value<long>() > 253402300799999L))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: deadlineUnixMs is outside the supported UTC range.", idJson);
            }
            var idempotencyToken = root["idempotencyKey"];
            if (idempotencyToken != null && (idempotencyToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(idempotencyToken.Value<string>()) || idempotencyToken.Value<string>().Length > 128))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: idempotencyKey must be a non-empty string of at most 128 characters.", idJson);
            }
            var idempotentToken = root["idempotent"];
            if (idempotentToken != null && idempotentToken.Type != JTokenType.Boolean)
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: idempotent must be a boolean.", idJson);
            }
            var requestIdToken = root["requestId"];
            if (requestIdToken != null && (requestIdToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(requestIdToken.Value<string>()) || requestIdToken.Value<string>().Length > 128))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: requestId must be a non-empty string of at most 128 characters.", idJson);
            }
            if (requestIdToken != null && !string.Equals(requestIdToken.Value<string>(), id, StringComparison.Ordinal))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: requestId must match the JSON-RPC id.", idJson);
            }
            var projectIdToken = ReadBoundedRootString(root, "projectId", 128, idJson);
            var editorInstanceIdToken = ReadBoundedRootString(root, "editorInstanceId", 128, idJson);
            var authProofToken = ReadBoundedRootString(root, "authProof", 128, idJson);

            return new UnityMcpRequest
            {
                Id = id,
                IdJson = idJson,
                Method = methodToken.Value<string>(),
                RawJson = paramsToken == null || paramsToken.Type == JTokenType.Null ? "{}" : paramsToken.ToString(Formatting.None),
                DeadlineUnixMs = deadlineToken != null ? deadlineToken.Value<long>() : 0,
                IdempotencyKey = idempotencyToken != null ? idempotencyToken.Value<string>() : id,
                ClientDeclaredIdempotent = idempotentToken != null && idempotentToken.Value<bool>(),
                ProjectId = projectIdToken != null ? projectIdToken.Value<string>() : string.Empty,
                EditorInstanceId = editorInstanceIdToken != null ? editorInstanceIdToken.Value<string>() : string.Empty,
                AuthProof = authProofToken != null ? authProofToken.Value<string>() : string.Empty
            };
        }

        private static JToken ReadBoundedRootString(JObject root, string name, int maxLength, string idJson)
        {
            var token = root[name];
            if (token != null && (token.Type != JTokenType.String || string.IsNullOrWhiteSpace(token.Value<string>()) || token.Value<string>().Length > maxLength))
            {
                throw new JsonRpcProtocolException(-32600, "Invalid request: " + name + " must be a non-empty string of at most " + maxLength + " characters.", idJson);
            }
            return token;
        }

        public static string Success(UnityMcpRequest request, string resultJson)
        {
            var response = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = ParseId(request != null ? request.IdJson : "null"),
                ["result"] = ParseResult(resultJson)
            };
            return response.ToString(Formatting.None);
        }

        public static string Error(UnityMcpRequest request, int code, string message)
        {
            return ErrorWithId(request != null ? request.IdJson : "null", code, message, null);
        }

        public static string Error(UnityMcpRequest request, int code, string message, JObject data)
        {
            return ErrorWithId(request != null ? request.IdJson : "null", code, message, data);
        }

        public static string Error(JsonRpcProtocolException exception)
        {
            return ErrorWithId(exception != null ? exception.IdJson : "null", exception != null ? exception.ErrorCode : -32600, exception != null ? exception.Message : "Invalid request.", null);
        }

        public static string Escape(string value)
        {
            var quoted = JsonConvert.ToString(value ?? string.Empty);
            return quoted.Length < 2 ? string.Empty : quoted.Substring(1, quoted.Length - 2);
        }

        public static string ReadString(string json, string key, string fallback)
        {
            var token = ReadProperty(json, key);
            return token != null && token.Type == JTokenType.String ? token.Value<string>() : fallback;
        }

        public static float ReadFloat(string json, string key, float fallback)
        {
            var token = ReadProperty(json, key);
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
            {
                return fallback;
            }

            try
            {
                return token.Value<float>();
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        public static int ReadInt(string json, string key, int fallback)
        {
            var token = ReadProperty(json, key);
            if (token == null || token.Type != JTokenType.Integer)
            {
                return fallback;
            }

            try
            {
                return token.Value<int>();
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        public static bool ReadBool(string json, string key, bool fallback)
        {
            var token = ReadProperty(json, key);
            return token != null && token.Type == JTokenType.Boolean ? token.Value<bool>() : fallback;
        }

        public static string ReadObject(string json, string key)
        {
            var token = ReadProperty(json, key);
            return token != null && token.Type == JTokenType.Object ? token.ToString(Formatting.None) : "{}";
        }

        public static List<string> ReadObjectArray(string json, string key)
        {
            var values = new List<string>();
            var token = ReadProperty(json, key) as JArray;
            if (token == null)
            {
                return values;
            }

            foreach (var item in token)
            {
                if (item.Type == JTokenType.Object)
                {
                    values.Add(item.ToString(Formatting.None));
                }
            }

            return values;
        }

        public static string AddBoolProperty(string objectJson, string key, bool value)
        {
            var root = ParseObject(objectJson);
            if (root.Property(key, StringComparison.Ordinal) == null)
            {
                root.Add(key, value);
            }

            return root.ToString(Formatting.None);
        }

        private static JToken ReadProperty(string json, string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return null;
            }

            var root = ParseObject(json);
            return root.Property(key, StringComparison.Ordinal)?.Value;
        }

        private static JObject ParseObject(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return new JObject();
            }

            var token = JToken.Parse(json, StrictLoadSettings);
            if (token is JObject root)
            {
                return root;
            }

            throw new JsonException("Expected a JSON object.");
        }

        private static JToken ParseId(string idJson)
        {
            if (string.IsNullOrWhiteSpace(idJson))
            {
                return JValue.CreateNull();
            }

            try
            {
                var token = JToken.Parse(idJson, StrictLoadSettings);
                return token.Type == JTokenType.String || token.Type == JTokenType.Integer || token.Type == JTokenType.Float || token.Type == JTokenType.Null
                    ? token
                    : JValue.CreateNull();
            }
            catch (JsonException)
            {
                return JValue.CreateNull();
            }
        }

        private static JToken ParseResult(string resultJson)
        {
            if (string.IsNullOrWhiteSpace(resultJson))
            {
                return JValue.CreateNull();
            }

            return JToken.Parse(resultJson, StrictLoadSettings);
        }

        private static string ErrorWithId(string idJson, int code, string message, JObject data)
        {
            var error = new JObject
            {
                ["code"] = code,
                ["message"] = message ?? string.Empty
            };
            if (data != null)
            {
                error["data"] = data;
            }
            var response = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = ParseId(idJson),
                ["error"] = error
            };
            return response.ToString(Formatting.None);
        }
    }

    internal sealed class UnityMcpRequest
    {
        public string Id = string.Empty;
        public string IdJson = "null";
        public string Method = string.Empty;
        public string RawJson = "{}";
        public long DeadlineUnixMs;
        public string IdempotencyKey = string.Empty;
        public bool ClientDeclaredIdempotent;
        public string ProjectId = string.Empty;
        public string EditorInstanceId = string.Empty;
        public string AuthProof = string.Empty;
    }

    internal sealed class JsonRpcProtocolException : Exception
    {
        public JsonRpcProtocolException(int errorCode, string message, string idJson = "null")
            : base(message)
        {
            ErrorCode = errorCode;
            IdJson = string.IsNullOrWhiteSpace(idJson) ? "null" : idJson;
        }

        public int ErrorCode { get; }
        public string IdJson { get; }
    }
}
