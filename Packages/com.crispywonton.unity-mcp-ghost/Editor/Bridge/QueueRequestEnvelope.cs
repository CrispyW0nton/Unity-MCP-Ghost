using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class QueueRequestEnvelope
    {
        public const int MaxRequestBytes = 1024 * 1024;
        public const int MaxEnvelopeBytes = 6 * MaxRequestBytes + 1024;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly byte[] ProofDomain = Encoding.UTF8.GetBytes("UnityMcpGhost.Queue.v2\0");
        private static readonly JsonLoadSettings StrictLoadSettings = new JsonLoadSettings
        {
            DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error
        };

        public static string ReadAuthenticatedRequest(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                return Decode(stream, BridgeSecurity.Token);
            }
        }

        // Only the bounded outer envelope is parsed here. The inner JSON-RPC string
        // must remain byte-exact until authentication has succeeded.
        internal static string Decode(Stream stream, string token)
        {
            string envelopeJson;
            using (var buffer = new MemoryStream())
            {
                var chunk = new byte[4096];
                int count;
                while ((count = stream.Read(chunk, 0, Math.Min(chunk.Length, MaxEnvelopeBytes + 1 - (int)buffer.Length))) > 0)
                {
                    if (buffer.Length + count > MaxEnvelopeBytes)
                    {
                        throw Failure("QUEUE_ENVELOPE_TOO_LARGE");
                    }
                    buffer.Write(chunk, 0, count);
                }
                try
                {
                    envelopeJson = StrictUtf8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
                }
                catch (DecoderFallbackException)
                {
                    throw Failure("INVALID_UTF8");
                }
            }

            JObject envelope;
            try
            {
                using (var reader = new JsonTextReader(new StringReader(envelopeJson)) { DateParseHandling = DateParseHandling.None, MaxDepth = 4 })
                {
                    envelope = JObject.Load(reader, StrictLoadSettings);
                    if (reader.Read())
                    {
                        throw Failure("QUEUE_ENVELOPE_INVALID");
                    }
                }
            }
            catch (JsonException)
            {
                throw Failure("QUEUE_ENVELOPE_INVALID");
            }

            var version = envelope["authProofVersion"];
            if (version == null || version.Type != JTokenType.Integer || version.ToString() != "2")
            {
                throw Failure("QUEUE_PROOF_VERSION_UNSUPPORTED");
            }
            foreach (var property in envelope.Properties())
            {
                if (property.Name != "authProofVersion" && property.Name != "requestJson" && property.Name != "authProof")
                {
                    throw Failure("QUEUE_ENVELOPE_INVALID");
                }
            }
            var request = envelope["requestJson"];
            if (request == null || request.Type != JTokenType.String)
            {
                throw Failure("QUEUE_ENVELOPE_INVALID");
            }
            var proof = envelope["authProof"];
            if (proof == null || proof.Type != JTokenType.String || !IsLowerHex64(proof.Value<string>()) || !IsLowerHex64(token))
            {
                throw Failure("AUTHENTICATION_FAILED");
            }

            var requestJson = request.Value<string>();
            byte[] requestBytes;
            try
            {
                if (StrictUtf8.GetByteCount(requestJson) > MaxRequestBytes)
                {
                    throw Failure("REQUEST_TOO_LARGE");
                }
                requestBytes = StrictUtf8.GetBytes(requestJson);
            }
            catch (EncoderFallbackException)
            {
                throw Failure("INVALID_UTF8");
            }

            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token)))
            {
                hmac.TransformBlock(ProofDomain, 0, ProofDomain.Length, null, 0);
                hmac.TransformFinalBlock(requestBytes, 0, requestBytes.Length);
                var expected = BridgeSecurity.BytesToHex(hmac.Hash);
                if (!BridgeSecurity.FixedTimeEquals(proof.Value<string>(), expected))
                {
                    throw Failure("AUTHENTICATION_FAILED");
                }
            }
            return requestJson;
        }

        private static bool IsLowerHex64(string value)
        {
            if (value == null || value.Length != 64) return false;
            foreach (var character in value)
            {
                if (!(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f')) return false;
            }
            return true;
        }

        private static QueueRequestEnvelopeException Failure(string code)
        {
            switch (code)
            {
                case "AUTHENTICATION_FAILED": return new QueueRequestEnvelopeException(code, "The durable queue request proof is missing or invalid.");
                case "QUEUE_PROOF_VERSION_UNSUPPORTED": return new QueueRequestEnvelopeException(code, "The durable queue requires a version 2 authenticated envelope.");
                case "REQUEST_TOO_LARGE": return new QueueRequestEnvelopeException(code, "The durable queue request exceeds its UTF-8 byte limit.");
                case "QUEUE_ENVELOPE_TOO_LARGE": return new QueueRequestEnvelopeException(code, "The durable queue envelope exceeds its UTF-8 byte limit.");
                case "INVALID_UTF8": return new QueueRequestEnvelopeException(code, "The durable queue request contains invalid Unicode.");
                default: return new QueueRequestEnvelopeException(code, "The durable queue envelope is invalid.");
            }
        }
    }

    internal sealed class QueueRequestEnvelopeException : Exception
    {
        public QueueRequestEnvelopeException(string code, string message) : base(message) { Code = code; }
        public string Code { get; }
    }
}
