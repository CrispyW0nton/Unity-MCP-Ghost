using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    [InitializeOnLoad]
    internal sealed class InputSystemSimulationBackend : IUnityMcpInputBackend
    {
        private static readonly Dictionary<string, UnityMcpInputReceipt> Receipts = new Dictionary<string, UnityMcpInputReceipt>(StringComparer.Ordinal);
        private static readonly Dictionary<string, PendingRelease> Pending = new Dictionary<string, PendingRelease>(StringComparer.Ordinal);
        private static readonly Dictionary<string, string> KeyProperties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["PageUp"] = "pageUpKey",
            ["PageDown"] = "pageDownKey",
            ["Space"] = "spaceKey",
            ["Enter"] = "enterKey",
            ["Escape"] = "escapeKey",
            ["UpArrow"] = "upArrowKey",
            ["DownArrow"] = "downArrowKey",
            ["LeftArrow"] = "leftArrowKey",
            ["RightArrow"] = "rightArrowKey",
            ["Tab"] = "tabKey",
            ["Backspace"] = "backspaceKey"
        };

        static InputSystemSimulationBackend()
        {
            UnityMcpInputBackendRegistry.Backend = new InputSystemSimulationBackend();
            EditorApplication.update -= CompletePendingReleases;
            EditorApplication.update += CompletePendingReleases;
        }

        public string BackendName => "unity-input-system";

        public bool TryStart(UnityMcpInputRequest request, out UnityMcpInputReceipt receipt, out string failureReason)
        {
            receipt = null;
            failureReason = string.Empty;
            if (!TryResolveApi(out var api, out failureReason))
            {
                return false;
            }

            object device;
            object button;
            if (request.Device == "keyboard")
            {
                device = api.KeyboardCurrent.GetValue(null);
                if (device == null)
                {
                    failureReason = "The Input System package is present, but no active Keyboard device is available.";
                    return false;
                }
                var propertyName = KeyProperty(request.Key);
                var property = device.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                button = property?.GetValue(device);
                if (button == null)
                {
                    failureReason = "The active Input System keyboard does not expose key '" + request.Key + "'.";
                    return false;
                }
            }
            else
            {
                device = api.MouseCurrent.GetValue(null);
                if (device == null)
                {
                    failureReason = "The Input System package is present, but no active Mouse device is available.";
                    return false;
                }
                button = device.GetType().GetProperty("leftButton", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device);
                var position = device.GetType().GetProperty("position", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device);
                if (button == null || position == null)
                {
                    failureReason = "The active Input System mouse does not expose position and leftButton controls.";
                    return false;
                }
                api.QueueValue(position, new Vector2(request.X, request.Y));
                api.Update();
            }

            var displayName = device.GetType().GetProperty("displayName", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device) as string
                ?? device.GetType().Name;
            var releaseOnly = request.Action == "release";
            api.QueueValue(button, releaseOnly ? 0f : 1f);
            api.Update();
            var pressed = ReadPressed(button);
            receipt = new UnityMcpInputReceipt
            {
                OperationId = request.OperationId,
                Action = request.Action,
                Backend = BackendName,
                FocusTarget = displayName,
                PressFrame = releaseOnly ? -1 : Time.frameCount,
                ReleaseFrame = releaseOnly ? Time.frameCount : -1,
                PressObserved = !releaseOnly && pressed,
                ReleaseObserved = releaseOnly && !pressed,
                Evidence = releaseOnly
                    ? "Input System button state was observed released after event processing."
                    : "Input System button state was observed pressed after event processing."
            };

            if (releaseOnly || request.Action == "press")
            {
                receipt.Status = "completed";
                Receipts[request.OperationId] = receipt;
                return true;
            }

            if (!pressed)
            {
                receipt.Status = "failed";
                receipt.ErrorCode = "INPUT_PRESS_NOT_OBSERVED";
                receipt.ErrorMessage = "The Input System did not report the requested control as pressed.";
                Receipts[request.OperationId] = receipt;
                return true;
            }

            receipt.Status = "running";
            Receipts[request.OperationId] = receipt;
            Pending[request.OperationId] = new PendingRelease
            {
                Api = api,
                Button = button,
                Receipt = receipt,
                StartedFrame = Time.frameCount
            };
            return true;
        }

        public bool TryGet(string operationId, out UnityMcpInputReceipt receipt)
        {
            return Receipts.TryGetValue(operationId ?? string.Empty, out receipt);
        }

        private static void CompletePendingReleases()
        {
            foreach (var operationId in Pending.Keys.ToArray())
            {
                var pending = Pending[operationId];
                pending.UpdateTicks++;
                if (Time.frameCount <= pending.StartedFrame && pending.UpdateTicks < 3)
                {
                    continue;
                }

                try
                {
                    pending.Api.QueueValue(pending.Button, 0f);
                    pending.Api.Update();
                    pending.Receipt.ReleaseFrame = Time.frameCount;
                    pending.Receipt.ReleaseObserved = !ReadPressed(pending.Button);
                    pending.Receipt.Status = pending.Receipt.ReleaseObserved ? "completed" : "failed";
                    pending.Receipt.Evidence += " Release was queued on a later editor/player update and the released device state was observed.";
                    if (!pending.Receipt.ReleaseObserved)
                    {
                        pending.Receipt.ErrorCode = "INPUT_RELEASE_NOT_OBSERVED";
                        pending.Receipt.ErrorMessage = "The Input System did not report the requested control as released.";
                    }
                }
                catch (Exception exception)
                {
                    pending.Receipt.Status = "failed";
                    pending.Receipt.ErrorCode = "INPUT_BACKEND_FAILED";
                    pending.Receipt.ErrorMessage = exception.Message;
                }
                Receipts[operationId] = pending.Receipt;
                Pending.Remove(operationId);
            }
        }

        private static string KeyProperty(string key)
        {
            if (KeyProperties.TryGetValue(key ?? string.Empty, out var property))
            {
                return property;
            }
            if (!string.IsNullOrWhiteSpace(key) && key.Length == 1 && char.IsLetter(key[0]))
            {
                return char.ToLowerInvariant(key[0]) + "Key";
            }
            if (!string.IsNullOrWhiteSpace(key) && key.Length == 1 && char.IsDigit(key[0]))
            {
                return "digit" + key[0] + "Key";
            }
            return string.Empty;
        }

        private static bool ReadPressed(object button)
        {
            return button?.GetType().GetProperty("isPressed", BindingFlags.Instance | BindingFlags.Public)?.GetValue(button) is bool value && value;
        }

        private static bool TryResolveApi(out InputSystemApi api, out string failureReason)
        {
            api = null;
            failureReason = string.Empty;
            var inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem", false);
            var keyboard = Type.GetType("UnityEngine.InputSystem.Keyboard, Unity.InputSystem", false);
            var mouse = Type.GetType("UnityEngine.InputSystem.Mouse, Unity.InputSystem", false);
            if (inputSystem == null || keyboard == null || mouse == null)
            {
                failureReason = "The Unity Input System package is not loaded.";
                return false;
            }

            var inputControlExtensions = Type.GetType("UnityEngine.InputSystem.InputControlExtensions, Unity.InputSystem", false);
            var queueValue = inputControlExtensions?.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .FirstOrDefault(method => method.Name == "QueueValueChange" && method.IsGenericMethodDefinition && method.GetParameters().Length >= 2);
            var update = inputSystem.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .FirstOrDefault(method => method.Name == "Update" && method.GetParameters().Length == 0);
            var keyboardCurrent = keyboard.GetProperty("current", BindingFlags.Static | BindingFlags.Public);
            var mouseCurrent = mouse.GetProperty("current", BindingFlags.Static | BindingFlags.Public);
            if (queueValue == null || update == null || keyboardCurrent == null || mouseCurrent == null)
            {
                failureReason = "The loaded Input System API is incompatible with Ghost's verified injection adapter.";
                return false;
            }
            api = new InputSystemApi(queueValue, update, keyboardCurrent, mouseCurrent);
            return true;
        }

        private sealed class InputSystemApi
        {
            private readonly MethodInfo queueValue;
            private readonly MethodInfo update;

            public InputSystemApi(MethodInfo queueValue, MethodInfo update, PropertyInfo keyboardCurrent, PropertyInfo mouseCurrent)
            {
                this.queueValue = queueValue;
                this.update = update;
                KeyboardCurrent = keyboardCurrent;
                MouseCurrent = mouseCurrent;
            }

            public PropertyInfo KeyboardCurrent { get; }
            public PropertyInfo MouseCurrent { get; }

            public void QueueValue(object control, object value)
            {
                var method = queueValue.MakeGenericMethod(value.GetType());
                var parameters = method.GetParameters().Length == 2
                    ? new[] { control, value }
                    : new[] { control, value, (object)-1d };
                method.Invoke(null, parameters);
            }

            public void Update()
            {
                update.Invoke(null, Array.Empty<object>());
            }
        }

        private sealed class PendingRelease
        {
            public InputSystemApi Api;
            public object Button;
            public UnityMcpInputReceipt Receipt;
            public int StartedFrame;
            public int UpdateTicks;
        }
    }
}
