using System;
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.TestTools;

namespace CrispyWonton.UnityMcpGhost.Runtime.Tests
{
    public sealed class InputSystemGameplayPlayModeTests
    {
        private GameObject gameObject;
        private InputSystemGameplayProbe gameplay;
        private Keyboard keyboard;
        private Mouse mouse;
        private InputSettings.UpdateMode originalUpdateMode;
        private InputSettings.BackgroundBehavior originalBackgroundBehavior;
        private InputSettings.EditorInputBehaviorInPlayMode originalEditorInputBehavior;
        private bool settingsCaptured;
        private IUnityMcpInputBackend backend;

        [SetUp]
        public void SetUp()
        {
            Assert.That(Application.isPlaying, Is.True, "These tests must consume the normal PlayMode player loop.");
            backend = UnityMcpInputBackendRegistry.Backend;
            Assert.That(backend, Is.Not.Null, "The real Editor injection adapter must be registered.");
            Assert.That(backend.BackendName, Is.EqualTo("unity-input-system"));
            originalUpdateMode = InputSystem.settings.updateMode;
            originalBackgroundBehavior = InputSystem.settings.backgroundBehavior;
            originalEditorInputBehavior = InputSystem.settings.editorInputBehaviorInPlayMode;
            settingsCaptured = true;
            InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsInDynamicUpdate;
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            keyboard = InputSystem.AddDevice<Keyboard>();
            mouse = InputSystem.AddDevice<Mouse>();
            gameObject = new GameObject("Ghost owned gameplay input observer");
            gameplay = gameObject.AddComponent<InputSystemGameplayProbe>();
            gameplay.Keyboard = keyboard;
            gameplay.Mouse = mouse;
            gameplay.PageText = gameObject.AddComponent<TextMesh>();
            gameplay.ObserveClickActions();
        }

        [TearDown]
        public void TearDown()
        {
            if (gameObject != null) UnityEngine.Object.DestroyImmediate(gameObject);
            if (keyboard != null) InputSystem.RemoveDevice(keyboard);
            if (mouse != null) InputSystem.RemoveDevice(mouse);
            if (settingsCaptured)
            {
                InputSystem.settings.updateMode = originalUpdateMode;
                InputSystem.settings.backgroundBehavior = originalBackgroundBehavior;
                InputSystem.settings.editorInputBehaviorInPlayMode = originalEditorInputBehavior;
                settingsCaptured = false;
            }
        }

        [UnityTest]
        public IEnumerator PageUpAndPageDownReachGameplayAndVisibleText()
        {
            yield return null;
            yield return Send("keyboard", "tap", "PageUp");
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1), "A backend receipt alone is not observed gameplay delivery.");
            Assert.That(gameplay.PageIndex, Is.EqualTo(1));
            Assert.That(gameplay.PageText.text, Is.EqualTo("Page 1"));
            Assert.That(gameplay.Releases, Is.EqualTo(1));
            Assert.That(gameplay.ReleaseFrame, Is.GreaterThan(gameplay.PressFrame));

