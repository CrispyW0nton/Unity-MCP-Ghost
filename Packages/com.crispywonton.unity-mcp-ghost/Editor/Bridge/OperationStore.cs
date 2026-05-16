using System;
using System.Collections.Generic;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class OperationStore
    {
        private sealed class Operation
        {
            public string Kind;
            public string Label;
            public Func<string> ReadJson;
        }

        private static readonly Dictionary<string, Operation> Operations = new Dictionary<string, Operation>();

        public static string Register(string kind, string label, Func<string> readJson)
        {
            var id = Guid.NewGuid().ToString("N");
            Register(id, kind, label, readJson);
            return id;
        }

        public static void Register(string id, string kind, string label, Func<string> readJson)
        {
            Operations[id] = new Operation
            {
                Kind = kind,
                Label = label,
                ReadJson = readJson
            };
        }

        public static string Read(string id)
        {
            if (string.IsNullOrEmpty(id) || !Operations.TryGetValue(id, out var operation))
            {
                throw new InvalidOperationException("Unknown Ghost operation: " + id);
            }

            return "{\"ok\":true,\"operationId\":\"" + JsonRpcUtil.Escape(id) + "\",\"kind\":\"" + JsonRpcUtil.Escape(operation.Kind) + "\",\"label\":\"" + JsonRpcUtil.Escape(operation.Label) + "\",\"state\":" + operation.ReadJson() + "}";
        }

        public static string List()
        {
            var first = true;
            var builder = new System.Text.StringBuilder();
            builder.Append("{\"ok\":true,\"operations\":[");
            foreach (var entry in Operations)
            {
                if (!first)
                {
                    builder.Append(",");
                }

                first = false;
                builder.Append("{\"operationId\":\"");
                builder.Append(JsonRpcUtil.Escape(entry.Key));
                builder.Append("\",\"kind\":\"");
                builder.Append(JsonRpcUtil.Escape(entry.Value.Kind));
                builder.Append("\",\"label\":\"");
                builder.Append(JsonRpcUtil.Escape(entry.Value.Label));
                builder.Append("\"}");
            }

            builder.Append("]}");
            return builder.ToString();
        }
    }
}
