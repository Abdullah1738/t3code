import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Analytics from "../analytics/Analytics.ts";
import { recordServerAnalytics } from "../../observability/RpcInstrumentation.ts";
import { stateFromRuns, type ControlThreadState } from "./model.ts";

type ControlEvent =
  | {
      readonly type: "thread.created";
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly parentThreadId: string | null;
    }
  | {
      readonly type: "thread.status";
      readonly threadId: string;
      readonly runId: string;
      readonly status: string;
      readonly state: ControlThreadState;
    }
  | {
      readonly type: "message.completed";
      readonly threadId: string;
      readonly runId: string | null;
      readonly messageId: string;
      readonly role: string;
      readonly text: string;
    }
  | {
      readonly type: "request.opened" | "request.resolved";
      readonly threadId: string;
      readonly requestId: string;
      readonly kind: "approval" | "question";
      readonly requestKind: string;
      readonly status: string;
    }
  | { readonly type: "thread.updated"; readonly threadId: string; readonly change: string };

/** Maps one stored orchestration event onto the small set of events integrations act on. */
export function controlEventFromStored(stored: OrchestrationV2StoredEvent): ControlEvent | null {
  const event = stored.event;
  switch (event.type) {
    case "thread.created":
      return {
        type: "thread.created",
        threadId: event.threadId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        parentThreadId: event.payload.lineage.parentThreadId,
      };
    case "run.created":
    case "run.updated":
      return {
        type: "thread.status",
        threadId: event.threadId,
        runId: event.payload.id,
        status: event.payload.status,
        state: stateFromRuns([event.payload], false).state,
      };
    case "message.updated":
      if (event.payload.streaming || event.payload.role === "system") return null;
      if (event.payload.role === "assistant" && event.payload.text.trim().length === 0) return null;
      return {
        type: "message.completed",
        threadId: event.threadId,
        runId: event.payload.runId,
        messageId: event.payload.id,
        role: event.payload.role,
        text: event.payload.text,
      };
    case "runtime-request.updated":
      return {
        type: event.payload.status === "pending" ? "request.opened" : "request.resolved",
        threadId: event.threadId,
        requestId: event.payload.id,
        kind: event.payload.kind === "user_input" ? "question" : "approval",
        requestKind: event.payload.kind,
        status: event.payload.status,
      };
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.settled":
    case "thread.unsettled":
      return { type: "thread.updated", threadId: event.threadId, change: event.type };
    default:
      return null;
  }
}

const encoder = new TextEncoder();
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sseFrame = (sequence: number, event: ControlEvent & { readonly origin?: string | null }) =>
  `id: ${sequence}\nevent: ${event.type}\ndata: ${encodeEventJson(event)}\n\n`;

class ControlOriginLookupError extends Data.TaggedError("ControlOriginLookupError")<{
  readonly cause: unknown;
}> {}

export class ControlHistoryCompactedError extends Data.TaggedError(
  "ControlHistoryCompactedError",
) {}

type FailureCode =
  | "buffer_overflow"
  | "event_read_failed"
  | "origin_lookup_failed"
  | "history_compacted"
  | "unknown";

export function failureCode(cause: Cause.Cause<unknown>): FailureCode | "interrupted" {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted";
  const tags = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if ("_tag" in value && typeof value._tag === "string") tags.add(value._tag);
    if ("cause" in value) visit(value.cause);
  };
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) visit(reason.error);
    else if (Cause.isDieReason(reason)) visit(reason.defect);
  }
  // The orchestrator wraps LiveStreamBufferError as a domain stream error.
  if (tags.has("ControlHistoryCompactedError")) return "history_compacted";
  if (tags.has("LiveStreamBufferError")) return "buffer_overflow";
  if (tags.has("ControlOriginLookupError")) return "origin_lookup_failed";
  if (tags.has("OrchestratorDomainEventStreamError") || tags.has("SqlError"))
    return "event_read_failed";
  return "unknown";
}

export function streamStart(
  lastEventId: string | undefined,
  after: string | null,
  head: number,
  compacted = false,
) {
  const raw = lastEventId ?? after;
  const resume =
    raw !== undefined && raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  const resumed = Number.isSafeInteger(resume) && resume >= 0 && resume <= head && !compacted;
  return { afterSequence: resumed ? resume : head, resumed };
}

