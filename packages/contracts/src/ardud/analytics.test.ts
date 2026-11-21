import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AnalyticsEvent,
  AnalyticsRollup,
  RunUsageEvent,
  AnalyticsIngestInput,
  AnalyticsReadInput,
} from "./analytics.ts";
import { clientRpcRequiredScopes } from "../clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope } from "../auth.ts";
import { WS_METHODS } from "../rpc.ts";

const event = {
  ts: "2026-11-13T00:00:00.000Z",
  kind: "ask.answered",
  surface: "web",
  route: "/boards",
  props: { count: 1 },
};
const decode = Schema.decodeUnknownSync(AnalyticsIngestInput);
const decodeEvent = Schema.decodeUnknownSync(AnalyticsEvent);
const decodeRead = Schema.decodeUnknownSync(AnalyticsReadInput);
const decodeRunUsage = Schema.decodeUnknownSync(RunUsageEvent, { onExcessProperty: "error" });
describe("analytics ingest contract", () => {
  it("preserves typed board metadata and excludes text", () => {
    const input = {
      ...event,
      kind: "kanban.card_move",
      surface: "server",
      cardId: "card-1",
      props: {
        number: 1,
        from: "todo",
        to: "working",
        actor: "owner",
        msInPrevStage: 100,
        blocking: true,
        round: 1,
        verdict: "clear",
        head: "abcdef1",
        used: 1,
        slots: 2,
        waiting: 0,
      },
    };
    expect(decodeEvent(input)).toEqual(input);
    expect(() =>
      decodeEvent({ ...input, props: { ...input.props, actor: "private words" } }),
    ).toThrow();
    expect(() => decodeEvent({ ...input, props: { ...input.props, head: "private" } })).toThrow();
  });
  it.each(["host_reboot", "quarantine_max_age"])(
    "accepts desktop lease recovery reason %s",
    (reason) => {
      expect(
        decodeEvent({
          ts: event.ts,
          kind: "desktop_lease.transition",
          surface: "server",
          route: "desktop-lease",
          ticket: "ticket-1",
          taskId: "task-1",
          mode: "native",
          from: "quarantined",
          to: "finished",
          reason,
          age_ms: 1000,
        }),
      ).toMatchObject({ reason, kind: "desktop_lease.transition" });
    },
  );
  it("accepts MCP filters and rejects unhashed request ids", () => {
    const call = { ...event, kind: "mcp.call", clientRequestId: "a".repeat(64) };
    expect(decodeEvent(call).clientRequestId).toBe("a".repeat(64));
    expect(() => decodeEvent({ ...call, clientRequestId: "private-request-id" })).toThrow();
    expect(
      decodeRead({
        day: "2026-11-13",
        kind: "mcp.call",
        tool: "card_update",
        outcome: "timeout",
        responseDelivery: "closed",
      }),
    ).toMatchObject({ tool: "card_update", outcome: "timeout", responseDelivery: "closed" });
    expect(() => decodeRead({ day: "2026-11-13", outcome: "maybe" })).toThrow();
  });
  it.each([
    "caller",
    "dispatch",
    "result",
    "handler",
    "parent_records",
    "child_records",
    "catalog",
    "request_key",
    "receipt",
    "settings",
    "selection",
    "workspace",
    "lane_wait",
    "query",
    "render",
  ])("decodes MCP rows with phase %s", (errorPhase) => {
    const row = { ...event, kind: "mcp.call", errorPhase };
    expect(decodeEvent(row)).toEqual(row);
  });
  it("keeps historical MCP rows without a phase and rejects unknown phases", () => {
    const row = { ...event, kind: "mcp.call" };
    expect(decodeEvent(row)).toEqual(row);
    expect(() => decodeEvent({ ...row, errorPhase: "unknown" })).toThrow();
  });
  it("accepts bounded batches and strips unrecognized content", () => {
    const input = decode({
      events: [
        {
          ...event,
          prompt: "private",
          props: { ...event.props, token: "secret", answer: "private" },
        },
      ],
    });
    expect(input.events).toEqual([event]);
    expect(decode({ events: Array.from({ length: 100 }, () => event) }).events).toHaveLength(100);
  });
  it.each(["limit", "events.limit", "private_token"])(
    "strips server-derived errorFields %s from client ingest",
    (field) => {
      expect(
        decode({ events: [{ ...event, kind: "mcp.call", errorFields: [field] }] }).events,
      ).toEqual([{ ...event, kind: "mcp.call" }]);
    },
  );
  it.each([
    ["empty", []],
    ["too many", Array.from({ length: 101 }, () => event)],
    ["server spoof", [{ ...event, surface: "server" }]],
    ["free text route", [{ ...event, route: "/search?q=private words" }]],
    ["free text property", [{ ...event, props: { method: "secret words" } }]],
    ["oversized id", [{ ...event, cardId: "a".repeat(513) }]],
    ["negative duration", [{ ...event, durationMs: -1 }]],
    ["not finite", [{ ...event, durationMs: Infinity }]],
    ["invalid time", [{ ...event, ts: "tomorrow" }]],
  ])("rejects %s", (_name, events) => {
    expect(() => decode({ events })).toThrow();
  });
  it("keeps server Claude excerpts out of client ingest and bounds persisted diagnostics", () => {
    const claudeApiError = {
      model: "claude-opus-5-5",
      host: "router.test",
      path: "/v1",
      status: 404,
      errorCode: "model_not_found",
      errorType: "not_found_error",
      errorText: "Model missing",
      attempt: 1,
      resume: false,
    };
    const row = { ...event, kind: "provider.claude_api_error", surface: "server", claudeApiError };
    expect(decodeEvent(row)).toEqual(row);
    expect(() => decode({ events: [{ ...row, surface: "web" }] })).toThrow();
    expect(() =>
      decodeEvent({ ...row, claudeApiError: { ...claudeApiError, errorText: "x".repeat(201) } }),
    ).toThrow();
    expect(() =>
      decodeEvent({ ...row, claudeApiError: { ...claudeApiError, path: "/v1?key=private" } }),
    ).toThrow();
  });
  it("requires an operating grant for client ingest", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.analyticsIngest, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });
  it("bounds reads and prevents path traversal", () => {
    const read = Schema.decodeUnknownSync(AnalyticsReadInput);
    expect(read({ day: "2026-11-13", limit: 500 }).limit).toBe(500);
    for (const input of [
      { day: "../../secrets" },
      { day: "2026-11-13", limit: 501 },
      { day: "2026-11-13", limit: 0 },
    ])
      expect(() => read(input)).toThrow();
  });
});

