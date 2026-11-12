import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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

const CREDENTIAL_KEY =
  "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|credential|password|passwd|secret|token)";
// A quoted value runs to its own closing quote, skipping escapes; an
// unterminated one runs to the end of the line.
const QUOTED_VALUE = String.raw`"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)`;
const QUOTED_KEY_CREDENTIAL_PATTERN = new RegExp(
  String.raw`(["'])(${CREDENTIAL_KEY})\1(\s*:\s*)(?:${QUOTED_VALUE}|[^\s,}\]]+)`,
  "gim",
);
const ASSIGNED_CREDENTIAL_PATTERN = new RegExp(
  String.raw`(\b${CREDENTIAL_KEY}\b\s*[:=]\s*)(?:${QUOTED_VALUE}|[^\s,;&"']+)`,
  "gim",
);
const redactQuotedKeyValue = (
  match: string,
  keyQuote: string,
  key: string,
  separator: string,
): string => {
  const valueQuote = match.charAt(keyQuote.length * 2 + key.length + separator.length);
  return valueQuote === '"' || valueQuote === "'"
    ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
    : `${keyQuote}${key}${keyQuote}${separator}[redacted]`;
};
const BEARER_TOKEN_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+=/]+/gi;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)[^\s/@]+@/gi;
const URL_QUERY_PATTERN = /\b(https?:\/\/[^\s?#]+)\?[^\s#]*/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

// The tail reaches run failures and persisted session errors (rendered with
// Cause.pretty, which skips later failure redaction), so it keeps only the last
// lines and drops credentials Codex may echo from HTTP errors or config.
export const boundStderrTail = (tail: string): string =>
  tail
    .replaceAll("\0", "")
    .split("\n")
    .slice(-STDERR_TAIL_MAX_LINES)
    .join("\n")
    .replace(QUOTED_KEY_CREDENTIAL_PATTERN, redactQuotedKeyValue)
    .replace(BEARER_TOKEN_PATTERN, "$1 [redacted]")
    .replace(ASSIGNED_CREDENTIAL_PATTERN, "$1[redacted]")
    .replace(URL_USERINFO_PATTERN, "$1")
    .replace(URL_QUERY_PATTERN, "$1")
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
      Effect.all([
        stderrTail ?? Effect.succeed<string | undefined>(undefined),
        Clock.currentTimeMillis,
      ]).pipe(
        Effect.map(
          ([tail, exitedAtMs]) =>
            new CodexError.CodexAppServerProcessExitedError({
              code,
              pid: handle.pid,
              exitedAt: DateTime.formatIso(DateTime.makeUnsafe(exitedAtMs)),
              ...(tail === undefined ? {} : { stderrTail: tail }),
            }),
        ),
      ),
  });
