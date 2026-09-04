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

            return new UnityMcpRequest
            {
                Id = id,
                IdJson = idJson,
                Method = methodToken.Value<string>(),
                RawJson = paramsToken == null || paramsToken.Type == JTokenType.Null ? "{}" : paramsToken.ToString(Formatting.None)
            };
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
            return ErrorWithId(request != null ? request.IdJson : "null", code, message);
        }

        public static string Error(JsonRpcProtocolException exception)
        {
            return ErrorWithId(exception != null ? exception.IdJson : "null", exception != null ? exception.ErrorCode : -32600, exception != null ? exception.Message : "Invalid request.");
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

        private static string ErrorWithId(string idJson, int code, string message)
        {
            var response = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = ParseId(idJson),
                ["error"] = new JObject
                {
                    ["code"] = code,
                    ["message"] = message ?? string.Empty
                }
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
