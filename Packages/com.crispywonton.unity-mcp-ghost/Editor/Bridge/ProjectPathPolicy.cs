using System;
using System.IO;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class ProjectPathPolicy
    {
        private static readonly string AssetsRootValue = Path.GetFullPath(Application.dataPath);
        private static readonly string ProjectRootValue = Path.GetFullPath(Path.Combine(AssetsRootValue, ".."));
        private static readonly bool CaseInsensitiveFileSystem = Application.platform == RuntimePlatform.WindowsEditor
            || Application.platform == RuntimePlatform.OSXEditor;

        public static string ProjectRoot => ProjectRootValue;
        public static string AssetsRoot => AssetsRootValue;

        public static void InitializeOnMainThread()
        {
            // Force Unity-dependent values to be captured before transport workers start.
            var unused = ProjectRootValue;
        }

        public static string NormalizeAssetPath(string path)
        {
            var input = (path ?? string.Empty).Trim().Replace('\\', '/');
            if (!string.Equals(input, "Assets", StringComparison.Ordinal) && !input.StartsWith("Assets/", StringComparison.Ordinal))
            {
                throw new ProjectPathException("PATH_OUTSIDE_ASSETS", "Asset paths must be under the selected project's Assets root: " + path);
            }

            if (Path.IsPathRooted(input))
            {
                throw new ProjectPathException("ABSOLUTE_ASSET_PATH_FORBIDDEN", "Asset paths must be project-relative: " + path);
            }

            var relative = input.Substring("Assets".Length).TrimStart('/');
            var candidate = Path.GetFullPath(Path.Combine(AssetsRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
            EnsureContained(candidate, AssetsRoot, "PATH_OUTSIDE_ASSETS");
            EnsureNoReparsePoints(candidate, AssetsRoot);
            var canonicalRelative = candidate.Length == AssetsRoot.Length
                ? string.Empty
                : candidate.Substring(AssetsRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.IsNullOrEmpty(canonicalRelative) ? "Assets" : "Assets/" + canonicalRelative.Replace('\\', '/');
        }

        public static string FullAssetPath(string assetPath)
        {
            var normalized = NormalizeAssetPath(assetPath);
            var relative = normalized.Substring("Assets".Length).TrimStart('/');
            var candidate = Path.GetFullPath(Path.Combine(AssetsRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
            EnsureContained(candidate, AssetsRoot, "PATH_OUTSIDE_ASSETS");
            EnsureNoReparsePoints(candidate, AssetsRoot);
            return candidate;
        }

        public static string RequireUnderProjectRoot(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ProjectPathException("PROJECT_PATH_REQUIRED", "A project path is required.");
            }

            var candidate = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(ProjectRoot, path));
            EnsureContained(candidate, ProjectRoot, "PATH_OUTSIDE_PROJECT");
            EnsureNoReparsePoints(candidate, ProjectRoot);
            return candidate;
        }

        private static void EnsureContained(string candidate, string root, string code)
        {
            var comparison = IsCaseInsensitiveFileSystem ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!string.Equals(normalizedCandidate, normalizedRoot, comparison)
                && !normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, comparison))
            {
                throw new ProjectPathException(code, "Resolved path escapes the selected Unity project boundary: " + candidate);
            }
        }

        private static void EnsureNoReparsePoints(string candidate, string root)
        {
            var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var current = Path.GetFullPath(candidate);
            while (!string.IsNullOrEmpty(current) && current.Length >= normalizedRoot.Length)
            {
                if (File.Exists(current) || Directory.Exists(current))
                {
                    var attributes = File.GetAttributes(current);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        throw new ProjectPathException("REPARSE_POINT_FORBIDDEN", "Symlink or junction traversal is not allowed for Unity MCP project paths: " + current);
                    }
                }

                if (string.Equals(current.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), normalizedRoot, IsCaseInsensitiveFileSystem ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                {
                    break;
                }
                current = Path.GetDirectoryName(current);
            }
        }

        private static bool IsCaseInsensitiveFileSystem => CaseInsensitiveFileSystem;
    }

    internal sealed class ProjectPathException : Exception
    {
        public ProjectPathException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; }
    }
}
