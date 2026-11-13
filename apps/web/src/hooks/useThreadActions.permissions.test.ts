import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  createAnalyticsCollector,
  registerEnvironmentAnalytics,
  setActiveAnalyticsEnvironment,
  type ClientAnalyticsEvent,
} from "@t3tools/client-runtime/ardud/analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareShortcutRecording } from "../ardud/keybindingAnalytics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
    pinnedAt: string | null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
  failedMutations: new Set<string>(),
  mutationBarrier: undefined as ((action: string) => Promise<void>) | undefined,
  dialogAvailable: true,
  confirmThreadUnpin: true,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      if (state.mutationBarrier) await state.mutationBarrier(action);
      if (state.failedMutations.has(action)) {
        return AsyncResult.failure(Cause.fail(new Error("Mutation failed")));
      }
      state.afterRequest?.(action);
      if (action === "unpin") {
        const thread = state.threads.find(
          (thread) =>
            thread.environmentId === request.environmentId && thread.id === request.input.threadId,
        );
        if (thread) thread.pinnedAt = null;
      }
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (environmentId: string) =>
    state.sessionLookupFails
      ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
      : AsyncResult.success({
          authenticated: true,
          scopes: [...(state.scopes.get(environmentId) ?? [])],
          auth: { serverUpdateScope: "environment:maintain" },
        }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => (state.dialogAvailable ? { dialogs: { confirm: state.confirm } } : null),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: state.confirmThreadUnpin,
    }),
}));

import { useThreadActions } from "./useThreadActions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
      pinnedAt: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  state.failedMutations.clear();
  state.mutationBarrier = undefined;
  state.dialogAvailable = true;
  state.confirmThreadUnpin = true;
});

describe("unpin shortcut confirmation analytics", () => {
  const pinnedAt = "2026-11-13T00:00:00.000Z";
  const events: ClientAnalyticsEvent[] = [];
  let collector: ReturnType<typeof createAnalyticsCollector>;
  let unregister: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.pinnedAt = pinnedAt;
    collector = createAnalyticsCollector({
      surface: "web",
      now: () => 0,
      send: async (batch) => {
        events.push(...batch);
      },
    });
    unregister = registerEnvironmentAnalytics(secondary, collector);
    setActiveAnalyticsEnvironment(secondary);
  });
  afterEach(() => {
    unregister();
    setActiveAnalyticsEnvironment(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const unpinFromShortcut = () =>
    useThreadActions().confirmAndUnpinThread(target, {
      onUnpinned: prepareShortcutRecording(
        { key: "p", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        "thread.pin",
      ),
    });
  const expectAnalytics = async (count: number) => {
    await collector.flush();
    expect(events).toHaveLength(count);
    if (count)
      expect(events).toMatchObject([
        { kind: "command.keybinding", surface: "web", props: { key: "thread.pin" } },
      ]);
  };

  it.each([
    { outcome: "cancelled", result: "Success", mutations: 0, records: 0 },
    { outcome: "rejected", result: "Failure", mutations: 0, records: 0 },
    { outcome: "confirmed", result: "Success", mutations: 1, records: 1 },
    { outcome: "revoked", result: "Failure", mutations: 0, records: 0 },
    { outcome: "mutation failed", result: "Failure", mutations: 1, records: 0 },
  ] as const)(
    "records only the completed unpin when $outcome",
    async ({ outcome, result, mutations, records }) => {
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const pending = unpinFromShortcut();
      expect(state.confirm).toHaveBeenCalledOnce();
      expect(state.requests).toEqual([]);
      expect(state.threads[0]!.pinnedAt).toBe(pinnedAt);
      await expectAnalytics(0);

      if (outcome === "revoked") state.scopes.get(secondary)!.clear();
      if (outcome === "mutation failed") state.failedMutations.add("unpin");
      if (outcome === "rejected") confirmation.reject(new Error("Dialog unavailable"));
      else confirmation.resolve(outcome !== "cancelled");
      const settled = await pending;

      expect(settled._tag).toBe(result);
      expect(state.requests).toHaveLength(mutations);
      if (mutations)
        expect(state.requests).toEqual([
          { action: "unpin", environmentId: secondary, input: { threadId: target.threadId } },
        ]);
      expect(state.threads[0]!.pinnedAt).toBe(records ? null : pinnedAt);
      expect(state.localEffects).toEqual([]);
      await expectAnalytics(records);
    },
  );

  it("waits for mutation success after confirmation before recording", async () => {
    const started = deferred<void>();
    const mutation = deferred<void>();
    state.mutationBarrier = (action) => {
      if (action !== "unpin") throw new Error("Unexpected mutation");
      started.resolve();
      return mutation.promise;
    };
    const pending = unpinFromShortcut();
    await started.promise;
    expect(state.requests).toHaveLength(1);
    expect(state.threads[0]!.pinnedAt).toBe(pinnedAt);
    await expectAnalytics(0);
    mutation.resolve();
    expect((await pending)._tag).toBe("Success");
    expect(state.threads[0]!.pinnedAt).toBeNull();
    await expectAnalytics(1);
  });

  it("does not record or open a dialog without the target permission", async () => {
    state.scopes.get(secondary)!.clear();
    expect((await unpinFromShortcut())._tag).toBe("Failure");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests).toEqual([]);
    expect(state.threads[0]!.pinnedAt).toBe(pinnedAt);
    await expectAnalytics(0);
  });

  it.each([
    { reason: "unavailable dialog API", dialogAvailable: false, confirmationEnabled: true },
    { reason: "disabled confirmation", dialogAvailable: true, confirmationEnabled: false },
  ])("records the actual unpin with $reason", async ({ dialogAvailable, confirmationEnabled }) => {
    state.dialogAvailable = dialogAvailable;
    state.confirmThreadUnpin = confirmationEnabled;
    expect((await unpinFromShortcut())._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests).toEqual([
      { action: "unpin", environmentId: secondary, input: { threadId: target.threadId } },
    ]);
    expect(state.threads[0]!.pinnedAt).toBeNull();
    await expectAnalytics(1);
  });
});

describe("thread action permissions", () => {
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("identifies the missing task scope when thread deletion is denied", async () => {
    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected permission denial");
    const error = Cause.squash<unknown>(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});
