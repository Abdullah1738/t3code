import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  blockedRetryPrompt,
  FOLLOW_QUIET_MS,
  type FollowedThread,
  runVerdict,
  threadVerdict,
} from "./runFollow.ts";

const start = Date.parse("2026-10-22T20:00:00.000Z");
const at = (minutes: number) => DateTime.makeUnsafe(start + minutes * 60_000);
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

interface RunFixture {
  readonly id: string;
  readonly status: string;
  readonly endsAt?: number;
  readonly queueHeld?: boolean;
  readonly userMessageId?: string;
  readonly delegatedCompletion?: unknown;
}

interface Fixture {
  readonly runs: ReadonlyArray<RunFixture>;
  readonly subagents?: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly endsAt?: number;
    readonly runId?: string;
    readonly completionDelivery?: { readonly state: string };
  }>;
  readonly requests?: ReadonlyArray<{ readonly status: string }>;
  readonly turns?: ReadonlyArray<{ readonly status: string; readonly runAttemptId: string | null }>;
  readonly errors?: ReadonlyArray<{
    readonly runId: string;
    readonly code: string | null;
    readonly message: string;
  }>;
  readonly deleted?: boolean;
  readonly autoResume?: boolean;
}

const projection = (fixture: Fixture): FollowedThread =>
  ({
    thread: {
      id: "thread-1",
      deletedAt: fixture.deleted === true ? at(0) : null,
      activeProviderThreadId: null,
      limitRecovery: fixture.autoResume === undefined ? null : { autoResume: fixture.autoResume },
    },
    runs: fixture.runs.map((run, index) => ({
      ordinal: index + 1,
      rootNodeId: `node-${run.id}`,
      startedAt: run.status === "queued" ? null : at(index),
      completedAt: TERMINAL.has(run.status) ? at(run.endsAt ?? index + 1) : null,
      ...run,
    })),
    subagents: (fixture.subagents ?? []).map((subagent) => ({
      origin: "native",
      childThreadId: null,
      nativeTaskRef: null,
      completedAt: subagent.endsAt === undefined ? null : at(subagent.endsAt),
      ...subagent,
    })),
    providerThreads: [],
    providerTurns: (fixture.turns ?? []).map((turn, index) => ({ id: `turn-${index}`, ...turn })),
    runtimeRequests: (fixture.requests ?? []).map((request, index) => ({
      id: `request-${index}`,
      ...request,
    })),
    turnItems: (fixture.errors ?? []).map((error, index) => ({
      id: `error-${index}`,
      type: "error",
      status: "failed",
      ordinal: index,
      runId: error.runId,
      nodeId: `node-${error.runId}`,
      updatedAt: at(1),
      failure: {
        class: "provider_error",
        code: error.code,
        message: error.message,
        retryable: null,
      },
    })),
  }) as unknown as FollowedThread;

const settledAfterQuiet = (fixture: Fixture, lastEndMinute = 1) =>
  threadVerdict(projection(fixture), start, start + lastEndMinute * 60_000 + FOLLOW_QUIET_MS);

const BLOCKED = { code: "provider.content-filter", message: "Provider blocked the response" };

