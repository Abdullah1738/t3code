import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  KANBAN_WS_METHODS,
  WS_METHODS,
  AnalyticsIngestInput,
  ORCHESTRATION_V2_WS_METHODS,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { createKanbanClient } from "./kanban/client.ts";
import type { KanbanTransport } from "./kanban/transport.ts";
import {
  createAnalyticsCollector,
  registerEnvironmentAnalytics,
  recordAnalytics,
  analyticsForEnvironment,
  analyticsOwnerAction,
  analyticsErrorTag,
  analyticsWebScreen,
  analyticsNavigationScreen,
  sanitizeAnalyticsEvent,
  sampleAnalyticsFrames,
  type ClientAnalyticsEvent,
  analyticsRpcSerialization,
  flushEnvironmentAnalytics,
  setActiveAnalyticsEnvironment,
} from "./analytics.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function collector(
  send = vi.fn(async (_events: ReadonlyArray<ClientAnalyticsEvent>) => {}),
  maxEvents?: number,
) {
  const value = createAnalyticsCollector({
    surface: "web",
    send,
    ...(maxEvents ? { maxEvents } : {}),
  });
  disposers.push(value.dispose);
  return { value, send };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const flushClasses = ["time", "size", "background", "close"] as const;
describe("client analytics batching", () => {
  it.each(
    flushClasses.flatMap((trigger) => [
      { trigger, fails: false },
      { trigger, fails: true },
    ]),
  )(
    "drains $trigger requests made during an active flight (first flight fails: $fails)",
    async ({ trigger, fails }) => {
      vi.useFakeTimers();
      const entered = deferred();
      const release = deferred();
      const accepted: ClientAnalyticsEvent[] = [];
      let sending = 0;
      let maxSending = 0;
      let attempts = 0;
      const send = vi.fn(async (events: ReadonlyArray<ClientAnalyticsEvent>) => {
        sending++;
        maxSending = Math.max(maxSending, sending);
        try {
          if (++attempts === 1) {
            entered.resolve();
            await release.promise;
            if (fails) throw new Error("private failure");
          }
          accepted.push(...events);
        } finally {
          sending--;
        }
      });
      const { value } = collector(send);
      value.record("owner.action", { props: { key: "first" } });
      const flight = value.flush();
      await entered.promise;
      value.record("owner.action", { props: { key: "arrival" } });
      let completed = flight;
      if (trigger === "time") await vi.advanceTimersByTimeAsync(10_000);
      else if (trigger === "size") {
        for (let i = 0; i < 99; i++) value.record("owner.action", { props: { key: `size-${i}` } });
      } else completed = value.background(trigger);
      expect(send).toHaveBeenCalledTimes(1);
      release.resolve();
      await completed;
      expect(value.pending()).toBe(0);
      expect(maxSending).toBe(1);
      expect(accepted.filter((event) => event.props?.key === "first")).toHaveLength(1);
      expect(accepted.filter((event) => event.props?.key === "arrival")).toHaveLength(1);
      if (trigger === "background" || trigger === "close") {
        expect(accepted).toContainEqual(
          expect.objectContaining({
            kind: "client.lifecycle",
            props: expect.objectContaining({ phase: trigger }),
          }),
        );
        expect(accepted.some((event) => event.kind === "screen.dwell")).toBe(true);
      }
      expect(send.mock.calls.every(([events]) => events.length <= 100)).toBe(true);
    },
  );

  it.each(["background", "close"] as const)(
    "bounds failed %s drains and retains arrivals for the next timed retry",
    async (phase) => {
      vi.useFakeTimers();
      const entered = deferred();
      const release = deferred();
      let attempts = 0;
      let sending = 0;
      let maxSending = 0;
      const send = vi.fn(async (_events: ReadonlyArray<ClientAnalyticsEvent>): Promise<void> => {
        sending++;
        maxSending = Math.max(maxSending, sending);
        try {
          if (++attempts === 1) {
            entered.resolve();
            await release.promise;
          }
          throw new Error("private failure");
        } finally {
          sending--;
        }
      });
      const { value } = collector(send, 200);
      value.record("owner.action", { props: { key: "retained" } });
      const flight = value.flush();
      await entered.promise;
      for (let i = 0; i < 10_000; i++) value.record("owner.action", { props: { count: i } });
      const closes = Array.from({ length: 5 }, () => value.background(phase));
      expect(value.pending()).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      release.resolve();
      await Promise.all([flight, ...closes]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(value.pending()).toBe(200);
      expect(maxSending).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(3);
      expect(value.pending()).toBe(200);
      const successful: ClientAnalyticsEvent[] = [];
      send.mockImplementation(async (events) => {
        successful.push(...events);
      });
      await value.flush();
      expect(value.pending()).toBe(0);
      expect(successful[0]).toMatchObject({ props: { key: "retained" } });
      expect(send.mock.calls.every(([events]) => events.length <= 100)).toBe(true);
    },
  );

  it("keeps close pending until arrivals during the final flight and RPC summaries are drained", async () => {
    const firstEntered = deferred(),
      firstRelease = deferred();
    const finalEntered = deferred(),
      finalRelease = deferred();
    const accepted: ClientAnalyticsEvent[] = [];
    let attempts = 0;
    const send = vi.fn(async (events: ReadonlyArray<ClientAnalyticsEvent>) => {
      const attempt = ++attempts;
      if (attempt === 1) {
        firstEntered.resolve();
        await firstRelease.promise;
      }
      if (attempt === 2) {
        finalEntered.resolve();
        await finalRelease.promise;
      }
      accepted.push(...events);
    });
    const { value } = collector(send);
    value.record("owner.action");
    const flight = value.flush();
    await firstEntered.promise;
    value.record("owner.action");
    let closed = false;
    const closing = value.background("close").then(() => {
      closed = true;
    });
    firstRelease.resolve();
    await finalEntered.promise;
    expect(closed).toBe(false);
    value.record("owner.action", { props: { key: "late-arrival" } });
    value.beginRpc(WS_METHODS.serverGetConfig)(10, 32);
    finalRelease.resolve();
    await Promise.all([flight, closing]);
    expect(value.pending()).toBe(0);
    expect(send).toHaveBeenCalledTimes(3);
    expect(accepted).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ key: "late-arrival" }) }),
    );
    expect(accepted).toContainEqual(
      expect.objectContaining({
        kind: "rpc.summary",
        props: expect.objectContaining({ count: 1, bytes: 32 }),
      }),
    );
  });
  it("sends 100 events as one request, then flushes the remainder after ten seconds", async () => {
    vi.useFakeTimers();
    const { value, send } = collector();
    for (let i = 0; i < 99; i++) value.record("owner.action");
    expect(send).not.toHaveBeenCalled();
    value.record("owner.action");
    await value.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(100);
    value.record("owner.action");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(value.pending()).toBe(0);
  });
  it("flushes on background and close, excluding background time from dwell", async () => {
    vi.useFakeTimers();
    const { value, send } = collector();
    value.setRoute({ route: "board", boardId: "robob" });
    const stop = value.trackScreen({ route: "ask", cardId: "card-1" });
    await vi.advanceTimersByTimeAsync(300);
    await value.background("background");
    await vi.advanceTimersByTimeAsync(5_000);
    value.foreground();
    await vi.advanceTimersByTimeAsync(200);
    stop();
    await value.background("close");
    const all = send.mock.calls.flatMap(([events]) => events);
    expect(all).toContainEqual(
      expect.objectContaining({ kind: "screen.dwell", route: "ask", durationMs: 500 }),
    );
    expect(
      all.filter((event) => event.kind === "client.lifecycle").map((event) => event.props?.phase),
    ).toEqual(["background", "active", "close"]);
    expect(value.pending()).toBe(0);
  });
  it("retains a failed batch, bounds events during failure and retries without overlap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async (_events: ReadonlyArray<ClientAnalyticsEvent>): Promise<void> => {
      await gate;
      throw new Error("private error text");
    });
    const { value } = collector(send, 200);
    for (let i = 0; i < 100; i++) value.record("owner.action", { props: { count: i } });
    const first = value.flush();
    await Promise.resolve();
    for (let i = 0; i < 1_000; i++) value.record("owner.action");
    expect(value.pending()).toBeLessThanOrEqual(200);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(value.pending()).toBe(200);
    send.mockImplementation(async () => {});
    await value.flush();
    expect(send.mock.calls.slice(1).every(([events]) => events.length <= 100)).toBe(true);
    expect(value.pending()).toBe(0);
    expect(send.mock.calls[1]![0][0]).toMatchObject({ kind: "owner.action", props: { count: 0 } });
  });
  it("aggregates durations, byte counts and failures, and suppresses ingest recursion", async () => {
    const { value, send } = collector();
    for (const duration of [10, 20, 30, 40, 100])
      value.beginRpc(WS_METHODS.serverGetConfig)(duration, 20);
    value.beginRpc(WS_METHODS.serverGetConfig)(150, 10, "TypeError");
    value.beginRpc(WS_METHODS.analyticsIngest)(500, 1000);
    expect(send).not.toHaveBeenCalled();
    await value.flush();
    expect(send.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        kind: "rpc.summary",
        props: expect.objectContaining({
          method: WS_METHODS.serverGetConfig,
          p50Ms: 30,
          p95Ms: 100,
          count: 5,
          bytes: 100,
        }),
      }),
      expect.objectContaining({
        kind: "rpc.summary",
        props: expect.objectContaining({ errorTag: "TypeError", count: 1 }),
      }),
    ]);
  });
  it("keeps environments isolated, including an action completing after another server is selected", async () => {
    const a = collector();
    const b = collector();
    disposers.push(
      registerEnvironmentAnalytics("a", a.value),
      registerEnvironmentAnalytics("b", b.value),
    );
    const finish = analyticsForEnvironment("a")!.beginRpc(WS_METHODS.serverGetConfig);
    recordAnalytics("b", "screen.open", { boardId: "board-b" });
    finish(10, 12);
    recordAnalytics("missing", "owner.action");
    await a.value.flush();
    await b.value.flush();
    expect(a.send.mock.calls[0]![0]).toHaveLength(1);
    expect(a.send.mock.calls[0]![0][0]!.kind).toBe("rpc.summary");
    expect(b.send.mock.calls[0]![0]).toHaveLength(1);
    expect(b.send.mock.calls[0]![0][0]!.boardId).toBe("board-b");
  });
  it("ends frame sampling after a fixed number of frames", () => {
    const { value } = collector();
    const callbacks: Array<(time: number) => void> = [];
    sampleAnalyticsFrames(
      value,
      (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      () => {},
    );
    for (let i = 0; i < 12; i++) callbacks[i]!(i * 16.7);
    expect(callbacks).toHaveLength(12);
  });
  it("flushes all environment queues on background while recording lifecycle only on the active one", async () => {
    const a = collector();
    const b = collector();
    disposers.push(
      registerEnvironmentAnalytics("flush-a", a.value),
      registerEnvironmentAnalytics("flush-b", b.value),
    );
    setActiveAnalyticsEnvironment("flush-a");
    a.value.record("owner.action");
    b.value.beginRpc(WS_METHODS.serverGetConfig)(10, 100);
    await flushEnvironmentAnalytics("background");
    expect(a.send.mock.calls[0]![0].some((event) => event.kind === "client.lifecycle")).toBe(true);
    expect(b.send.mock.calls[0]![0].map((event) => event.kind)).toEqual(["rpc.summary"]);
    setActiveAnalyticsEnvironment(null);
  });

  it("counts received transport bytes per unary method without retaining or reserializing results", async () => {
    const { value, send } = collector();
    disposers.push(registerEnvironmentAnalytics("wire-env", value));
    const parser = analyticsRpcSerialization("wire-env").makeUnsafe();
    parser.encode({
      _tag: "Request",
      id: 1,
      tag: WS_METHODS.serverGetConfig,
      payload: { text: "private outgoing payload" },
    });
    parser.encode({ _tag: "Request", id: 2, tag: WS_METHODS.analyticsIngest, payload: {} });
    const response = {
      _tag: "Exit",
      requestId: 1,
      exit: { _tag: "Success", value: { text: "private response 😀" } },
    };
    const raw = JSON.stringify(response);
    expect(parser.decode(raw)).toEqual([response]);
    value.beginRpc(WS_METHODS.serverGetConfig)(20, 0);
    parser.decode(JSON.stringify({ _tag: "Exit", requestId: 2, exit: { _tag: "Success" } }));
    await value.flush();
    const events = send.mock.calls.flatMap(([batch]) => batch);
    expect(events).toHaveLength(1);
    expect(events[0]!.props).toMatchObject({
      method: WS_METHODS.serverGetConfig,
      bytes: new TextEncoder().encode(raw).byteLength,
      count: 1,
    });
    expect(JSON.stringify(events)).not.toContain("private");
  });
});

