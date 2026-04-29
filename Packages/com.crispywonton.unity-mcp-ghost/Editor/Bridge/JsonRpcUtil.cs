using System;
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
            var regex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*\"(?<value>[^\"]*)\"");
            var match = regex.Match(json ?? string.Empty);
            return match.Success ? match.Groups["value"].Value : fallback;
        }

        public static float ReadFloat(string json, string key, float fallback)
        {
            var regex = new Regex("\"" + Regex.Escape(key) + "\"\\s*:\\s*(?<value>-?[0-9]+(?:\\.[0-9]+)?)");
            var match = regex.Match(json ?? string.Empty);
            if (!match.Success)
            {
                return fallback;
            }

            return float.TryParse(match.Groups["value"].Value, out var value) ? value : fallback;
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

        private static string MatchValue(Regex regex, string json)
        {
            var match = regex.Match(json ?? string.Empty);
            return match.Success ? match.Groups["value"].Value : string.Empty;
        }
    }

    internal sealed class UnityMcpRequest
    {
        public string Id;
        public string Method;
        public string RawJson;
    }
}