export const makeBody = Effect.fn("ArdudControl.eventsBody")(function* <E, R, E2, R2>(input: {
  readonly source: Stream.Stream<OrchestrationV2StoredEvent, E, R>;
  readonly afterSequence: number;
  readonly resumed: boolean;
  readonly threadFilter: string | null;
  readonly originFilter: string | null;
  readonly accepts: (stored: OrchestrationV2StoredEvent) => boolean;
  readonly originOf: (threadId: string) => Effect.Effect<string | null, E2, R2>;
  readonly analytics: Analytics.Analytics["Service"] | undefined;
}) {
  const clock = yield* Clock.Clock;
  const started = clock.currentTimeMillisUnsafe();
  const progress = yield* Ref.make({ lastSentSequence: input.afterSequence, framesSent: 0 });
  // The body runs after the route's service layer has built the response.
  const record = (kind: string, code?: FailureCode, durationMs?: number) =>
    input.analytics === undefined
      ? Effect.void
      : recordServerAnalytics(input.analytics, {
          ts: DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
          kind,
          surface: "server",
          route: "control.events",
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(code === undefined
            ? {}
            : {
                errorTag: `events.stream_failed.${code}`,
                props: { code },
              }),
        });
  const source = input.source.pipe(
    Stream.filter(input.accepts),
    Stream.rechunk(1),
    Stream.mapEffect((stored) =>
      Effect.gen(function* () {
        const event = controlEventFromStored(stored);
        if (event === null) return null;
        const origin = yield* input
          .originOf(event.threadId)
          .pipe(Effect.mapError((cause) => new ControlOriginLookupError({ cause })));
        if (
          input.originFilter !== null &&
          !(input.originFilter === "none" ? origin === null : origin === input.originFilter)
        )
          return null;
        return {
          sequence: stored.sequence,
          frame: sseFrame(stored.sequence, { ...event, origin }),
        };
      }),
    ),
    Stream.filter((frame) => frame !== null),
  );
  const hello = Stream.fromEffect(record("events.stream_connected")).pipe(
    Stream.map(() => ({
      sequence: input.afterSequence,
      frame: `retry: 3000\nid: ${input.afterSequence}\nevent: ready\ndata: ${encodeEventJson({ type: "ready", sequence: input.afterSequence, resumed: input.resumed })}\n\n`,
    })),
  );
  const heartbeats = Stream.tick("15 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ sequence: null, frame: ": ping\n\n" })),
  );
  return Stream.concat(hello, Stream.merge(source, heartbeats)).pipe(
    // Track frames at the final consumer, after merge's prefetch queue. Rechunk
    // prevents a pull from advancing the cursor past a frame it hasn't returned.
    Stream.rechunk(1),
    Stream.mapEffect((item) =>
      Ref.update(progress, (state) => ({
        lastSentSequence: item.sequence ?? state.lastSentSequence,
        framesSent: state.framesSent + (item.sequence === null ? 0 : 1),
      })).pipe(Effect.as(item.frame)),
    ),
    Stream.catchCause((cause) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const code = failureCode(cause);
          if (code === "interrupted") return Stream.empty;
          const state = yield* Ref.get(progress);
          const ageMs = Math.max(0, clock.currentTimeMillisUnsafe() - started);
          yield* Effect.logWarning("ardud control events stream failed", {
            code,
            threadFilter: input.threadFilter,
            afterSequence: input.afterSequence,
            ...state,
            ageMs,
            cause: Cause.pretty(cause).slice(0, 4096),
          });
          yield* record("events.stream_failed", code);
          return Stream.make(
            `id: ${state.lastSentSequence}\nevent: error\ndata: ${encodeEventJson({ type: "error", code })}\n\n`,
          );
        }),
      ),
    ),
    Stream.ensuring(
      Effect.suspend(() =>
        record(
          "events.stream_closed",
          undefined,
          Math.max(0, clock.currentTimeMillisUnsafe() - started),
        ),
      ),
    ),
    Stream.map((frame) => encoder.encode(frame)),
  );
});
