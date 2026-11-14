import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isTerminalToggleShortcut, resolveShortcutCommand } from "../../keybindings";
import { useChatShortcuts, type ChatShortcutsInput } from "./useChatShortcuts";

const state = vi.hoisted(() => ({
  record: vi.fn(),
  cleanups: [] as Array<() => void>,
  paletteOpen: false,
  confirmPending: false,
  terminalOwner: null as "drawer" | null,
}));
vi.mock("@t3tools/client-runtime/ardud/analytics", () => ({
  activeAnalytics: () => ({ record: state.record }),
}));
vi.mock("react", () => ({
  useRef: <A>(current: A) => ({ current }),
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: (effect: () => () => void) => state.cleanups.push(effect()),
}));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => state.paletteOpen }));
vi.mock("../../lib/terminalCloseConfirm", () => ({
  isTerminalCloseConfirmPending: () => state.confirmPending,
}));
vi.mock("../../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => state.terminalOwner }));
vi.mock("./composerFocusRedirect", () => ({ shouldTypeToFocusComposer: () => false }));

class Keypress extends Event {
  readonly key: string;
  readonly ctrlKey = true;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey = false;
  readonly isComposing = false;
  constructor(
    key = "k",
    readonly repeat = false,
  ) {
    super("keydown", { cancelable: true });
    this.key = key;
  }
}

function input(overrides: Partial<ChatShortcutsInput> = {}): ChatShortcutsInput {
  return {
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    typeIntoComposer: () => false,
    closeThreadFind: vi.fn(),
    commands: {},
    fallback: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paletteOpen = false;
  state.confirmPending = false;
  state.terminalOwner = null;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { platform: "Linux" });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("chat shortcut execution analytics", () => {
  it("records one execution when several listeners inspect the same keypress", () => {
    const action = vi.fn(() => true);
    const probes = vi.fn((event: Event) => {
      if (!(event instanceof Keypress)) throw new Error("Unexpected event");
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS);
      isTerminalToggleShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS);
    });
    window.addEventListener("keydown", (event) => probes(event));
    useChatShortcuts(input({ commands: { "commandPalette.toggle": action } }));
    window.addEventListener("keydown", probes);
    const event = new Keypress();
    window.dispatchEvent(event);
    expect(probes).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(1);
    expect(state.record).toHaveBeenCalledExactlyOnceWith("command.keybinding", {
      props: { key: "commandPalette.toggle" },
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { name: "no handler", result: "absent", repeat: false, count: 0, prevented: false },
    { name: "unavailable command", result: false, repeat: false, count: 0, prevented: false },
    { name: "claimed no-op", result: undefined, repeat: false, count: 0, prevented: true },
    { name: "executed command", result: true, repeat: false, count: 1, prevented: true },
    { name: "repeated command", result: true, repeat: true, count: 0, prevented: true },
  ] as const)(
    "handles $name without changing propagation",
    ({ result, repeat, count, prevented }) => {
      useChatShortcuts(
        input({ commands: result === "absent" ? {} : { "commandPalette.toggle": () => result } }),
      );
      const event = new Keypress("k", repeat);
      window.dispatchEvent(event);
      expect(state.record).toHaveBeenCalledTimes(count);
      expect(event.defaultPrevented).toBe(prevented);
    },
  );

  it.each(["pending confirmation", "repeated close"])(
    "does not count %s as terminal execution",
    (reason) => {
      state.confirmPending = reason === "pending confirmation";
      state.terminalOwner = "drawer";
      const close = vi.fn(() => true);
      useChatShortcuts(input({ commands: { "terminal.close": close } }));
      const event = new Keypress("w", reason === "repeated close");
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(state.record).not.toHaveBeenCalled();
    },
  );

  it("uses the active environment script once after probing primary bindings", () => {
    const execute = vi.fn(() => true);
    useChatShortcuts(
      input({
        keybindings: compileResolvedKeybindingsConfig([
          { key: "mod+k", command: "script.primary.run" },
        ]),
        scriptKeybindings: compileResolvedKeybindingsConfig([
          { key: "mod+k", command: "script.active-private.run" },
        ]),
        fallback: (command) => (command === "script.active-private.run" ? execute : undefined),
      }),
    );
    window.dispatchEvent(new Keypress());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.record).toHaveBeenCalledExactlyOnceWith("command.keybinding", {
      props: { key: "projectScript" },
    });
  });
});
