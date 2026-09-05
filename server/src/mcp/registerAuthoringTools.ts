import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ComponentValueSchema, DryRunSchema, ParamsSchema, registerUnityRequestTool, type ToolContext } from "./createServer.js";

export function registerAuthoringTools(server: McpServer, context: ToolContext): void {
  registerUnityRequestTool(
    server,
    context,
    "scene_create",
    "Create a new Unity scene for level, menu, or gameplay prototyping work.",
    {
      setup: z.enum(["empty", "default"]).default("default"),
      mode: z.enum(["single", "additive"]).default("single"),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.create"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_open",
    "Open a Unity scene asset by path.",
    {
      path: z.string().min(1),
      mode: z.enum(["single", "additive"]).default("single"),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.open"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_set_active",
    "Set the active Unity scene by path or name.",
    {
      path: z.string().optional(),
      name: z.string().optional(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.set_active"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_unload",
    "Unload an open additive Unity scene by path or name.",
    {
      path: z.string().optional(),
      name: z.string().optional(),
      removeScene: z.boolean().default(true),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.unload"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_scene",
    "Compatibility tool for scene actions.",
    {
      action: z.enum(["create", "open", "save", "save_all", "list_open", "get_setup", "set_active", "unload"]),
      params: ParamsSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `scene.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "component_add",
    "Add a Unity component to a GameObject by type name, such as BoxCollider, Rigidbody, AudioSource, or a project MonoBehaviour.",
    {
      instanceId: z.number().int(),
      type: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "component.add"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_get",
    "Read components on a GameObject, or read one component by component instance ID.",
    {
      instanceId: z.number().int().optional(),
      componentInstanceId: z.number().int().optional(),
      type: z.string().optional(),
      maxProperties: z.number().int().positive().max(200).default(80)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    "component.get"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_modify",
    "Modify a serialized component property through Unity SerializedObject, with dry-run support.",
    {
      componentInstanceId: z.number().int().optional(),
      instanceId: z.number().int().optional(),
      type: z.string().optional(),
      propertyPath: z.string().min(1),
      value: ComponentValueSchema,
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "component.modify"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_remove",
    "Remove a Unity component by component instance ID.",
    {
      componentInstanceId: z.number().int(),
      dryRun: DryRunSchema
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2 },
    "component.remove"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_component",
    "Compatibility tool for component add/get/modify/remove actions.",
    {
      action: z.enum(["add", "get", "modify", "remove"]),
      params: ParamsSchema
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2, destructive: true },
    (args) => `component.${args.action}`,
    (args) => args.params
  );
}
