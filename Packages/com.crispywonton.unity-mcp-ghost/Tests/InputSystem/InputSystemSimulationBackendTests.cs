using System;
using System.Collections;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.TestTools;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class InputSystemSimulationBackendTests
    {
        private InputSettings.UpdateMode originalUpdateMode;
        private InputSettings.BackgroundBehavior originalBackground;
        private InputSettings.EditorInputBehaviorInPlayMode originalRouting;

        [UnitySetUp]
        public IEnumerator EnterNormalPlayMode()
        {
            yield return new EnterPlayMode();
            originalUpdateMode = InputSystem.settings.updateMode;
            originalBackground = InputSystem.settings.backgroundBehavior;
            originalRouting = InputSystem.settings.editorInputBehaviorInPlayMode;
            InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsInDynamicUpdate;
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
        }

        [UnityTearDown]
        public IEnumerator RestoreEditor()
        {
            InputSystem.settings.updateMode = originalUpdateMode;
            InputSystem.settings.backgroundBehavior = originalBackground;
            InputSystem.settings.editorInputBehaviorInPlayMode = originalRouting;
            yield return new ExitPlayMode();
        }

        [UnityTest]
        public IEnumerator PointerClickUsesAbsoluteCoordinatesAndCompletesRelease()
        {
            var mouse = InputSystem.AddDevice<Mouse>();
            try
            {
                InputSystem.QueueStateEvent(mouse, new MouseState { position = new Vector2(40, 25) });
                yield return null;
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
                Assert.That(receipt.Status, Is.EqualTo("running"));
                Assert.That(receipt.PressObserved, Is.False, "The next player update has not occurred yet.");

                var deadline = Time.realtimeSinceStartup + 5;
                while (receipt.Status == "running" && Time.realtimeSinceStartup < deadline)
                {
                    yield return null;
                    backend.TryGet(request.OperationId, out receipt);
                }

                Assert.That(receipt.Status, Is.EqualTo("completed"));
                Assert.That(Vector2.Distance(mouse.position.ReadValue(), new Vector2(320, 180)), Is.LessThan(0.01f));
                Assert.That(receipt.PressObserved, Is.True);
                Assert.That(receipt.ReleaseObserved, Is.True);
                Assert.That(receipt.ReleaseFrame, Is.GreaterThan(receipt.PressFrame));
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
                Assert.That(receipt.Status, Is.EqualTo("running"));
                Assert.That(receipt.PressObserved, Is.False);

                var deadline = Time.realtimeSinceStartup + 5;
                while (receipt.Status == "running" && Time.realtimeSinceStartup < deadline)
                {
                    yield return null;
                    backend.TryGet(request.OperationId, out receipt);
                }

                Assert.That(receipt.Status, Is.EqualTo("completed"));
                Assert.That(receipt.PressObserved, Is.True);
                Assert.That(receipt.ReleaseObserved, Is.True);
                Assert.That(receipt.ReleaseFrame, Is.GreaterThan(receipt.PressFrame));
            }
            finally
            {
                InputSystem.RemoveDevice(keyboard);
            }
        }

        [UnityTest]
        public IEnumerator ControllerRejectsUnsupportedUpdatesWithoutClaimingDelivery()
        {
            InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsManually;
            var response = InputSimulationController.Simulate("{\"device\":\"keyboard\",\"action\":\"tap\",\"key\":\"PageUp\",\"backend\":\"unity-input-system\"}");
            Assert.That(JsonRpcUtil.ReadBool(response, "ok", true), Is.False, response);
            StringAssert.Contains("UNSUPPORTED_INPUT_BACKEND", response);
            yield return null;
        }

        [UnityTest]
        public IEnumerator PausedPlayModeRejectsWithoutCreatingReceiptOrQueuingInput()
        {
            var keyboard = InputSystem.AddDevice<Keyboard>();
            var originallyPaused = EditorApplication.isPaused;
            var inputEvents = 0;
            Action<InputEventPtr, InputDevice> observeEvent = (eventPtr, device) =>
            {
                if (ReferenceEquals(device, keyboard)) inputEvents++;
            };
            InputSystem.onEvent += observeEvent;
            try
            {
                keyboard.MakeCurrent();
                EditorApplication.isPaused = true;
                Assert.That(EditorApplication.isPaused, Is.True);
                AssertRejectedWithoutReceipt("unpaused Play mode");
                EditorApplication.isPaused = false;
                yield return null;
                yield return null;
                Assert.That(inputEvents, Is.Zero, "Rejected input must not appear after Play mode resumes.");
                Assert.That(keyboard.pageUpKey.isPressed, Is.False);
            }
            finally
            {
                EditorApplication.isPaused = originallyPaused;
                InputSystem.onEvent -= observeEvent;
                InputSystem.RemoveDevice(keyboard);
            }
        }

        [UnityTest]
        public IEnumerator UnfocusedGameViewRoutingRejectsWithoutCreatingReceiptOrQueuingInput()
        {
            var keyboard = InputSystem.AddDevice<Keyboard>();
            var originalFocusedWindow = EditorWindow.focusedWindow;
            InputRoutingFocusWindow focusWindow = null;
            var inputEvents = 0;
            Action<InputEventPtr, InputDevice> observeEvent = (eventPtr, device) =>
            {
                if (ReferenceEquals(device, keyboard)) inputEvents++;
            };
            try
            {
                InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDevicesRespectGameViewFocus;
                if (Application.isFocused)
                {
                    focusWindow = ScriptableObject.CreateInstance<InputRoutingFocusWindow>();
                    focusWindow.titleContent = new GUIContent("Ghost input routing test");
                    focusWindow.ShowUtility();
                    focusWindow.Focus();
                }
                yield return null;
                Assert.That(Application.isFocused, Is.False, "The fixture must move focus away from the Game View before checking rejection.");
                keyboard.MakeCurrent();
                InputSystem.onEvent += observeEvent;
                AssertRejectedWithoutReceipt("routes keyboard/pointer input away from the player");
                InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
                yield return null;
                yield return null;
                Assert.That(inputEvents, Is.Zero, "Rejected input must not appear when gameplay routing is restored.");
                Assert.That(keyboard.pageUpKey.isPressed, Is.False);
            }
            finally
            {
                InputSystem.onEvent -= observeEvent;
                InputSystem.settings.editorInputBehaviorInPlayMode = originalRouting;
                if (focusWindow != null) focusWindow.Close();
                if (originalFocusedWindow != null) originalFocusedWindow.Focus();
                InputSystem.RemoveDevice(keyboard);
            }
        }

        private static void AssertRejectedWithoutReceipt(string expectedReason)
        {
            var backend = new InputSystemSimulationBackend();
            var request = new UnityMcpInputRequest
            {
                OperationId = Guid.NewGuid().ToString("N"),
                Device = "keyboard",
                Action = "tap",
                Key = "PageUp"
            };
            Assert.That(backend.TryStart(request, out var receipt, out var reason), Is.False);
            StringAssert.Contains(expectedReason, reason);
            Assert.That(receipt, Is.Null);
            Assert.That(backend.TryGet(request.OperationId, out _), Is.False);

            var response = InputSimulationController.Simulate("{\"device\":\"keyboard\",\"action\":\"tap\",\"key\":\"PageUp\",\"backend\":\"unity-input-system\"}");
            Assert.That(JsonRpcUtil.ReadBool(response, "ok", true), Is.False, response);
            Assert.That(JsonRpcUtil.ReadString(response, "status", ""), Is.EqualTo("failed"), response);
            StringAssert.Contains("UNSUPPORTED_INPUT_BACKEND", response);
            StringAssert.Contains(expectedReason, response);
            Assert.That(backend.TryGet(JsonRpcUtil.ReadString(response, "operationId", ""), out _), Is.False);
        }

        [UnityTest]
        public IEnumerator ControllerReportsNormalPlayerUpdateReceipt()
        {
            var keyboard = InputSystem.AddDevice<Keyboard>();
            try
            {
                var response = InputSimulationController.Simulate("{\"device\":\"keyboard\",\"action\":\"tap\",\"key\":\"PageUp\",\"backend\":\"unity-input-system\"}");
                Assert.That(JsonRpcUtil.ReadString(response, "status", ""), Is.EqualTo("running"), response);
                Assert.That(JsonRpcUtil.ReadBool(response, "pressObserved", true), Is.False);
                var operationId = JsonRpcUtil.ReadString(response, "operationId", "");
                var deadline = Time.realtimeSinceStartup + 5;
                while (JsonRpcUtil.ReadString(response, "status", "") == "running" && Time.realtimeSinceStartup < deadline)
                {
                    yield return null;
                    response = InputSimulationController.Status("{\"operationId\":\"" + operationId + "\"}");
                }
                Assert.That(JsonRpcUtil.ReadBool(response, "ok", false), Is.True, response);
                Assert.That(JsonRpcUtil.ReadString(response, "status", ""), Is.EqualTo("completed"), response);
                Assert.That(JsonRpcUtil.ReadString(response, "backend", ""), Is.EqualTo("unity-input-system"));
                Assert.That(JsonRpcUtil.ReadInt(response, "releaseFrame", -1), Is.GreaterThan(JsonRpcUtil.ReadInt(response, "pressFrame", -1)));
            }
            finally
            {
                InputSystem.RemoveDevice(keyboard);
            }
        }
    }

    internal sealed class InputRoutingFocusWindow : EditorWindow
    {
    }
}
