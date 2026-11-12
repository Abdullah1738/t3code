import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureCategory,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterFailureReason } from "./ProviderAdapter.ts";
import * as Schema from "effect/Schema";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.";
  }
}

export class ContextHandoffBackgroundWorkError extends Schema.TaggedError<ContextHandoffBackgroundWorkError>()(
  "ContextHandoffBackgroundWorkError",
  {},
) {
  override get message() {
    return "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

const PROVIDER_FAILURE_CATEGORIES: Partial<
  Record<string, { readonly summary: string; readonly guidance: string }>
> = {
  ProviderAdapterTurnStartError: {
    summary: "The provider could not start this turn",
    guidance: "Retry the turn; if it keeps failing, check the provider setup and server logs.",
  },
  ProviderAdapterEventStreamError: {
    summary: "The provider event stream closed unexpectedly",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
  ProviderAdapterOpenSessionError: {
    summary: "The provider session could not be opened",
    guidance: "Check that the provider is installed and signed in, then retry the turn.",
  },
  ProviderAdapterResumeThreadError: {
    summary: "The provider conversation could not be resumed",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
};

const PROVIDER_FAILURE_REASONS: Record<ProviderAdapterFailureReason, string> = {
  previous_turn_active: "the previous turn is still running",
  attachment_unreadable: "an attachment could not be read",
};

function causeMessage(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let category: (typeof PROVIDER_FAILURE_CATEGORIES)[string];
  let reason: string | undefined;
  // A dead provider process names its exit code and last stderr line, which
  // is the only clue to why every request on its session failed.
  let processExit: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const tag = (cause as Record<string, unknown>)._tag;
      switch (tag) {
        case "ContextHandoffBudgetError":
          return new ContextHandoffBudgetError().message;
        case "ContextHandoffBackgroundWorkError":
          return new ContextHandoffBackgroundWorkError().message;
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "CursorModelUnavailableError":
          return stringField(cause, "message");
        case "ContextHandoffDeliveryUncertainError":
          return "T3 could not confirm whether conversation history reached the provider. Retry the turn to recover the session.";
        case "CodexAppServerProcessExitedError":
          processExit ??= stringField(cause, "message");
          break;
        case "ProviderAdapterProtocolError": {
          const typedReason = (cause as Record<string, unknown>).reason;
          if (
            category !== undefined &&
            typeof typedReason === "string" &&
            Object.hasOwn(PROVIDER_FAILURE_REASONS, typedReason)
          ) {
            reason ??= PROVIDER_FAILURE_REASONS[typedReason as ProviderAdapterFailureReason];
          }
          break;
        }
      }
      if (typeof tag === "string" && Object.hasOwn(PROVIDER_FAILURE_CATEGORIES, tag)) {
        category = PROVIDER_FAILURE_CATEGORIES[tag];
        reason = undefined;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  reason ??= processExit;
  if (category === undefined) return processExit;
  return reason
    ? `${category.summary}: ${reason}. ${category.guidance}`
    : `${category.summary}. ${category.guidance}`;
}

// Errors expose `providerUsageLimit` when they reliably identify a provider
// usage limit (e.g. Codex exiting with its limit notice), whatever wraps them.
function usageLimitInCause(cause: unknown): { readonly resetAt: string | null } | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") return undefined;
      const usageLimit = (cause as Record<string, unknown>).providerUsageLimit;
      if (typeof usageLimit === "object" && usageLimit !== null) {
        const resetAt = (usageLimit as Record<string, unknown>).resetAt;
        return { resetAt: typeof resetAt === "string" ? resetAt : null };
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringField(value: unknown, key: "message" | "code"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

const sensitiveJsonKey =
  /(?:authorization|cookie|cookies|token|apikey|password|secret|credential)$/iu;

function redactJsonValue(value: unknown, depth: number): unknown {
  if (depth >= 8) return "[REDACTED]";
  if (typeof value === "string") return redactProviderFailureText(value, depth + 1);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveJsonKey.test(key.replace(/[^a-z0-9]/giu, ""))
          ? "[REDACTED]"
          : redactJsonValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

// Parse JSON fragments before matching plain text, preserving escaped quotes
// inside values and decoding nested string-valued bodies without losing boundaries.
function redactJsonFragments(value: string, depth: number): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "{" && value[index] !== "[") continue;
    parts.push(value.slice(start, index));
    const fragmentStart = index;
    let nesting = 0;
    let quoted = false;
    let escaped = false;
    for (; index < value.length; index++) {
      const character = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") nesting++;
      else if ((character === "}" || character === "]") && --nesting === 0) break;
    }
    const fragment = value.slice(fragmentStart, index + 1);
    try {
      parts.push(JSON.stringify(redactJsonValue(JSON.parse(fragment), depth)));
    } catch {
      parts.push(
        /cookie|token|password|secret|authorization|credential|api[_-]?key/iu.test(fragment)
          ? "[REDACTED_JSON]"
          : fragment,
      );
    }
    start = index + 1;
  }
  parts.push(value.slice(start));
  return parts.join("");
}

function redactProviderFailureText(value: string, depth = 0): string {
  return redactJsonFragments(replaceUnsafeControlCharacters(value), depth)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(
      /((?:["']?(?:set[_-]?cookie|cookie)["']?)\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:(?:access|refresh|id|auth|session)[_-]?token|api[_-]?key|(?:proxy[_-]?)?authorization|credential|password|(?:client[_-]?)?secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:(?:access|refresh|id|auth|session)[_-]?token|api[_-]?key|(?:proxy[_-]?)?authorization|credential|password|(?:client[_-]?)?secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly category?: OrchestrationV2ProviderFailureCategory;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const rawMessage = input.message ?? causeMessage(input.cause) ?? DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const usageLimit = usageLimitInCause(input.cause);
  const failureClass = usageLimit === undefined ? (input.class ?? "unknown") : "usage_limit";
  const resetAt = input.resetAt ?? usageLimit?.resetAt;
  const rawCode = input.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: failureClass,
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: input.retryable ?? null,
    // Only producers that classify a category set it. Others keep the record shape they
    // always had, so OpenCode and Pi failures serialize exactly as before.
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(failureClass === "usage_limit" && resetAt != null && Number.isFinite(Date.parse(resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(resetAt)) }
      : {}),
  };
}

export function withPreviousFailure(
  failure: OrchestrationV2ProviderFailure,
  previous: OrchestrationV2ProviderFailure | undefined,
): OrchestrationV2ProviderFailure {
  if (previous === undefined || failure.message.startsWith("Automatic resume failed."))
    return failure;
  return makeProviderFailure({
    ...failure,
    category: failure.category ?? "unknown",
    resetAt: failure.resetAt ?? null,
    message: `Automatic resume failed. First error: ${previous.message.slice(0, 1500)} Resume error: ${failure.message.slice(0, 1500)} Files may be partly written.`,
  });
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
