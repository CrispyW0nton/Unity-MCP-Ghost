namespace CrispyWonton.UnityMcpGhost.Editor
{
    internal sealed partial class CommandRegistry
    {
        public CommandRegistry()
        {
            RegisterCoreCommands();
            RegisterRuntimeCommands();
            RegisterScenarioCommands();
            RegisterAuthoringCommands();
            RegisterAnalysisCommands();
            RegisterCodeAndPackageCommands();
            RegisterOperationCommands();
        }

        private void RegisterCoreCommands()
        {
            Register("ping", HandlePing);
            Register("health", HandleHealth);
            Register("editor.get_state", HandleEditorState);
        }

        private void RegisterRuntimeCommands()
        {
            Register("console.get_logs", HandleConsoleLogs);
            Register("console.diagnostics_get", HandleConsoleDiagnostics);
            Register("console.clear", request => ConsoleLogBuffer.Clear());
            Register("console.mark", request => ConsoleLogBuffer.MarkBoundary(JsonRpcUtil.ReadString(request.RawJson, "label", string.Empty)));
            Register("console.query", request => ConsoleLogBuffer.Query(request.RawJson, false));
            Register("console.assert", request => ConsoleLogBuffer.Query(request.RawJson, true));
            Register("play_mode.get", request => PlayModeController.Get());
            Register("play_mode.set", request => PlayModeController.Set(request.RawJson));
            Register("play_mode.step", request => PlayModeController.Step());
            Register("input.simulate", request => InputSimulationController.Simulate(request.RawJson));
            Register("input.status", request => InputSimulationController.Status(request.RawJson));
            Register("screenshot.capture", HandleScreenshotCapture);
            Register("screenshot.diff", HandleScreenshotDiff);
            Register("screenshot.baselines_list", HandleScreenshotBaselinesList);
            Register("screenshot.baselines_cleanup", HandleScreenshotBaselinesCleanup);
        }

        private void RegisterScenarioCommands()
        {
            Register("editor.snapshot", request => ScenarioBridgeController.CaptureEditorState());
            Register("editor.restore_snapshot", request => ScenarioBridgeController.RestoreEditorState(request.RawJson));
            Register("scenario.source_apply", request => ScenarioBridgeController.ApplySources(request.RawJson));
            Register("scenario.source_restore", request => ScenarioBridgeController.RestoreSources(request.RawJson));
            Register("scenario.source_complete", request => ScenarioBridgeController.CompleteSources(request.RawJson));
            Register("scenario.source_get", request => ScenarioBridgeController.GetSourceTransaction(request.RawJson));
            Register("runtime.inspect", request => ScenarioBridgeController.InspectRuntime(request.RawJson, false));
            Register("runtime.assert", request => ScenarioBridgeController.InspectRuntime(request.RawJson, true));
        }

        private void RegisterAuthoringCommands()
        {
            Register("player.build", HandlePlayerBuild);
            Register("scene.get_hierarchy", HandleSceneHierarchy);
            Register("scene.create", HandleSceneCreate);
            Register("scene.open", HandleSceneOpen);
            Register("scene.save", HandleSceneSave);
            Register("scene.save_all", HandleSceneSaveAll);
            Register("scene.list_open", HandleSceneListOpen);
            Register("scene.get_setup", HandleSceneGetSetup);
            Register("scene.set_active", HandleSceneSetActive);
            Register("scene.unload", HandleSceneUnload);
            Register("gameobject.create", HandleGameObjectCreate);
            Register("gameobject.create_primitive", HandleGameObjectCreatePrimitive);
            Register("gameobject.set_transform", HandleGameObjectSetTransform);
            Register("gameobject.find", HandleGameObjectFind);
            Register("gameobject.get", HandleGameObjectGet);
            Register("gameobject.delete", HandleGameObjectDelete);
            Register("gameobject.duplicate", HandleGameObjectDuplicate);
            Register("gameobject.set_parent", HandleGameObjectSetParent);
            Register("component.add", HandleComponentAdd);
            Register("component.get", HandleComponentGet);
            Register("component.modify", HandleComponentModify);
            Register("component.remove", HandleComponentRemove);
            Register("asset.find", HandleAssetFind);
            Register("asset.create_folder", HandleAssetCreateFolder);
            Register("asset.move", HandleAssetMove);
            Register("asset.copy", HandleAssetCopy);
            Register("asset.delete", HandleAssetDelete);
            Register("asset.refresh", HandleAssetRefresh);
            Register("prefab.create", HandlePrefabCreate);
            Register("prefab.instantiate", HandlePrefabInstantiate);
        }

        private void RegisterAnalysisCommands()
        {
            Register("semantic.asset_references_trace", HandleSemanticAssetReferencesTrace);
            Register("prefab.references_trace", HandleSemanticAssetReferencesTrace);
            Register("semantic.unity_event_bindings_find", HandleSemanticUnityEventBindingsFind);
            Register("semantic.animator_analyze", HandleSemanticAnimatorAnalyze);
            Register("semantic.meta_integrity_check", HandleSemanticMetaIntegrityCheck);
            Register("semantic.unused_assets_find", HandleSemanticUnusedAssetsFind);
            Register("semantic.class_impact_analyze", HandleSemanticClassImpactAnalyze);
            Register("semantic.call_path_find", HandleSemanticCallPathFind);
            Register("semantic.lint_unity_run", HandleSemanticLintUnityRun);
            Register("semantic.project_index_summary", HandleSemanticProjectIndexSummary);
            Register("semantic.test_scope_suggest", HandleSemanticTestScopeSuggest);
        }

        private void RegisterCodeAndPackageCommands()
        {
            Register("compile.diagnostics_get", HandleCompileDiagnostics);
            Register("script.read", HandleScriptRead);
            Register("script.create", HandleScriptCreate);
            Register("script.write", HandleScriptWrite);
            Register("script.apply_edits", HandleScriptApplyEdits);
            Register("script.delete", HandleScriptDelete);
            Register("script.restore", HandleScriptRestore);
            Register("script.transaction_complete", HandleScriptTransactionComplete);
            Register("script.validate", HandleScriptValidate);
            Register("package.list", HandlePackageList);
            Register("package.search", HandlePackageSearch);
            Register("package.add", HandlePackageAdd);
            Register("package.remove", HandlePackageRemove);
        }

        private void RegisterOperationCommands()
        {
            Register("operation.get", HandleOperationGet);
            Register("operation.list", HandleOperationList);
            Register("operation.cancel", HandleOperationCancel);
            Register("compile.wait", HandleCompileWait);
            Register("compile.status_get", HandleCompileStatusGet);
            Register("tests.run", HandleTestsRun);
            Register("batch.execute", HandleBatchExecute);
        }
    }
}
