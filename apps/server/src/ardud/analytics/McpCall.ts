import { isReasonClass, kanbanReasonClass, schemaReason } from "./McpFailureReason.ts";
import { interruptionProps } from "../../observability/analyticsInterruption.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hashing the small retry key synchronously keeps ledger capture independent of runtime crypto services.
import * as NodeCrypto from "node:crypto";
import {
  KanbanErrorCode,
  McpDenyReason,
  OrchestratorMcpFailure,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Exit from "effect/Exit";
import type * as SchemaIssue from "effect/SchemaIssue";
import { McpSchema } from "effect/ai";

type Phase = NonNullable<AnalyticsEvent["errorPhase"]>;
type ThreadReadStage = NonNullable<AnalyticsEvent["threadReadStages"]>[number];
type MutableThreadReadStage = { -readonly [K in keyof ThreadReadStage]: ThreadReadStage[K] };
type TaskLookup = Pick<
  NonNullable<AnalyticsEvent["props"]>,
  | "foundBy"
  | "notFoundReason"
  | "idCanonical"
  | "idShape"
  | "commandId"
  | "taskId"
  | "receiptState"
  | "missingLookup"
>;

export class McpCall extends Context.Service<
  McpCall,
  {
    boardId?: string;
    cardId?: string;
    cardNumber?: number;
    targetResolved?: boolean;
    callerRole?: AnalyticsEvent["callerRole"];
    callerKind?: AnalyticsEvent["callerKind"];
    callerCardNumber?: number;
    callerCardStage?: string;
    writePhases?: AnalyticsEvent["writePhases"];
    cardStage?: string;
    denyReason?: AnalyticsEvent["denyReason"];
    reasonClass?: AnalyticsEvent["reasonClass"];
    invalidField?: string;
    refusedAt?: AnalyticsEvent["refusedAt"];
    boardWrite?: boolean;
    boardAdmitted?: boolean;
    readOnly?: boolean;
    inputKeys?: ReadonlySet<string>;
    replyPhases?: AnalyticsEvent["replyPhases"];
    resolveCallerContext?: (parentThreadId?: string) => void;
    delegation?: {
      readonly taskId: string;
      readonly readCommitted: Effect.Effect<boolean | "unknown">;
    };
    detachedAnalytics?: {
      readonly tool: string;
      readonly callerIdentity: string | undefined;
      readonly callerThreadId: string | undefined;
      readonly startedAt: string;
      readonly build: string;
      readonly bootId: string;
    };
    threadList?: {
      phase: "caller" | "project" | "candidates" | "shell" | "render";
      batchCount: number;
      candidateRows: number;
      elapsedMs: number;
      readerWaitMs: number;
      queryMs: number;
    };
    threadRead?: {
      readerWaitMs: number;
      queryMs: number;
      renderMs: number;
      threadReadStages: Array<MutableThreadReadStage>;
      acknowledgement?: "may_have_completed" | "completed";
      phase?: {
        name: "lane_wait" | "query" | "render";
        started: bigint;
        elapsed: { lane_wait: number; query: number; render: number };
      };
      activeStage?: {
        readonly row: MutableThreadReadStage;
        readonly started: bigint;
        readonly durationBefore: number;
      };
    };
    callerResolved: boolean;
    cardNext?: {
      stages: Array<{
        stage: NonNullable<AnalyticsEvent["cardNextStages"]>[number]["stage"];
        durationMs: number;
        readerWaitMs: number;
        queryMs: number;
        completed: boolean;
      }>;
      active?: { started: bigint; index: number; durationBefore: number };
      waitingSince?: bigint;
    };
    callerResolveMs: number;
    requestTiming?: {
      readonly authMs: number;
      readonly dispatchMs: number;
      readonly preHandlerMs: number;
    };
    callerStarted?: bigint;
    // Handler waits can update readerLane after caller resolution has finished.
    callerReaderLane?: string;
    readerLane: string;
    boundedRead?: { readonly phase: string; readonly waitedMs: number };
    readDeadlineExpired?: true;
    waitStage?: "lookup.caller" | "lookup.target" | "waiting";
    waitLookupMs?: number;
    phase: Phase;
    saved: boolean | "unknown";
    dispatchFenceRecovered?: boolean;
    retryPath?: "receipt_fast" | "attached_pending" | "dispatched";
    taskLookup?: TaskLookup;
    replyFailure?: "reply_timeout" | "reply_error";
    replyStage?: string;
    replySubSteps?: ReadonlyArray<{ readonly subStep: string; readonly ms: number }>;
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
const isDenyReason = Schema.is(McpDenyReason);
const isKanbanErrorCode = Schema.is(KanbanErrorCode);
const BOARD_BUSY =
  /^(?:Missions board conflict: )?(?:Board busy: not written|Not saved \(board busy\))/;
const TYPED_OUTCOMES = {
  TimeoutError: "timeout",
  ThreadReadTimeoutError: "timeout",
  WikiReadTimeoutError: "timeout",
  PullRequestWatchTimeoutError: "timeout",
  PullRequestWatchUnavailableError: "refused",
  PullRequestToolTimeoutError: "timeout",
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

export function hashClientRequestId(clientRequestId: string, callerIdentity: string | undefined) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([callerIdentity ?? "", clientRequestId]))
    .digest("hex");
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
          clientRequestId: hashClientRequestId(input.clientRequestId, callerIdentity),
        }
      : {}),
  };
}

