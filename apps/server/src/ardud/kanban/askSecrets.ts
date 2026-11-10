/**
 * The owner answers an ask that has secret fields. It comes over the app's
 * private channel (WS `secrets.answerAsk`), with the same owner proof as a
 * secret card, and never over the board's HTTP routes.
 *
 * Each value goes straight to `SecretRequests.hold` (memory only) and comes
 * back as a one-use ref. The board is given the refs, never the values: the
 * ask's stored answer says a field was provided, and the wake text carries
 * the ref to the agent. Nothing in this file logs, echoes or stores a value.
 */
import {
  ThreadId,
  type KanbanAskSecretAnswerInput,
  type KanbanAskSecretAnswerResult,
  type SecretRef,
} from "@t3tools/contracts";
import { KanbanError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { SecretRequests } from "../../secrets/SecretRequests.ts";
import { HELD_SECRET_MAX_CHARS } from "../auth/heldSecrets.ts";
import type { OwnerProvenance } from "../auth/provenance.ts";
import { requireSecretAnswerAuthority } from "../auth/secretAnswers.ts";
import type { AskSecretRef } from "./engine/asks.ts";
import type { KanbanServiceShape } from "./engine/KanbanService.ts";

const OWNER = { _tag: "owner" } as const;

const invalid = (detail: string) => Effect.fail(new KanbanError({ code: "invalid", detail }));

export const answerAskSecrets =
  (
    kanban: Pick<KanbanServiceShape, "askSecretPlan" | "answerAsk" | "ownCards">,
    secrets: Pick<SecretRequests["Service"], "hold" | "discard">,
  ) =>
  (input: KanbanAskSecretAnswerInput, answeredBy: OwnerProvenance | null) =>
    Effect.gen(function* () {
      // Refused before anything is read, kept or recorded.
      yield* requireSecretAnswerAuthority(answeredBy);
      const ids = Object.keys(input.secrets);
      if (ids.length === 0) {
        return yield* invalid(
          "secrets is empty: an answer with no secret goes to the answer route",
        );
      }
      // The messages name the field and never the value.
      for (const id of ids) {
        const value = input.secrets[id]!;
        if (value.trim() === "") return yield* invalid(`secret field "${id}" is empty`);
        if (value.length > HELD_SECRET_MAX_CHARS) {
          return yield* invalid(
            `secret field "${id}" is longer than ${HELD_SECRET_MAX_CHARS} characters`,
          );
        }
      }
      const plan = yield* kanban.askSecretPlan(input.cardId, input.askId, ids);
      const asker = plan.threadId;
      const redeemableBy = (threadId: ThreadId) =>
        asker !== null
          ? Effect.succeed(threadId === asker)
          : // An evaluator's ask: whoever works the card when the ref is used.
            kanban.ownCards(threadId).pipe(
              Effect.map((cards) => cards.some((card) => card.id === input.cardId)),
              Effect.orElseSucceed(() => false),
            );
      const held: Array<SecretRef> = [];
      const refs: Record<string, AskSecretRef> = {};
      const forget = Effect.suspend(() => Effect.forEach(held, secrets.discard, { discard: true }));
      return yield* Effect.gen(function* () {
        for (const id of ids) {
          const kept = yield* secrets.hold(
            { projectId: plan.projectId, value: input.secrets[id]!.trim(), redeemableBy },
            answeredBy,
          );
          held.push(kept.ref);
          refs[id] = {
            ref: kept.ref,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(kept.expiresAtMs)),
            redeemer: plan.redeemer,
          };
        }
        const result = yield* kanban.answerAsk(
          input.cardId,
          input.askId,
          input.answer,
          OWNER,
          refs,
        );
        const card = result.card;
        return {
          card: { id: card.id, number: card.number, stage: card.stage },
          ask: card.asks.find((entry) => entry.id === input.askId) ?? null,
        } satisfies KanbanAskSecretAnswerResult;
        // An answer that did not go through leaves no value behind.
      }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : forget)));
    }).pipe(Effect.withSpan("KanbanAskSecrets.answer"));
