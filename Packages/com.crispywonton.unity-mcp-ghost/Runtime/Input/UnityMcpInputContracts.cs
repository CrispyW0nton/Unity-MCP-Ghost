using System;

namespace CrispyWonton.UnityMcpGhost
{
    [Serializable]
    public sealed class UnityMcpInputRequest
    {
        public string OperationId = string.Empty;
        public string Device = string.Empty;
        public string Action = string.Empty;
        public string Key = string.Empty;
        public string Button = string.Empty;
        public float X;
        public float Y;
    }

    [Serializable]
    public sealed class UnityMcpInputReceipt
    {
        public string OperationId = string.Empty;
        public string Status = "completed";
        public string Backend = string.Empty;
        public string Action = string.Empty;
        public string FocusTarget = string.Empty;
        public int PressFrame = -1;
        public int ReleaseFrame = -1;
        public bool PressObserved;
        public bool ReleaseObserved;
        public string Evidence = string.Empty;
        public string ErrorCode = string.Empty;
        public string ErrorMessage = string.Empty;
    }

    public interface IUnityMcpInputDriver
    {
        string DriverName { get; }
        bool TrySimulate(UnityMcpInputRequest request, out UnityMcpInputReceipt receipt, out string failureReason);
    }

    public interface IUnityMcpInputBackend
    {
        string BackendName { get; }
        bool TryStart(UnityMcpInputRequest request, out UnityMcpInputReceipt receipt, out string failureReason);
        bool TryGet(string operationId, out UnityMcpInputReceipt receipt);
    }

    public static class UnityMcpInputBackendRegistry
    {
        public static IUnityMcpInputBackend Backend { get; set; }
    }
}
