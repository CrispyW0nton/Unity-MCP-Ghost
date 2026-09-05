using System;
using System.IO;
using System.Text;
using System.Threading;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class AtomicStateFile
    {
        private const int MaxReplacementAttempts = 4;
        internal static Action<string, string> ReplaceOverrideForTests;

        public static void WriteAllText(string path, string contents)
        {
            path = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            var ownsTemporaryFile = false;
            try
            {
                var bytes = new UTF8Encoding(false).GetBytes(contents ?? string.Empty);
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    ownsTemporaryFile = true;
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(path))
                {
                    for (var attempt = 0; ; attempt++)
                    {
                        try
                        {
                            if (ReplaceOverrideForTests != null) ReplaceOverrideForTests(temporaryPath, path);
                            else File.Replace(temporaryPath, path, null);
                            break;
                        }
                        catch (IOException) when (attempt + 1 < MaxReplacementAttempts && File.Exists(temporaryPath) && File.Exists(path))
                        {
                            // Sharing contention is transient; retry only the same prepared
                            // replacement, never a Unity command or destructive fallback.
                            Thread.Sleep(5 << attempt);
                        }
                    }
                }
                else
                {
                    File.Move(temporaryPath, path);
                }
            }
            catch (Exception writeFailure)
            {
                // Never delete the destination to make replacement succeed: it may be
                // the only durable receipt preventing a non-idempotent mutation replay.
                if (ownsTemporaryFile)
                {
                    try { File.Delete(temporaryPath); }
                    catch (Exception cleanupFailure)
                    {
                        throw new AggregateException("Atomic state write failed and temporary-file cleanup was incomplete.", writeFailure, cleanupFailure);
                    }
                }
                throw;
            }
        }
    }
}
