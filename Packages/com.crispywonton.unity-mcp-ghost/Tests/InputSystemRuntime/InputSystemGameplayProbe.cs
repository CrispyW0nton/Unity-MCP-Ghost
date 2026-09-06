using UnityEngine;
using UnityEngine.InputSystem;

namespace CrispyWonton.UnityMcpGhost.Runtime.Tests
{
    // Deliberately consumes the normal game loop, not a backend receipt or a
    // callback in the injector. A claimed delivery cannot set these observations.
    public sealed class InputSystemGameplayProbe : MonoBehaviour
    {
        public Keyboard Keyboard;
        public Mouse Mouse;
        public TextMesh PageText;
        public int PageIndex;
        public int PageUpPresses;
        public int PageDownPresses;
        public int Releases;
        public int Clicks;
        public int ActionClicks;
        public int PressFrame = -1;
        public int ReleaseFrame = -1;
        public Vector2 ClickPosition;
        public Vector2 ActionClickPosition;
        private InputAction clickAction;

        public void ObserveClickActions()
        {
            clickAction = new InputAction("Owned pointer click", InputActionType.Button);
            clickAction.AddBinding(Mouse.leftButton);
            clickAction.performed += ObserveClick;
            clickAction.Enable();
        }

        private void ObserveClick(InputAction.CallbackContext context)
        {
            ActionClicks++;
            ActionClickPosition = Mouse.position.ReadValue();
        }

        private void OnDestroy()
        {
            clickAction?.Dispose();
        }

        private void Update()
        {
            if (Keyboard.pageUpKey.wasPressedThisFrame)
            {
                PageIndex++;
                PageUpPresses++;
                PressFrame = Time.frameCount;
            }
            if (Keyboard.pageDownKey.wasPressedThisFrame)
            {
                PageIndex--;
                PageDownPresses++;
                PressFrame = Time.frameCount;
            }
            if (Keyboard.pageUpKey.wasReleasedThisFrame || Keyboard.pageDownKey.wasReleasedThisFrame)
            {
                Releases++;
                ReleaseFrame = Time.frameCount;
            }
            if (Mouse.leftButton.wasPressedThisFrame)
            {
                Clicks++;
                ClickPosition = Mouse.position.ReadValue();
                PressFrame = Time.frameCount;
            }
            if (Mouse.leftButton.wasReleasedThisFrame)
            {
                Releases++;
                ReleaseFrame = Time.frameCount;
            }
            PageText.text = "Page " + PageIndex;
        }
    }
}
