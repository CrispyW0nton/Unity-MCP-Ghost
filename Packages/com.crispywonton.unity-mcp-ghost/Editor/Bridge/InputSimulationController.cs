using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal static class InputSimulationController
    {
        private const int MaxReceipts = 100;
        private static readonly Dictionary<string, UnityMcpInputReceipt> Receipts = new Dictionary<string, UnityMcpInputReceipt>(StringComparer.Ordinal);
        private static readonly Queue<string> ReceiptOrder = new Queue<string>();

        public static string Simulate(string json)
        {
            if (!UnityEditor.EditorApplication.isPlaying)
            {
                return Failure("INPUT_REQUIRES_PLAY_MODE", "Input simulation requires normal Play mode.", string.Empty);
            }

            var request = new UnityMcpInputRequest
            {
                OperationId = Guid.NewGuid().ToString("N"),
                Device = JsonRpcUtil.ReadString(json, "device", "keyboard").ToLowerInvariant(),
                Action = JsonRpcUtil.ReadString(json, "action", "tap").ToLowerInvariant(),
                Key = JsonRpcUtil.ReadString(json, "key", string.Empty),
                Button = JsonRpcUtil.ReadString(json, "button", "left").ToLowerInvariant(),
                X = JsonRpcUtil.ReadFloat(json, "x", 0f),
                Y = JsonRpcUtil.ReadFloat(json, "y", 0f)
            };
            var backendPreference = JsonRpcUtil.ReadString(json, "backend", "auto").ToLowerInvariant();
            if (backendPreference != "auto" && backendPreference != "unity-input-system" && backendPreference != "project-test-driver")
            {
                return Failure("INVALID_INPUT_REQUEST", "Backend must be auto, unity-input-system, or project-test-driver.", request.OperationId);
            }
            var validation = Validate(request);
            if (!string.IsNullOrEmpty(validation))
            {
                return Failure("INVALID_INPUT_REQUEST", validation, request.OperationId);
            }

            var failures = new List<string>();
            var backend = UnityMcpInputBackendRegistry.Backend;
            if (backend != null && backendPreference != "project-test-driver")
            {
                try
                {
                    if (backend.TryStart(request, out var receipt, out var failureReason))
                    {
                        receipt = NormalizeReceipt(request, receipt, backend.BackendName);
                        Store(receipt);
                        return Serialize(receipt);
                    }
                    if (!string.IsNullOrWhiteSpace(failureReason))
                    {
                        failures.Add(backend.BackendName + ": " + failureReason);
                    }
                }
                catch (Exception exception)
                {
                    failures.Add(backend.BackendName + ": " + exception.Message);
                }
            }

            var drivers = backendPreference == "unity-input-system"
                ? Array.Empty<IUnityMcpInputDriver>()
                : Resources.FindObjectsOfTypeAll<MonoBehaviour>()
                .OfType<IUnityMcpInputDriver>()
                .Where(driver => !(driver is Behaviour behaviour) || behaviour.isActiveAndEnabled)
                .OrderBy(driver => driver.DriverName, StringComparer.Ordinal)
                .ToArray();
            foreach (var driver in drivers)
            {
                try
                {
                    if (!driver.TrySimulate(request, out var receipt, out var failureReason))
                    {
                        if (!string.IsNullOrWhiteSpace(failureReason))
                        {
                            failures.Add(driver.DriverName + ": " + failureReason);
                        }
                        continue;
                    }

                    receipt = NormalizeReceipt(request, receipt, "project-test-driver:" + driver.DriverName);
                    if (string.IsNullOrWhiteSpace(receipt.FocusTarget) && driver is MonoBehaviour component)
                    {
                        receipt.FocusTarget = HierarchyPath(component.transform);
                    }
                    Store(receipt);
                    return Serialize(receipt);
                }
                catch (Exception exception)
                {
                    failures.Add(driver.DriverName + ": " + exception.Message);
                }
            }

            var detail = failures.Count == 0
                ? "No verified backend matching '" + backendPreference + "' accepted the request."
                : string.Join("; ", failures);
            return Failure("UNSUPPORTED_INPUT_BACKEND", detail, request.OperationId);
        }

        public static string Status(string json)
        {
            var operationId = JsonRpcUtil.ReadString(json, "operationId", string.Empty);
            if (string.IsNullOrWhiteSpace(operationId))
            {
                return Failure("INPUT_OPERATION_ID_REQUIRED", "input.status requires operationId.", operationId);
            }

            var backend = UnityMcpInputBackendRegistry.Backend;
            if (backend != null && backend.TryGet(operationId, out var updated))
            {
                updated = NormalizeReceipt(new UnityMcpInputRequest { OperationId = operationId }, updated, backend.BackendName);
                Store(updated);
            }
            return Receipts.TryGetValue(operationId, out var receipt)
                ? Serialize(receipt)
                : Failure("INPUT_OPERATION_NOT_FOUND", "Input operation was not found or is no longer retained.", operationId);
        }

        internal static void ResetForTests()
        {
            Receipts.Clear();
            ReceiptOrder.Clear();
        }

        private static string Validate(UnityMcpInputRequest request)
        {
            if (request.Device == "keyboard")
            {
                if (request.Action != "tap" && request.Action != "press" && request.Action != "release")
                {
                    return "Keyboard action must be tap, press, or release.";
                }
                return string.IsNullOrWhiteSpace(request.Key) ? "Keyboard input requires key." : string.Empty;
            }
            if (request.Device == "pointer")
            {
                if (request.Action != "click" && request.Action != "press" && request.Action != "release")
                {
                    return "Pointer action must be click, press, or release.";
                }
                return request.Button == "left" ? string.Empty : "Only the left pointer button is currently supported.";
            }
            return "Device must be keyboard or pointer.";
        }

        private static UnityMcpInputReceipt NormalizeReceipt(UnityMcpInputRequest request, UnityMcpInputReceipt receipt, string backend)
        {
            receipt = receipt ?? new UnityMcpInputReceipt();
            receipt.OperationId = string.IsNullOrWhiteSpace(receipt.OperationId) ? request.OperationId : receipt.OperationId;
            receipt.Backend = string.IsNullOrWhiteSpace(receipt.Backend) ? backend : receipt.Backend;
            receipt.Action = string.IsNullOrWhiteSpace(receipt.Action) ? request.Action : receipt.Action;
            receipt.Status = string.IsNullOrWhiteSpace(receipt.Status) ? "completed" : receipt.Status;
            return receipt;
        }

        private static void Store(UnityMcpInputReceipt receipt)
        {
            if (!Receipts.ContainsKey(receipt.OperationId))
            {
                ReceiptOrder.Enqueue(receipt.OperationId);
            }
            Receipts[receipt.OperationId] = receipt;
            while (ReceiptOrder.Count > MaxReceipts)
            {
                Receipts.Remove(ReceiptOrder.Dequeue());
            }
        }

        private static string Serialize(UnityMcpInputReceipt receipt)
        {
            var requiresPress = receipt.Action != "release";
            var requiresRelease = receipt.Action == "tap" || receipt.Action == "click" || receipt.Action == "release";
            var ok = string.Equals(receipt.Status, "completed", StringComparison.Ordinal)
                && string.IsNullOrEmpty(receipt.ErrorCode)
                && (!requiresPress || receipt.PressObserved)
                && (!requiresRelease || receipt.ReleaseObserved);
            var value = new JObject
            {
                ["ok"] = ok || string.Equals(receipt.Status, "running", StringComparison.Ordinal),
                ["operationId"] = receipt.OperationId,
                ["status"] = receipt.Status,
                ["backend"] = receipt.Backend,
                ["action"] = receipt.Action,
                ["focusTarget"] = receipt.FocusTarget,
                ["pressFrame"] = receipt.PressFrame,
                ["releaseFrame"] = receipt.ReleaseFrame,
                ["pressObserved"] = receipt.PressObserved,
                ["releaseObserved"] = receipt.ReleaseObserved,
                ["deliveryEvidence"] = receipt.Evidence
            };
            if (!ok && !string.Equals(receipt.Status, "running", StringComparison.Ordinal))
            {
                value["error"] = new JObject
                {
                    ["code"] = string.IsNullOrWhiteSpace(receipt.ErrorCode) ? "INPUT_DELIVERY_NOT_VERIFIED" : receipt.ErrorCode,
                    ["message"] = string.IsNullOrWhiteSpace(receipt.ErrorMessage) ? "Input backend did not prove delivery." : receipt.ErrorMessage
                };
            }
            return value.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static string Failure(string code, string message, string operationId)
        {
            return new JObject
            {
                ["ok"] = false,
                ["operationId"] = string.IsNullOrWhiteSpace(operationId) ? null : operationId,
                ["status"] = "failed",
                ["error"] = new JObject { ["code"] = code, ["message"] = message }
            }.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static string HierarchyPath(Transform transform)
        {
            var value = transform.name;
            while (transform.parent != null)
            {
                transform = transform.parent;
                value = transform.name + "/" + value;
            }
            return value;
        }
    }
}
