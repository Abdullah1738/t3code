import { KanbanBoardId, KanbanCardId, type KanbanCardRetry } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  decideRetry,
  heldByPause,
  noRetryReason,
  NO_VERDICT_REASON,
  RETRY_BACKOFF_MS,
  RETRY_SETTLE_MS,
  reviewRetryNote,
  withoutRetries,
  withoutRoleRetries,
  withRetryNote,
  type RetryFailure,
  type RetryInput,
} from "./retries.ts";

const start = Date.parse("2026-11-10T10:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const dropped: RetryFailure = {
  class: "provider_error",
  code: null,
  message: "upstream closed the stream",
  category: "unknown",
  retryable: null,
  runId: "run-1",
};

const decide = (patch: Partial<RetryInput> & { readonly afterMs?: number } = {}) => {
  const { afterMs = 0, ...rest } = patch;
  return decideRetry({
    kind: "run_failed",
    role: "work",
    failure: dropped,
    retries: undefined,
    paused: false,
    nowMs: start + afterMs,
    at: iso(start + afterMs),
    ...rest,
  });
};

const waiting: KanbanCardRetry = {
  kind: "run_failed",
  role: "work",
  runId: "run-1",
  reason: "upstream closed the stream",
  at: iso(start),
  state: "waiting",
};
const restarted: KanbanCardRetry = {
  ...waiting,
  at: iso(start + RETRY_BACKOFF_MS),
  state: "restarted",
};

describe("noRetryReason", () => {
  it("retries a dropped stream, a crash and a run that failed without a message", () => {
    expect(noRetryReason(dropped)).toBeNull();
    expect(
      noRetryReason({ class: "transport_error", code: null, message: "socket hang up" }),
    ).toBeNull();
    expect(
      noRetryReason({
        class: "unknown",
        code: null,
        message: "The run failed without an error message.",
        retryable: null,
      }),
    ).toBeNull();
    expect(
      noRetryReason({
        class: "provider_error",
        code: "provider.internal",
        message: "exited with code 1",
      }),
    ).toBeNull();
  });

  it("never retries an outage: those threads are paused and probed", () => {
    for (const category of ["quota", "transient", "auth_expired"]) {
      expect(noRetryReason({ ...dropped, category })).toMatch(/out of usage or down/);
    }
    expect(noRetryReason({ class: "usage_limit", code: null, message: "limit" })).not.toBeNull();
    expect(
      noRetryReason({ ...dropped, category: undefined, message: "rate limit hit" }),
    ).not.toBeNull();
  });

  it("never retries a model that is not offered or allowed", () => {
    expect(noRetryReason({ ...dropped, category: "model_invalid" })).toMatch(/model/);
    for (const message of [
      "Variant unavailable for opus/gpt-6-astra: high",
      "The model gpt-9 does not exist or you do not have access to it",
      "model claude-x is not available on this plan",
      "Unknown model: foo",
      "You are not authorized to use this model",
    ]) {
      expect(noRetryReason({ ...dropped, message }), message).toMatch(/model/);
    }
    expect(noRetryReason({ ...dropped, code: "provider.no-route" })).not.toBeNull();
  });

  it("never retries a missing workspace or a run someone stopped", () => {
    for (const message of [
      "spawn ENOENT",
      "chdir: no such file or directory: /Users/x/checkouts/gone",
      "The worktree for this thread no longer exists",
      "workspace root not found",
    ]) {
      expect(noRetryReason({ ...dropped, message }), message).toMatch(/workspace/);
    }
    for (const message of [
      "Run interrupted by the owner",
      "cancelled by user",
      "aborted by operator",
    ]) {
      expect(noRetryReason({ ...dropped, message }), message).toMatch(/stopped/);
    }
  });

  it("never retries what the provider refuses as it stands", () => {
    expect(noRetryReason({ ...dropped, category: "config" })).not.toBeNull();
    expect(noRetryReason({ ...dropped, category: "content_filter" })).not.toBeNull();
    expect(noRetryReason({ ...dropped, category: "context_exhausted" })).not.toBeNull();
    expect(
      noRetryReason({ ...dropped, message: "prompt is too long: 250000 tokens" }),
    ).not.toBeNull();
    expect(noRetryReason({ ...dropped, retryable: false })).not.toBeNull();
    expect(noRetryReason({ ...dropped, class: "permission_error" })).not.toBeNull();
    expect(noRetryReason({ ...dropped, class: "validation_error" })).not.toBeNull();
    expect(noRetryReason({ ...dropped, code: "provider.invalid-request" })).not.toBeNull();
    expect(noRetryReason({ ...dropped, code: "provider.content-filter" })).not.toBeNull();
  });
});

