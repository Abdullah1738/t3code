import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AnalyticsEvent,
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
describe("analytics ingest contract", () => {
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
      }),
    ).toMatchObject({ tool: "card_update", outcome: "timeout" });
    expect(() => decodeRead({ day: "2026-11-13", outcome: "maybe" })).toThrow();
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
