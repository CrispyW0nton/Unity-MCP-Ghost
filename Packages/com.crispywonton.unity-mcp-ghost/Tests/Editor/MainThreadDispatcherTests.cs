using System;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class MainThreadDispatcherTests
    {
        [TearDown]
        public void TearDown()
        {
            MainThreadDispatcher.ClearForTests();
        }

        [Test]
        public void RejectsWorkAfterBoundedCapacity()
        {
            for (var index = 0; index < MainThreadDispatcher.MaxPendingItems; index++)
            {
                Assert.That(MainThreadDispatcher.TryEnqueue(() => { }, null, null, null), Is.True);
            }

            Assert.That(MainThreadDispatcher.TryEnqueue(() => { }, null, null, null), Is.False);
        }

        [Test]
        public void DrainsOnlyTheConfiguredItemBudget()
        {
            var executed = 0;
            for (var index = 0; index < 10; index++)
            {
                MainThreadDispatcher.TryEnqueue(() => executed++, null, null, null);
            }

            var drained = MainThreadDispatcher.DrainBudget(3, 1000, DateTime.UtcNow);

            Assert.That(drained, Is.EqualTo(3));
            Assert.That(executed, Is.EqualTo(3));
            Assert.That(MainThreadDispatcher.PendingCount, Is.EqualTo(7));
        }

        [Test]
        public void ExpiredWorkNeverRunsItsMutation()
        {
            var executed = false;
            var expired = false;
            var now = DateTime.UtcNow;
            MainThreadDispatcher.TryEnqueue(() => executed = true, now.AddSeconds(-1), () => expired = true, null);

            MainThreadDispatcher.DrainBudget(1, 1000, now);

            Assert.That(executed, Is.False);
            Assert.That(expired, Is.True);
        }

        [Test]
        public void HandlerExceptionIsReportedWithoutBreakingTheQueue()
        {
            Exception observed = null;
            var secondRan = false;
            MainThreadDispatcher.TryEnqueue(() => throw new InvalidOperationException("boom"), null, null, exception => observed = exception);
            MainThreadDispatcher.TryEnqueue(() => secondRan = true, null, null, null);

            MainThreadDispatcher.DrainBudget(2, 1000, DateTime.UtcNow);

            Assert.That(observed, Is.TypeOf<InvalidOperationException>());
            Assert.That(secondRan, Is.True);
        }
    }
}
