import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AnalyticsIngestInput, AnalyticsReadInput } from "./analytics.ts";
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
describe("analytics ingest contract", () => {
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
