import { describe, expect, it } from "vite-plus/test";
import { reasonClass, elapsed, label } from "./analytics.ts";

describe("board analytics privacy", () => {
  it.each([
    ["Stale queued runs on the thread", "stale_queued_runs"],
    ["Run went silent twice", "run_silent"],
    ["No project set for this card", "missing_project"],
    ["Thread model differs from card model: private", "thread_model_differs"],
    ["Review verdict refused: private", "verdict_refused"],
    ["Variant unavailable for private model", "variant_unavailable"],
    ["Provider blocked the response: private prompt", "provider_blocked"],
    ["Interrupted by owner", "interrupted"],
    ["Run failed: prompt is too long", "context_exhausted"],
    ["usage limit exceeded", "provider_capacity"],
    ["access token has expired", "authentication"],
    ["Model unavailable: private", "model_unavailable"],
    ["Timed out waiting", "timeout"],
    ["Reviewer stopped without a verdict", "no_verdict"],
    ["Thread start failed: private", "thread_start"],
    ["A private error message", "other"],
  ])("classifies %s without retaining it", (message, expected) => {
    expect(reasonClass(message)).toBe(expected);
  });
  it.each([
    ["content_filter", "provider_blocked"],
    ["model_invalid", "model_unavailable"],
    ["context_exhausted", "context_exhausted"],
    ["auth_expired", "authentication"],
    ["quota", "provider_capacity"],
    ["transient", "provider_capacity"],
    ["config", "configuration"],
  ])("uses normalized %s categories when message wording varies", (category, expected) => {
    expect(reasonClass("private", category)).toBe(expected);
  });
  it("bounds labels and clamps malformed or negative durations", () => {
    expect(label("private words")).toBe("other");
    expect(label("a".repeat(161))).toBe("other");
    expect(elapsed("2026-11-13T12:00:00.000Z", "2026-11-13T13:00:00.000Z")).toBe(0);
    expect(elapsed("bad", "bad")).toBe(0);
  });
});
