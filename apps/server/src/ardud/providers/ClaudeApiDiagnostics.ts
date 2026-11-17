import type { AnalyticsEvent, OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Analytics from "../analytics/Analytics.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";

type Details = NonNullable<AnalyticsEvent["claudeApiError"]>;

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

// Use the same redactor as persisted provider failures, before truncating any value.
function safeText(value: string, environment: NodeJS.ProcessEnv): string {
  for (const [key, secret] of Object.entries(environment)) {
    if (/key|token|secret|password|authorization|cookie/i.test(key) && secret && secret.length >= 4)
      value = value.replaceAll(secret, "[REDACTED]");
  }
  return makeProviderFailure({ message: value }).message.replace(
    /(\/[^\s"'<>?]*)\?[^\s"'<>]*/g,
    "$1",
  );
}

const label = (value: string) => value.replace(/[^a-zA-Z0-9_.:/#@%+-]/g, "_").slice(0, 160);

export function details(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly model: string;
  readonly status?: number | null | undefined;
  readonly body?: unknown;
  readonly errorCode?: string | null | undefined;
  readonly attempt: number;
  readonly resume: boolean;
}): Details {
  let host = "unknown";
  let path = "/";
  try {
    const url = new URL(input.environment.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
    if (url.protocol === "http:" || url.protocol === "https:") {
      host = label(safeText(url.host, input.environment));
      path = safeText(url.pathname, input.environment)
        .replace(/[^a-zA-Z0-9_./%~+-]/g, "_")
        .slice(0, 256);
    }
  } catch {
    // An invalid endpoint must never fall back to logging the configured value.
  }
  let body = input.body;
  const raw = typeof body === "string" ? body : (JSON.stringify(body) ?? "");
  if (typeof body === "string") {
    const start = body.indexOf("{");
    if (start >= 0) {
      try {
        body = JSON.parse(body.slice(start, body.lastIndexOf("}") + 1));
      } catch {
        /* The bounded redactor handles incomplete JSON. */
      }
    }
  }
  const bodyError = property(body, "error");
  const error = bodyError ?? body;
  const code =
    property(error, "code") ??
    property(body, "code") ??
    (typeof bodyError === "string" ? bodyError : undefined);
  const type = property(error, "type") ?? property(body, "type");
  return {
    model: safeText(input.model, input.environment).slice(0, 4096),
    host,
    path,
    status:
      typeof input.status === "number" &&
      Number.isInteger(input.status) &&
      input.status >= 100 &&
      input.status <= 599
        ? input.status
        : null,
    errorCode: label(
      safeText(typeof code === "string" ? code : (input.errorCode ?? "unknown"), input.environment),
    ),
    errorType: label(safeText(typeof type === "string" ? type : "unknown", input.environment)),
    errorText: safeText(raw, input.environment).slice(0, 200),
    attempt: Math.max(1, Math.trunc(input.attempt)),
    resume: input.resume,
  };
}

export function describe(
  failure: OrchestrationV2ProviderFailure,
  error: Details,
): OrchestrationV2ProviderFailure {
  const summary = [
    error.status === null ? null : `HTTP ${error.status}`,
    error.errorCode === "unknown" ? error.errorType : error.errorCode,
    error.model.slice(0, 512),
    `${error.host}${error.path}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    ...failure,
    message: makeProviderFailure({
      message: `${summary}${error.errorText ? `: ${error.errorText}` : ""} — ${failure.message}`,
    }).message,
  };
}

// Only Claude's stream-exit boundary opts into showing a scrubbed native cause.
// Other providers keep makeProviderFailure's generic fallback for arbitrary defects.
export function queryCause(
  cause: unknown,
  environment: NodeJS.ProcessEnv,
): { readonly message?: string; readonly code?: string } {
  const failure = makeProviderFailure({ cause, class: "transport_error" });
  if (failure.message !== "Provider turn failed.") return {};
  const seen = new Set<unknown>();
  let message: string | undefined;
  let code: string | undefined;
  for (let depth = 0; cause != null && depth < 16 && !seen.has(cause); depth++) {
    seen.add(cause);
    if (Cause.isCause(cause)) {
      cause = Cause.squash(cause);
      continue;
    }
    if (typeof cause === "string") {
      message = cause;
      break;
    }
    if (typeof cause !== "object") break;
    const nextMessage = property(cause, "message");
    const nextCode = property(cause, "code");
    if (typeof nextMessage === "string" && nextMessage.trim()) message = nextMessage;
    if (typeof nextCode === "string" && nextCode.trim()) code = nextCode;
    cause = property(cause, "cause");
  }
  return message === undefined && code === undefined
    ? {}
    : {
        message: `Provider turn failed. Last error: ${safeText([code, message].filter(Boolean).join(": "), environment).slice(0, 200)}`,
        ...(code === undefined ? {} : { code: label(safeText(code, environment)) }),
      };
}

export const makeRecorder = Effect.fn("ClaudeApiDiagnostics.makeRecorder")(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const boards = yield* Effect.serviceOption(KanbanStore.KanbanStore);
  return Effect.fn("ClaudeApiDiagnostics.record")(function* (input: {
    readonly turn: ProviderAdapterV2TurnInput;
    readonly startedAt: DateTime.Utc;
    readonly error: Details;
    readonly phase: "attempt" | "give_up";
  }) {
    const now = yield* DateTime.now;
    const link = Option.isSome(boards)
      ? yield* boards.value.threadLink(input.turn.threadId).pipe(Effect.orElseSucceed(() => null))
      : null;
    const row: AnalyticsEvent = {
      ts: DateTime.formatIso(now),
      kind: "provider.claude_api_error",
      surface: "server",
      route: "provider",
      threadId: input.turn.threadId,
      callerRole:
        link?.role ??
        (input.turn.appThread.lineage.relationshipToParent === "subagent" ? "unattached" : "none"),
      ...(link === null
        ? {}
        : { boardId: link.boardId, ...(link.cardId === null ? {} : { cardId: link.cardId }) }),
      durationMs: Math.max(
        0,
        DateTime.toEpochMillis(now) - DateTime.toEpochMillis(input.startedAt),
      ),
      phase: input.phase,
      props: { runId: input.turn.runId },
      claudeApiError: input.error,
    };
    yield* Effect.logWarning("provider.claude_api_error", row);
    if (Option.isSome(analytics)) yield* analytics.value.record(row);
  });
});
