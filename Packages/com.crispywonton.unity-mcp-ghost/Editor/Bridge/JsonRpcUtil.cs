using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class JsonRpcUtil
    {
        private static readonly Regex IdRegex = new Regex("\"id\"\\s*:\\s*\"(?<value>[^\"]*)\"", RegexOptions.Compiled);
        private static readonly Regex MethodRegex = new Regex("\"method\"\\s*:\\s*\"(?<value>[^\"]*)\"", RegexOptions.Compiled);

        public static UnityMcpRequest ParseRequest(string json)
        {
            return new UnityMcpRequest
            {
                Id = MatchValue(IdRegex, json),
                Method = MatchValue(MethodRegex, json),
                RawJson = json
            };
        }

        public static string Success(string id, string resultJson)
        {
            return "{\"jsonrpc\":\"2.0\",\"id\":\"" + Escape(id) + "\",\"result\":" + resultJson + "}";
        }

        public static string Error(string id, int code, string message)
        {
            return "{\"jsonrpc\":\"2.0\",\"id\":\"" + Escape(id) + "\",\"error\":{\"code\":" + code + ",\"message\":\"" + Escape(message) + "\"}}";
        }

        public static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(value.Length + 8);
            foreach (var character in value)
            {
                switch (character)
                {
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        builder.Append(character);
                        break;
                }
            }

            return builder.ToString();
        }

        public static string ReadString(string json, string key, string fallback)
        {
            return TryReadString(json, key, out var value) ? value : fallback;
        }

        public static float ReadFloat(string json, string key, float fallback)
        {
            var regex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*(?<value>-?[0-9]+(?:\\.[0-9]+)?)");
            var match = regex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return fallback;
            }

            return float.TryParse(match.Groups["value"].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : fallback;
        }

        public static int ReadInt(string json, string key, int fallback)
        {
            var regex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*(?<value>-?[0-9]+)");
            var match = regex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return fallback;
            }

            return int.TryParse(match.Groups["value"].Value, out var value) ? value : fallback;
        }

        public static bool ReadBool(string json, string key, bool fallback)
        {
            var regex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*(?<value>true|false)", RegexOptions.IgnoreCase);
            var match = regex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return fallback;
            }

            return string.Equals(match.Groups["value"].Value, "true", StringComparison.OrdinalIgnoreCase);
        }

        public static string ReadObject(string json, string key)
        {
            var keyRegex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:");
            var match = keyRegex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return "{}";
            }

            var start = json.IndexOf('{', match.Index + match.Length);
            return start < 0 ? "{}" : ReadBalancedObject(json, start);
        }

        public static List<string> ReadObjectArray(string json, string key)
        {
            var values = new List<string>();
            var keyRegex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:");
            var match = keyRegex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return values;
            }

            var arrayStart = json.IndexOf('[', match.Index + match.Length);
            if (arrayStart < 0)
            {
                return values;
            }

            var depth = 0;
            var inString = false;
            var escaped = false;
            var objectStart = -1;

            for (var index = arrayStart + 1; index < json.Length; index++)
            {
                var character = json[index];

                if (inString)
                {
                    if (escaped)
                    {
                        escaped = false;
                    }
                    else if (character == '\\')
                    {
                        escaped = true;
                    }
                    else if (character == '"')
                    {
                        inString = false;
                    }

                    continue;
                }

                if (character == '"')
                {
                    inString = true;
                    continue;
                }

                if (character == '[' && depth == 0)
                {
                    continue;
                }

                if (character == ']' && depth == 0)
                {
                    break;
                }

                if (character == '{')
                {
                    if (depth == 0)
                    {
                        objectStart = index;
                    }

                    depth++;
                    continue;
                }

                if (character == '}')
                {
                    depth--;
                    if (depth == 0 && objectStart >= 0)
                    {
                        values.Add(json.Substring(objectStart, index - objectStart + 1));
                        objectStart = -1;
                    }
                }
            }

            return values;
        }

        public static string AddBoolProperty(string objectJson, string key, bool value)
        {
            var trimmed = string.IsNullOrWhiteSpace(objectJson) ? "{}" : objectJson.Trim();
            if (trimmed.Contains("\"" + key + "\""))
            {
                return trimmed;
            }

            if (trimmed == "{}")
            {
                return "{\"" + Escape(key) + "\":" + (value ? "true" : "false") + "}";
            }

            return trimmed.Substring(0, trimmed.Length - 1) + ",\"" + Escape(key) + "\":" + (value ? "true" : "false") + "}";
        }

        private static string MatchValue(Regex regex, string json)
        {
            var match = regex.Match(json ?? string.Empty);
            return match.Success ? match.Groups["value"].Value : string.Empty;
        }

        private static bool TryReadString(string json, string key, out string value)
        {
            value = string.Empty;
            var keyRegex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:");
            var match = keyRegex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return false;
            }

            var start = json.IndexOf('"', match.Index + match.Length);
            if (start < 0)
            {
                return false;
            }

            var builder = new StringBuilder();
            var escaped = false;
            for (var index = start + 1; index < json.Length; index++)
            {
                var character = json[index];
                if (escaped)
                {
                    switch (character)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            builder.Append(character);
                            break;
                        case 'n':
                            builder.Append('\n');
                            break;
                        case 'r':
                            builder.Append('\r');
                            break;
                        case 't':
                            builder.Append('\t');
                            break;
                        default:
                            builder.Append(character);
                            break;
                    }

                    escaped = false;
                    continue;
                }

                if (character == '\\')
                {
                    escaped = true;
                    continue;
                }

                if (character == '"')
                {
                    value = builder.ToString();
                    return true;
                }

                builder.Append(character);
            }

            return false;
        }

        private static string ReadBalancedObject(string json, int start)
        {
            var depth = 0;
            var inString = false;
            var escaped = false;

            for (var index = start; index < json.Length; index++)
            {
                var character = json[index];

                if (inString)
                {
                    if (escaped)
                    {
                        escaped = false;
                    }
                    else if (character == '\\')
                    {
                        escaped = true;
                    }
                    else if (character == '"')
                    {
                        inString = false;
                    }

                    continue;
                }

                if (character == '"')
                {
                    inString = true;
                    continue;
                }

                if (character == '{')
                {
                    depth++;
                }
                else if (character == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return json.Substring(start, index - start + 1);
                    }
                }
            }

            return "{}";
        }
    }

    internal sealed class UnityMcpRequest
    {
        public string Id;
        public string Method;
        public string RawJson;
    }
}
