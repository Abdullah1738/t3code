import {
  MissionError,
  type Ask,
  type InboxComment,
  type MissionMessage,
  type MissionProvenance,
  type MissionRecordRef,
  type PostMessageInput,
  type SuggestionTargetKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { SuggestionApplication } from "./suggestionModel.ts";

/**
 * What the router does when an answer lands: a decision message in the
 * control room to the asker and the holders of the released records. The
 * live layer is the router's (`router/adapters.ts`); there is no fallback.
 */
export class AsksSignals extends Context.Service<
  AsksSignals,
  {
    readonly askResolved: (input: {
      readonly ask: Ask;
      readonly released: ReadonlyArray<MissionRecordRef>;
      /** The owner's comments on the ask, the note he gave with the answer last. */
      readonly comments?: ReadonlyArray<InboxComment>;
    }) => Effect.Effect<void>;
  }
>()("t3/ardud/missions/asks/ports/AsksSignals") {}

export const signalsNoop = Layer.succeed(
  AsksSignals,
  AsksSignals.of({ askResolved: () => Effect.void }),
);

const refLabel = (ref: MissionRecordRef) => ref.label ?? `${ref.kind} ${ref.id}`;

/** The line the asker gets when its ask resolves. */
export const askResolvedLine = (
  ask: Ask,
  released: ReadonlyArray<MissionRecordRef>,
  comments: ReadonlyArray<InboxComment> = [],
): string => {
  const line = resolvedLine(ask, released);
  if (comments.length === 0) return line;
  return [line, "", "The owner's comments:", ...comments.map((c) => `- ${c.body}`)].join("\n");
};

const resolvedLine = (ask: Ask, released: ReadonlyArray<MissionRecordRef>): string => {
  const freed = released.length === 0 ? "" : ` Released: ${released.map(refLabel).join(", ")}.`;
  if (ask.status === "answered" && ask.answer !== null) {
    const option = ask.answer.optionId
      ? ask.options.find((candidate) => candidate.id === ask.answer?.optionId)
      : undefined;
    const answer = [option?.label, ask.answer.text].filter((part) => part && part.length > 0);
    const how =
      (ask.answer.onOwnerCondition ?? null) === null
        ? "answered"
        : "answered by the master on the owner's condition";
    return `[Mission ask ${ask.id} ${how}] ${ask.question} -> ${answer.join(" - ")}.${freed}`;
  }
  return `[Mission ask ${ask.id} ${ask.status}] ${ask.question}.${freed}`;
};

/**
 * Posting into a mission room through the router (`router/adapters.ts`), so
 * there is one message store and one delivery path.
 */
export class AsksRooms extends Context.Service<
  AsksRooms,
  {
    readonly post: (
      input: PostMessageInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionMessage, MissionError>;
  }
>()("t3/ardud/missions/asks/ports/AsksRooms") {}

/** The track whose service applies an accepted suggestion of each kind. */
export const SUGGESTION_OWNERS: Readonly<Record<SuggestionTargetKind, string>> = {
  role: "policy",
  "role-model": "policy",
  rule: "core",
  "review-policy": "policy",
  "criticality-guide": "policy",
  pool: "policy",
  "sub-mission-order": "core",
  lane: "core",
  schedule: "core",
  "draft-note": "asks",
  layout: "views",
};

/** Applies an accepted suggestion and returns the outcome line. */
export type SuggestionApply = (
  application: SuggestionApplication,
  provenance: MissionProvenance,
) => Effect.Effect<string, MissionError>;

/**
 * One track's applier: applies an accepted suggestion through the owning
 * service, the same call a human edit makes, and returns the outcome line.
 */
export class SuggestionAppliers extends Context.Service<
  SuggestionAppliers,
  { readonly apply: SuggestionApply }
>()("t3/ardud/missions/asks/ports/SuggestionAppliers") {}

/**
 * Where tracks register their appliers. Asks reads it when a suggestion is
 * accepted, so policy and core can register from their own layers without
 * asks depending on them (they depend on asks). A kind nobody registered
 * applies nothing and the outcome says so.
 */
export class SuggestionApplierRegistry extends Context.Service<
  SuggestionApplierRegistry,
  {
    readonly register: (
      kinds: ReadonlyArray<SuggestionTargetKind>,
      apply: SuggestionApply,
    ) => Effect.Effect<void>;
    readonly apply: SuggestionApply;
  }
>()("t3/ardud/missions/asks/ports/SuggestionApplierRegistry") {}

export const notWired = (kind: SuggestionTargetKind) =>
  `Accepted; not applied: nothing applies ${kind} suggestions on this server (the ${SUGGESTION_OWNERS[kind]} service is not wired).`;

export const applierRegistry = Layer.effect(
  SuggestionApplierRegistry,
  Effect.gen(function* () {
    const appliers = yield* Ref.make(new Map<SuggestionTargetKind, SuggestionApply>());
    return SuggestionApplierRegistry.of({
      register: (kinds, apply) =>
        Ref.update(appliers, (current) => {
          const next = new Map(current);
          for (const kind of kinds) next.set(kind, apply);
          return next;
        }),
      apply: (application, provenance) =>
        Effect.flatMap(Ref.get(appliers), (current) => {
          const apply = current.get(application.targetKind);
          return apply === undefined
            ? Effect.succeed(notWired(application.targetKind))
            : apply(application, provenance);
        }),
    });
  }),
);
