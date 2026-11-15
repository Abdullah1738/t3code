import { interruptionProps } from "../../observability/analyticsInterruption.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hashing the small retry key synchronously keeps ledger capture independent of runtime crypto services.
import * as NodeCrypto from "node:crypto";
import { OrchestratorMcpFailure, type AnalyticsEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Exit from "effect/Exit";
import { McpSchema } from "effect/ai";

type Phase = NonNullable<AnalyticsEvent["errorPhase"]>;
type ThreadReadStage = NonNullable<AnalyticsEvent["threadReadStages"]>[number];
type MutableThreadReadStage = { -readonly [K in keyof ThreadReadStage]: ThreadReadStage[K] };

export class McpCall extends Context.Service<
  McpCall,
  {
    boardId?: string;
    cardId?: string;
    cardNumber?: number;
    delegation?: {
      readonly taskId: string;
      readonly readCommitted: Effect.Effect<boolean | "unknown">;
    };
    threadRead?: {
      readerWaitMs: number;
      queryMs: number;
      renderMs: number;
      threadReadStages: Array<MutableThreadReadStage>;
      activeStage?: {
        readonly row: MutableThreadReadStage;
        readonly started: bigint;
        readonly durationBefore: number;
      };
    };
    callerResolved: boolean;
    callerResolveMs: number;
    requestTiming?: {
      readonly authMs: number;
      readonly dispatchMs: number;
      readonly preHandlerMs: number;
    };
    callerStarted?: bigint;
    readerLane: string;
    waitStage?: "lookup.caller" | "lookup.target" | "waiting";
    waitLookupMs?: number;
    phase: Phase;
    saved: boolean | "unknown";
    replyFailure?: "reply_timeout" | "reply_error";
    replyStage?: string;
    handlerErrorTag?: string;
    handlerOutcome?: "timeout" | "refused";
  }
>()("t3/ardud/analytics/McpCall") {}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const label = (value: unknown, max = 160): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[a-zA-Z0-9_.:/#@%+-]+$/.test(value)
    ? value
    : undefined;
const isFailureCode = Schema.is(OrchestratorMcpFailure.fields.code);
const BOARD_BUSY =
  /^(?:Missions board conflict: )?(?:Board busy: not written|Not saved \(board busy\))/;
const TYPED_OUTCOMES = {
  TimeoutError: "timeout",
  PullRequestWatchTimeoutError: "timeout",
  PreviewAutomationTimeoutError: "timeout",
  PreviewAutomationRecordingDeadlineExpiredError: "timeout",
  PreviewAutomationUnavailableError: "refused",
  McpCapabilityUnavailableError: "refused",
  PreviewControlRequiredError: "refused",
  PreviewAutomationControlInterruptedError: "refused",
  PreviewAutomationUnsupportedClientError: "refused",
  DeviceActionUnavailableError: "refused",
  DeviceToolUnavailableError: "refused",
} as const;

function classifyFailure(error: Record<string, unknown>) {
  if (
    (error._tag === "KanbanError" &&
      error.code === "conflict" &&
      typeof error.detail === "string" &&
      BOARD_BUSY.test(error.detail)) ||
    (isFailureCode(error.code) &&
      typeof error.message === "string" &&
      BOARD_BUSY.test(error.message))
  )
    return { tag: "board_busy", outcome: "refused" as const };
  if (isFailureCode(error.code)) return { tag: error.code };
  if (error.code === -32602 || error._tag === "InvalidParams" || error._tag === "SchemaError")
    return { tag: "invalid_request" };
  if (typeof error._tag === "string" && Object.hasOwn(TYPED_OUTCOMES, error._tag))
    return { tag: error._tag, outcome: TYPED_OUTCOMES[error._tag as keyof typeof TYPED_OUTCOMES] };
  if (error._tag === "DeviceBootError" && error.reason === "timeout")
    return { tag: "DeviceBootError", outcome: "timeout" as const };
  return undefined;
}

export function callIdentifiers(payload: unknown, callerIdentity: string | undefined) {
  const input = fields(payload);
  return {
    ...(label(input.boardId, 512) ? { boardId: label(input.boardId, 512)! } : {}),
    ...(label(input.cardId ?? input.card, 512)
      ? { cardId: label(input.cardId ?? input.card, 512)! }
      : {}),
    ...(typeof input.clientRequestId === "string"
      ? {
          clientRequestId: NodeCrypto.createHash("sha256")
            .update(JSON.stringify([callerIdentity ?? "", input.clientRequestId]))
            .digest("hex"),
        }
      : {}),
  };
}

// Resolution already happens in the tool; capture only its canonical metadata without another DB read.
export const resolvedContext = Effect.fnUntraced(function* (context: {
  boardId?: string;
  id?: string;
  number?: number;
}) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None" || call.value.cardId !== undefined) return;
  if (context.boardId) call.value.boardId = context.boardId;
  if (context.id) call.value.cardId = context.id;
  if (context.number !== undefined) call.value.cardNumber = context.number;
});

// Every deadline already has a span; this only preserves its phase through MCP error encoding.
export const failedPhase = Effect.fnUntraced(function* (phase: string) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some")
    call.value.phase =
      phase === "caller" || phase === "dispatch" || phase === "result"
        ? phase
        : phase === "records"
          ? "result"
          : "handler";
});

// Dispatch owns the commit span; observing the receipt must not add per-event spans.
export const setSaved = Effect.fnUntraced(function* (saved: boolean) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some") call.value.saved = saved;
});

// Capture the receipt lookup before dispatch so interruption cannot hide a committed command.
export const trackDelegation = Effect.fnUntraced(function* (
  taskId: string,
  readCommitted: Effect.Effect<boolean | "unknown">,
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some") call.value.delegation = { taskId, readCommitted };
});