            yield return Send("keyboard", "tap", "PageDown");
            Assert.That(gameplay.PageDownPresses, Is.EqualTo(1));
            Assert.That(gameplay.PageIndex, Is.EqualTo(0));
            Assert.That(gameplay.PageText.text, Is.EqualTo("Page 0"));
            Assert.That(gameplay.Releases, Is.EqualTo(2));
            Assert.That(gameplay.ReleaseFrame, Is.GreaterThan(gameplay.PressFrame));
        }

        [UnityTest]
        public IEnumerator PointerClickReachesGameplayAtAbsoluteCoordinates()
        {
            yield return null;
            yield return Send("pointer", "click", string.Empty, 320, 180);
            Assert.That(gameplay.Clicks, Is.EqualTo(1));
            Assert.That(Vector2.Distance(gameplay.ClickPosition, new Vector2(320, 180)), Is.LessThan(0.01f));
            Assert.That(gameplay.Releases, Is.EqualTo(1));
            Assert.That(gameplay.ReleaseFrame, Is.GreaterThan(gameplay.PressFrame));
        }

        [UnityTest]
        public IEnumerator DifferentKeysOnOneDeviceRejectOverlapWithoutClobberingTheAcceptedTap()
        {
            yield return null;
            keyboard.MakeCurrent();
            var first = new UnityMcpInputRequest { OperationId = Guid.NewGuid().ToString("N"), Device = "keyboard", Action = "tap", Key = "PageUp" };
            var overlapping = new UnityMcpInputRequest { OperationId = Guid.NewGuid().ToString("N"), Device = "keyboard", Action = "tap", Key = "PageDown" };
            Assert.That(backend.TryStart(first, out var firstReceipt, out var reason), Is.True, reason);
            // No player update between admissions: full device snapshots must
            // not overwrite an operation that the backend already accepted.
            var overlapAccepted = backend.TryStart(overlapping, out var overlappingReceipt, out var overlapReason);
            var deadline = Time.realtimeSinceStartup + 5;
            while ((firstReceipt.Status == "running" || overlappingReceipt?.Status == "running") && Time.realtimeSinceStartup < deadline)
                yield return null;
            yield return null;

            Assert.That(firstReceipt.Status, Is.EqualTo("completed"), firstReceipt.ErrorMessage);
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1));
            Assert.That(overlapAccepted, Is.False, "Only one operation per device may be in flight.");
            StringAssert.Contains("in-flight", overlapReason);
            Assert.That(overlappingReceipt, Is.Null);
            Assert.That(backend.TryGet(overlapping.OperationId, out _), Is.False);
            Assert.That(gameplay.PageDownPresses, Is.Zero);
            Assert.That(keyboard.pageUpKey.isPressed, Is.False);

            yield return Send("keyboard", "tap", "PageDown");
            Assert.That(gameplay.PageDownPresses, Is.EqualTo(1), "The device must become available after completion.");
            Assert.That(gameplay.Releases, Is.EqualTo(2));
        }

        [UnityTest]
        public IEnumerator PointerActionCallbackObservesRequestedAbsoluteCoordinates()
        {
            InputSystem.QueueStateEvent(mouse, new UnityEngine.InputSystem.LowLevel.MouseState { position = new Vector2(40, 25) });
            yield return null;
            Assert.That(mouse.position.ReadValue(), Is.EqualTo(new Vector2(40, 25)));

            yield return Send("pointer", "click", string.Empty, 320, 180);

            Assert.That(gameplay.ActionClicks, Is.EqualTo(1));
            Assert.That(Vector2.Distance(gameplay.ActionClickPosition, new Vector2(320, 180)), Is.LessThan(0.01f),
                "InputAction.performed must see the requested coordinates during the button transition.");
            Assert.That(gameplay.Clicks, Is.EqualTo(1));
            Assert.That(gameplay.Releases, Is.EqualTo(1));
        }

        [UnityTest]
        public IEnumerator SeparatePressAndReleaseReachGameplayOnDifferentFrames()
        {
            yield return null;
            yield return Send("keyboard", "press", "PageUp");
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1));
            Assert.That(gameplay.Releases, Is.Zero);
            Assert.That(keyboard.pageUpKey.isPressed, Is.True);
            yield return Send("keyboard", "release", "PageUp");
            Assert.That(gameplay.Releases, Is.EqualTo(1));
            Assert.That(keyboard.pageUpKey.isPressed, Is.False);
            Assert.That(gameplay.ReleaseFrame, Is.GreaterThan(gameplay.PressFrame));
        }

        [UnityTest]
        public IEnumerator TapDoesNotCertifyAnAlreadyHeldKeyAsANewPress()
        {
            yield return null;
            yield return Send("keyboard", "press", "PageUp");
            var request = new UnityMcpInputRequest { OperationId = Guid.NewGuid().ToString("N"), Device = "keyboard", Action = "tap", Key = "PageUp" };
            Assert.That(backend.TryStart(request, out _, out var reason), Is.False, "A held key has no new press edge to deliver.");
            StringAssert.Contains("already pressed", reason);
            yield return Send("keyboard", "release", "PageUp");
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1));
            Assert.That(gameplay.Releases, Is.EqualTo(1));
        }

        [UnityTest]
        public IEnumerator ExpiredInputCannotExecuteBeforeTheNextEditorTick()
        {
            yield return null;
            var request = new UnityMcpInputRequest { OperationId = Guid.NewGuid().ToString("N"), Device = "keyboard", Action = "tap", Key = "PageUp" };
            Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.True, reason);
            // Deliberately model a blocked main thread, so an Editor-update
            // timeout callback cannot run before the next Dynamic input update.
            // A fake clock would not exercise this actual scheduling boundary.
            System.Threading.Thread.Sleep(5100);
            InputSystem.Update();
            Assert.That(backend.TryGet(request.OperationId, out receipt), Is.True);
            Assert.That(receipt.Status, Is.EqualTo("failed"));
            Assert.That(receipt.ErrorCode, Is.EqualTo("INPUT_DELIVERY_TIMEOUT"));
            Assert.That(receipt.PressObserved, Is.False);
            yield return null;
            yield return null;
            Assert.That(keyboard.pageUpKey.isPressed, Is.False);
            Assert.That(gameplay.PageUpPresses, Is.Zero);
        }

        [UnityTest]
        public IEnumerator ExpiredTapAfterObservedPressStaysFailedAndEventuallyReleases()
        {
            yield return null;
            keyboard.MakeCurrent();
            var request = new UnityMcpInputRequest { OperationId = Guid.NewGuid().ToString("N"), Device = "keyboard", Action = "tap", Key = "PageUp" };
            Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.True, reason);
            var pressDeadline = Time.realtimeSinceStartup + 5;
            while (!receipt.PressObserved && receipt.Status == "running" && Time.realtimeSinceStartup < pressDeadline)
                yield return null;
            Assert.That(receipt.PressObserved, Is.True);
            Assert.That(receipt.Status, Is.EqualTo("running"));
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1), "Stall only after gameplay consumed the press.");
            Assert.That(keyboard.pageUpKey.isPressed, Is.True);

            // Stall the actual main thread after press delivery. The deferred
            // release must survive expiry when normal player frames resume.
            System.Threading.Thread.Sleep(5100);
            var releaseDeadline = Time.realtimeSinceStartup + 2;
            do
            {
                yield return null;
                Assert.That(backend.TryGet(request.OperationId, out receipt), Is.True);
            } while ((receipt.Status == "running" || keyboard.pageUpKey.isPressed) && Time.realtimeSinceStartup < releaseDeadline);
            yield return null;

            Assert.That(receipt.Status, Is.EqualTo("failed"), "Cleanup must not certify an expired operation as completed.");
            Assert.That(receipt.ErrorCode, Is.EqualTo("INPUT_DELIVERY_TIMEOUT"));
            Assert.That(keyboard.pageUpKey.isPressed, Is.False, "An observed tap press retains its release obligation after timeout.");
            Assert.That(receipt.ReleaseObserved, Is.True, "Failed receipts must expose the eventual cleanup evidence.");
            Assert.That(receipt.ReleaseFrame, Is.GreaterThan(receipt.PressFrame));
            StringAssert.Contains("Cleanup release", receipt.Evidence);
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(1));
            Assert.That(gameplay.Releases, Is.EqualTo(1));
            Assert.That(gameplay.ReleaseFrame, Is.GreaterThan(gameplay.PressFrame));
            yield return Send("keyboard", "tap", "PageUp");
            Assert.That(gameplay.PageUpPresses, Is.EqualTo(2), "Cleanup must make the device available again.");
            Assert.That(backend.TryGet(request.OperationId, out receipt), Is.True);
            Assert.That(receipt.Status, Is.EqualTo("failed"));
            Assert.That(receipt.ErrorCode, Is.EqualTo("INPUT_DELIVERY_TIMEOUT"));
        }

        private IEnumerator Send(string device, string action, string key, float x = 0, float y = 0)
        {
            keyboard.MakeCurrent();
            mouse.MakeCurrent();
            var request = new UnityMcpInputRequest
            {
                OperationId = Guid.NewGuid().ToString("N"),
                Device = device,
                Action = action,
                Key = key,
                X = x,
                Y = y
            };
            Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.True, reason);
            var deadline = Time.realtimeSinceStartup + 5;
            do
            {
                // No manual InputSystem.Update: the game must consume the event
                // through its normal Update before we inspect the observed state.
                yield return null;
                Assert.That(backend.TryGet(request.OperationId, out receipt), Is.True);
            } while (receipt.Status == "running" && Time.realtimeSinceStartup < deadline);
            Assert.That(receipt.Status, Is.EqualTo("completed"), receipt.ErrorMessage);
            yield return null;
        }
    }
}
