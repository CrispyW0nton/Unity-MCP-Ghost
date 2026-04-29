using System;
using System.Collections.Generic;
using UnityEditor;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class MainThreadDispatcher
    {
        private static readonly Queue<Action> Work = new Queue<Action>();

        static MainThreadDispatcher()
        {
            EditorApplication.update -= Drain;
            EditorApplication.update += Drain;
        }

        public static void Enqueue(Action action)
        {
            lock (Work)
            {
                Work.Enqueue(action);
            }
        }

        private static void Drain()
        {
            while (true)
            {
                Action action;
                lock (Work)
                {
                    if (Work.Count == 0)
                    {
                        return;
                    }

                    action = Work.Dequeue();
                }

                action();
            }
        }
    }
}
