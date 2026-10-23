import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { idleBlocker, type IdleInput, sessionHoldsWork } from "./idle.ts";

const now = DateTime.makeUnsafe("2026-10-22T12:00:00.000Z");
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);

interface RunFixture {
  readonly id: string;
  readonly status: string;
  readonly providerThreadId?: string;
  readonly delegatedCompletion?: {
    readonly disposition: string;
    readonly delivery: { readonly taskIds: ReadonlyArray<string> } | null;
  };
}

interface AttemptFixture {
  readonly runId: string;
  readonly providerThreadId?: string;
  readonly nativeThreadId?: string;
  readonly startedAt?: string | null;
}

interface Fixture {
  readonly archivedAt?: string | null;
  readonly runs?: ReadonlyArray<RunFixture>;
  readonly attempts?: ReadonlyArray<AttemptFixture>;
  readonly turns?: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly runAttemptId: string | null;
  }>;
  readonly requests?: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  }>;
  readonly subagents?: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly runId?: string;
    readonly origin?: string;
    readonly completionDelivery?: { readonly state: string };
  }>;
  readonly roster?: ReadonlyArray<{ readonly taskId: string; readonly kind: string }>;
  readonly native?: string | null;
  readonly singleProviderThread?: boolean;
  readonly limitRecovery?: { readonly autoResume: boolean };
  readonly snoozedUntil?: DateTime.Utc;
  readonly pullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly source: string;
    readonly watched: boolean;
  }>;
  readonly restartContinuationPending?: boolean;
  readonly continuationOffered?: boolean;
  readonly providerThreadsHoldingWork?: ReadonlyArray<string>;
  readonly expectedNativeSessionId?: string;
}

const input = (fixture: Fixture = {}): IdleInput => {
  const runs = (fixture.runs ?? [{ id: "run-1", status: "completed" }]).map((run, index) => ({
    ordinal: index + 1,
    providerThreadId: "provider-thread-active",
    activeAttemptId: run.status === "queued" ? null : `attempt-${run.id}`,
    startedAt: run.status === "queued" ? null : "2026-10-22T10:00:00.000Z",
    completedAt: TERMINAL.has(run.status)
      ? DateTime.makeUnsafe(`2026-10-22T10:0${index + 1}:00.000Z`)
      : null,
    ...run,
  }));
  const attempts = (
    fixture.attempts ??
    runs.filter((run) => run.status !== "queued").map((run): AttemptFixture => ({ runId: run.id }))
  ).map((attempt) => ({
    id: `attempt-${attempt.runId}`,
    runId: attempt.runId,
    providerThreadId:
      attempt.providerThreadId ??
      runs.find((run) => run.id === attempt.runId)?.providerThreadId ??
      "provider-thread-active",
    nativeThreadId: attempt.nativeThreadId ?? "ses_current",
    startedAt: attempt.startedAt === undefined ? "2026-10-22T10:00:00.000Z" : attempt.startedAt,
  }));
  const active = {
    id: "provider-thread-active",
    nativeThreadRef:
      fixture.native === null
        ? null
        : { driver: "opencode", nativeId: fixture.native ?? "ses_current", strength: "strong" },
    pendingBackgroundTasks: fixture.roster ?? [],
  };
  const old = {
    id: "provider-thread-old",
    nativeThreadRef: { driver: "opencode", nativeId: "ses_old", strength: "strong" },
    pendingBackgroundTasks: [],
  };
  return {
    projection: {
      thread: {
        id: "thread-idle",
        archivedAt: fixture.archivedAt ?? null,
        activeProviderThreadId: "provider-thread-active",
        limitRecovery: fixture.limitRecovery ?? null,
        snoozedUntil: fixture.snoozedUntil ?? null,
        pullRequests: (fixture.pullRequests ?? []).map((link) => ({
          host: "github.com",
          repository: "ardud/robob",
          number: link.number,
          source: link.source,
          ...(link.watched ? { watch: { wakes: 0 } } : {}),
        })),
      },
      runs,
      attempts,
      providerTurns: fixture.turns ?? [],
      runtimeRequests: fixture.requests ?? [],
      subagents: (fixture.subagents ?? []).map((subagent) => ({
        origin: "provider_native",
        runId: null,
        title: null,
        nativeTaskRef: null,
        childThreadId: null,
        ...subagent,
      })),
      providerThreads: fixture.singleProviderThread === true ? [active] : [old, active],
    },
    restartContinuationPending: fixture.restartContinuationPending ?? false,
    continuationOffered: fixture.continuationOffered ?? false,
    providerThreadsHoldingWork: fixture.providerThreadsHoldingWork ?? [],
    expectedNativeSessionId: fixture.expectedNativeSessionId,
    now,
  } as unknown as IdleInput;
};

