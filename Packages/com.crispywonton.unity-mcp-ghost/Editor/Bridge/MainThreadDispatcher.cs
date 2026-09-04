using System;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEditor;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal static class MainThreadDispatcher
    {
        internal const int MaxPendingItems = 256;
        internal const int MaxItemsPerUpdate = 16;
        internal const double MaxMillisecondsPerUpdate = 8d;

        private static readonly Queue<DispatchItem> Work = new Queue<DispatchItem>();

        static MainThreadDispatcher()
        {
            EditorApplication.update -= Drain;
            EditorApplication.update += Drain;
        }

        public static void Enqueue(Action action)
        {
            if (!TryEnqueue(action, null, null, null))
            {
                throw new InvalidOperationException("Unity MCP main-thread dispatcher is at capacity.");
            }
        }

        public static bool TryEnqueue(Action action, DateTime? deadlineUtc, Action onExpired, Action<Exception> onError)
        {
            if (action == null)
            {
                throw new ArgumentNullException(nameof(action));
            }
            lock (Work)
            {
                if (Work.Count >= MaxPendingItems)
                {
                    return false;
                }
                Work.Enqueue(new DispatchItem
                {
                    Action = action,
                    DeadlineUtc = deadlineUtc,
                    OnExpired = onExpired,
                    OnError = onError
                });
                return true;
            }
        }

        private static void Drain()
        {
            DrainBudget(MaxItemsPerUpdate, MaxMillisecondsPerUpdate, DateTime.UtcNow);
        }

        internal static int DrainBudget(int maxItems, double maxMilliseconds, DateTime nowUtc)
        {
            var completed = 0;
            var stopwatch = Stopwatch.StartNew();
            while (completed < Math.Max(1, maxItems) && stopwatch.Elapsed.TotalMilliseconds < Math.Max(0.1d, maxMilliseconds))
            {
                DispatchItem item;
                lock (Work)
                {
                    if (Work.Count == 0)
                    {
                        return completed;
                    }

                    item = Work.Dequeue();
                }

                try
                {
                    if (item.DeadlineUtc.HasValue && nowUtc > item.DeadlineUtc.Value)
                    {
                        item.OnExpired?.Invoke();
                    }
                    else
                    {
                        item.Action();
                    }
                }
                catch (Exception exception)
                {
                    item.OnError?.Invoke(exception);
                }
                completed++;
            }
            return completed;
        }

        internal static int PendingCount
        {
            get
            {
                lock (Work)
                {
                    return Work.Count;
                }
            }
        }

        internal static void ClearForTests()
        {
            lock (Work)
            {
                Work.Clear();
            }
        }

        private sealed class DispatchItem
        {
            public Action Action;
            public DateTime? DeadlineUtc;
            public Action OnExpired;
            public Action<Exception> OnError;
        }
    }
}
