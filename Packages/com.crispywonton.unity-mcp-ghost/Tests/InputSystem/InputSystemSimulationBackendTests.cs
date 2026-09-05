using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.TestTools;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class InputSystemSimulationBackendTests
    {
        [UnityTest]
        public IEnumerator PointerClickUsesAbsoluteCoordinatesAndCompletesRelease()
        {
            var mouse = InputSystem.AddDevice<Mouse>();
            try
            {
                InputSystem.QueueStateEvent(mouse, new MouseState { position = new Vector2(40, 25) });
                InputSystem.Update();
                var backend = new InputSystemSimulationBackend();
                var request = new UnityMcpInputRequest
                {
                    OperationId = "input-system-pointer",
                    Device = "pointer",
                    Action = "click",
                    X = 320,
                    Y = 180
                };

                Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.True, reason);
                Assert.That(Vector2.Distance(mouse.position.ReadValue(), new Vector2(320, 180)), Is.LessThan(0.01f));
                Assert.That(receipt.PressObserved, Is.True);

                for (var index = 0; index < 5 && receipt.Status == "running"; index++)
                {
                    yield return null;
                    backend.TryGet(request.OperationId, out receipt);
                }

                Assert.That(receipt.Status, Is.EqualTo("completed"));
                Assert.That(receipt.ReleaseObserved, Is.True);
            }
            finally
            {
                InputSystem.RemoveDevice(mouse);
            }
        }

        [UnityTest]
        public IEnumerator KeyboardTapCompletesPressAndReleaseEvidence()
        {
            var keyboard = InputSystem.AddDevice<Keyboard>();
            try
            {
                var backend = new InputSystemSimulationBackend();
                var request = new UnityMcpInputRequest
                {
                    OperationId = "input-system-keyboard",
                    Device = "keyboard",
                    Action = "tap",
                    Key = "PageUp"
                };

                Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.True, reason);
                Assert.That(receipt.PressObserved, Is.True);

                for (var index = 0; index < 5 && receipt.Status == "running"; index++)
                {
                    yield return null;
                    backend.TryGet(request.OperationId, out receipt);
                }

                Assert.That(receipt.Status, Is.EqualTo("completed"));
                Assert.That(receipt.ReleaseObserved, Is.True);
            }
            finally
            {
                InputSystem.RemoveDevice(keyboard);
            }
        }
    }
}