function failureMetadata(error: Record<string, unknown>, state: McpCall["Service"]) {
  if (isReasonClass(error.reasonClass)) state.reasonClass = error.reasonClass;
  else if (error._tag === "KanbanError" && isKanbanErrorCode(error.code))
    state.reasonClass = kanbanReasonClass(
      error.code,
      typeof error.reason === "string" ? error.reason : undefined,
    );
  if (typeof error.invalidField === "string" && state.inputKeys?.has(error.invalidField))
    state.invalidField = error.invalidField;
}

// Capture the first issue before MCP encodes parameter failures as InvalidParams.
export const parameterFailure = Effect.fnUntraced(function* (issue: SchemaIssue.Issue) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some") {
    failureMetadata(schemaReason(issue), call.value);
    if (!call.value.readOnly && call.value.taskLookup === undefined && call.value.saved !== true)
      call.value.saved = false;
  }
});

export const writeAdmitted = Effect.fnUntraced(function* () {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some" && call.value.boardWrite) {
    call.value.boardAdmitted = true;
    delete call.value.refusedAt;
  }
});

export const writeCommitting = Effect.fnUntraced(function* () {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some" && call.value.boardWrite && call.value.saved !== true)
    call.value.saved = "unknown";
});

export const writeRefused = Effect.fnUntraced(function* (
  stage: "pre_lock" | "in_write" | "post_write",
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some" && call.value.boardWrite && call.value.refusedAt === undefined)
    call.value.refusedAt = call.value.saved === true ? "post_write" : stage;
});

// Resolution already happens in the tool; capture only its canonical metadata without another DB read.
export const resolvedContext = Effect.fnUntraced(function* (context: {
  boardId?: string;
  id?: string;
  number?: number;
  stage?: string;
}) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None" || call.value.targetResolved) return;
  if (context.boardId) call.value.boardId = context.boardId;
  if (context.id) {
    // Caller attribution is provisional; the first canonical target wins over
    // it, while later dependency/sibling reads cannot replace that target.
    call.value.targetResolved = true;
    call.value.cardId = context.id;
    if (context.stage) call.value.cardStage = context.stage;
  }
  if (context.number !== undefined) call.value.cardNumber = context.number;
});

// Every deadline already has a span; this only preserves its phase through MCP error encoding.
export const failedPhase = Effect.fnUntraced(function* (phase: string) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some")
    call.value.phase =
      phase === "caller" ||
      phase === "dispatch" ||
      phase === "result" ||
      phase === "lane_wait" ||
      phase === "query" ||
      phase === "render"
        ? phase
        : phase === "records"
          ? "result"
          : "handler";
});

// Dispatch owns the commit span; observing the receipt must not add per-event spans.
export const setSaved = Effect.fnUntraced(function* (saved: boolean) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some" && call.value.saved !== true) call.value.saved = saved;
});

// Retry path belongs to the delegateTask span and its existing call row.
export const setRetryPath = Effect.fnUntraced(function* (
  retryPath: NonNullable<McpCall["Service"]["retryPath"]>,
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some") call.value.retryPath = retryPath;
  yield* Effect.annotateCurrentSpan("t3.delegate.retry_path", retryPath);
});

// Recovery belongs to the enclosing delegateTask span, not another analytics span.
export const dispatchFenceRecovered = Effect.gen(function* () {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some") {
    call.value.dispatchFenceRecovered = true;
    call.value.phase = "result";
  }
});

// readTask owns the lookup span; retain only categories in the call ledger.
export const setTaskLookup = Effect.fnUntraced(function* (
  lookup: Required<Pick<TaskLookup, "foundBy" | "idCanonical">> & TaskLookup,
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None") return;
  // Internal status/cancel/ack reads must not erase evidence from the input lookup.
  const previous = call.value.taskLookup;
  call.value.taskLookup =
    previous?.foundBy !== undefined && previous.foundBy !== "none"
      ? {
          ...previous,
          ...lookup,
          foundBy: previous.foundBy,
          idCanonical: previous.idCanonical ?? lookup.idCanonical,
        }
      : { ...previous, ...lookup };
  if (lookup.foundBy !== "none") call.value.saved = true;
  else if (lookup.notFoundReason === "never_saved" && call.value.saved !== true)
    call.value.saved = false;
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
  // Detached cleanup after a deadline must not overwrite the returned timeout with "Failure".
  if (Cause.hasInterruptsOnly(cause)) return;
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None") return;
  const error = cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? [fields(reason.error)]
      : reason._tag === "Die"
        ? [fields(reason.defect)]
        : [],
  )[0];
  failureMetadata(error ?? {}, call.value);
  const classified = classifyFailure(error ?? {});
  if (
    (error?.code === "invalid_request" || String(error?.code).endsWith("_denied")) &&
    isDenyReason(error?.reason)
  )
    call.value.denyReason = error?.reason;
  call.value.handlerErrorTag = classified?.tag ?? (Cause.hasDies(cause) ? "Defect" : "Failure");
  if (classified?.outcome) call.value.handlerOutcome = classified.outcome;
  else delete call.value.handlerOutcome;
});

