import { recordConsumedShortcut } from "../../ardud/keybindingAnalytics";
import {
  AuthOrchestrationOperateScope,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { useRemoteOpenState } from "../../remoteOpen";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const remote = useRemoteOpenState(environmentId);

  useEffect(() => {
    if (!enabled || remote.mode !== "local-exec") return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      void openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: preferredEditor,
        },
      });
      if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        recordConsumedShortcut(event, "editor.openFavorite");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    openInEditorMutation,
    preferredEditor,
    remote.mode,
  ]);
}
