import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlMessage, RunSummary, ThreadDetail } from "../src/control.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { recordsFromThread } from "../src/robob.ts";
import { createToolLog, toolLog, type LogLine } from "../src/toollog.ts";
import { FAIL_CAUSES, robobErrorCode, turnFailCause, type FailCause } from "../src/turn-fail-cause.ts";
import { captureLogs } from "./log-fixture.ts";

const paths: [string, Parameters<typeof turnFailCause>[0], FailCause][] = [
  ["provider refusal on the route", { outcome: "refused", sinceTurnStartMs: 60_000, info: { idleOutcome: "failed" } }, "steer_refused"],
  ["call-site cause wins over run facts", { outcome: "failed", sinceTurnStartMs: 0, info: { cause: "timeout", idleOutcome: "failed" } }, "timeout"],
  ["delivery expiry", { outcome: "failed", endReason: "expired", sinceTurnStartMs: 0 }, "timeout"],
  ["never delivered", { outcome: "failed", endReason: "undelivered", sinceTurnStartMs: 0 }, "undelivered"],
  ["never delivered while the link is down", { outcome: "failed", endReason: "undelivered", linkDown: true, sinceTurnStartMs: 0 }, "link_down"],
  ["Robob restart (cancelled, server_restart)", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "cancelled", cancelReason: "server_restart" } } }, "robob_restart"],
  ["Robob shutdown (cancelled, server_shutdown)", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "cancelled", cancelReason: "server_shutdown" } } }, "robob_restart"],
  ["cancelled run (user_stop)", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "cancelled", cancelReason: "user_stop" } } }, "run_cancelled"],
  ["cancelled run without a reason", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "cancelled" } } }, "run_cancelled"],
  ["rolled back run", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "rolled_back" } } }, "run_cancelled"],
  ["interrupted run (provider_interrupted)", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "interrupted", cancelReason: "provider_interrupted" } } }, "run_cancelled"],
  ["interrupted run without a reason", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted", diag: { runStatus: "interrupted" } } }, "run_cancelled"],
  ["interrupted without diagnostics", { outcome: "failed", endReason: "errored", sinceTurnStartMs: 0, info: { idleOutcome: "interrupted" } }, "run_cancelled"],
  ["failed run under 5 s", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 60_000, info: { idleOutcome: "failed", diag: { runStatus: "failed", runMs: 4_999 } } }, "instant_fail"],
  ["failed run of 5 s", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 0, info: { idleOutcome: "failed", diag: { runStatus: "failed", runMs: 5_000 } } }, "provider_error"],
  ["failed run, no run length, short turn", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 1_000, info: { idleOutcome: "failed" } }, "instant_fail"],
  ["failed run, no run length, long turn", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 30_000, info: { idleOutcome: "failed" } }, "provider_error"],
  ["NaN run length falls back to the turn", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 30_000, info: { idleOutcome: "failed", diag: { runStatus: "failed", runMs: Number.NaN } } }, "provider_error"],
  ["succeeded idle with a provider error", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 9_000, info: { idleOutcome: "succeeded", error: { message: "x" } } }, "provider_error"],
  ["selected-model complaint", { outcome: "failed", endReason: "failed", sinceTurnStartMs: 100, info: { idleOutcome: "succeeded", modelError: true } }, "instant_fail"],
  ["no facts at all", { outcome: "failed", sinceTurnStartMs: 0 }, "unknown"],
  ["no facts, link down", { outcome: "failed", linkDown: true, sinceTurnStartMs: 0 }, "link_down"],
];

test.each(paths)("failCause: %s", (_name, input, expected) => {
  expect(turnFailCause(input)).toBe(expected);
});

test("every cause the classifier returns is in the logged enum", () => {
  for (const [, input] of paths) expect(FAIL_CAUSES).toContain(turnFailCause(input));
});

test.each([
  [undefined, false, undefined],
  [null, false, undefined],
  ["There's an issue with the selected model (x).", false, "selected_model"],
  ["anything", true, "selected_model"],
  ["Run failed without error details", false, "no_detail"],
  [{ type: "ProviderError", message: "429 Too Many Requests" }, false, "rate_limited"],
  ["Overloaded", false, "overloaded"],
  ["prompt is too long: 250000 tokens", false, "context_length"],
  ["401 Unauthorized", false, "auth"],
  ["Provider blocked the response", false, "refusal"],
  ["request timed out", false, "timeout"],
  ["connection failed", false, "other"],
  [{ message: 42 }, false, "other"],
  [42, false, "other"],
  [Symbol("x"), false, "other"],
] as [unknown, boolean, string | undefined][])("robobErrorCode(%p)", (error, modelError, expected) => {
  expect(robobErrorCode(error, modelError)).toBe(expected as ReturnType<typeof robobErrorCode>);
});

