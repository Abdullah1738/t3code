/**
 * What became of OpenCode child sessions (background subagents) across a Robob
 * restart. OpenCode runs as its own service here, so a child Robob marks
 * cancelled at shutdown can keep running and then post its result into its
 * parent's session. Telling the parent it is gone makes it start the same work
 * twice; on 24 Oct both "lost" reviews had finished and reported back.
 */
import type { OrchestrationV2RestartCancelledBackgroundWork } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSettings from "../../serverSettings.ts";
import { restartCancelledBackgroundWorkNote } from "../../orchestration-v2/RestartBackgroundNote.ts";
import {
  configuredConnection,
  listActiveSessionIds,
  listRecentMessages,
  OpenCodeHttpError,
  type OpenCodeConnection,
  type OpenCodeMessage,
} from "./OpenCodeHttp.ts";

export type ChildCheckState = "running" | "finished" | "stopped" | "unknown";

export interface ChildCheck {
  readonly state: ChildCheckState;
  /** The child's last answer, for a finished one. */
  readonly result?: string;
}

export interface ChildRef {
  readonly sessionId: string;
  /** Epoch millis of when the child was started. */
  readonly since: number;
}

// Restart waits on this probe, so a slow or dead OpenCode must not hold it up.
const PROBE_TIMEOUT = "3 seconds";
// A message this close to the child's start may still be the one before it.
const SLACK_MS = 5_000;
const RECENT_MESSAGE_LIMIT = 10;

/**
 * ardud: the restart note text for cut work. Running and finished OpenCode
 * children are left out (a finished child's answer is quoted in one line); an
 * unknown child gets its own hedged paragraph, since it may still report back;
 * everything else is passed through from the upstream note unchanged.
 */
export const restartNoteParts = (
  work: ReadonlyArray<Pick<OrchestrationV2RestartCancelledBackgroundWork, "child">>,
  checks: ReadonlyMap<string, ChildCheck>,
) => {
  const finished: Array<{ readonly index: number; readonly result: string }> = [];
  const unknown: Array<number> = [];
  const rest: Array<number> = [];
  work.forEach((entry, index) => {
    const sessionId = childSessionId(entry.child?.threadId);
    const check = sessionId === undefined ? undefined : checks.get(sessionId);
    if (check?.state === "running") return;
    if (check?.state === "finished") {
      finished.push({ index, result: check.result ?? "" });
      return;
    }
    if (check?.state === "unknown") {
      unknown.push(index);
      return;
    }
    rest.push(index);
  });
  return { rest, finished, unknown };
};

/** The OpenCode session behind a native child's thread id, if it has one. */
export const childSessionId = (threadId: string | null | undefined) =>
  threadId?.match(/native-thread:(ses_[A-Za-z0-9]+)/)?.[1];

/**
 * The text of an assistant turn that completed cleanly after the child started.
 * Requires `time.completed`: a turn still streaming, or one whose completion
 * was never recorded, is not a result.
 */
