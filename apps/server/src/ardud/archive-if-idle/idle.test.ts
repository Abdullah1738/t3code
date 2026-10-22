import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { idleBlocker, type IdleInput } from "./idle.ts";

const now = DateTime.makeUnsafe("2026-10-22T12:00:00.000Z");

interface Fixture {
  readonly archivedAt?: string | null;
  readonly runs?: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly requests?: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly status: string }>;
  readonly subagents?: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly roster?: ReadonlyArray<{ readonly taskId: string; readonly kind: string }>;
  readonly native?: string | null;
  readonly limitRecovery?: { readonly autoResume: boolean };
  readonly snoozedUntil?: DateTime.Utc;
  readonly restartContinuationPending?: boolean;
  readonly expectedNativeSessionId?: string;
}

const input = (fixture: Fixture = {}): IdleInput =>
  ({
    projection: {
      thread: {
        id: "thread-idle",
        archivedAt: fixture.archivedAt ?? null,
        activeProviderThreadId: "provider-thread-active",
        limitRecovery: fixture.limitRecovery ?? null,
        snoozedUntil: fixture.snoozedUntil ?? null,
      },
      runs: fixture.runs ?? [{ id: "run-1", status: "completed" }],
      runtimeRequests: fixture.requests ?? [],
      subagents: (fixture.subagents ?? []).map((subagent) => ({
        ...subagent,
        origin: "provider_native",
        title: null,
        nativeTaskRef: null,
        childThreadId: null,
      })),
      providerThreads: [
        {
          id: "provider-thread-old",
          nativeThreadRef: { driver: "opencode", nativeId: "ses_old", strength: "strong" },
          pendingBackgroundTasks: [],
        },
        {
          id: "provider-thread-active",
          nativeThreadRef:
            fixture.native === null
              ? null
              : { driver: "opencode", nativeId: fixture.native ?? "ses_current", strength: "strong" },
          pendingBackgroundTasks: fixture.roster ?? [],
        },
      ],
    },
    restartContinuationPending: fixture.restartContinuationPending ?? false,
    expectedNativeSessionId: fixture.expectedNativeSessionId,
    now,
  }) as unknown as IdleInput;

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
        limitRecovery: { autoResume: false },
        snoozedUntil: DateTime.makeUnsafe("2026-10-22T11:00:00.000Z"),
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

  it("refuses a thread that wakes on its own", () => {
    expect(reason({ restartContinuationPending: true })).toBe("pending-wake");
    expect(reason({ limitRecovery: { autoResume: true } })).toBe("pending-wake");
    expect(reason({ snoozedUntil: DateTime.makeUnsafe("2026-10-22T13:00:00.000Z") })).toBe(
      "pending-wake",
    );
  });

  it("refuses when the active session is not the expected one", () => {
    expect(reason({ expectedNativeSessionId: "ses_old" })).toBe("session-changed");
    expect(
      idleBlocker(input({ native: null, expectedNativeSessionId: "ses_current" }))?.reason,
    ).toBe("session-changed");
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