export function callOutcome(
  exit: Exit.Exit<McpSchema.CallToolResult | McpSchema.InputRequired, unknown>,
  state: McpCall["Service"],
): Pick<AnalyticsEvent, "outcome" | "errorTag" | "errorPhase" | "saved" | "props"> {
  const { notFoundReason, ...taskLookup } = state.taskLookup ?? {};
  if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause))
    return {
      outcome: "interrupted",
      ...(state.readOnly && state.taskLookup === undefined
        ? {}
        : {
            saved: state.boardWrite && state.saved === false ? ("unknown" as const) : state.saved,
          }),
      errorPhase: state.phase,
      props: {
        ...taskLookup,
        ...(state.retryPath === undefined ? {} : { retryPath: state.retryPath }),
        ...(state.dispatchFenceRecovered ? { dispatchFenceRecovered: true } : {}),
        code: "unknown",
        ...interruptionProps(exit.cause),
        ...(state.replySubSteps === undefined ? {} : { subSteps: state.replySubSteps }),
      },
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
  // The boundary deadline wins over a detached handler's cancellation/cleanup failure.
  const typedReadTimeout =
    classified?.tag === "ThreadReadTimeoutError" || classified?.tag === "WikiReadTimeoutError";
  const code = state.readDeadlineExpired
    ? "TimeoutError"
    : typedReadTimeout
      ? classified.tag
      : (state.handlerErrorTag ?? classified?.tag);
  const typedOutcome = state.readDeadlineExpired
    ? "timeout"
    : typedReadTimeout
      ? classified.outcome
      : (state.handlerOutcome ?? classified?.outcome);
  const inputRequired = exit._tag === "Success" && exit.value instanceof McpSchema.InputRequired;
  const failed =
    inputRequired ||
    exit._tag === "Failure" ||
    output?.isError === true ||
    (content._tag !== undefined && code !== undefined);
  if (failed || state.handlerErrorTag !== undefined || state.replyFailure !== undefined) {
    failureMetadata(error, state);
    if (state.replyFailure === "reply_timeout") state.reasonClass = "reply_timeout";
    state.reasonClass ??=
      state.replyFailure === "reply_timeout"
        ? "reply_timeout"
        : code === "board_busy"
          ? "board_busy"
          : code?.endsWith("_denied") || code === "parent_not_active"
            ? "not_allowed"
            : code?.endsWith("_not_found")
              ? "not_found"
              : "other";
    if (
      (error.code === "invalid_request" || String(error.code).endsWith("_denied")) &&
      isDenyReason(error.reason)
    )
      state.denyReason = error.reason;
    if (code === "invalid_request" && state.denyReason === undefined)
      state.denyReason = "invalid_args";
  }
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
        : content.saved === null || content.saved === "unknown"
          ? "unknown"
          : inputRequired ||
              code === "caller_unresolved" ||
              code === "capability_denied" ||
              code === "parent_not_active" ||
              code === "PreviewAutomationUnavailableError" ||
              code === "McpCapabilityUnavailableError" ||
              busy
            ? false
            : state.saved;
  if (state.boardWrite && (failed || timeout || state.replyFailure))
    state.refusedAt =
      saved === true
        ? "post_write"
        : (state.refusedAt ?? (state.boardAdmitted ? "in_write" : "pre_lock"));
  else delete state.refusedAt;
  return {
    outcome: timeout
      ? "timeout"
      : failed || state.replyFailure
        ? refused
          ? "refused"
          : "error"
        : "ok",
    ...(state.readOnly && state.taskLookup === undefined ? {} : { saved }),
    props: {
      ...taskLookup,
      ...(state.retryPath === undefined ? {} : { retryPath: state.retryPath }),
      ...(state.dispatchFenceRecovered ? { dispatchFenceRecovered: true } : {}),
      ...(notFoundReason === undefined ? {} : { notFoundReason }),
      ...(state.replyStage === undefined ? {} : { phase: state.replyStage }),
      ...(state.replySubSteps === undefined ? {} : { subSteps: state.replySubSteps }),
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
            typedReadTimeout &&
            (error.phase === "lane_wait" || error.phase === "query" || error.phase === "render")
              ? error.phase
              : code === "caller_unresolved" ||
                  (partial && state.phase === "caller" && !state.callerResolved)
                ? "caller"
                : replyTooLarge || state.replyFailure || partial || waitTimedOut || requestTimedOut
                  ? "result"
                  : state.phase,
        }
      : {}),
  };
}
