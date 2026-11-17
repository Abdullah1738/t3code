import {
  CommandId,
  EventId,
  TurnItemId,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

export const persist = Effect.fn("SteerDeliveryFailure.persist")(function* (
  effect: EffectOutbox.OrchestrationEffectV2,
  failure?: OrchestrationV2ProviderFailure,
) {
  if (effect.request.type !== "provider-turn.steer") return;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const request = effect.request;
  const context = yield* projections.getProviderControlContext(effect.threadId, request);
  const now = yield* DateTime.now;
  const runId = context.run?.id ?? context.message?.runId ?? null;
  const nodeId = context.providerTurn?.nodeId ?? context.run?.rootNodeId ?? null;
  const providerThread = context.providerThread;
  const messageId = request.messageId.replace(/\p{Cc}/gu, "").slice(0, 200);

  // A receipt makes replay after a worker crash harmless and leaves failed writes retryable.
  yield* sink.commitCommand({
    commandId: CommandId.make(`command:steer-delivery-failed:${effect.id}`),
    commandType: "provider-turn.steer.delivery-failed",
    threadId: effect.threadId,
    acceptedAt: now,
    effects: [],
    events: [
      ...(failure === undefined || context.message === undefined
        ? []
        : [
            {
              id: EventId.make(`event:steer-delivery-unconfirmed:${effect.id}`),
              type: "message.updated" as const,
              threadId: effect.threadId,
              occurredAt: now,
              payload: { ...context.message, deliveryFailure: failure, updatedAt: now },
            },
          ]),
      {
        id: EventId.make(`event:steer-delivery-failed:${effect.id}`),
        type: "turn-item.updated",
        threadId: effect.threadId,
        ...(runId === null ? {} : { runId }),
        ...(nodeId === null ? {} : { nodeId }),
        ...(providerThread === undefined
          ? {}
          : {
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
            }),
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`steer-delivery-failed:${effect.id}`),
          type: "system_notice",
          threadId: effect.threadId,
          runId,
          nodeId,
          providerThreadId: providerThread?.id ?? request.providerThreadId,
          providerTurnId: context.providerTurn?.id ?? request.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "failed",
          title: failure === undefined ? "Message delivery failed" : "Message delivery unconfirmed",
          message:
            failure === undefined
              ? `Message ${messageId} was saved, but delivery to the provider failed.`
              : `Message ${messageId} was saved. ${failure.message}`,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});