const reason = (fixture?: Fixture) => idleBlocker(input(fixture))?.reason ?? null;

describe("idleBlocker", () => {
  it("lets a settled thread go, with or without an expected session", () => {
    expect(reason()).toBeNull();
    expect(reason({ runs: [] })).toBeNull();
    expect(reason({ expectedNativeSessionId: "ses_current" })).toBeNull();
    expect(
      reason({
        runs: [
          { id: "run-1", status: "failed" },
          { id: "run-2", status: "interrupted" },
          { id: "run-3", status: "cancelled" },
        ],
        requests: [{ id: "request-1", kind: "user_input", status: "resolved" }],
        subagents: [{ id: "subagent-1", status: "completed" }],
        turns: [
          { id: "turn-1", status: "completed", runAttemptId: null },
          { id: "turn-2", status: "running", runAttemptId: "attempt-run-3" },
        ],
        limitRecovery: { autoResume: false },
        snoozedUntil: DateTime.makeUnsafe("2026-10-22T11:00:00.000Z"),
        expectedNativeSessionId: "ses_current",
      }),
    ).toBeNull();
  });

  it.each(["preparing", "starting", "running", "waiting"])("refuses a %s run", (status) => {
    expect(reason({ runs: [{ id: "run-1", status }] })).toBe("running");
  });

  it("refuses queued work, held or not", () => {
    expect(reason({ runs: [{ id: "run-2", status: "queued" }] })).toBe("queued");
    expect(
      idleBlocker(
        input({
          runs: [
            { id: "run-1", status: "completed" },
            { id: "run-2", status: "queued" },
            { id: "run-3", status: "queued" },
          ],
        }),
      )?.detail,
    ).toBe("Thread thread-idle has 2 queued runs.");
  });

  it("refuses a pending request", () => {
    expect(reason({ requests: [{ id: "request-1", kind: "approval", status: "pending" }] })).toBe(
      "pending-request",
    );
  });

  it("refuses running subagents and background tasks", () => {
    expect(reason({ subagents: [{ id: "subagent-1", status: "running" }] })).toBe(
      "background-work",
    );
    expect(reason({ roster: [{ taskId: "task-1", kind: "command" }] })).toBe("background-work");
  });

  it("refuses work or a wake that only the provider session still holds", () => {
    const held = { providerThreadsHoldingWork: ["provider-thread-active"] };
    expect(reason(held)).toBe("background-work");
    expect(idleBlocker(input(held))?.detail).toBe(
      "Thread thread-idle has background work or a wake held by provider thread provider-thread-active.",
    );
  });

  it("refuses a subagent child thread whose provider turn still runs without a run", () => {
    const child = { runs: [], turns: [{ id: "turn-1", status: "running", runAttemptId: null }] };
    expect(reason(child)).toBe("background-work");
    expect(idleBlocker(input(child))?.detail).toBe(
      "Thread thread-idle has provider turn turn-1 running.",
    );
    expect(
      reason({ runs: [], turns: [{ id: "turn-1", status: "pending", runAttemptId: null }] }),
    ).toBe("background-work");
  });

  it("refuses a thread still owed a delegated task report", () => {
    const open = (taskIds: ReadonlyArray<string> | null) => ({
      id: "run-1",
      status: "completed",
      delegatedCompletion: {
        disposition: "open",
        delivery: taskIds === null ? null : { taskIds },
      },
    });
    const task = (state: string) => ({
      id: "task-1",
      status: "completed",
      runId: "run-1",
      origin: "app_owned",
      completionDelivery: { state },
    });
    expect(reason({ runs: [open(["task-1"])] })).toBe("pending-wake");
    expect(reason({ runs: [open(null)], subagents: [task("pending")] })).toBe("pending-wake");
    expect(reason({ runs: [open(null)], subagents: [task("claimed")] })).toBe("pending-wake");
    expect(reason({ runs: [open(null)], subagents: [task("delivered")] })).toBeNull();
    expect(
      reason({
        runs: [
          {
            id: "run-1",
            status: "completed",
            delegatedCompletion: { disposition: "disposed", delivery: null },
          },
        ],
        subagents: [task("pending")],
      }),
    ).toBeNull();
  });

  it("refuses a thread that wakes on its own", () => {
    expect(reason({ restartContinuationPending: true })).toBe("pending-wake");
    expect(idleBlocker(input({ continuationOffered: true }))).toEqual({
      reason: "pending-wake",
      detail: "Thread thread-idle has a provider continuation waiting to start.",
    });
    expect(reason({ limitRecovery: { autoResume: true } })).toBe("pending-wake");
    expect(reason({ snoozedUntil: DateTime.makeUnsafe("2026-10-22T13:00:00.000Z") })).toBe(
      "pending-wake",
    );
  });

  it("refuses a thread that watches a pull request", () => {
    expect(
      idleBlocker(input({ pullRequests: [{ number: 7, source: "agent", watched: true }] })),
    ).toEqual({ reason: "pending-wake", detail: "Thread thread-idle watches ardud/robob#7." });
    expect(reason({ pullRequests: [{ number: 7, source: "agent", watched: false }] })).toBeNull();
    // A dismissed stack member is not watched any more, even with a stale watch on it.
    expect(
      reason({ pullRequests: [{ number: 7, source: "stack-dismissed", watched: true }] }),
    ).toBeNull();
  });

  it("refuses when the active session is not the expected one", () => {
    expect(reason({ expectedNativeSessionId: "ses_old" })).toBe("session-changed");
    expect(
      idleBlocker(input({ native: null, expectedNativeSessionId: "ses_current" }))?.reason,
    ).toBe("session-changed");
  });

  it("trusts the expected session only when the latest run ran on it", () => {
    const expectedNativeSessionId = "ses_current";
    // Rewriting the old provider thread moved the pointer, but the last run
    // still ran on the old session.
    expect(
      reason({
        runs: [{ id: "run-1", status: "completed", providerThreadId: "provider-thread-old" }],
        attempts: [{ runId: "run-1", nativeThreadId: "ses_old" }],
        expectedNativeSessionId,
      }),
    ).toBe("session-changed");
    expect(
      reason({ attempts: [{ runId: "run-1", startedAt: null }], expectedNativeSessionId }),
    ).toBe("session-changed");
    expect(reason({ attempts: [], expectedNativeSessionId })).toBe("session-changed");
    expect(
      reason({
        attempts: [{ runId: "run-1", nativeThreadId: "ses_other" }],
        expectedNativeSessionId,
      }),
    ).toBe("session-changed");
    expect(
      reason({
        attempts: [{ runId: "run-1", providerThreadId: "provider-thread-old" }],
        expectedNativeSessionId,
      }),
    ).toBe("session-changed");
  });

  it("trusts a runless thread's session only with a single provider thread", () => {
    expect(reason({ runs: [], expectedNativeSessionId: "ses_current" })).toBe("session-changed");
    expect(
      reason({ runs: [], singleProviderThread: true, expectedNativeSessionId: "ses_current" }),
    ).toBeNull();
  });

  it("refuses an archived thread first", () => {
    expect(
      reason({
        archivedAt: "2026-10-22T10:00:00.000Z",
        runs: [{ id: "run-1", status: "running" }],
      }),
    ).toBe("archived");
  });
});

