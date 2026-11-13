import { activeAnalytics } from "@t3tools/client-runtime/ardud/analytics";
import type { KeybindingCommand } from "@t3tools/contracts";
import type { ShortcutEventLike } from "@t3tools/shared/keybindings";
import { projectScriptIdFromCommand } from "../projectScripts";

const executions = new WeakMap<ShortcutEventLike, { recorded: boolean }>();

export function recordConsumedShortcut(
  event: ShortcutEventLike & { readonly nativeEvent?: ShortcutEventLike },
  command: KeybindingCommand | null,
) {
  prepareShortcutRecording(event, command)();
}

export function prepareShortcutRecording(
  event: ShortcutEventLike & { readonly nativeEvent?: ShortcutEventLike },
  command: KeybindingCommand | null,
) {
  const nativeEvent = event.nativeEvent ?? event;
  const execution = executions.get(nativeEvent) ?? { recorded: false };
  executions.set(nativeEvent, execution);
  const collector = activeAnalytics();
  const repeated = event.repeat || nativeEvent.repeat;
  // Deferred handlers retain the shared marker, so event objects remain collectible.
  return () => {
    if (command === null || repeated || !collector || execution.recorded) return;
    execution.recorded = true;
    collector.record("command.keybinding", {
      props: { key: projectScriptIdFromCommand(command) === null ? command : "projectScript" },
    });
  };
}