const completedAnswer = (message: OpenCodeMessage, since: number): string | undefined => {
  if (message.type !== "assistant") return undefined;
  if (message.finish !== "stop" || message.error !== undefined) return undefined;
  if (message.time.completed === undefined) return undefined;
  if (message.time.created < since - SLACK_MS) return undefined;
  const text = (message.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("\n")
    .trim();
  return text.length === 0 ? undefined : text;
};

const checkOne = Effect.fn("ChildSessions.checkOne")(function* (
  connection: OpenCodeConnection,
  child: ChildRef,
  active: ReadonlySet<string>,
) {
  if (active.has(child.sessionId)) return { state: "running" } satisfies ChildCheck;
  const read = yield* listRecentMessages(connection, child.sessionId, {
    limit: RECENT_MESSAGE_LIMIT,
  }).pipe(
    Effect.map((value) => ({ kind: "ok" as const, value })),
    Effect.catch((error) =>
      // The session is gone from OpenCode: nothing left to report or resume.
      Effect.succeed(
        Schema.is(OpenCodeHttpError)(error) && error.status === 404
          ? { kind: "gone" as const }
          : { kind: "failed" as const },
      ),
    ),
    Effect.timeoutOption(PROBE_TIMEOUT),
  );
  if (Option.isNone(read) || read.value.kind === "failed")
    return { state: "unknown" } satisfies ChildCheck;
  if (read.value.kind === "gone") return { state: "stopped" } satisfies ChildCheck;
  const { messages } = read.value.value;
  // Newest first from OpenCode's read path; the newest idle entry records how the run ended.
  const newestIdle = messages.findLast((message) => message.type === "idle");
  // A session with no post-start turn never ran this child.
  const postStart = messages.filter((message) => message.time.created >= child.since - SLACK_MS);
  if (postStart.length === 0) return { state: "stopped" } satisfies ChildCheck;
  // The result is the newest completed assistant turn after the child started.
  const answer = postStart.findLast((message) => completedAnswer(message, child.since) !== undefined);
  const text = answer === undefined ? undefined : completedAnswer(answer, child.since);
  if (newestIdle?.outcome === "succeeded" && text !== undefined)
    return { state: "finished", result: text } satisfies ChildCheck;
  return { state: "stopped" } satisfies ChildCheck;
});

/**
 * Looks up the state of each child. Never fails: with no external OpenCode
 * server configured, a child Robob starts stops with it, so every child is
 * `stopped`. A failed read leaves that child `unknown`.
 */
export const checkChildren = (
  settings: ServerSettings.ServerSettingsService["Service"],
  children: ReadonlyArray<ChildRef>,
): Effect.Effect<ReadonlyMap<string, ChildCheck>> =>
  Effect.gen(function* () {
    const configured = yield* configuredConnection(settings);
    const result = new Map<string, ChildCheck>();
    // ardud: only a confirmed local setup means "stopped without a probe". An
    // unreadable or half-configured setup is unknown, never a cancellation claim.
    if (configured.kind === "local") {
      for (const child of children) result.set(child.sessionId, { state: "stopped" });
      return result;
    }
    if (configured.kind === "unknown") {
      for (const child of children) result.set(child.sessionId, { state: "unknown" });
      return result;
    }
    const connection = configured.connection;
    const active = yield* listActiveSessionIds(connection).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map((value) => (Option.isSome(value) ? value.value : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
    if (active === undefined) {
      for (const child of children) result.set(child.sessionId, { state: "unknown" });
      return result;
    }
    yield* Effect.forEach(
      children,
      (child) =>
        checkOne(connection, child, active).pipe(
          Effect.map((check) => {
            result.set(child.sessionId, check);
          }),
        ),
      { concurrency: 4, discard: true },
    );
    return result as ReadonlyMap<string, ChildCheck>;
  });

/**
 * ardud: the note for work a restart cut. With no OpenCode child in it there is
 * no HTTP call and the upstream note is returned unchanged. Otherwise running
 * children are left out, a finished child's answer is quoted in one line, and
 * an unknown child gets a hedged paragraph, since it may still report back.
 */
export const restartNoteSummary = Effect.fn("ChildSessions.restartNoteSummary")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  work: ReadonlyArray<OrchestrationV2RestartCancelledBackgroundWork>,
) {
  const refs = work.flatMap((entry) => {
    const sessionId = childSessionId(entry.child?.threadId);
    return entry.child === undefined || sessionId === undefined
      ? []
      : [{ sessionId, since: DateTime.toEpochMillis(entry.child.startedAt) }];
  });
  if (refs.length === 0)
    return { text: restartCancelledBackgroundWorkNote(work), claimsCancelled: work.length > 0 };
  const checks = yield* checkChildren(settings, refs);
  const parts = restartNoteParts(work, checks);
  const lines: Array<string> = [];
  const rest = parts.rest.map((index) => work[index]!);
  if (rest.length > 0) lines.push(restartCancelledBackgroundWorkNote(rest));
  for (const finished of parts.finished) {
    const first = finished.result.split("\n")[0]!.trim().slice(0, 200);
    lines.push(`- finished while the server restarted, already reported back: ${first}`);
  }
  if (parts.unknown.length > 0) {
    lines.push(
      "Some background work could not be checked after the restart. It may still be running and report back by itself; don't call it again just to check. Resume one only once you know it stopped without a result.",
    );
  }
  return { text: lines.join("\n\n"), claimsCancelled: rest.length > 0 };
});

/** The note text alone, for callers that only need the prompt. */
export const restartNoteText = (
  settings: ServerSettings.ServerSettingsService["Service"],
  work: ReadonlyArray<OrchestrationV2RestartCancelledBackgroundWork>,
) => restartNoteSummary(settings, work).pipe(Effect.map((summary) => summary.text));
