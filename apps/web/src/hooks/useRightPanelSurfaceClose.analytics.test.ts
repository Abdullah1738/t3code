import {
  createAnalyticsCollector,
  registerEnvironmentAnalytics,
  setActiveAnalyticsEnvironment,
  type ClientAnalyticsEvent,
} from "@t3tools/client-runtime/ardud/analytics";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareShortcutRecording } from "../ardud/keybindingAnalytics";
import { isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const state = vi.hoisted(() => ({
  dialogAvailable: true,
  confirm: vi.fn<(message: string, options: { variant: string }) => Promise<boolean>>(),
  terminalConfirmations: [] as Promise<boolean>[],
  scopes: new Set<string>(),
  browserController: "agent" as "agent" | "human" | "none",
  terminalSessions: new Set<string>(),
  previewSessions: new Set<string>(),
  closeTerminalUi: vi.fn<(ref: ScopedThreadRef, id: string) => void>(),
  closeTerminalSession: vi.fn<(id: string) => void>(),
  closePreviewSession: vi.fn<(input: { threadRef: ScopedThreadRef; tabId: string }) => void>(),
}));

vi.mock("../rightPanelStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rightPanelStore")>();
  return {
    ...original,
    useRightPanelStore: Object.assign(
      (select: (store: ReturnType<typeof original.useRightPanelStore.getState>) => unknown) =>
        select(original.useRightPanelStore.getState()),
      original.useRightPanelStore,
    ),
  };
});
vi.mock("./useStableCallback", () => ({ useStableCallback: <A>(callback: A) => callback }));
vi.mock("../localApi", () => ({
  readLocalApi: () => (state.dialogAvailable ? { dialogs: { confirm: state.confirm } } : null),
}));
vi.mock("../lib/terminalCloseConfirm", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/terminalCloseConfirm")>();
  return {
    ...original,
    confirmTerminalClose: (...args: Parameters<typeof original.confirmTerminalClose>) => {
      const pending = original.confirmTerminalClose(...args);
      state.terminalConfirmations.push(pending);
      return pending;
    },
  };
});
vi.mock("../components/terminal/useThreadTerminalActions", () => ({
  useThreadTerminalActions: () => ({ closeTerminalSession: state.closeTerminalSession }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (
    select: (store: { closeTerminal: typeof state.closeTerminalUi }) => unknown,
  ) => select({ closeTerminal: state.closeTerminalUi }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: (_environmentId: EnvironmentId, scope: string) => state.scopes.has(scope),
  useEnvironmentScope: (_environmentId: EnvironmentId | null, scope: string) =>
    state.scopes.has(scope),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../previewStateStore", () => ({
  useThreadPreviewState: () => ({
    sessions: {},
    desktopByTabId: { "tab-1": { controller: state.browserController } },
  }),
  setActivePreviewTab: vi.fn(),
}));
vi.mock("../components/preview/closePreviewSession", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    closePreviewSession: async (input: { threadRef: ScopedThreadRef; tabId: string }) => {
      state.closePreviewSession(input);
      state.previewSessions.delete(input.tabId);
      return AsyncResult.success(undefined);
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const threadRef = {
  environmentId: EnvironmentId.make("close-env"),
  threadId: ThreadId.make("thread"),
};
const events: ClientAnalyticsEvent[] = [];
let collector: ReturnType<typeof createAnalyticsCollector>;
let unregister: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.dialogAvailable = true;
  state.confirm.mockResolvedValue(true);
  state.terminalConfirmations = [];
  state.scopes = new Set([AuthPreviewOperateScope, AuthTerminalOperateScope]);
  state.browserController = "agent";
  state.terminalSessions.clear();
  state.previewSessions.clear();
  state.closeTerminalSession.mockImplementation((id) => {
    state.terminalSessions.delete(id);
  });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  useRightPanelStore.getState().open(threadRef, "files");
  events.length = 0;
  collector = createAnalyticsCollector({
    surface: "web",
    now: () => 0,
    send: async (batch) => {
      events.push(...batch);
    },
  });
  unregister = registerEnvironmentAnalytics(threadRef.environmentId, collector);
  setActiveAnalyticsEnvironment(threadRef.environmentId);
});
afterEach(() => {
  unregister();
  setActiveAnalyticsEnvironment(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(isTerminalCloseConfirmPending()).toBe(false);
});

const surfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces;
function openSurface(kind: "terminal" | "browser"): RightPanelSurface {
  const store = useRightPanelStore.getState();
  if (kind === "terminal") {
    store.openTerminal(threadRef, "terminal-1");
    store.splitTerminal(threadRef, "terminal:terminal-1", "terminal-2");
    state.terminalSessions = new Set(["terminal-1", "terminal-2"]);
  } else {
    store.openBrowser(threadRef, "tab-1");
    state.previewSessions.add("tab-1");
  }
  const surface = surfaces().find(
    (entry) => entry.kind === (kind === "browser" ? "preview" : kind),
  );
  if (!surface) throw new Error("Missing test surface");
  return surface;
}
function closeFromShortcut(surface: RightPanelSurface, ref: ScopedThreadRef | null = threadRef) {
  useRightPanelSurfaceClose({ threadRef: ref, terminalLabelsById: new Map() }).closeSurface(
    surface,
    prepareShortcutRecording(
      { key: "w", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      "rightPanel.close",
    ),
  );
}
async function expectAnalytics(count: number) {
  await collector.flush();
  expect(events).toHaveLength(count);
  if (count)
    expect(events).toMatchObject([
      { kind: "command.keybinding", surface: "web", props: { key: "rightPanel.close" } },
    ]);
}
function expectUntouched(surface: RightPanelSurface) {
  expect(surfaces()).toContainEqual(surface);
  expect(state.closeTerminalSession).not.toHaveBeenCalled();
  expect(state.closeTerminalUi).not.toHaveBeenCalled();
  expect(state.closePreviewSession).not.toHaveBeenCalled();
  if (surface.kind === "terminal") expect([...state.terminalSessions]).toEqual(surface.terminalIds);
  if (surface.kind === "preview") expect([...state.previewSessions]).toEqual([surface.resourceId]);
}
function expectClosed(surface: RightPanelSurface) {
  expect(surfaces()).not.toContainEqual(surface);
  expect(surfaces()).toEqual([{ id: "files", kind: "files" }]);
  if (surface.kind === "terminal") {
    expect(state.closeTerminalSession.mock.calls).toEqual(surface.terminalIds.map((id) => [id]));
    expect(state.closeTerminalUi.mock.calls).toEqual(
      surface.terminalIds.map((id) => [threadRef, id]),
    );
    expect(state.terminalSessions.size).toBe(0);
    expect(state.closePreviewSession).not.toHaveBeenCalled();
  } else if (surface.kind === "preview") {
    expect(state.closePreviewSession).toHaveBeenCalledOnce();
    expect(state.closePreviewSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadRef, tabId: surface.resourceId }),
    );
    expect(state.previewSessions.size).toBe(0);
    expect(state.closeTerminalSession).not.toHaveBeenCalled();
    expect(state.closeTerminalUi).not.toHaveBeenCalled();
  }
}

describe.each(["terminal", "browser"] as const)("%s surface shortcut confirmation", (kind) => {
  it.each(["cancelled", "rejected", "confirmed"] as const)(
    "records only an actual close when %s",
    async (outcome) => {
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const surface = openSurface(kind);
      closeFromShortcut(surface);
      expect(state.confirm).toHaveBeenCalledOnce();
      const settled = state.terminalConfirmations.at(-1) ?? confirmation.promise;
      try {
        expectUntouched(surface);
        await expectAnalytics(0);
        if (kind === "terminal") expect(isTerminalCloseConfirmPending()).toBe(true);
        if (outcome === "rejected") confirmation.reject(new Error("Dialog unavailable"));
        else confirmation.resolve(outcome === "confirmed");
        await settled.catch(() => undefined);
        if (outcome === "confirmed") expectClosed(surface);
        else expectUntouched(surface);
        await expectAnalytics(outcome === "confirmed" ? 1 : 0);
      } finally {
        confirmation.resolve(false);
        await settled.catch(() => undefined);
      }
    },
  );

  it("preserves existing behavior when the dialog API is unavailable", async () => {
    state.dialogAvailable = false;
    const surface = openSurface(kind);
    closeFromShortcut(surface);
    const settled = state.terminalConfirmations.at(-1);
    if (settled) await settled;
    expect(state.confirm).not.toHaveBeenCalled();
    if (kind === "terminal") expectClosed(surface);
    else expectUntouched(surface);
    await expectAnalytics(kind === "terminal" ? 1 : 0);
  });
});

describe("surface closes without confirmation", () => {
  it.each([
    { id: "diff", kind: "diff" },
    {
      id: "file:src/app.ts",
      kind: "file",
      relativePath: "src/app.ts",
      revealLine: null,
      revealRequestId: 0,
    },
    { id: "device", kind: "device" },
    {
      id: "pull-request:1",
      kind: "pull-request",
      projectId: "project",
      repository: "repo",
      number: 1,
    },
    { id: "pull-requests", kind: "pull-requests" },
    { id: "browser:new", kind: "preview", resourceId: null },
  ] satisfies RightPanelSurface[])("records synchronous $kind dismissal", async (surface) => {
    useRightPanelStore.setState({
      byThreadKey: {
        [scopedThreadKey(threadRef)]: {
          isOpen: true,
          activeSurfaceId: surface.id,
          surfaces: [{ id: "files", kind: "files" }, surface],
        },
      },
    });
    closeFromShortcut(surface);
    expect(surfaces()).toEqual([{ id: "files", kind: "files" }]);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.closeTerminalSession).not.toHaveBeenCalled();
    expect(state.closeTerminalUi).not.toHaveBeenCalled();
    expect(state.closePreviewSession).not.toHaveBeenCalled();
    await expectAnalytics(1);
  });

  it.each(["human", "none"] as const)(
    "closes a browser controlled by %s without a dialog",
    async (controller) => {
      state.browserController = controller;
      const surface = openSurface("browser");
      closeFromShortcut(surface);
      expectClosed(surface);
      expect(state.confirm).not.toHaveBeenCalled();
      await expectAnalytics(1);
    },
  );

  it("closes only the local terminal surface without terminal permission", async () => {
    state.scopes.delete(AuthTerminalOperateScope);
    const surface = openSurface("terminal");
    closeFromShortcut(surface);
    expect(surfaces()).toEqual([{ id: "files", kind: "files" }]);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.closeTerminalSession).not.toHaveBeenCalled();
    expect(state.closeTerminalUi).not.toHaveBeenCalled();
    expect(state.terminalSessions.size).toBe(2);
    await expectAnalytics(1);
  });

  it("does not record or release resources without a thread destination", async () => {
    const surface = openSurface("terminal");
    closeFromShortcut(surface, null);
    expectUntouched(surface);
    expect(state.confirm).not.toHaveBeenCalled();
    await expectAnalytics(0);
  });
});
