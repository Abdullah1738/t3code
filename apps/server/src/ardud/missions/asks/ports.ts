import {
  CommandId,
  MessageId,
  MissionError,
  ThreadId,
  type Ask,
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

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import type { SuggestionApplication } from "./suggestionModel.ts";

/**
 * Thread operations asks need: forking the master's thread and handing a
 * line to a thread. Keys make both idempotent, so a retried command lands once.
 */
export class AsksThreads extends Context.Service<
  AsksThreads,
  {
    readonly fork: (input: {
      readonly sourceThreadId: ThreadId;
      readonly title: string;
      readonly key: string;
    }) => Effect.Effect<ThreadId, MissionError>;
    readonly deliver: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      /** The owner's own words (a Discuss decision) go in as his message. */
      readonly asOwner: boolean;
      readonly key: string;
    }) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/asks/ports/AsksThreads") {}

const threadFailure = (what: string) => (error: unknown) =>
  new MissionError({
    code: "conflict",
    detail: `${what}: ${error instanceof Error ? error.message : String(error)}`,
  });

/** Robob's own fork and send paths (the same commands `t3_thread_fork` and `t3_thread_send` use). */
export const threadsLayer = Layer.effect(
  AsksThreads,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return AsksThreads.of({
      fork: ({ sourceThreadId, title, key }) => {
        const commandId = CommandId.make(`ardud-missions:fork:${key}`);
        const targetThreadId = ThreadId.make(`${commandId}:fork`);
        return threads
          .dispatch({
            type: "thread.fork",
            commandId,
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            title,
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(
            Effect.as(targetThreadId),
            Effect.mapError(threadFailure("Cannot fork the master")),
          );
      },
      deliver: ({ threadId, text, asOwner, key }) =>
        Effect.gen(function* () {
          const shell = yield* threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(threadFailure("Cannot read the thread")));
          if (shell === null) {
            return yield* new MissionError({ code: "not-found", detail: `No thread ${threadId}.` });
          }
          yield* threads
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`ardud-missions:deliver:${key}`),
              messageId: MessageId.make(`ardud-missions:deliver:${key}`),
              threadId,
              text,
              attachments: [],
              mode: "queue",
              createdBy: asOwner ? "user" : "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(threadFailure("Cannot deliver to the thread")));
        }),
    });
  }),
);

/**
 * What the router does when an answer lands: wake the asker's thread and the
 * threads holding the released records. Router owns wakes; until it merges
 * this is a no-op seam and the asker sees the answer on its next read.
 */
export class AsksSignals extends Context.Service<
  AsksSignals,
  {
    readonly askResolved: (input: {
      readonly ask: Ask;
      readonly askerThreadId: ThreadId | null;
      readonly released: ReadonlyArray<MissionRecordRef>;
    }) => Effect.Effect<void>;
  }
>()("t3/ardud/missions/asks/ports/AsksSignals") {}

export const signalsNoop = Layer.succeed(
  AsksSignals,
  AsksSignals.of({ askResolved: () => Effect.void }),
);

const refLabel = (ref: MissionRecordRef) => ref.label ?? `${ref.kind} ${ref.id}`;

/** The line the asker gets when its ask resolves. */
export const askResolvedLine = (ask: Ask, released: ReadonlyArray<MissionRecordRef>): string => {
  const freed = released.length === 0 ? "" : ` Released: ${released.map(refLabel).join(", ")}.`;
  if (ask.status === "answered" && ask.answer !== null) {
    const option = ask.answer.optionId
      ? ask.options.find((candidate) => candidate.id === ask.answer?.optionId)
      : undefined;
    const answer = [option?.label, ask.answer.text].filter((part) => part && part.length > 0);
    return `[Mission ask ${ask.id} answered] ${ask.question} -> ${answer.join(" - ")}.${freed}`;
  }
  return `[Mission ask ${ask.id} ${ask.status}] ${ask.question}.${freed}`;
};

/**
 * Until the router merges: hand the asker a queued line on its own thread so
 * it resumes the held branch. The router's doorbell replaces this layer.
 */
export const signalsDeliver = Layer.effect(
  AsksSignals,
  Effect.gen(function* () {
    const threads = yield* AsksThreads;
    return AsksSignals.of({
      askResolved: ({ ask, askerThreadId, released }) =>
        askerThreadId === null
          ? Effect.void
          : threads
              .deliver({
                threadId: askerThreadId,
                text: askResolvedLine(ask, released),
                asOwner: false,
                key: `ask:${ask.id}:${ask.status}:${ask.updatedAt}`,
              })
              .pipe(Effect.ignore),
    });
  }),
);

/**
 * Posting into a mission room. Router owns rooms and messages; until it
 * merges `mission_post` refuses with a clear reason instead of writing a
 * second message store.
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

export const roomsPending = Layer.succeed(
  AsksRooms,
  AsksRooms.of({
    post: () =>
      Effect.fail(
        new MissionError({
          code: "conflict",
          detail: "Mission rooms are not wired on this server yet (router track).",
        }),
      ),
  }),
);

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