describe("threadVerdict", () => {
  it("waits while the run, its subagents, a question or an owed report keep the thread busy", () => {
    const later = start + 60 * 60_000;
    expect(
      threadVerdict(projection({ runs: [{ id: "a", status: "running" }] }), start, later),
    ).toEqual({ _tag: "wait" });
    expect(
      threadVerdict(
        projection({
          runs: [
            { id: "a", status: "completed" },
            { id: "b", status: "queued" },
          ],
        }),
        start,
        later,
      )._tag,
    ).toBe("wait");
    expect(
      threadVerdict(
        projection({
          runs: [{ id: "a", status: "completed" }],
          subagents: [{ id: "child", status: "running" }],
        }),
        start,
        later,
      )._tag,
    ).toBe("wait");
    expect(
      threadVerdict(
        projection({ runs: [{ id: "a", status: "waiting" }], requests: [{ status: "pending" }] }),
        start,
        later,
      )._tag,
    ).toBe("wait");
    expect(
      threadVerdict(
        projection({
          runs: [{ id: "a", status: "completed" }],
          turns: [{ status: "running", runAttemptId: null }],
        }),
        start,
        later,
      )._tag,
    ).toBe("wait");
    expect(
      threadVerdict(
        projection({ runs: [{ id: "a", status: "failed" }], autoResume: true }),
        start,
        later,
      )._tag,
    ).toBe("wait");
  });

  it("waits out the quiet window after the latest run or subagent ends", () => {
    const fixture: Fixture = {
      runs: [{ id: "a", status: "completed", endsAt: 1 }],
      subagents: [{ id: "child", status: "completed", endsAt: 10 }],
    };
    const tenMinutes = start + 10 * 60_000;
    expect(threadVerdict(projection(fixture), start, tenMinutes + FOLLOW_QUIET_MS - 1)._tag).toBe(
      "wait",
    );
    expect(threadVerdict(projection(fixture), start, tenMinutes + FOLLOW_QUIET_MS)).toEqual({
      _tag: "settled",
      status: "succeeded",
      error: null,
      blocked: false,
    });
  });

  it("fails with the provider error when the work a run woke ends blocked", () => {
    // 22 Oct nightly: the scheduled run completed, later wake runs were blocked.
    const verdict = settledAfterQuiet(
      {
        runs: [
          { id: "scheduled", status: "completed", endsAt: 1 },
          { id: "wake-1", status: "completed", endsAt: 2 },
          { id: "wake-2", status: "failed", endsAt: 3 },
        ],
        errors: [{ runId: "wake-2", ...BLOCKED }],
      },
      3,
    );
    expect(verdict).toEqual({
      _tag: "settled",
      status: "failed",
      error: "Provider blocked the response",
      blocked: true,
    });
  });

  it("does not call a held queue or a stopped run a success", () => {
    expect(
      settledAfterQuiet({
        runs: [
          { id: "a", status: "completed" },
          { id: "b", status: "queued", queueHeld: true },
        ],
      }),
    ).toMatchObject({ status: "failed", blocked: false });
    expect(settledAfterQuiet({ runs: [{ id: "a", status: "interrupted" }] })).toMatchObject({
      status: "failed",
      error: "The run ended interrupted.",
    });
    expect(settledAfterQuiet({ runs: [{ id: "a", status: "failed" }], errors: [] })).toMatchObject({
      status: "failed",
      error: "The run failed.",
      blocked: false,
    });
    expect(
      settledAfterQuiet({ runs: [{ id: "a", status: "completed" }], deleted: true }),
    ).toMatchObject({ status: "failed", error: "The thread was deleted." });
  });

  it("does not wait on a report parked in a held queue", () => {
    // The parent cohort still owes a delegated report, but its wake run is held
    // behind the blocked run, so nothing will ever deliver it.
    const verdict = settledAfterQuiet({
      runs: [
        {
          id: "a",
          status: "failed",
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: "wake", taskIds: ["task-1"] },
          },
        },
        { id: "wake", status: "queued", queueHeld: true, userMessageId: "wake" },
      ],
      subagents: [
        {
          id: "task-1",
          status: "completed",
          endsAt: 1,
          runId: "a",
          completionDelivery: { state: "claimed" },
        },
      ],
      errors: [{ runId: "a", ...BLOCKED }],
    });
    expect(verdict).toMatchObject({
      status: "failed",
      error: "Provider blocked the response",
      blocked: true,
    });
  });

  it("waits on a report that isn't sent yet, even behind an unrelated held run", () => {
    const blockedParent = {
      id: "a",
      status: "failed",
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: "report", taskIds: ["task-1"] },
      },
    };
    const unrelated = {
      id: "later",
      status: "queued",
      queueHeld: true,
      userMessageId: "later-message",
    };
    const child = { id: "task-1", status: "completed", endsAt: 1, runId: "a" };
    // Reserved for a message that hasn't been dispatched as a run yet.
    expect(
      settledAfterQuiet({
        runs: [blockedParent, unrelated],
        subagents: [{ ...child, completionDelivery: { state: "claimed" } }],
        errors: [{ runId: "a", ...BLOCKED }],
      })._tag,
    ).toBe("wait");
    // Not reserved at all: the report is still pending.
    expect(
      settledAfterQuiet({
        runs: [
          {
            ...blockedParent,
            delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
          },
          unrelated,
        ],
        subagents: [{ ...child, completionDelivery: { state: "pending" } }],
        errors: [{ runId: "a", ...BLOCKED }],
      })._tag,
    ).toBe("wait");
  });

  it("only treats the content filter as blocked", () => {
    expect(
      settledAfterQuiet({
        runs: [{ id: "a", status: "failed" }],
        errors: [{ runId: "a", code: "provider.overloaded", message: "Overloaded" }],
      }),
    ).toMatchObject({ status: "failed", error: "Overloaded", blocked: false });
  });
});

describe("runVerdict", () => {
  const runId = RunId.make("scheduled");

  it("follows only the run the bound task queued", () => {
    expect(
      runVerdict(projection({ runs: [{ id: "scheduled", status: "queued" }] }), runId)._tag,
    ).toBe("wait");
    expect(
      runVerdict(projection({ runs: [{ id: "scheduled", status: "running" }] }), runId)._tag,
    ).toBe("wait");
    expect(
      runVerdict(projection({ runs: [{ id: "scheduled", status: "completed" }] }), runId),
    ).toMatchObject({ status: "succeeded" });
    expect(
      runVerdict(
        projection({
          runs: [{ id: "scheduled", status: "failed" }],
          errors: [{ runId: "scheduled", ...BLOCKED }],
        }),
        runId,
      ),
    ).toMatchObject({ status: "failed", blocked: true });
    expect(
      runVerdict(
        projection({ runs: [{ id: "scheduled", status: "queued", queueHeld: true }] }),
        runId,
      ),
    ).toMatchObject({ status: "failed" });
    expect(runVerdict(projection({ runs: [] }), runId)).toMatchObject({ status: "failed" });
  });
});

describe("blockedRetryPrompt", () => {
  it("keeps the prompt and links the blocked thread", () => {
    const text = blockedRetryPrompt("Do the nightly review.", "Nightly", "thread-blocked");
    expect(text.startsWith("Do the nightly review.\n")).toBe(true);
    expect(text).toContain("[Nightly](t3-thread://v1/thread-blocked)");
  });
});
