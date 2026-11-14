import type { KeybindingCommand } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  type ShortcutEventLike,
} from "@t3tools/shared/keybindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { composerSubmissionIntentForKey } from "../composer-logic";
import {
  dispatchPreviewAction,
  subscribePreviewAction,
} from "../components/preview/previewActionBus";
import {
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
} from "../keybindings";
import { preventRepeatedTerminalCloseShortcut } from "../lib/terminalCloseShortcut";
import { prepareShortcutRecording, recordConsumedShortcut } from "./keybindingAnalytics";

const state = vi.hoisted(() => ({
  record: vi.fn(),
  otherRecord: vi.fn(),
  otherEnvironment: false,
}));
vi.mock("@t3tools/client-runtime/ardud/analytics", () => ({
  activeAnalytics: () => ({ record: state.otherEnvironment ? state.otherRecord : state.record }),
}));

const shortcut = (overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key: "k",
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.otherEnvironment = false;
  vi.stubGlobal("navigator", { platform: "Linux" });
});
afterEach(() => vi.unstubAllGlobals());

describe("shortcut consumption analytics", () => {
  it.each([
    { name: "ignored resolution", consumes: false, available: true, repeat: false, count: 0 },
    { name: "matched but unavailable", consumes: true, available: false, repeat: false, count: 0 },
    { name: "consumed command", consumes: true, available: true, repeat: false, count: 1 },
    { name: "repeat", consumes: true, available: true, repeat: true, count: 0 },
  ])("records $name only after execution", ({ consumes, available, repeat, count }) => {
    const event = shortcut({ repeat });
    const action = vi.fn();
    for (let index = 0; index < 4; index++) {
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS);
      isTerminalToggleShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS);
    }
    expect(state.record).not.toHaveBeenCalled();
    const command = resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS);
    if (consumes && available && !event.repeat && command === "commandPalette.toggle") {
      action();
      recordConsumedShortcut(event, command);
    }
    expect(action).toHaveBeenCalledTimes(count);
    expect(state.record).toHaveBeenCalledTimes(count);
  });

  it("deduplicates native events and React wrappers without suppressing the next keypress", () => {
    const nativeEvent = shortcut();
    recordConsumedShortcut({ ...nativeEvent, nativeEvent }, "commandPalette.toggle");
    recordConsumedShortcut(nativeEvent, "commandPalette.toggle");
    recordConsumedShortcut({ ...nativeEvent, nativeEvent }, "commandPalette.toggle");
    recordConsumedShortcut(shortcut(), "commandPalette.toggle");
    expect(state.record).toHaveBeenCalledTimes(2);
  });

  it.each(["wrapper", "native"])("suppresses a repeat flag on the %s event", (source) => {
    const nativeEvent = shortcut({ repeat: source === "native" });
    recordConsumedShortcut(
      { ...nativeEvent, repeat: source === "wrapper", nativeEvent },
      "chat.new",
    );
    expect(state.record).not.toHaveBeenCalled();
  });

  it("normalizes project script labels after primary and active environment matching", () => {
    const primary = compileResolvedKeybindingsConfig([
      { key: "mod+k", command: "script.primary.run" },
    ]);
    const active = compileResolvedKeybindingsConfig([
      { key: "mod+k", command: "script.private-build.run" },
    ]);
    const event = shortcut();
    const command = resolveChatShortcutCommand(event, primary, active);
    expect(command).toBe("script.private-build.run");
    expect(state.record).not.toHaveBeenCalled();
    recordConsumedShortcut(event, command);
    expect(state.record).toHaveBeenCalledExactlyOnceWith("command.keybinding", {
      props: { key: "projectScript" },
    });
    expect(JSON.stringify(state.record.mock.calls)).not.toContain("private-build");
  });

  it("keeps terminal probes, repeat prevention and composer submission intent pure", () => {
    const event = { ...shortcut({ key: "w", repeat: true }), preventDefault: vi.fn() };
    const options = { context: { terminalFocus: true, terminalOpen: true } };
    for (const matcher of [
      isTerminalToggleShortcut,
      isTerminalSplitShortcut,
      isTerminalSplitVerticalShortcut,
      isTerminalNewShortcut,
      isTerminalCloseShortcut,
    ]) {
      matcher(event, DEFAULT_RESOLVED_KEYBINDINGS, options);
    }
    expect(preventRepeatedTerminalCloseShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS)).toBe(true);
    expect(
      composerSubmissionIntentForKey({
        event: shortcut({ key: "Enter" }),
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        isSoftwareKeyboardOpen: false,
        isDraftThread: true,
      }),
    ).toBe("background");
    expect(state.record).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "records deferred execution only when confirmed=%s, in its original environment",
    (confirmed) => {
      const command: KeybindingCommand = "terminal.close";
      const record = prepareShortcutRecording(shortcut({ key: "w" }), command);
      expect(state.record).not.toHaveBeenCalled();
      state.otherEnvironment = true;
      if (confirmed) {
        record();
        record();
      }
      expect(state.record).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed)
        expect(state.record).toHaveBeenCalledWith("command.keybinding", {
          props: { key: command },
        });
      expect(state.otherRecord).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "no receiver", receiver: false, executes: false, count: 0 },
    { name: "unavailable receiver", receiver: true, executes: false, count: 0 },
    { name: "executed preview command", receiver: true, executes: true, count: 1 },
  ])("records $name only after the preview action is consumed", ({ receiver, executes, count }) => {
    vi.stubGlobal("window", new EventTarget());
    const probe = subscribePreviewAction(() => undefined);
    const stop = receiver ? subscribePreviewAction(() => executes) : () => {};
    try {
      if (dispatchPreviewAction("refresh"))
        recordConsumedShortcut(shortcut({ key: "r" }), "preview.refresh");
      expect(state.record).toHaveBeenCalledTimes(count);
    } finally {
      stop();
      probe();
    }
  });
});