describe("decideRetry: a failed run", () => {
  it("does not flag the first failure: it records it and waits with its thread", () => {
    const decision = decide();
    expect(decision).toEqual({ _tag: "wait", retries: [waiting] });
  });

  it("holds while the same failed run is seen again inside the backoff", () => {
    expect(decide({ retries: [waiting], afterMs: 30_000 })).toEqual({ _tag: "hold" });
    expect(decide({ retries: [waiting], afterMs: RETRY_BACKOFF_MS - 1 })).toEqual({ _tag: "hold" });
  });

  it("restarts the card once the backoff is over", () => {
    expect(decide({ retries: [waiting], afterMs: RETRY_BACKOFF_MS })).toEqual({
      _tag: "restart",
      retries: [restarted],
    });
  });

  it("flags the second failure", () => {
    const second = { ...dropped, runId: "run-2" };
    expect(
      decide({ retries: [restarted], failure: second, afterMs: RETRY_BACKOFF_MS + 5_000 }),
    ).toEqual({
      _tag: "flag",
      why: "the retry failed too",
    });
    // A different run failing while the first still waits is a second failure too.
    expect(decide({ retries: [waiting], failure: second, afterMs: 10_000 })._tag).toBe("flag");
  });

  it("gives the restart time to start a new run, then flags if the old failure still stands", () => {
    expect(decide({ retries: [restarted], afterMs: RETRY_BACKOFF_MS + 30_000 })).toEqual({
      _tag: "hold",
    });
    expect(decide({ retries: [restarted], afterMs: RETRY_BACKOFF_MS + RETRY_SETTLE_MS })).toEqual({
      _tag: "flag",
      why: "the restart did not start a new run",
    });
  });

  it("flags at once what a retry can't help", () => {
    expect(decide({ failure: { ...dropped, retryable: false } })._tag).toBe("flag");
    expect(decide({ failure: { ...dropped, category: "model_invalid" } })._tag).toBe("flag");
    expect(decide({ failure: { ...dropped, message: "no such file or directory" } })._tag).toBe(
      "flag",
    );
    expect(decide({ failure: null })._tag).toBe("flag");
  });

  it("neither retries nor flags a card the board's pause holds", () => {
    expect(decide({ paused: true })).toEqual({ _tag: "hold" });
    expect(decide({ paused: true, retries: [waiting], afterMs: RETRY_BACKOFF_MS })).toEqual({
      _tag: "hold",
    });
    expect(decide({ paused: true, failure: { ...dropped, retryable: false } })).toEqual({
      _tag: "hold",
    });
  });

  it("counts a worker's and a reviewer's retries apart", () => {
    const review = decide({ role: "review", retries: [restarted] });
    expect(review._tag).toBe("wait");
    expect(review._tag === "wait" ? review.retries.map((retry) => retry.role) : []).toEqual([
      "work",
      "review",
    ]);
  });

  it("starts over once the record is cleared (a good turn, a real move, a flag)", () => {
    expect(decide({ retries: undefined, failure: { ...dropped, runId: "run-9" } })._tag).toBe(
      "wait",
    );
  });
});

describe("decideRetry: a reviewer without a verdict", () => {
  const input = { kind: "no_verdict", role: "review", failure: null } as const;
  const used: KanbanCardRetry = {
    kind: "no_verdict",
    role: "review",
    runId: null,
    reason: NO_VERDICT_REASON,
    at: iso(start),
    state: "restarted",
  };

  it("restarts the review once, with no backoff", () => {
    expect(decide(input)).toEqual({ _tag: "restart", retries: [used] });
  });

  it("flags the second time", () => {
    expect(decide({ ...input, retries: [used], afterMs: 60_000 })._tag).toBe("flag");
  });

  it("keeps a failed-run retry on the same review apart", () => {
    const failed: KanbanCardRetry = { ...restarted, role: "review" };
    const decision = decide({ ...input, retries: [failed] });
    expect(decision._tag).toBe("restart");
    expect(decision._tag === "restart" ? decision.retries.map((retry) => retry.kind) : []).toEqual([
      "run_failed",
      "no_verdict",
    ]);
  });

  it("does nothing on a paused board", () => {
    expect(decide({ ...input, paused: true })).toEqual({ _tag: "hold" });
  });
});

describe("retry records and notes", () => {
  const card = {
    id: KanbanCardId.make("c1"),
    retries: [waiting, { ...restarted, role: "review" as const }],
  };

  it("clears the whole record, or one role's", () => {
    expect("retries" in withoutRetries(card as never)).toBe(false);
    const plain = { id: card.id };
    expect(withoutRetries(plain as never)).toBe(plain);
    expect(
      (withoutRoleRetries(card as never, "work") as typeof card).retries.map((r) => r.role),
    ).toEqual(["review"]);
    expect(
      "retries" in withoutRoleRetries({ id: card.id, retries: [waiting] } as never, "work"),
    ).toBe(false);
    expect(withoutRoleRetries(plain as never, "work")).toBe(plain);
  });

  it("knows which cards a pause holds", () => {
    const pause = { reason: "cutover", keep: [card.id], at: iso(start), by: "owner" };
    expect(heldByPause({ pause: null }, card)).toBe(false);
    expect(heldByPause({ pause }, card)).toBe(false);
    expect(heldByPause({ pause }, { id: KanbanCardId.make("c2") })).toBe(true);
    expect(KanbanBoardId.make("b1")).toBe("b1");
  });

  it("tells the restarted worker why, after what was already waiting for it", () => {
    expect(withRetryNote(null, "boom")).toMatch(/^Your last run on this card failed: "boom"/);
    expect(withRetryNote("Review findings: fix x", "boom")).toMatch(
      /^Review findings: fix x\n\nYour last run on this card failed: "boom"/,
    );
  });

  it("tells a restarted reviewer why, and nobody else", () => {
    expect(reviewRetryNote({ retries: undefined })).toBeNull();
    expect(reviewRetryNote({ retries: [waiting, restarted] })).toBeNull();
    expect(reviewRetryNote({ retries: [{ ...waiting, role: "review" }] })).toBeNull();
    expect(reviewRetryNote({ retries: [{ ...restarted, role: "review" }] })).toMatch(
      /failed: "upstream closed the stream"/,
    );
    expect(
      reviewRetryNote({
        retries: [
          {
            ...restarted,
            role: "review",
            kind: "no_verdict",
            runId: null,
            reason: NO_VERDICT_REASON,
          },
        ],
      }),
    ).toMatch(/ended without a verdict/);
  });
});
