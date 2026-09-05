using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace CrispyWonton.UnityMcpGhost.Runtime.Tests
{
    public sealed class RuntimeInputContractPlayModeTests
    {
        [UnityTest]
        public IEnumerator ProjectDriverObservesPageUpAcrossAFrame()
        {
            var driver = new FixtureInputDriver();
            var request = new UnityMcpInputRequest
            {
                OperationId = "playmode-page-up",
                Device = "keyboard",
                Action = "tap",
                Key = "PageUp"
            };

            UnityMcpInputReceipt receipt;
            string failure;
            Assert.That(driver.TrySimulate(request, out receipt, out failure), Is.True, failure);
            Assert.That(receipt.PressObserved, Is.True);
            Assert.That(receipt.ReleaseObserved, Is.True);
            Assert.That(receipt.Backend, Is.EqualTo(driver.DriverName));
            var observedFrame = Time.frameCount;

            yield return null;

            Assert.That(Time.frameCount, Is.GreaterThan(observedFrame));
            Assert.That(driver.PageIndex, Is.EqualTo(1));
        }
    }

    internal sealed class FixtureInputDriver : IUnityMcpInputDriver
    {
        public string DriverName
        {
            get { return "playmode-fixture-driver"; }
        }

        public int PageIndex { get; private set; }

        public bool TrySimulate(UnityMcpInputRequest request, out UnityMcpInputReceipt receipt, out string failureReason)
        {
            receipt = new UnityMcpInputReceipt
            {
                OperationId = request.OperationId,
                Backend = DriverName,
                Action = request.Action,
                FocusTarget = "playmode-test",
                PressFrame = Time.frameCount,
                ReleaseFrame = Time.frameCount,
                PressObserved = true,
                ReleaseObserved = true,
                Evidence = request.Key
            };
            if (request.Device == "keyboard" && request.Action == "tap" && request.Key == "PageUp")
            {
                PageIndex++;
                failureReason = string.Empty;
                return true;
            }

            failureReason = "Unsupported fixture input.";
            return false;
        }
    }
}
