import type { EvaluatorTrigger, EvaluatorReuseMissReason } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { EvaluatorPurpose } from "./briefs.ts";
import { EvaluatorPurposeKind, KanbanThreadLink, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Analytics from "../../analytics/Analytics.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { recordServerAnalytics } from "../../../observability/RpcInstrumentation.ts";

export const origin = Context.Reference<EvaluatorTrigger | undefined>("KanbanEvaluatorOrigin", {
  defaultValue: () => undefined,
});
export const attribution = Context.Reference<
  { readonly boardId: string; readonly cardId: string | null } | undefined
>("KanbanEvaluatorAttribution", { defaultValue: () => undefined });
export const forCard = (boardId: string, cardId: string | null) =>
  Effect.provideService(attribution, { boardId, cardId });
export const startObserver = Context.Reference<
  ((threadId: ThreadId) => Effect.Effect<void>) | undefined
>("KanbanEvaluatorStartObserver", {
  defaultValue: () => undefined,
});
export const deliveryObserver = Context.Reference<
  ((identity: string) => Effect.Effect<void>) | undefined
>("KanbanEvaluatorDeliveryObserver", {
  defaultValue: () => undefined,
});
const decodePurpose = Schema.decodeUnknownOption(EvaluatorPurposeKind);
const decodeLink = Schema.decodeUnknownEffect(Schema.fromJsonString(KanbanThreadLink));
export const purposeKind = (value: string | null) =>
  Option.getOrElse(decodePurpose(value?.split(":")[0]), () => "unknown" as const);

export const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const boards = yield* Effect.serviceOption(BoardsDatabase.BoardsDatabase);
  const genericRecipient = Effect.fn("EvaluatorAnalytics.genericRecipient")(
    function* (threadId: string) {
      if (Option.isNone(analytics) || Option.isNone(boards)) return null;
      // Observation cannot hold a thread's dispatch lock behind a background boards migration.
      if (boards.value.isReady?.() === false) return null;
      const rows = yield* boards.value.sql<{ json: string }>`SELECT json FROM ardud_kanban_threads
      WHERE thread_id = ${threadId} AND json_extract(json, '$.role') = 'evaluator'`;
      if (!rows[0]) return null;
      return yield* decodeLink(rows[0].json);
    },
    NodeSqliteClient.readOnly,
    Effect.catchCause(() => Effect.succeed(null)),
  );

  const recordGenericDelivery = Effect.fn("EvaluatorAnalytics.recordGenericDelivery")(
    function* (link: KanbanThreadLink) {
      if (Option.isNone(analytics)) return;
      const current = (yield* attribution) ?? link;
      yield* recordServerAnalytics(analytics.value, {
        ts: DateTime.formatIso(yield* DateTime.now),
        surface: "server",
        route: "kanban",
        kind: "kanban.evaluator",
        boardId: current.boardId,
        ...(current.cardId ? { cardId: current.cardId } : {}),
        threadId: link.threadId,
        purposeKind: purposeKind(link.purpose),
        trigger: (yield* origin) ?? "thread_send",
        outcome: "reused",
      });
    },
    Effect.catchCause(() => Effect.void),
  );
  // The committing dispatch already owns the span; failures cannot change its result.
  const observe = Effect.fnUntraced(
    function* (delivery: { threadId: ThreadId; commandId: string }) {
      const started = yield* startObserver;
      const delivered = yield* deliveryObserver;
      if (started !== undefined) yield* Effect.suspend(() => started(delivery.threadId));
      else if (delivered !== undefined) yield* Effect.suspend(() => delivered(delivery.commandId));
      else {
        const recipient = yield* genericRecipient(delivery.threadId);
        if (recipient !== null) yield* recordGenericDelivery(recipient);
      }
    },
    Effect.catchCause(() => Effect.void),
  );
  return { observe };
});

export const triggerFor = (kind: EvaluatorPurpose["kind"]): EvaluatorTrigger => {
  switch (kind) {
    case "discussion":
      return "discussion_post";
    case "request":
      return "evaluator_start";
    case "setup":
      return "setup";
    case "nightly":
      return "nightly";
    default:
      return `tick_${kind}`;
  }
};

export interface ReuseObservation {
  reason: EvaluatorReuseMissReason;
}