// The toolkit erases defects and some typed errors while encoding the MCP reply.
export const handlerFailure = Effect.fnUntraced(function* <E>(cause: Cause.Cause<E>) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None") return;
  const error = cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? [fields(reason.error)]
      : reason._tag === "Die"
        ? [fields(reason.defect)]
        : [],
  )[0];
  const classified = classifyFailure(error ?? {});
  call.value.handlerErrorTag = classified?.tag ?? (Cause.hasDies(cause) ? "Defect" : "Failure");
  if (classified?.outcome) call.value.handlerOutcome = classified.outcome;
  else delete call.value.handlerOutcome;
});

export function callOutcome(
  exit: Exit.Exit<McpSchema.CallToolResult | McpSchema.InputRequired, unknown>,
  state: McpCall["Service"],
): Pick<AnalyticsEvent, "outcome" | "errorTag" | "errorPhase" | "saved" | "props"> {
  if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause))
    return {
      outcome: "interrupted",
      saved: state.saved,
      errorPhase: state.phase,
      props: { code: "unknown", ...interruptionProps(exit.cause) },
    };
  const output =
    exit._tag === "Success" && !(exit.value instanceof McpSchema.InputRequired)
      ? exit.value
      : undefined;
  const content = fields(output?.structuredContent);
  let encodedError: Record<string, unknown> = {};
  if (output?.isError && output.structuredContent === undefined) {
    const part = output.content?.find((part) => part.type === "text");
    if (part?.type === "text" && part.text.length <= 8192) {
      try {
        encodedError = fields(JSON.parse(part.text));
      } catch {
        /* Plain-text failures have no typed code. */
      }
    }
  }
  const error =
    exit._tag === "Failure"
      ? (exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Fail"
            ? [fields(reason.error)]
            : reason._tag === "Die"
              ? [fields(reason.defect)]
              : [],
        )[0] ?? {})
      : output?.structuredContent === undefined
        ? encodedError
        : content;
  const classified = classifyFailure(error);
  const code = state.handlerErrorTag ?? classified?.tag;
  const typedOutcome = state.handlerOutcome ?? classified?.outcome;
  const inputRequired = exit._tag === "Success" && exit.value instanceof McpSchema.InputRequired;
  const failed =
    inputRequired ||
    exit._tag === "Failure" ||
    output?.isError === true ||
    (content._tag !== undefined && code !== undefined);
  // Only errors need text inspection. Large successful replies must not be copied or scanned.
  const part = failed ? output?.content?.find((part) => part.type === "text") : undefined;
  const text =
    failed && typeof error.message === "string"
      ? error.message.slice(0, 8192)
      : part?.type === "text"
        ? part.text.slice(0, 8192)
        : "";
  const partial = content.partial === true;
  const waitTimedOut = content.waitTimedOut === true || content.timedOut === true;
  const requestTimedOut = content.status === "timed_out";
  const timeout =
    typedOutcome === "timeout" ||
    partial ||
    waitTimedOut ||
    requestTimedOut ||
    state.replyFailure === "reply_timeout" ||
    code === "caller_unresolved" ||
    code === "delegation_timeout" ||
    code === "send_timeout" ||
    code === "lookup_timeout";
  const busy = code === "board_busy" || BOARD_BUSY.test(text);
  const refused =
    typedOutcome === "refused" ||
    inputRequired ||
    busy ||
    code === "capability_denied" ||
    code === "parent_not_active" ||
    code?.endsWith("_denied") === true;
  const replyTooLarge = /reply too large|reply exceeds/i.test(text);
  const saved =
    state.saved === true
      ? true
      : typeof content.saved === "boolean"
        ? content.saved
        : inputRequired ||
            code === "caller_unresolved" ||
            code === "capability_denied" ||
            code === "parent_not_active" ||
            code === "PreviewAutomationUnavailableError" ||
            code === "McpCapabilityUnavailableError" ||
            busy
          ? false
          : state.saved;
  return {
    outcome: timeout
      ? "timeout"
      : failed || state.replyFailure
        ? refused
          ? "refused"
          : "error"
        : "ok",
    saved,
    props: {
      ...(state.replyStage === undefined ? {} : { phase: state.replyStage }),
      code:
        state.replyFailure ??
        (busy
          ? "board_busy"
          : inputRequired
            ? "input_required"
            : partial
              ? "partial_result"
              : waitTimedOut
                ? "wait_timeout"
                : requestTimedOut
                  ? "request_timeout"
                  : replyTooLarge
                    ? "reply_too_large"
                    : code === "Failure" || code === "Defect"
                      ? "unknown"
                      : (code ?? "unknown")),
      ...(exit._tag === "Failure" ? interruptionProps(exit.cause) : {}),
    },
    ...(failed || timeout || state.replyFailure
      ? {
          errorTag:
            state.replyFailure ??
            (inputRequired
              ? "input_required"
              : partial
                ? "partial_result"
                : waitTimedOut
                  ? "wait_timeout"
                  : requestTimedOut
                    ? "request_timeout"
                    : busy
                      ? "board_busy"
                      : replyTooLarge
                        ? "reply_too_large"
                        : (code ??
                          (exit._tag === "Failure" && Cause.hasDies(exit.cause)
                            ? "Defect"
                            : "McpToolError"))),
          errorPhase:
            code === "caller_unresolved" ||
            (partial && state.phase === "caller" && !state.callerResolved)
              ? "caller"
              : replyTooLarge || state.replyFailure || partial || waitTimedOut || requestTimedOut
                ? "result"
                : state.phase,
        }
      : {}),
  };
}