const usage = {
  ts: event.ts,
  kind: "run.usage",
  surface: "server",
  route: "provider",
  runId: "run:one",
  threadId: "thread:one",
  role: "chat",
  providerInstance: "codex",
  model: "gpt-6.1-sol",
  effort: "max",
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  wallMs: null,
  turnCount: 0,
  endReason: "failed",
  usageStatus: "unavailable",
  reviewRound: null,
};
it("requires the metadata-only usage schema and preserves null measurements", () => {
  const decodeUsage = Schema.decodeUnknownSync(RunUsageEvent, { onExcessProperty: "error" });
  expect(decodeUsage(usage)).toEqual(usage);
  expect(Object.hasOwn(decodeUsage(usage), "cancelReason")).toBe(false);
  const cancelled = { ...usage, endReason: "cancelled", cancelReason: "server_shutdown" };
  expect(decodeUsage(cancelled)).toEqual(cancelled);
  expect(() => decodeUsage({ ...cancelled, cancelReason: "unclassified" })).toThrow();
  for (const key of ["prompt", "message", "text", "toolArgs", "toolOutput", "output"]) {
    expect(() => decodeUsage({ ...usage, [key]: "private" })).toThrow();
  }
  const decodeEvent = Schema.decodeUnknownSync(AnalyticsEvent, { onExcessProperty: "error" });
  expect(() =>
    decodeEvent({ ts: event.ts, kind: "run.usage", surface: "server", route: "provider" }),
  ).toThrow();
  expect(() => decode({ events: [{ ...usage, surface: "web" }] })).toThrow();
  expect(() => decodeUsage({ ...usage, inputTokens: -1 })).toThrow();
  expect(
    Schema.decodeUnknownSync(AnalyticsReadInput)({
      day: "2026-11-13",
      kind: "run.usage",
      cardId: "card:one",
    }).cardId,
  ).toBe("card:one");
});

