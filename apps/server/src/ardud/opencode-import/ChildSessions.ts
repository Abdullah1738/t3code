/**
 * What became of OpenCode child sessions (background subagents) across a Robob
 * restart. OpenCode runs as its own service here, so a child Robob marks
 * cancelled at shutdown can keep running and then post its result into its
 * parent's session. Telling the parent it is gone makes it start the same work
 * twice; on 24 Oct both "lost" reviews had finished and reported back.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSettings from "../../serverSettings.ts";
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

/** The OpenCode session behind a native child's thread id, if it has one. */
export const childSessionId = (threadId: string | null | undefined) =>
  threadId?.match(/native-thread:(ses_[A-Za-z0-9]+)/)?.[1];

/** The text of an assistant turn that finished cleanly after the child started. */
const completedAnswer = (message: OpenCodeMessage, since: number): string | undefined => {
  if (message.type !== "assistant") return undefined;
  if (message.finish !== "stop" || message.error !== undefined) return undefined;
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
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.catch((error) =>
      // The session is gone from OpenCode: nothing left to report or resume.
      Effect.succeed(
        Schema.is(OpenCodeHttpError)(error) && error.status === 404 ? "gone" : "failed",
      ),
    ),
  );
  if (read === "gone") return { state: "stopped" } satisfies ChildCheck;
  if (read === "failed" || Option.isNone(read)) return { state: "unknown" } satisfies ChildCheck;
  const { messages } = read.value;
  const newest = messages.at(-1);
  // A session with no turn, or whose newest message predates the child, never ran it.
  if (newest === undefined || newest.time.created < child.since - SLACK_MS)
    return { state: "stopped" } satisfies ChildCheck;
  const answered = messages.findLast(
    (message) => completedAnswer(message, child.since) !== undefined,
  );
  const text = answered === undefined ? undefined : completedAnswer(answered, child.since);
  if (newest.type === "assistant" && text !== undefined) {
    return { state: "finished", result: text } satisfies ChildCheck;
  }
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
    const connection = yield* configuredConnection(settings);
    const result = new Map<string, ChildCheck>();
    if (connection === undefined) {
      for (const child of children) result.set(child.sessionId, { state: "stopped" });
      return result;
    }
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
