import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

const state = vi.hoisted(() => ({
  record: vi.fn(),
  navigate: vi.fn(),
  goBack: vi.fn(),
  dispatch: vi.fn(),
  copy: vi.fn(),
  registeredHandlerConsumed: false,
  canGoBack: false,
  paletteOpen: false,
}));
vi.mock("@t3tools/client-runtime/ardud/analytics", () => ({
  activeAnalytics: () => ({ record: state.record }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A,>(callback: A) => callback,
  useMemo: <A,>(factory: () => A) => factory(),
  useRef: <A,>(current: A) => ({ current }),
  useEffect: () => {},
  useState: <A,>(initial: A) => [
    typeof initial === "boolean" ? state.paletteOpen : initial,
    vi.fn(),
  ],
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string) => ({ name }) },
  useNavigation: () => ({
    navigate: state.navigate,
    goBack: state.goBack,
    dispatch: state.dispatch,
    canGoBack: () => state.canGoBack,
  }),
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: state.copy }));
vi.mock("../../native/T3KeyboardCommands", () => ({ T3KeyboardCommands: "KeyboardCommands" }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../threads/GitActionProgressOverlay", () => ({ GitActionProgressOverlay: "Progress" }));
vi.mock("./CommandPalette", () => ({ CommandPalette: "Palette" }));
vi.mock("./hardwareKeyboardCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hardwareKeyboardCommands")>()),
  dispatchHardwareKeyboardCommand: () => state.registeredHandlerConsumed,
}));

import { HardwareKeyboardCommandProvider } from "./HardwareKeyboardCommandProvider";

type NodeProps = {
  children?: ReactNode;
  value?: ReactNode;
  onCommand?: (command: HardwareKeyboardCommand) => void;
};
function commandHandler(node: ReactNode, type: string): NonNullable<NodeProps["onCommand"]> {
  const find = (node: ReactNode): NodeProps["onCommand"] => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const handler = find(child);
        if (handler) return handler;
      }
      return undefined;
    }
    if (!isValidElement<NodeProps>(node)) return undefined;
    if (node.type === type) return node.props.onCommand;
    return find(node.props.children) ?? find(node.props.value);
  };
  const handler = find(node);
  if (!handler) throw new Error(`Missing ${type} command handler`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.registeredHandlerConsumed = false;
  state.canGoBack = false;
  state.paletteOpen = false;
  state.copy.mockResolvedValue(false);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("native keyboard execution analytics", () => {
  it.each([
    { name: "unhandled command", pathname: "/settings", command: "focusSearch", calls: 0 },
    { name: "unavailable copy", pathname: "/settings", command: "copyThreadReference", calls: 0 },
    { name: "unavailable thread screen", pathname: "/settings", command: "files", calls: 0 },
    {
      name: "already active screen",
      pathname: "/threads/env/thread/files",
      command: "files",
      calls: 0,
    },
    { name: "opened thread screen", pathname: "/threads/env/thread", command: "files", calls: 1 },
    { name: "new task", pathname: "/", command: "newTask", calls: 1 },
    { name: "opened palette", pathname: "/", command: "commandPalette", calls: 1 },
    { name: "back at home", pathname: "/", command: "back", calls: 0 },
  ] as const)("records $name only when executed", ({ pathname, command, calls }) => {
    const node = HardwareKeyboardCommandProvider({ pathname });
    commandHandler(node, "KeyboardCommands")(command);
    expect(state.record).toHaveBeenCalledTimes(calls);
    if (calls)
      expect(state.record).toHaveBeenCalledWith("command.keybinding", { props: { key: command } });
  });

  it("records a command consumed by a registered handler once", () => {
    state.registeredHandlerConsumed = true;
    const node = HardwareKeyboardCommandProvider({ pathname: "/" });
    commandHandler(node, "KeyboardCommands")("focusSearch");
    expect(state.record).toHaveBeenCalledExactlyOnceWith("command.keybinding", {
      props: { key: "focusSearch" },
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("executes palette selections without labelling them as hardware keybindings", () => {
    state.paletteOpen = true;
    const node = HardwareKeyboardCommandProvider({ pathname: "/" });
    commandHandler(node, "Palette")("newTask");
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith("NewTaskSheet", { screen: "NewTask" });
    expect(state.record).not.toHaveBeenCalled();
    commandHandler(node, "KeyboardCommands")("commandPalette");
    expect(state.record).not.toHaveBeenCalled();
  });
});