describe("sessionHoldsWork", () => {
  const providerThread = { id: "provider-thread-1" } as unknown as OrchestrationV2ProviderThread;

  // Work finishing hands off to a continuation: it leaves the running set and
  // enters the held set as the first probe returns, as a provider can between
  // two reads.
  const handingOff = () => {
    let state: "running" | "handed-off" = "running";
    const probe = (read: () => boolean) =>
      Effect.sync(() => {
        const answer = read();
        state = "handed-off";
        return answer;
      });
    return {
      hasPendingBackgroundWorkForThread: () => probe(() => state === "running"),
      holdsWorkForThread: () => probe(() => state === "handed-off"),
    };
  };

  it.effect("sees work that moves from running to a handoff between its probes", () =>
    Effect.gen(function* () {
      expect(yield* sessionHoldsWork(handingOff(), providerThread)).toBe(true);
    }),
  );

  it.effect("counts a failed probe as held work", () =>
    Effect.gen(function* () {
      expect(
        yield* sessionHoldsWork(
          {
            hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
            holdsWorkForThread: () => Effect.die("probe crashed"),
          },
          providerThread,
        ),
      ).toBe(true);
    }),
  );

  it.effect("asks the whole session only when it has no thread probes", () =>
    Effect.gen(function* () {
      expect(
        yield* sessionHoldsWork({ hasPendingBackgroundWork: Effect.succeed(true) }, providerThread),
      ).toBe(true);
      expect(
        yield* sessionHoldsWork(
          {
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
            holdsWorkForThread: () => Effect.succeed(false),
          },
          providerThread,
        ),
      ).toBe(false);
      expect(yield* sessionHoldsWork({}, providerThread)).toBe(false);
    }),
  );
});