test("a run that did not succeed carries its status, model and length; a successful one carries none", () => {
  const runs: RunSummary[] = [
    { runId: "run:t:1", ordinal: 1, status: "completed", model: { instanceId: "codex", model: "gpt-6-sol" }, startedAt: "2026-11-23T01:00:00Z", completedAt: "2026-11-23T01:00:10Z" },
    { runId: "run:t:2", ordinal: 2, status: "failed", model: { instanceId: "antigravity", model: "ag/gemini-4-neon-high" }, startedAt: "2026-11-23T01:01:00Z", completedAt: "2026-11-23T01:01:01.500Z" },
    { runId: "run:t:3", ordinal: 3, status: "cancelled", cancelReason: "server_restart", startedAt: null, completedAt: "2026-11-23T01:02:00Z" },
  ];
  const message = (runId: string, n: number): ControlMessage => ({ messageId: `m${n}`, runId, role: "assistant", text: "PRIVATE_TEXT", streaming: false,
    createdAt: "2026-11-23T01:00:00Z", updatedAt: "2026-11-23T01:00:00Z" } as ControlMessage);
  const thread: Pick<ThreadDetail, "threadId" | "recentRuns" | "run" | "lastError"> = { threadId: "t", recentRuns: runs, run: null, lastError: "PRIVATE_ERROR" };
  const idles = recordsFromThread(thread, runs.map((run, n) => message(run.runId, n))).filter(record => record.type === "idle");
  expect(idles.map(record => record.diag)).toEqual([
    undefined,
    { runStatus: "failed", provider: "antigravity", model: "ag/gemini-4-neon-high", runMs: 1_500 },
    { runStatus: "cancelled", cancelReason: "server_restart" },
  ]);
  expect(JSON.stringify(idles.map(record => record.diag))).not.toContain("PRIVATE");
});

test("the log keeps only clean cause fields on turn.end", async () => {
  const logs = await captureLogs(async () => {
    toolLog.write({ component: "router", kind: "perf", name: "turn.end", ok: false, durationMs: 1, ids: { chat: "owner" },
      props: { outcome: "failed", endReason: "failed", failCause: "robob_restart", robobRunStatus: "cancelled", robobCancelReason: "server_restart", robobErrorCode: "rate_limited",
        provider: "codex", model: "ag/gemini-4-neon-high", attempt: 2, requeued: true, sinceTurnStartMs: 1_234 } });
    toolLog.write({ component: "router", kind: "perf", name: "turn.end", ok: false, durationMs: 1, ids: { chat: "owner" },
      props: { outcome: "failed", failCause: "PRIVATE_cause", robobRunStatus: "PRIVATE status", robobCancelReason: "PRIVATE_reason", robobErrorCode: "PRIVATE_code",
        provider: "+971501234567", model: "PRIVATE model text", attempt: 0, requeued: "yes", sinceTurnStartMs: -1 } });
    // Cause keys mean nothing on other rows.
    toolLog.write({ component: "router", kind: "event", name: "turn.start", ids: { chat: "owner" }, props: { failCause: "instant_fail", model: "codex" } });
  });
  const ends = logs.filter(line => line.name === "turn.end");
  expect(ends[0]!.props).toEqual({ outcome: "failed", endReason: "failed", failCause: "robob_restart", robobRunStatus: "cancelled", robobCancelReason: "server_restart", robobErrorCode: "rate_limited",
    provider: "codex", model: "ag/gemini-4-neon-high", attempt: 2, requeued: true, sinceTurnStartMs: 1_234 });
  expect(ends[1]!.props).toEqual({ outcome: "failed" });
  expect(logs.find(line => line.name === "turn.start")?.props).toBeUndefined();
  expect(JSON.stringify(logs)).not.toContain("PRIVATE");
  expect(JSON.stringify(logs)).not.toContain("971501234567");
});

const row = (ts: string, props: Record<string, string | number | boolean>, ok = false, durationMs = 10_000): LogLine =>
  ({ ts, tool: "imessage", component: "router", kind: "perf", name: "turn.end", ok, durationMs, ids: { chat: "owner" }, props });

test("the rollup groups failed turns by cause, provider/model and hour, and reads rows from before the change", async () => {
  const lines = [
    row("2026-11-23T01:22:58.129Z", { outcome: "failed", endReason: "failed" }, false, 48_175),
    row("2026-11-23T01:30:00Z", { outcome: "failed", endReason: "failed" }, false, 1_000),
    row("2026-11-23T02:00:00Z", { outcome: "failed", failCause: "instant_fail", provider: "antigravity", model: "ag/gemini-4-neon-high", sinceTurnStartMs: 900 }),
    row("2026-11-23T02:10:00Z", { outcome: "failed", failCause: "instant_fail", provider: "antigravity", model: "ag/gemini-4-neon-high", sinceTurnStartMs: 1_100 }),
    row("2026-11-23T02:20:00Z", { outcome: "refused", failCause: "steer_refused", provider: "codex", sinceTurnStartMs: 30_000 }),
    row("2026-11-23T03:00:00Z", { outcome: "failed", failCause: "unknown", sinceTurnStartMs: 7_000 }),
    row("2026-11-23T03:05:00Z", { outcome: "replied" }, true, 500),
    row("2026-11-23T03:06:00Z", { outcome: "no_reply" }, true, 500),
  ];
  async function* iterate() { for (const line of lines) yield line; }
  const { failedTurns } = await summarizeLog(iterate(), undefined, [], "2026-11-23");
  expect(failedTurns).toEqual({
    count: 6, under5s: 3,
    byCause: { unrecorded: 2, instant_fail: 2, steer_refused: 1, unknown: 1 },
    byProviderModel: { unrecorded: 3, "antigravity/ag/gemini-4-neon-high": 2, "codex/?": 1 },
    byHour: { "01": 2, "02": 3, "03": 1 },
  });
});

test("the daily rollup file carries failedTurns", async () => {
  const root = mkdtempSync(join(tmpdir(), "rollup-fail-cause-"));
  try {
    writeFileSync(join(root, "2026-11-23.ndjson"), [
      row("2026-11-23T01:00:00Z", { outcome: "failed", endReason: "failed" }),
      row("2026-11-23T01:10:00Z", { outcome: "failed", failCause: "provider_error", sinceTurnStartMs: 60_000 }),
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const result = await createToolLog({ root }).rollup("2026-11-23");
    expect(result?.failedTurns).toMatchObject({ count: 2, byCause: { unrecorded: 1, provider_error: 1 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

