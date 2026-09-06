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
        private static readonly Dictionary<string, PendingInput> Pending = new Dictionary<string, PendingInput>(StringComparer.Ordinal);
        private static InputSystemApi activeApi;
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
            EditorApplication.update -= ExpirePending;
            EditorApplication.update += ExpirePending;
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
            if (!EditorApplication.isPlaying || EditorApplication.isPaused || !api.UsesDynamicUpdate)
            {
                failureReason = "Verified Input System delivery requires unpaused Play mode with ProcessEventsInDynamicUpdate.";
                return false;
            }
            if (!api.RoutesInputToGame)
            {
                failureReason = "The Game View is not focused and the project routes keyboard/pointer input away from the player. Focus the Game View or explicitly configure the project input routing.";
                return false;
            }

            object device;
            object button;
            object position = null;
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
                position = device.GetType().GetProperty("position", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device);
                if (button == null || position == null)
                {
                    failureReason = "The active Input System mouse does not expose position and leftButton controls.";
                    return false;
                }
            }

            if (Pending.Values.Any(item => ReferenceEquals(item.Device, device)))
            {
                failureReason = "The requested device already has an in-flight input operation or release cleanup.";
                return false;
            }
            if (request.Action != "release" && ReadPressed(button))
            {
                failureReason = "The requested control is already pressed; release it before requesting a new press or tap.";
                return false;
            }

            var displayName = device.GetType().GetProperty("displayName", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device) as string
                ?? device.GetType().Name;
            receipt = new UnityMcpInputReceipt
            {
                OperationId = request.OperationId,
                Action = request.Action,
                Backend = BackendName,
                FocusTarget = "Game View / " + displayName + " / routing=" + api.EditorRouting,
                Status = "running",
                Evidence = "Awaiting the normal Dynamic input update; no manual InputSystem.Update is performed."
            };
            Receipts[request.OperationId] = receipt;
            Pending[request.OperationId] = new PendingInput
            {
                Device = device,
                Button = button,
                Position = position,
                Coordinates = new Vector2(request.X, request.Y),
                Receipt = receipt,
                Release = request.Action == "release",
                Deadline = EditorApplication.timeSinceStartup + 5
            };
            return true;
        }

        public bool TryGet(string operationId, out UnityMcpInputReceipt receipt)
        {
            return Receipts.TryGetValue(operationId ?? string.Empty, out receipt);
        }

        private static void BeforeInputUpdate()
        {
            if (Pending.Count == 0) return;
            // A long frame can reach this callback before Editor.update gets a
            // chance to expire requests. Never queue an already expired event.
            ExpirePending();
            if (Pending.Count == 0 || activeApi == null || !activeApi.IsDynamicUpdate || !EditorApplication.isPlaying || EditorApplication.isPaused) return;
            foreach (var pending in Pending.Values.ToArray())
            {
                // A surviving domain can resume with a reset player frame count.
                if (pending.Queued || (pending.Receipt.PressObserved && Time.frameCount == pending.Receipt.PressFrame)) continue;
                try
                {
                    // One device snapshot makes click coordinates visible to
                    // action callbacks at the same instant as the button edge.
                    // Failed-click cleanup releases only; it must not move the pointer.
                    activeApi.QueueState(pending.Device, pending.Button, pending.Release ? 0f : 1f,
                        pending.CleanupOnly ? null : pending.Position, pending.Coordinates);
                    pending.Queued = true;
                }
                catch (Exception exception)
                {
                    Fail(pending, "INPUT_BACKEND_FAILED", exception.GetBaseException().Message);
                }
            }
        }

        private static void AfterInputUpdate()
        {
            if (Pending.Count == 0 || activeApi == null || !activeApi.IsDynamicUpdate) return;
            foreach (var pending in Pending.Values.ToArray())
            {
                if (!pending.Queued) continue;
                var observed = pending.Release ? !ReadPressed(pending.Button) : ReadPressed(pending.Button) && ReadPressEdge(pending.Button);
                if (!observed)
                {
                    Fail(pending, pending.Release ? "INPUT_RELEASE_NOT_OBSERVED" : "INPUT_PRESS_NOT_OBSERVED", "The normal Dynamic update did not observe the requested button state.");
                    continue;
                }
                if (pending.Release)
                {
                    pending.Receipt.ReleaseObserved = true;
                    pending.Receipt.ReleaseFrame = Time.frameCount;
                }
                else
                {
                    pending.Receipt.PressObserved = true;
                    pending.Receipt.PressFrame = Time.frameCount;
                }
                pending.Receipt.Evidence += " " + (pending.CleanupOnly ? "Cleanup release" : pending.Release ? "Released" : "Pressed") + " state observed in normal Dynamic update at frame " + Time.frameCount + ".";
                if (pending.CleanupOnly)
                {
                    // Recovery evidence does not turn a failed operation green.
                    Pending.Remove(pending.Receipt.OperationId);
                }
                else if (!pending.Release && (pending.Receipt.Action == "tap" || pending.Receipt.Action == "click"))
                {
                    pending.Release = true;
                    pending.Queued = false;
                }
                else
                {
                    pending.Receipt.Status = "completed";
                    Pending.Remove(pending.Receipt.OperationId);
                }
            }
        }

        private static void ExpirePending()
        {
            if (Pending.Count == 0) return;
            foreach (var pending in Pending.Values.ToArray())
            {
                if (pending.CleanupOnly)
                {
                    if (!DeviceIsAdded(pending.Device))
                    {
                        pending.Receipt.Evidence += " Release cleanup ended because the target device was removed.";
                        Pending.Remove(pending.Receipt.OperationId);
                    }
                }
                else if (!EditorApplication.isPlaying || EditorApplication.timeSinceStartup >= pending.Deadline)
                {
                    Fail(pending, "INPUT_DELIVERY_TIMEOUT", "A normal player input update was not observed before the deadline or Play mode stopped; delivery is not certified.");
                }
            }
        }

        private static void Fail(PendingInput pending, string code, string message)
        {
            if (!pending.CleanupOnly)
            {
                pending.Receipt.Status = "failed";
                pending.Receipt.ErrorCode = code;
                pending.Receipt.ErrorMessage = message;
            }
            if (pending.Receipt.PressObserved && (pending.Receipt.Action == "tap" || pending.Receipt.Action == "click")
                && DeviceIsAdded(pending.Device))
            {
                // Once gameplay received a transient press, retain ownership
                // until a later Dynamic update observes its release. An expired
                // request that never pressed has no event left to deliver.
                // Keep this obligation while stopped if the domain/device survives.
                if (!pending.CleanupOnly) pending.Receipt.Evidence += " Release cleanup is pending a normal Dynamic update.";
                pending.CleanupOnly = true;
                pending.Release = true;
                pending.Queued = false;
            }
            else
            {
                Pending.Remove(pending.Receipt.OperationId);
            }
        }

        private static bool DeviceIsAdded(object device)
        {
            return device?.GetType().GetProperty("added", BindingFlags.Instance | BindingFlags.Public)?.GetValue(device) is bool added && added;
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

        private static bool ReadPressEdge(object button)
        {
            return button?.GetType().GetProperty("wasPressedThisFrame", BindingFlags.Instance | BindingFlags.Public)?.GetValue(button) is bool value && value;
        }

        private static bool TryResolveApi(out InputSystemApi api, out string failureReason)
        {
            api = activeApi;
            failureReason = string.Empty;
            if (api != null) return true;
            var inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem", false);
            var keyboard = Type.GetType("UnityEngine.InputSystem.Keyboard, Unity.InputSystem", false);
            var mouse = Type.GetType("UnityEngine.InputSystem.Mouse, Unity.InputSystem", false);
            if (inputSystem == null || keyboard == null || mouse == null)
            {
                failureReason = "The Unity Input System package is not loaded.";
                return false;
            }

            var inputControlExtensions = Type.GetType("UnityEngine.InputSystem.InputControlExtensions, Unity.InputSystem", false);
            var stateEvent = Type.GetType("UnityEngine.InputSystem.LowLevel.StateEvent, Unity.InputSystem", false);
            var eventPtr = Type.GetType("UnityEngine.InputSystem.LowLevel.InputEventPtr, Unity.InputSystem", false);
            var createStateEvent = stateEvent?.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .FirstOrDefault(method => method.Name == "From" && method.GetParameters().Length == 3
                    && method.GetParameters()[1].IsOut && typeof(IDisposable).IsAssignableFrom(method.ReturnType));
            var writeValue = inputControlExtensions?.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .FirstOrDefault(method => method.Name == "WriteValueIntoEvent" && method.IsGenericMethodDefinition
                    && method.GetParameters().Length == 3 && method.GetParameters()[0].ParameterType.IsGenericType);
            var queueEvent = inputSystem.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .FirstOrDefault(method => method.Name == "QueueEvent" && !method.IsGenericMethod
                    && method.GetParameters().Length == 1 && method.GetParameters()[0].ParameterType == eventPtr);
            var beforeUpdate = inputSystem.GetEvent("onBeforeUpdate", BindingFlags.Static | BindingFlags.Public);
            var afterUpdate = inputSystem.GetEvent("onAfterUpdate", BindingFlags.Static | BindingFlags.Public);
            var updateType = Type.GetType("UnityEngine.InputSystem.LowLevel.InputState, Unity.InputSystem", false)?.GetProperty("currentUpdateType", BindingFlags.Static | BindingFlags.Public);
            var settings = inputSystem.GetProperty("settings", BindingFlags.Static | BindingFlags.Public);
            var keyboardCurrent = keyboard.GetProperty("current", BindingFlags.Static | BindingFlags.Public);
            var mouseCurrent = mouse.GetProperty("current", BindingFlags.Static | BindingFlags.Public);
            if (createStateEvent == null || writeValue == null || queueEvent == null || beforeUpdate == null || afterUpdate == null || updateType == null || settings == null || keyboardCurrent == null || mouseCurrent == null)
            {
                failureReason = "The loaded Input System API is incompatible with Ghost's verified injection adapter.";
                return false;
            }
            api = new InputSystemApi(createStateEvent, writeValue, queueEvent, updateType, settings, keyboardCurrent, mouseCurrent);
            beforeUpdate.AddEventHandler(null, (Action)BeforeInputUpdate);
            afterUpdate.AddEventHandler(null, (Action)AfterInputUpdate);
            activeApi = api;
            return true;
        }

        private sealed class InputSystemApi
        {
            private readonly MethodInfo createStateEvent;
            private readonly MethodInfo writeButton;
            private readonly MethodInfo writePosition;
            private readonly MethodInfo queueEvent;
            private readonly object eventAllocator;
            private readonly PropertyInfo updateType;
            private readonly PropertyInfo settings;

            public InputSystemApi(MethodInfo createStateEvent, MethodInfo writeValue, MethodInfo queueEvent, PropertyInfo updateType, PropertyInfo settings, PropertyInfo keyboardCurrent, PropertyInfo mouseCurrent)
            {
                this.createStateEvent = createStateEvent;
                writeButton = writeValue.MakeGenericMethod(typeof(float));
                writePosition = writeValue.MakeGenericMethod(typeof(Vector2));
                this.queueEvent = queueEvent;
                eventAllocator = createStateEvent.GetParameters()[2].DefaultValue;
                this.updateType = updateType;
                this.settings = settings;
                KeyboardCurrent = keyboardCurrent;
                MouseCurrent = mouseCurrent;
            }

            public PropertyInfo KeyboardCurrent { get; }
            public PropertyInfo MouseCurrent { get; }
            public bool IsDynamicUpdate => string.Equals(updateType.GetValue(null)?.ToString(), "Dynamic", StringComparison.Ordinal);
            public string EditorRouting => ReadSetting("editorInputBehaviorInPlayMode");
            public bool RoutesInputToGame => Application.isFocused || EditorRouting == "AllDeviceInputAlwaysGoesToGameView";
            public bool UsesDynamicUpdate
            {
                get
                {
                    return ReadSetting("updateMode") == "ProcessEventsInDynamicUpdate";
                }
            }

            public void QueueState(object device, object button, float value, object position, Vector2 coordinates)
            {
                var arguments = new[] { device, null, eventAllocator };
                // StateEvent.From preserves unrelated controls. QueueEvent copies
                // the event, so its temporary native allocation is always disposed.
                using ((IDisposable)createStateEvent.Invoke(null, arguments))
                {
                    var eventPtr = arguments[1];
                    writeButton.Invoke(null, new[] { button, (object)value, eventPtr });
                    if (position != null) writePosition.Invoke(null, new[] { position, (object)coordinates, eventPtr });
                    queueEvent.Invoke(null, new[] { eventPtr });
                }
            }

            private string ReadSetting(string name)
            {
                var value = settings.GetValue(null);
                return value?.GetType().GetProperty(name)?.GetValue(value)?.ToString() ?? string.Empty;
            }
        }

        private sealed class PendingInput
        {
            public object Device;
            public object Button;
            public object Position;
            public Vector2 Coordinates;
            public UnityMcpInputReceipt Receipt;
            public bool Release;
            public bool Queued;
            public bool CleanupOnly;
            public double Deadline;
        }
    }
}
