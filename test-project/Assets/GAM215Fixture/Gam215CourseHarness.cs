using System;
using System.Globalization;
using UnityEngine;

public sealed class Gam215CourseHarness : MonoBehaviour
{
    public string LastAction = string.Empty;
    public string CurrentScene = string.Empty;
    public string Target = string.Empty;
    public string VisibleText = string.Empty;
    public bool Visible;
    public int CallCount;

    public static Gam215CourseHarness Active { get; private set; }

    private Camera courseCamera;
    private GameObject visualTarget;
    private Material visualMaterial;

    private void Awake()
    {
        Active = this;
        LastAction = string.Empty;
        CurrentScene = string.Empty;
        Target = string.Empty;
        VisibleText = string.Empty;
        Visible = false;
        CallCount = 0;
        EnsureVisuals();
        ApplyVisualState();
    }

    private void OnDestroy()
    {
        if (Active == this)
        {
            Active = null;
        }
        if (visualMaterial != null)
        {
            Destroy(visualMaterial);
        }
    }

    public void Record(string action, string scene, string target, string value, bool visible)
    {
        LastAction = action ?? string.Empty;
        CurrentScene = scene ?? string.Empty;
        Target = target ?? string.Empty;
        VisibleText = value ?? string.Empty;
        Visible = visible;
        CallCount++;
        ApplyVisualState();
        Debug.Log(string.Format(
            CultureInfo.InvariantCulture,
            "MARVIN|{0}|{1}|{2}|{3}|{4}",
            LastAction,
            CurrentScene,
            Target,
            VisibleText,
            Visible ? "true" : "false"));
    }

    private void EnsureVisuals()
    {
        var cameraObject = new GameObject("GAM215 Evidence Camera");
        cameraObject.tag = "MainCamera";
        courseCamera = cameraObject.AddComponent<Camera>();
        courseCamera.clearFlags = CameraClearFlags.SolidColor;
        courseCamera.orthographic = true;
        courseCamera.orthographicSize = 2f;
        cameraObject.transform.position = new Vector3(0f, 0f, -10f);

        visualTarget = GameObject.CreatePrimitive(PrimitiveType.Quad);
        visualTarget.name = "GAM215 Visible State";
        visualTarget.transform.localScale = new Vector3(2.5f, 1.25f, 1f);
        var shader = Shader.Find("Unlit/Color");
        if (shader != null)
        {
            visualMaterial = new Material(shader);
            visualTarget.GetComponent<Renderer>().sharedMaterial = visualMaterial;
        }
    }

    private void ApplyVisualState()
    {
        var hash = StableHash(LastAction + "|" + CurrentScene + "|" + Target + "|" + VisibleText);
        var red = 0.15f + ((hash & 0xff) / 255f) * 0.45f;
        var green = 0.15f + (((hash >> 8) & 0xff) / 255f) * 0.45f;
        var blue = 0.15f + (((hash >> 16) & 0xff) / 255f) * 0.45f;
        if (courseCamera != null)
        {
            courseCamera.backgroundColor = new Color(red * 0.45f, green * 0.45f, blue * 0.45f, 1f);
        }
        if (visualTarget != null)
        {
            visualTarget.SetActive(Visible);
            if (visualMaterial != null)
            {
                visualMaterial.color = new Color(red, green, blue, 1f);
            }
        }
    }

    private static int StableHash(string value)
    {
        unchecked
        {
            var hash = 17;
            foreach (var character in value ?? string.Empty)
            {
                hash = (hash * 31) + character;
            }
            return hash & 0x7fffffff;
        }
    }
}

public static class Marvin
{
    public static void Play(string scene)
    {
        RequireHarness().Record("Play", scene, string.Empty, scene, true);
    }

    public static void Write(string label, string value)
    {
        RequireHarness().Record("Write", "Module1", label, value, true);
    }

    public static void Write(string label, int value)
    {
        Write(label, value.ToString(CultureInfo.InvariantCulture));
    }

    public static void Write(string label, float value)
    {
        Write(label, value.ToString("0.###", CultureInfo.InvariantCulture));
    }

    public static void Write(string scene, string label, string value)
    {
        RequireHarness().Record("Write", scene, label, value, true);
    }

    public static void Write(string scene, string label, int value)
    {
        Write(scene, label, value.ToString(CultureInfo.InvariantCulture));
    }

    public static void Write(string scene, string label, float value)
    {
        Write(scene, label, value.ToString("0.###", CultureInfo.InvariantCulture));
    }

    public static void ShowOrHide(string scene, string target, bool visible)
    {
        RequireHarness().Record("ShowOrHide", scene, target, visible ? "true" : "false", visible);
    }

    public static void Draw(string scene, string target, string state)
    {
        RequireHarness().Record("Draw", scene, target, state, true);
    }

    private static Gam215CourseHarness RequireHarness()
    {
        if (Gam215CourseHarness.Active == null)
        {
            throw new InvalidOperationException("The clean-room GAM 215 scene is missing Gam215CourseHarness.");
        }
        return Gam215CourseHarness.Active;
    }
}