describe("analytics privacy", () => {
  it("records real shared pick/poll confirmations and dropped asks with creation metadata", async () => {
    const { value, send } = collector();
    const request = vi.fn(async () => ({
      boardId: "robob",
      discussionId: "discussion-1",
      asks: [
        {
          id: "q1",
          at: "2020-01-01T00:00:00.000Z",
          options: [{ id: "approve", label: "private option" }],
        },
      ],
    }));
    const transport: KanbanTransport = {
      analytics: () => value,
      permission: () => Atom.make(true),
      permissionStatus: () => Atom.make("granted" as const),
      stream: () => () => {},
      request: request as unknown as KanbanTransport["request"],
    };
    const client = createKanbanClient(transport);
    for (const phase of ["pick", "poll"] as const) {
      await client.answer("robob", "discussion-1", 1, "block-1", ["approve"], "private answer", {
        phase,
        createdAt: "2020-01-01T00:00:00.000Z",
      });
    }
    await client.changeAsk("card-1", "q1", "drop");
    request.mockRejectedValueOnce(new Error("private refusal"));
    await expect(
      client.answer("robob", "discussion-1", 1, "block-1", ["approve"], "private", {
        phase: "pick",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    await value.flush();
    const events = send.mock.calls.flatMap(([batch]) => batch);
    expect(
      events.filter((event) => event.kind === "ask.answered").map((event) => event.props?.phase),
    ).toEqual(["pick", "poll"]);
    expect(
      events
        .filter((event) => event.kind === "ask.answered")
        .every(
          (event) =>
            typeof event.durationMs === "number" &&
            event.props?.createdAt === "2020-01-01T00:00:00.000Z",
        ),
    ).toBe(true);
    expect(events.find((event) => event.kind === "ask.dropped")).toMatchObject({
      boardId: "robob",
      cardId: "card-1",
      props: { phase: "pick", reason: "closed", createdAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(JSON.stringify(events)).not.toContain("private");
  });
  it("rebuilds events from the metadata allowlist and never exports free text or URLs", () => {
    const event = sanitizeAnalyticsEvent({
      ts: "2026-11-13T12:00:00.000Z",
      kind: "owner.action",
      surface: "web",
      route: "/boards/robob?query=secret",
      boardId: "robob",
      threadId: "https://server/private",
      durationMs: Infinity,
      text: "private prompt",
      message: "private message",
      error: "private error",
      url: "https://server/?token=secret",
      props: {
        method: KANBAN_WS_METHODS.cardPatch,
        key: "theme",
        errorTag: "private-error-token",
        phase: "private phase",
        queryLength: 12,
        answer: "private answer",
        query: "private query",
        settingsValue: "private setting",
      },
    });
    expect(event).toEqual({
      ts: "2026-11-13T12:00:00.000Z",
      kind: "owner.action",
      surface: "web",
      route: "other",
      boardId: "robob",
      props: { method: KANBAN_WS_METHODS.cardPatch, key: "theme", queryLength: 12 },
    });
    expect(Schema.is(AnalyticsIngestInput)({ events: [event] })).toBe(true);
    expect(sanitizeAnalyticsEvent({ ...event, surface: "server" })).toBeUndefined();
    expect(analyticsErrorTag(new Error("private message"))).toBe("Error");
  });
  it("infers mutation metadata only from IDs and known methods", () => {
    const metadata = analyticsOwnerAction(KANBAN_WS_METHODS.cardPatch, {
      cardId: "card-1",
      boardId: "robob",
      prompt: "private prompt",
      text: "private text",
      settings: { theme: "secret" },
    });
    expect(metadata).toEqual({
      cardId: "card-1",
      boardId: "robob",
      props: { method: KANBAN_WS_METHODS.cardPatch, key: "prompt" },
    });
    expect(
      analyticsOwnerAction(KANBAN_WS_METHODS.cardPatch, {
        cardId: "card-1",
        stage: "working",
        priority: 1,
        comment: "private comment",
      })?.props?.key,
    ).toBe("stage.priority.comment");
    expect(analyticsOwnerAction(WS_METHODS.analyticsIngest, {})).toBeUndefined();
    expect(
      analyticsOwnerAction(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "message.dispatch",
        threadId: "thread-1",
        text: "private prompt",
      }),
    ).toEqual({
      threadId: "thread-1",
      props: { method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand, key: "message.dispatch" },
    });
    expect(analyticsOwnerAction("private method", {})).toBeUndefined();
  });
  it("keeps only recognized route templates and explicitly allowed navigation params", () => {
    expect(analyticsWebScreen("/boards/robob?query=private")).toEqual({
      details: { route: "board", boardId: "robob" },
    });
    expect(
      analyticsNavigationScreen("KanbanRecord", {
        environmentId: "a",
        kind: "card",
        boardId: "robob",
        id: "card-1",
        title: "private title",
        url: "https://private",
      }),
    ).toEqual({
      environmentId: "a",
      details: { route: "card", boardId: "robob", cardId: "card-1" },
    });
  });
});

type RpcMethodClass = "mutation" | "read" | "stream" | "report" | "ingest";
const wsMethodClasses = {
  projectsList: "read",
  projectsAdd: "mutation",
  projectsRemove: "mutation",
  projectsListEntries: "read",
  projectsReadFile: "read",
  projectsSearchContents: "read",
  projectsSearchEntries: "read",
  projectsWriteFile: "mutation",
  projectsMutate: "mutation",
  projectsEnsureScratch: "mutation",
  projectsCreateNew: "mutation",
  shellOpenInEditor: "mutation",
  filesystemBrowse: "read",
  filesystemGetMetadata: "read",
  agentSessionsScan: "read",
  agentSessionsImport: "mutation",
  assetsCreateUrl: "read",
  assetsPersistChatAttachments: "mutation",
  attachmentsCreateUploadUrl: "mutation",
  attachmentsDelete: "mutation",
  mcpAppsCallTool: "mutation",
  mcpAppsToolInfo: "read",
  mcpAppsReadResource: "read",
  mcpAppsUpdateModelContext: "mutation",
  providerUploadFeedback: "mutation",
  providerAuthStart: "mutation",
  providerConsumeResetCredit: "mutation",
  providerAuthComplete: "mutation",
  chatGptReconnectProfile: "mutation",
  chatGptImportProfile: "mutation",
  chatGptHandoffSubscribe: "stream",
  codexAuthCallbackSubscribe: "stream",
  providerAuthRespond: "mutation",
  providerAuthCancel: "mutation",
  providerAuthLogout: "mutation",
  providerAuthSubscribe: "stream",
  providerInstallStart: "mutation",
  providerInstallCancel: "mutation",
  providerInstallSubscribe: "stream",
  providerInstallRemove: "mutation",
  vcsPull: "mutation",
  vcsRefreshStatus: "mutation",
  vcsListRefs: "read",
  vcsCreateWorktree: "mutation",
  vcsRemoveWorktree: "mutation",
  vcsCreateRef: "mutation",
  vcsSwitchRef: "mutation",
  vcsInit: "mutation",
  gitRunStackedAction: "stream",
  gitResolvePullRequest: "read",
  gitPreparePullRequestThread: "mutation",
  reviewGetDiffPreview: "read",
  reviewGetDiffFileContents: "read",
  terminalOpen: "mutation",
  terminalAttach: "stream",
  terminalObserve: "stream",
  terminalWrite: "mutation",
  terminalResize: "mutation",
  terminalClear: "mutation",
  terminalRestart: "mutation",
  terminalClose: "mutation",
  previewOpen: "mutation",
  previewNavigate: "mutation",
  previewResize: "mutation",
  previewAdjust: "mutation",
  previewRefresh: "mutation",
  previewClose: "mutation",
  previewList: "read",
  previewClearProfile: "mutation",
  previewReportProfiles: "report",
  previewReportStatus: "report",
  deviceConfigure: "mutation",
  deviceList: "read",
  deviceTestHost: "read",
  deviceOpen: "mutation",
  deviceClose: "mutation",
  deviceShutdown: "mutation",
  deviceDetail: "read",
  deviceAction: "mutation",
  serverProbe: "read",
  serverGetConfig: "read",
  serverRefreshProviders: "mutation",
  serverUpdateProvider: "mutation",
  serverUpdateServer: "mutation",
  serverUpdateServerWithProgress: "stream",
  serverCommitDesktopUpdate: "mutation",
  serverUpsertKeybinding: "mutation",
  serverRemoveKeybinding: "mutation",
  serverRunStorageCleanup: "mutation",
  serverGetStorageCleanupReport: "stream",
  serverGetDatabaseStorage: "stream",
  serverGetSettings: "read",
  serverUpdateSettings: "mutation",
  serverDiscoverSourceControl: "read",
  serverSearchAcpRegistry: "read",
  serverPrepareAcpRegistryAgent: "mutation",
  serverUninstallAcpRegistryManagedBinary: "mutation",
  serverAcceptAcpRegistryUrlAuth: "mutation",
  serverListAcpRegistrySessions: "read",
  serverImportAcpRegistrySession: "mutation",
  serverDeleteAcpRegistrySession: "mutation",
  serverListAcpRegistryProviders: "read",
  serverSetAcpRegistryProvider: "mutation",
  serverDisableAcpRegistryProvider: "mutation",
  serverLogoutAcpRegistry: "mutation",
  serverGetTraceDiagnostics: "read",
  serverGetProcessDiagnostics: "read",
  serverGetHostResources: "read",
  serverGetProcessResourceHistory: "read",
  serverGetResourceTelemetryHistory: "read",
  serverRetryResourceTelemetry: "mutation",
  serverCheckOtlpEndpoint: "read",
  serverSignalProcess: "mutation",
  analyticsIngest: "ingest",
  serverReportClientActivity: "report",
  serverReportHostPowerState: "report",
  serverGetBackgroundPolicy: "read",
  serverGetUsageSummary: "read",
  serverRefreshUsageRates: "mutation",
  scheduledTasksList: "read",
  scheduledTasksSubscribe: "stream",
  scheduledTasksUpsert: "mutation",
  scheduledTasksSetEnabled: "mutation",
  scheduledTasksDelete: "mutation",
  scheduledTasksRunNow: "mutation",
  scheduledTasksRotateWebhookToken: "mutation",
  secretsAnswerRequest: "mutation",
  secretsAnswerAsk: "mutation",
  scheduledTasksListWebhookDeliveries: "read",
  scheduledTasksGetWebhookDelivery: "read",
  cloudGetRelayClientStatus: "read",
  cloudInstallRelayClient: "stream",
  pullRequestsList: "read",
  pullRequestsListStats: "read",
  pullRequestsSummary: "read",
  pullRequestsRouting: "read",
  pullRequestsRoutingIdentity: "read",
  pullRequestsStack: "read",
  pullRequestsLinkedThreads: "read",
  pullRequestsDetail: "read",
  pullRequestsPreview: "read",
  pullRequestsChecks: "read",
  pullRequestsActivity: "read",
  pullRequestsReviewGuide: "read",
  pullRequestsGenerateReviewGuide: "mutation",
  pullRequestsThreadComments: "read",
  pullRequestsDiffFileContents: "read",
  pullRequestsFilesViewed: "read",
  pullRequestsSetFilesViewed: "mutation",
  pullRequestsRunAction: "mutation",
  pullRequestsUpdate: "mutation",
  pullRequestsComment: "mutation",
  pullRequestsUpdateComment: "mutation",
  pullRequestsSubmitReview: "mutation",
  pullRequestsReplyToThread: "mutation",
  pullRequestsSetThreadResolution: "mutation",
  pullRequestsSetReaction: "mutation",
  pullRequestsInvalidate: "mutation",
  pullRequestsReportState: "report",
  pullRequestsSubscribeRefreshes: "stream",
  pullRequestsReviewerCandidates: "read",
  pullRequestsRequestReviewers: "mutation",
  pullRequestsLabelCandidates: "read",
  pullRequestsSetLabels: "mutation",
  sourceControlLookupRepository: "read",
  sourceControlCloneRepository: "mutation",
  sourceControlPublishRepository: "mutation",
  projectCloneStart: "mutation",
  projectCloneCancel: "mutation",
  projectCloneRetry: "mutation",
  subscribeProjectClones: "stream",
  subscribeVcsStatus: "stream",
  subscribeWorktreeSetup: "stream",
  worktreeSetupCancel: "mutation",
  subscribeTerminalEvents: "stream",
  subscribeTerminalMetadata: "stream",
  subscribePreviewEvents: "stream",
  subscribeDiscoveredLocalServers: "stream",
  subscribeDeviceState: "stream",
  subscribeServerConfig: "stream",
  subscribeServerLifecycle: "stream",
  subscribeAuthAccess: "stream",
  subscribeBackgroundPolicy: "stream",
  subscribeResourceTelemetry: "stream",
} as const satisfies Record<keyof typeof WS_METHODS, RpcMethodClass>;
const kanbanMethodClasses = {
  boards: "stream",
  subscribe: "stream",
  card: "read",
  discussions: "read",
  threads: "read",
  owner: "read",
  messages: "read",
  message: "read",
  wiki: "read",
  boardCreate: "mutation",
  boardUpdate: "mutation",
  setupStart: "mutation",
  setupEnd: "mutation",
  boardPause: "mutation",
  cardPatch: "mutation",
  cardSettle: "mutation",
  cardStop: "mutation",
  cardAsk: "mutation",
  cardDiscussion: "mutation",
  poolSet: "mutation",
  poolRemove: "mutation",
  discussionCreate: "mutation",
  discussionRead: "mutation",
  discussionUpdate: "mutation",
  messagePost: "mutation",
  answer: "mutation",
  scripts: "read",
  scriptRuns: "read",
  scriptEnable: "mutation",
  scriptRun: "mutation",
  scriptAcknowledge: "mutation",
} as const satisfies Record<keyof typeof KANBAN_WS_METHODS, RpcMethodClass>;
const orchestrationMethodClasses = {
  dispatchCommand: "mutation",
  getTurnDiff: "read",
  getFullThreadDiff: "read",
  searchThreads: "read",
  searchThread: "read",
  searchThreadStream: "stream",
  getArchivedShellSnapshot: "read",
  getThreadProjection: "read",
  getWorkflowScript: "read",
  stopWorkflow: "mutation",
  getTurnItem: "read",
  launchThread: "mutation",
  subscribeArchivedShell: "stream",
  subscribeShell: "stream",
  subscribeThread: "stream",
  subscribeCommandOutput: "stream",
} as const satisfies Record<keyof typeof ORCHESTRATION_V2_WS_METHODS, RpcMethodClass>;

const mutationCorpus = [
  ...Object.entries(wsMethodClasses).map(([key, classification]) => ({
    method: WS_METHODS[key as keyof typeof WS_METHODS],
    classification,
  })),
  ...Object.entries(kanbanMethodClasses).map(([key, classification]) => ({
    method: KANBAN_WS_METHODS[key as keyof typeof KANBAN_WS_METHODS],
    classification,
  })),
  ...Object.entries(orchestrationMethodClasses).map(([key, classification]) => ({
    method: ORCHESTRATION_V2_WS_METHODS[key as keyof typeof ORCHESTRATION_V2_WS_METHODS],
    classification,
  })),
];

describe("owner mutation method corpus", () => {
  it("makes an independent decision for every current RPC method", () => {
    const expected = [
      ...Object.values(WS_METHODS),
      ...Object.values(KANBAN_WS_METHODS),
      ...Object.values(ORCHESTRATION_V2_WS_METHODS),
    ].toSorted();
    expect(mutationCorpus.map((entry) => entry.method).toSorted()).toEqual(expected);
    expect(new Set(mutationCorpus.map((entry) => entry.method)).size).toBe(expected.length);
  });

  it.each(mutationCorpus)("$method is $classification", ({ method, classification }) => {
    const metadata = analyticsOwnerAction(method, {
      boardId: "board-1",
      cardId: "card-1",
      discussionId: "discussion-1",
      threadId: "thread-1",
      text: "PRIVATE_PAYLOAD",
      prompt: "PRIVATE_PAYLOAD",
      query: "PRIVATE_PAYLOAD",
      answer: "PRIVATE_PAYLOAD",
      error: "PRIVATE_PAYLOAD",
      toast: "PRIVATE_PAYLOAD",
      url: "https://private.invalid/?token=PRIVATE_PAYLOAD",
      settings: { theme: "PRIVATE_PAYLOAD" },
      command: { threadId: "other-thread", text: "PRIVATE_PAYLOAD" },
      secrets: { field: "PRIVATE_PAYLOAD" },
    });
    if (classification !== "mutation") {
      expect(metadata).toBeUndefined();
      return;
    }
    expect(metadata).toEqual({
      boardId: "board-1",
      cardId: "card-1",
      discussionId: "discussion-1",
      threadId: "thread-1",
      props: { method, ...(method === KANBAN_WS_METHODS.cardPatch ? { key: "prompt" } : {}) },
    });
    const event = sanitizeAnalyticsEvent({
      ...metadata,
      ts: "2026-11-13T12:00:00.000Z",
      surface: "web",
      route: "board",
      kind: "owner.action",
    });
    expect(Schema.is(AnalyticsIngestInput)({ events: [event] })).toBe(true);
    expect(JSON.stringify(event)).not.toContain("PRIVATE_PAYLOAD");
  });

  it("keeps protected diagnostic reads separate from both protected and unprotected mutations", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.serverCheckOtlpEndpoint, {}).length).toBeGreaterThan(
      0,
    );
    expect(
      analyticsOwnerAction(WS_METHODS.serverCheckOtlpEndpoint, {
        headers: { authorization: "PRIVATE_PAYLOAD" },
      }),
    ).toBeUndefined();
    expect(analyticsOwnerAction(WS_METHODS.serverGetConfig, {})).toBeUndefined();
    expect(
      analyticsOwnerAction(WS_METHODS.serverUpsertKeybinding, {
        command: "PRIVATE_PAYLOAD",
        key: "PRIVATE_PAYLOAD",
      }),
    ).toEqual({ props: { method: WS_METHODS.serverUpsertKeybinding } });
    expect(
      analyticsOwnerAction(WS_METHODS.terminalRestart, {
        threadId: "thread-1",
        data: "PRIVATE_PAYLOAD",
      }),
    ).toEqual({ threadId: "thread-1", props: { method: WS_METHODS.terminalRestart } });
  });
});
