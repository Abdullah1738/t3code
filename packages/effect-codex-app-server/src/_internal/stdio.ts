import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const STDERR_TAIL_MAX_CHARS = 8_192;
export const STDERR_TAIL_MAX_LINES = 50;

export const appendStderrTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk}`;
  return next.length <= STDERR_TAIL_MAX_CHARS ? next : next.slice(-STDERR_TAIL_MAX_CHARS);
};

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization:\s*\S+(?:\s+\S+)?/gi;
const API_KEY_HEADER_PATTERN = /\b(?:x-api-key|api[-_]?key)\s*[:=]\s*\S+/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

// The tail ends up in run failures that agents and boards read, so it keeps
// only the last lines and drops credentials Codex may echo from HTTP errors.
export const boundStderrTail = (tail: string): string =>
  tail
    .replaceAll("\0", "")
    .split("\n")
    .slice(-STDERR_TAIL_MAX_LINES)
    .join("\n")
    .replace(AUTHORIZATION_HEADER_PATTERN, "Authorization: [redacted]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(API_KEY_HEADER_PATTERN, "api-key: [redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]");

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrTail?: Effect.Effect<string>,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      (stderrTail ?? Effect.succeed<string | undefined>(undefined)).pipe(
        Effect.map(
          (tail) =>
            new CodexError.CodexAppServerProcessExitedError({
              code,
              pid: handle.pid,
              ...(tail === undefined ? {} : { stderrTail: tail }),
            }),
        ),
      ),
  });