it.each(["runId", "threadId"] as const)("accepts bounded derived usage %s values", (field) => {
  const decodeUsage = Schema.decodeUnknownSync(RunUsageEvent);
  for (const value of ["derived:review!~'()*1338", "a".repeat(8192)]) {
    expect(decodeUsage({ ...usage, [field]: value })[field]).toBe(value);
  }
  for (const value of ["a".repeat(8193), "unencoded space", "unencoded界", "line\nbreak"]) {
    expect(() => decodeUsage({ ...usage, [field]: value })).toThrow();
  }
});

it.each([
  ["plain", "review-1338_v1.2"],
  ["parentheses", "review(1338)"],
  ["bang", "review!1338"],
  ["apostrophe", "review'1338"],
  ["star", "review*1338"],
  ["tilde", "review~1338"],
  ["separators", "review:/#@%+1338"],
  ["whitespace", "review 1338\tunit"],
  ["unicode", "مراجعة-1338"],
  ["maximum-key", "界".repeat(256)],
] as const)("accepts %s allocator keys in both run usage IDs", (_name, key) => {
  const commandId = `command:mcp:delegate-task:caller:${encodeURIComponent(key)}`;
  const threadId = `thread:delegated-task:${encodeURIComponent(commandId)}`;
  const runId = `run:thread:${encodeURIComponent(threadId)}:ordinal:1`;
  const row = { ...usage, threadId, runId };
  expect(decodeRunUsage(row)).toEqual(row);
  expect(decodeEvent(row)).toEqual(row);
});

it.each([
  "claude-opus-5[1m]",
  "Claude Opus 5.5",
  "vendor/model:variant@2026-11-13",
  "vendor/model|route?hint=value",
  "m".repeat(161),
  "m".repeat(4096),
])("accepts provider-owned model identifiers: %s", (model) => {
  expect(Schema.decodeUnknownSync(RunUsageEvent)({ ...usage, model }).model).toBe(model);
});

it.each(["live_thread", "steer", "start", "none"] as const)(
  "#1603 post-routing target %s is retained without message content",
  (target) => {
    const row = {
      ...event,
      kind: "kanban.post_routing",
      outcome: "ok",
      props: { actor: "script", seq: 39, target, phase: "routed" },
    };
    expect(decodeEvent(row)).toEqual(row);
    expect(() =>
      decodeEvent({ ...row, props: { ...row.props, target: "arbitrary text" } }),
    ).toThrow();
  },
);

it.each(["started", "reused", "merged", "queued_spawn_cap"] as const)(
  "#1490 accepts evaluator outcome %s and bounded attribution labels",
  (outcome) => {
    const row = {
      ...event,
      kind: "kanban.evaluator",
      surface: "server",
      boardId: "board-offbox",
      purposeKind: "request",
      trigger: "report_bug",
      outcome,
      reuseMissReason: "no_card_reuse_scope",
    };
    expect(decodeEvent(row)).toEqual(row);
    expect(
      decodeRead({ day: "2026-11-14", boardId: "board-offbox", kind: row.kind, outcome }),
    ).toMatchObject({ outcome });
    for (const field of ["purposeKind", "trigger", "reuseMissReason"])
      expect(() => decodeEvent({ ...row, [field]: "private words" })).toThrow();
  },
);

it("decodes detached outcomes additively and rejects raw request ids", () => {
  const old = { ...event, kind: "mcp.call", tool: "delegate_task", outcome: "timeout" };
  expect(decodeEvent(old)).toEqual(old);
  for (const outcome of ["committed", "failed", "capped"] as const) {
    const row = {
      ...old,
      kind: "mcp.detached",
      outcome,
      lateMs: 1234,
      afterCap: true,
      clientRequestId: "a".repeat(64),
    };
    expect(decodeEvent(row)).toEqual(row);
    expect(() => decodeEvent({ ...row, clientRequestId: "raw-request-id" })).toThrow();
    expect(() => decodeEvent({ ...row, lateMs: -1 })).toThrow();
  }
  expect(
    Schema.is(AnalyticsRollup.fields.mcpCalls)([
      {
        tool: "delegate_task",
        hour: "2026-11-13T00:00:00.000Z",
        build: "test",
        bootId: "boot",
        count: 1,
        p50Ms: 10000,
        p95Ms: 10000,
        maxMs: 10000,
        approximate: false,
        failures: 1,
        failureRate: 1,
        outcomes: { timeout: 1 },
        savedCounts: { unknown: 1 },
        reasonClasses: {},
        invalidFields: {},
        errors: [],
        failedThenRetried: 0,
        retrySucceeded: 0,
      },
    ]),
  ).toBe(true);
});

