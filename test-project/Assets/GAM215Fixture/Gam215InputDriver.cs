using CrispyWonton.UnityMcpGhost;
using UnityEngine;

public sealed class Gam215InputDriver : MonoBehaviour, IUnityMcpInputDriver
{
    public int PageIndex;
    public int PointerClicks;
    public string DriverName => "gam215-fixture";

    private void Start()
    {
        Debug.Log("GAM215_FIXTURE_READY:0");
    }

    public bool TrySimulate(UnityMcpInputRequest request, out UnityMcpInputReceipt receipt, out string failureReason)
    {
        receipt = null;
        failureReason = string.Empty;
        if (request.Device == "keyboard" && request.Action == "tap")
        {
            if (request.Key == "PageUp")
            {
                PageIndex++;
            }
            else if (request.Key == "PageDown")
            {
                PageIndex--;
            }
            else
            {
                failureReason = "Fixture driver supports PageUp and PageDown taps only.";
                return false;
            }
            Debug.Log("GAM215_PAGE:" + PageIndex);
        }
        else if (request.Device == "pointer" && request.Action == "click")
        {
            PointerClicks++;
            Debug.Log("GAM215_POINTER_CLICK:" + PointerClicks);
        }
        else
        {
            failureReason = "Fixture driver did not accept this device/action pair.";
            return false;
        }

        receipt = new UnityMcpInputReceipt
        {
            OperationId = request.OperationId,
            Action = request.Action,
            Backend = "project-test-driver:gam215-fixture",
            FocusTarget = gameObject.name,
            PressFrame = Time.frameCount,
            ReleaseFrame = Time.frameCount,
            PressObserved = true,
            ReleaseObserved = true,
            Evidence = request.Device == "keyboard"
                ? "Fixture state changed to page " + PageIndex + " and emitted GAM215_PAGE."
                : "Fixture pointer-click count changed to " + PointerClicks + " and emitted GAM215_POINTER_CLICK."
        };
        return true;
    }

    private void OnGUI()
    {
        GUI.Label(new Rect(20, 20, 400, 30), "GAM 215 fixture page: " + PageIndex);
        GUI.Label(new Rect(20, 50, 400, 30), "Pointer clicks: " + PointerClicks);
    }
}