it("decodes runtime samples with exact model ids and bounded hourly rollups", () => {
  const row = {
    ts: event.ts,
    kind: "server.runtime_sample",
    surface: "server",
    route: "server",
    props: {
      runningTurns: {
        total: 1,
        byProvider: { "custom:provider[2]": 1 },
        byModel: { "cx/gpt-6.1-sol[1m]": 1, other: 0 },
      },
      runningByOrigin: {
        boardWork: 0,
        boardReview: 0,
        boardEvaluator: 0,
        delegatedChild: 0,
        scheduledTask: 0,
        other: 1,
      },
      providerSessions: { codex: 1 },
      host: { load1: 12, load5: 10, load15: 8, rssMiB: 900, heapUsedMiB: 500 },
      sampleMs: 0.25,
    },
  };
  expect(decodeEvent(row)).toEqual(row);
  const retry = {
    ts: event.ts,
    kind: "provider.retry",
    surface: "server",
    route: "provider",
    threadId: "thread:watcher",
    props: {
      runId: "run:watcher",
      provider: "claudeAgent",
      model: "claude-sonnet-5-5",
      attempt: 2,
      maxRetries: 10,
      errorMessage: "Request timed out.",
      waitSinceResponseMs: 300000,
    },
  };
  const guard = {
    ...retry,
    kind: "provider.guard_interrupt",
    props: { ...retry.props, guardFiredDuringRetry: true },
  };
  for (const sample of [row, retry, guard]) expect(decodeEvent(sample)).toEqual(sample);
  expect(() => decode({ events: [row] })).toThrow();
  expect(() => decodeEvent({ ...row, props: { ...row.props, sampleMs: -1 } })).toThrow();
  const hour = {
    hour: "00",
    samples: 60,
    runningTurnsMax: 5,
    runningTurnsAvg: 2.5,
    queuedRunsMax: null,
    load1Max: 12,
    sampleMsMax: 0.4,
  };
  expect(
    Schema.is(AnalyticsRollup.fields.runtimeSamples)(Array.from({ length: 24 }, () => hour)),
  ).toBe(true);
  expect(
    Schema.is(AnalyticsRollup.fields.runtimeSamples)(Array.from({ length: 25 }, () => hour)),
  ).toBe(false);
});

it("accepts tick attribution, rejects negative measurements and strips non-label keys", () => {
  const input = {
    ...event,
    kind: "kanban.tick_phase",
    props: {
      phase: "thread_status",
      count: 2,
      byRead: { find: { count: 2, ms: 25 } },
      byStep: { evaluatorStatusPlan: { count: 2, ms: 25 } },
    },
  };
  expect(decodeEvent(input).props).toEqual(input.props);
  expect(() =>
    decodeEvent({ ...input, props: { byRead: { find: { count: -1, ms: 25 } } } }),
  ).toThrow();
  expect(
    decodeEvent({ ...input, props: { byStep: { "private words": { count: 1, ms: 25 } } } }).props
      ?.byStep,
  ).toEqual({});
});

it("bounds MCP error paths and accepts nested schema fields without values", () => {
  const row = {
    ...event,
    kind: "mcp.call",
    tool: "card_get",
    errorFields: ["events.limit", "items.0.name"],
  };
  expect(decodeEvent(row).errorFields).toEqual(row.errorFields);
  for (const errorFields of [
    ["x".repeat(65)],
    Array(6).fill("limit"),
    ["private value"],
    ["events[0]"],
    [""],
  ])
    expect(() => decodeEvent({ ...row, errorFields })).toThrow();
});

it.each([null, 680])(
  "retains late-start identity and settlement timing (%s ms)",
  (msAfterRunEnded) => {
    const row = {
      ...event,
      surface: "server",
      kind: "provider_turn.late_start_interrupt_queued",
      threadId: "thread:late",
      props: {
        runId: "run:late",
        providerTurnId: "provider-turn:late",
        providerThreadId: "provider-thread:late",
        providerSessionId: "provider-session:late",
        runStatus: "interrupted",
        msAfterRunEnded,
      },
    };
    expect(decodeEvent(row)).toEqual(row);
  },
);
