import {
  AskId,
  CallId,
  DraftId,
  DraftNoteId,
  ForkId,
  isOwnerProvenance,
  MissionError,
  MissionId,
  NoteId,
  SuggestionId,
  type AnswerAskInput,
  type Ask,
  type Call,
  type CloseForkInput,
  type DecideDraftInput,
  type DecideSuggestionInput,
  type DirectionCheckItem,
  type Draft,
  type DraftNote,
  type Lane,
  type Mission,
  type MissionActor,
  type MissionEvent,
  type MissionFork,
  type MissionMessage,
  type MissionProvenance,
  type MissionRecordRef,
  type Note,
  type PostMessageInput,
  type ReactToCallInput,
  type ReopenAskInput,
  type ReopenDraftInput,
  type ReopenSuggestionInput,
  type SaveDraftNoteInput,
  type StartForkInput,
  type Suggestion,
  type SuggestionAuthor,
  type SuggestionStats,
  type UpdateForkInput,
  type WithdrawAskInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreKind, MissionStoreRecord } from "../store/recordIndex.ts";
import {
  answerAsk,
  openAsk,
  rejectAskDefaults,
  reopenAsk,
  supersedeAsk,
  withdrawAsk,
} from "./askModel.ts";
import { directionCheck, makeCall, reactToCall } from "./callModel.ts";
import { draftNoteFromSuggestion, learnFromEdits } from "./draftLearning.ts";
import {
  decideDraft,
  draftExamples,
  type DraftExample,
  notesFor,
  reopenDraft,
  reviseDraft,
  saveDraftNote,
  submitDraft,
} from "./draftModel.ts";
import {
  archiveFork,
  checkStartFork,
  closeFork,
  forkRef,
  forkTitle,
  markForkCommits,
  openFork,
  openForkFor,
  reopenFork,
  type MasterDelivery,
} from "./forkModel.ts";
import { heldLane, heldRecords, heldWorkItem, type HeldRecord } from "./holds.ts";
import * as Inbound from "./inbound.ts";
import {
  OpenAskRequest,
  type DraftGuideInput,
  type MakeCallInput,
  type ProposeSuggestionInput,
  type ReviseDraftInput,
  type SubmitDraftInput,
} from "./inputs.ts";
import * as Ports from "./ports.ts";
import {
  expectedForAnswer,
  expectedForDraftDecision,
  type ExpectedText,
  verifyInbound,
} from "./provenance.ts";
import {
  clipSummary,
  dedupeRefs,
  type MissionCaller,
  type MissionEventDraft as ModelEvent,
  type Outcome,
  sameActor,
} from "./shared.ts";
import {
  defaultAsker,
  isParticipant,
  standingOf,
  threadOfActor,
  type MissionCast,
  type Standing,
} from "./standing.ts";
import {
  decideSuggestion,
  proposeSuggestion,
  recordOutcome,
  reopenSuggestion,
  suggestionStats,
} from "./suggestionModel.ts";

/**
 * The asks track over core's mission store: owner asks and their holds,
 * the master's calls and the owner's reactions, drafts with notes and edit
 * learning, suggestions from every author, and forks off the master thread.
 *
 * Provenance always comes from the transport (the calling thread, the
 * owner's app session, a verified iMessage). Inputs never carry identity.
 */

/** Events for records that belong to no mission (global draft notes and suggestions). */
export const GLOBAL_TIMELINE = MissionId.make("missions-global");

const SUGGESTION_SYSTEM_AUTHORS: ReadonlySet<string> = new Set<SuggestionAuthor>([
  "scribe",
  "editor",
  "governor",
  "owner-corrections",
  "code-check",
]);

const EDITOR: MissionCaller = {
  provenance: { _tag: "system", component: "editor" },
  actors: [{ _tag: "system", component: "editor" }],
};

const decodeOpenAsk = Schema.decodeUnknownResult(OpenAskRequest);

export interface AskAnswerResult {
  readonly ask: Ask;
  readonly released: ReadonlyArray<MissionRecordRef>;
}

export interface DraftDecisionResult {
  readonly draft: Draft;
  /** Draft-note suggestions the owner's edit just triggered. */
  readonly suggestions: ReadonlyArray<Suggestion>;
}

export interface DraftGuide {
  readonly notes: ReadonlyArray<DraftNote>;
  readonly examples: ReadonlyArray<DraftExample>;
}

export interface ForkResult {
  readonly fork: MissionFork;
  /** The question or summary line reached its thread. */
  readonly delivered: boolean;
  readonly note: Note | null;
}

export interface MissionDesk {
  readonly mission: Mission;
  readonly openAsks: ReadonlyArray<Ask>;
  /** Records waiting on an ask, and the line they show. Nothing else waits. */
  readonly held: ReadonlyArray<HeldRecord>;
  readonly pendingDrafts: ReadonlyArray<Draft>;
  readonly openSuggestions: ReadonlyArray<Suggestion>;
  readonly openForks: ReadonlyArray<MissionFork>;
  readonly directionCheck: ReadonlyArray<DirectionCheckItem>;
  readonly lanes: ReadonlyArray<Pick<Lane, "id" | "name" | "status" | "statusReason">>;
  readonly latestSeq: number;
}

export interface ListFilter {
  readonly missionId?: MissionId | undefined;
  readonly status?: ReadonlyArray<string> | undefined;
}

type Fx<A> = Effect.Effect<A, MissionError>;

export class AsksService extends Context.Service<
  AsksService,
  {
    // Reads
    readonly missions: () => Fx<ReadonlyArray<Mission>>;
    readonly desk: (missionId: MissionId) => Fx<MissionDesk>;
    readonly digest: (missionId: MissionId, since: string) => Fx<ReadonlyArray<MissionEvent>>;
    readonly events: (
      missionId: MissionId,
      afterSeq: number,
      limit?: number,
    ) => Fx<ReadonlyArray<MissionEvent>>;
    readonly asks: (filter: ListFilter) => Fx<ReadonlyArray<Ask>>;
    readonly ask: (askId: AskId) => Fx<Ask>;
    readonly calls: (missionId: MissionId) => Fx<ReadonlyArray<Call>>;
    readonly directionCheck: (
      missionId: MissionId,
      since: string | null,
    ) => Fx<ReadonlyArray<DirectionCheckItem>>;
    readonly drafts: (filter: ListFilter) => Fx<ReadonlyArray<Draft>>;
    readonly draftGuide: (input: DraftGuideInput) => Fx<DraftGuide>;
    readonly draftNotes: (missionId: MissionId | null) => Fx<ReadonlyArray<DraftNote>>;
    readonly suggestions: (filter: ListFilter) => Fx<ReadonlyArray<Suggestion>>;
    readonly suggestionStats: () => Fx<ReadonlyArray<SuggestionStats>>;
    readonly forks: (filter: ListFilter) => Fx<ReadonlyArray<MissionFork>>;
    readonly notes: (missionId: MissionId) => Fx<ReadonlyArray<Note>>;
    /** Who the caller is in a mission: its roles, lanes, open forks and whether it is the master. */
    readonly standing: (missionId: MissionId, provenance: MissionProvenance) => Fx<Standing>;
    // Asks
    readonly openAsk: (raw: unknown, provenance: MissionProvenance) => Fx<Ask>;
    readonly answerAsk: (
      input: AnswerAskInput,
      provenance: MissionProvenance,
    ) => Fx<AskAnswerResult>;
    readonly withdrawAsk: (
      input: WithdrawAskInput,
      provenance: MissionProvenance,
    ) => Fx<AskAnswerResult>;
    readonly reopenAsk: (input: ReopenAskInput, provenance: MissionProvenance) => Fx<Ask>;
    // Calls
    readonly makeCall: (input: MakeCallInput, provenance: MissionProvenance) => Fx<Call>;
    readonly reactToCall: (input: ReactToCallInput, provenance: MissionProvenance) => Fx<Call>;
    // Drafts
    readonly submitDraft: (input: SubmitDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    readonly reviseDraft: (input: ReviseDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    readonly decideDraft: (
      input: DecideDraftInput,
      provenance: MissionProvenance,
    ) => Fx<DraftDecisionResult>;
    readonly reopenDraft: (input: ReopenDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    readonly saveDraftNote: (
      input: SaveDraftNoteInput,
      provenance: MissionProvenance,
    ) => Fx<DraftNote>;
    // Suggestions
    readonly proposeSuggestion: (
      input: ProposeSuggestionInput,
      provenance: MissionProvenance,
    ) => Fx<Suggestion>;
    readonly decideSuggestion: (
      input: DecideSuggestionInput,
      provenance: MissionProvenance,
    ) => Fx<Suggestion>;
    readonly reopenSuggestion: (
      input: ReopenSuggestionInput,
      provenance: MissionProvenance,
    ) => Fx<Suggestion>;
    // Forks
    readonly startFork: (input: StartForkInput, provenance: MissionProvenance) => Fx<ForkResult>;
    readonly closeFork: (input: CloseForkInput, provenance: MissionProvenance) => Fx<ForkResult>;
    readonly updateFork: (input: UpdateForkInput, provenance: MissionProvenance) => Fx<ForkResult>;
    // Notes and rooms
    readonly ackNote: (noteId: NoteId, provenance: MissionProvenance) => Fx<Note>;
    readonly post: (input: PostMessageInput, provenance: MissionProvenance) => Fx<MissionMessage>;
  }
>()("t3/ardud/missions/asks/AsksService") {}

const fromOutcome = <A>(outcome: Outcome<A>): Fx<A> => Effect.fromResult(outcome);

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const replaceById = <R extends { readonly id: string }>(
  records: ReadonlyArray<R>,
  ...next: ReadonlyArray<R>
): R[] => {
  const ids = new Set(next.map((record) => record.id));
  return [...records.filter((record) => !ids.has(record.id)), ...next];
};

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const inbound = yield* Inbound.InboundLookup;
  const threads = yield* Ports.AsksThreads;
  const signals = yield* Ports.AsksSignals;
  const rooms = yield* Ports.AsksRooms;
  const appliers = yield* Ports.SuggestionAppliers;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (prefix: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => `${prefix}-${uuid}`),
    );

  const need = <K extends MissionStoreKind>(kind: K, id: string) =>
    store.get(kind, id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => fail("not-found", `No ${kind} ${id}.`),
          onSome: Effect.succeed,
        }),
      ),
    );

  const castOf = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = Option.getOrNull(yield* store.get("mission", missionId));
      const roles = yield* store.list("role", { missionId });
      const bindings = yield* store.list("role-binding", { missionId, status: ["bound"] });
      const lanes = yield* store.list("lane", { missionId });
      const forks = yield* store.list("fork", { missionId, status: ["open"] });
      const cast: MissionCast = { missionId, mission, roles, bindings, lanes, forks };
      return cast;
    });

  const standingIn = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* castOf(missionId);
      if (cast.mission === null) return yield* fail("not-found", `No mission ${missionId}.`);
      return { cast, standing: standingOf(cast, provenance) };
    });

  /** A caller outside any mission: only its own thread or component. */
  const bareCaller = (provenance: MissionProvenance): MissionCaller => {
    switch (provenance._tag) {
      case "owner-app":
      case "owner-imessage":
        return { provenance, actors: [{ _tag: "owner" }] };
      case "agent":
        return { provenance, actors: [{ _tag: "thread", threadId: provenance.threadId }] };
      case "system":
        return { provenance, actors: [{ _tag: "system", component: provenance.component }] };
      case "import":
        return {
          provenance,
          actors: [{ _tag: "system", component: `import:${provenance.source}` }],
        };
    }
  };

  /**
   * Writes a command's records with its first event, then the rest of its
   * events caused by that one. Global records go on the global timeline.
   */
  const persist = (
    missionId: MissionId | null,
    events: ReadonlyArray<ModelEvent>,
    upserts: ReadonlyArray<MissionStoreRecord>,
  ) =>
    Effect.gen(function* () {
      const timeline = missionId ?? GLOBAL_TIMELINE;
      const [first, ...rest] = events;
      if (first === undefined) return yield* Effect.die("A mission command produced no event.");
      const committed = yield* store.commit({
        event: { ...first, missionId: timeline },
        upserts,
      });
      for (const event of rest) {
        yield* store.appendEvent({ ...event, missionId: timeline, causedBy: committed.event.id });
      }
      return committed.event;
    });

  /**
   * Owner provenance for a decision: the app session as is, or an iMessage
   * relayed by an agent with its inbound id, checked against the bridge or
   * Moni's chat. Anything else stays agent provenance and the model refuses.
   */
  const ownerVoice = (command: {
    readonly provenance: MissionProvenance;
    readonly inboundId: string | undefined;
    readonly expected: ExpectedText;
    readonly notBefore: string;
    readonly what: string;
  }) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(command.provenance)) return command.provenance;
      if (command.inboundId === undefined) return command.provenance;
      const message = yield* inbound.find(command.inboundId, command.notBefore);
      const verified: MissionProvenance = yield* fromOutcome(
        verifyInbound({
          inboundId: command.inboundId,
          inbound: message,
          expected: command.expected.expected,
          contradicts: command.expected.contradicts,
          notBefore: command.notBefore,
          what: command.what,
        }),
      );
      return verified;
    });

  /** Blocks must name records of this mission (threads are taken as given). */
  const checkBlocks = (missionId: MissionId, blocks: ReadonlyArray<MissionRecordRef>) =>
    Effect.forEach(
      blocks,
      (ref) => {
        switch (ref.kind) {
          case "work-item":
          case "lane":
          case "sub-mission":
          case "milestone":
          case "draft":
          case "fork":
          case "approval":
          case "rule-change-request":
            return need(ref.kind, ref.id).pipe(
              Effect.flatMap((record) =>
                record.missionId === missionId
                  ? Effect.void
                  : fail("invalid", `${ref.kind} ${ref.id} belongs to another mission.`),
              ),
            );
          default:
            return Effect.void;
        }
      },
      { discard: true },
    );

  /** Work items and lanes named in `refs`, with their ask holds recomputed. */
  const syncHolds = (
    missionId: MissionId,
    refs: ReadonlyArray<MissionRecordRef>,
    asks: ReadonlyArray<Ask>,
    at: string,
  ) =>
    Effect.gen(function* () {
      const upserts: MissionStoreRecord[] = [];
      for (const ref of dedupeRefs(refs)) {
        if (ref.kind === "work-item") {
          const item = Option.getOrNull(yield* store.get("work-item", ref.id));
          if (item === null || item.missionId !== missionId) continue;
          const next = heldWorkItem(item, asks, at);
          if (next !== null) upserts.push({ _tag: "work-item", record: next });
        } else if (ref.kind === "lane") {
          const lane = Option.getOrNull(yield* store.get("lane", ref.id));
          if (lane === null || lane.missionId !== missionId) continue;
          const next = heldLane(lane, asks, at);
          if (next !== null) upserts.push({ _tag: "lane", record: next });
        }
      }
      return upserts;
    });

  const signalResolved = (ask: Ask, released: ReadonlyArray<MissionRecordRef>) =>
    Effect.gen(function* () {
      const cast = yield* castOf(ask.missionId);
      yield* signals.askResolved({
        ask,
        askerThreadId: threadOfActor(cast, ask.askedBy),
        released,
      });
    });

  const deliver = (
    delivery: {
      readonly threadId: MasterDelivery["threadId"];
      readonly text: string;
      readonly asOwner: boolean;
    },
    key: string,
  ) =>
    threads.deliver({ ...delivery, key }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Mission delivery failed", { key, detail: error.detail }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const allDraftNotes = (missionId: MissionId | null) =>
    Effect.gen(function* () {
      const global = yield* store.list("draft-note", { missionId: null });
      const scoped = missionId === null ? [] : yield* store.list("draft-note", { missionId });
      return [...global, ...scoped];
    });

  const listWith = <K extends "ask" | "draft" | "suggestion" | "fork">(
    kind: K,
    filter: ListFilter,
  ) =>
    store.list(kind, {
      ...(filter.missionId === undefined ? {} : { missionId: filter.missionId }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    });

  // -------------------------------------------------------------------------
  // Asks

  const openAskCommand = (raw: unknown, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      yield* fromOutcome(rejectAskDefaults(raw));
      const decoded = decodeOpenAsk(raw);
      if (Result.isFailure(decoded)) {
        return yield* fail("invalid", `Ask input: ${decoded.failure.message}`);
      }
      const { supersedes, ...input } = decoded.success;
      const { standing } = yield* standingIn(input.missionId, provenance);
      const askedBy: MissionActor | null =
        defaultAsker(standing) ?? (isOwnerProvenance(provenance) ? { _tag: "owner" } : null);
      if (askedBy === null) {
        return yield* fail(
          "forbidden",
          `Only the master or a lane of mission ${input.missionId} opens asks; this caller holds neither.`,
        );
      }
      const asks = yield* store.list("ask", { missionId: input.missionId });
      const id = AskId.make(yield* newId("ask"));
      const at = yield* now;
      const command = { id, input, caller: standing.caller, askedBy, existing: asks, now: at };
      let records: Ask[];
      let events: ModelEvent[];
      let opened: Ask;
      if (supersedes !== undefined) {
        const previous = asks.find((ask) => ask.id === supersedes);
        if (previous === undefined) return yield* fail("not-found", `No ask ${supersedes}.`);
        const result = yield* fromOutcome(supersedeAsk({ ask: previous, replacement: command }));
        opened = result.replacement.record;
        records = [result.superseded.record, opened];
        events = [...result.superseded.events, ...result.replacement.events];
      } else {
        const result = yield* fromOutcome(openAsk(command));
        opened = result.record;
        records = [opened];
        events = [...result.events];
      }
      yield* checkBlocks(input.missionId, input.blocks);
      const after = replaceById(asks, ...records);
      const holds = yield* syncHolds(input.missionId, opened.blocks, after, at);
      yield* persist(input.missionId, events, [
        ...records.map((record) => ({ _tag: "ask" as const, record })),
        ...holds,
      ]);
      return opened;
    });

  const answerAskCommand = (input: AnswerAskInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const ask = yield* need("ask", input.askId);
      const option =
        input.optionId === null
          ? null
          : (ask.options.find((candidate) => candidate.id === input.optionId) ?? null);
      const voice = yield* ownerVoice({
        provenance,
        inboundId: input.inboundId,
        expected: expectedForAnswer({ text: input.text, option }),
        notBefore: ask.updatedAt,
        what: "Answering an ask",
      });
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const resolution = yield* fromOutcome(
        answerAsk({ ask, input, provenance: voice, asks, now: at }),
      );
      const after = replaceById(asks, resolution.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(ask.missionId, resolution.events, [
        { _tag: "ask", record: resolution.record },
        ...holds,
      ]);
      return { ask: resolution.record, released: resolution.released };
    });

  const withdrawAskCommand = (input: WithdrawAskInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const ask = yield* need("ask", input.askId);
      const { standing } = yield* standingIn(ask.missionId, provenance);
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const resolution = yield* fromOutcome(
        withdrawAsk({ ask, caller: standing.caller, reason: input.reason, asks, now: at }),
      );
      const after = replaceById(asks, resolution.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(ask.missionId, resolution.events, [
        { _tag: "ask", record: resolution.record },
        ...holds,
      ]);
      return { ask: resolution.record, released: resolution.released };
    });

  const reopenAskCommand = (input: ReopenAskInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const ask = yield* need("ask", input.askId);
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const reopened = yield* fromOutcome(
        reopenAsk({ ask, provenance, reason: input.reason, now: at }),
      );
      const after = replaceById(asks, reopened.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(ask.missionId, reopened.events, [
        { _tag: "ask", record: reopened.record },
        ...holds,
      ]);
      return reopened.record;
    });

  // -------------------------------------------------------------------------
  // Calls

  const makeCallCommand = (input: MakeCallInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const { standing } = yield* standingIn(input.missionId, provenance);
      const decidedBy: MissionActor | null =
        defaultAsker(standing) ?? (isOwnerProvenance(provenance) ? { _tag: "owner" } : null);
      if (decidedBy === null) {
        return yield* fail("forbidden", "Calls come from the mission's master or a lane.");
      }
      const at = yield* now;
      const made = yield* fromOutcome(
        makeCall({
          id: CallId.make(yield* newId("call")),
          missionId: input.missionId,
          subMissionId: input.subMissionId ?? null,
          caller: standing.caller,
          decidedBy,
          title: input.title,
          decision: input.decision,
          reason: input.reason,
          alternatives: input.alternatives ?? [],
          reversible: input.reversible ?? true,
          subject: input.subject ?? null,
          now: at,
        }),
      );
      yield* persist(input.missionId, made.events, [{ _tag: "call", record: made.record }]);
      return made.record;
    });

  const reactToCallCommand = (input: ReactToCallInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const call = yield* need("call", input.callId);
      const reacted = yield* fromOutcome(
        reactToCall({
          call,
          reaction: input.reaction,
          note: input.note ?? "",
          provenance,
          now: yield* now,
        }),
      );
      yield* persist(call.missionId, reacted.events, [{ _tag: "call", record: reacted.record }]);
      return reacted.record;
    });

  // -------------------------------------------------------------------------
  // Drafts

  const draftSource = (standing: Standing): Draft["source"] => {
    const fork = standing.forks[0];
    if (fork !== undefined) return { kind: "fork", ref: forkRef(fork) };
    const lane = standing.lanes[0];
    if (lane !== undefined)
      return { kind: "lane", ref: { kind: "lane", id: lane.id, label: lane.name } };
    if (standing.isMaster) return { kind: "master", ref: null };
    return { kind: "editor", ref: null };
  };

  const submitDraftCommand = (input: SubmitDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const { standing } = yield* standingIn(input.missionId, provenance);
      if (provenance._tag === "agent" && !isParticipant(standing)) {
        return yield* fail(
          "forbidden",
          `This thread holds no role, lane or fork in mission ${input.missionId}.`,
        );
      }
      const writer = standing.roles.find((role) => role.kind === "writer") ?? null;
      const notes = yield* allDraftNotes(input.missionId);
      const existing = yield* store.list("draft", {
        missionId: input.missionId,
        status: ["pending", "rewrite-requested"],
      });
      const submitted = yield* fromOutcome(
        submitDraft({
          id: DraftId.make(yield* newId("draft")),
          missionId: input.missionId,
          audience: input.audience,
          channel: input.channel,
          target: input.target,
          text: input.text,
          source: draftSource(standing),
          writerRoleId: writer?.id ?? null,
          caller: standing.caller,
          notes,
          existing,
          now: yield* now,
        }),
      );
      yield* persist(input.missionId, submitted.events, [
        { _tag: "draft", record: submitted.record },
      ]);
      return submitted.record;
    });

  const reviseDraftCommand = (input: ReviseDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const revised = yield* fromOutcome(
        reviseDraft({
          draft,
          text: input.text,
          caller: standing.caller,
          notes: yield* allDraftNotes(draft.missionId),
          now: yield* now,
        }),
      );
      yield* persist(draft.missionId, revised.events, [{ _tag: "draft", record: revised.record }]);
      return revised.record;
    });

  /** After an owner edit: propose a draft note once the same edit repeats. */
  const learnFrom = (missionId: MissionId) =>
    Effect.gen(function* () {
      const drafts = yield* store.list("draft", { missionId });
      const notes = yield* allDraftNotes(missionId);
      const existing: Suggestion[] = [...(yield* store.list("suggestion"))];
      const opened: Suggestion[] = [];
      for (const proposal of learnFromEdits({ missionId, drafts, notes, suggestions: existing })) {
        const result = proposeSuggestion({
          id: SuggestionId.make(yield* newId("suggestion")),
          proposal,
          author: "owner-corrections",
          caller: EDITOR,
          existing,
          now: yield* now,
        });
        if (Result.isFailure(result)) continue;
        yield* persist(proposal.missionId, result.success.events, [
          { _tag: "suggestion", record: result.success.record },
        ]);
        existing.push(result.success.record);
        opened.push(result.success.record);
      }
      return opened;
    });

  const decideDraftCommand = (input: DecideDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const voice = yield* ownerVoice({
        provenance,
        inboundId: input.inboundId,
        expected: expectedForDraftDecision(input),
        notBefore: draft.createdAt,
        what: "Deciding a draft",
      });
      const decided = yield* fromOutcome(
        decideDraft({ draft, input, provenance: voice, now: yield* now }),
      );
      yield* persist(draft.missionId, decided.events, [{ _tag: "draft", record: decided.record }]);
      const suggestions = decided.edit === null ? [] : yield* learnFrom(draft.missionId);
      return { draft: decided.record, suggestions };
    });

  const reopenDraftCommand = (input: ReopenDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const reopened = yield* fromOutcome(reopenDraft(draft, provenance, yield* now));
      yield* persist(draft.missionId, reopened.events, [
        { _tag: "draft", record: reopened.record },
      ]);
      return reopened.record;
    });

  const saveDraftNoteCommand = (input: SaveDraftNoteInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const existing = input.noteId === undefined ? null : yield* need("draft-note", input.noteId);
      if (input.missionId !== null) yield* need("mission", input.missionId);
      const saved = yield* fromOutcome(
        saveDraftNote({
          id: input.noteId ?? DraftNoteId.make(yield* newId("draft-note")),
          existing,
          missionId: input.missionId,
          scope: input.scope,
          text: input.text,
          active: input.active ?? existing?.active ?? true,
          source: existing?.source ?? "owner",
          provenance,
          notes: yield* allDraftNotes(input.missionId),
          now: yield* now,
        }),
      );
      yield* persist(saved.record.missionId, saved.events, [
        { _tag: "draft-note", record: saved.record },
      ]);
      return saved.record;
    });

  // -------------------------------------------------------------------------
  // Suggestions

  const suggestionAuthor = (
    standing: Standing | null,
    provenance: MissionProvenance,
  ): SuggestionAuthor | null => {
    if (provenance._tag === "system") {
      return SUGGESTION_SYSTEM_AUTHORS.has(provenance.component)
        ? (provenance.component as SuggestionAuthor)
        : null;
    }
    if (provenance._tag !== "agent" || standing === null) return null;
    if (standing.isMaster) return "master";
    const role = standing.roles.find((held) => held.kind === "scribe" || held.kind === "editor");
    return role === undefined ? null : (role.kind as SuggestionAuthor);
  };

  const proposeSuggestionCommand = (input: ProposeSuggestionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) {
        return yield* fail(
          "forbidden",
          "The owner changes things directly; suggestions come from agents.",
        );
      }
      const standing =
        input.missionId === null ? null : (yield* standingIn(input.missionId, provenance)).standing;
      const author = suggestionAuthor(standing, provenance);
      if (author === null) {
        return yield* fail(
          "forbidden",
          "Suggestions come from the master, the scribe, the editor, the governor or code checks.",
        );
      }
      const proposed = yield* fromOutcome(
        proposeSuggestion({
          id: SuggestionId.make(yield* newId("suggestion")),
          proposal: {
            missionId: input.missionId,
            targetKind: input.targetKind,
            target: input.target ?? null,
            title: input.title,
            before: input.before ?? null,
            after: input.after,
            diffText: input.diffText,
            why: input.why,
            evidence: input.evidence,
            acceptor: input.acceptor ?? "owner",
          },
          author,
          caller: standing?.caller ?? bareCaller(provenance),
          existing: yield* store.list("suggestion"),
          now: yield* now,
        }),
      );
      yield* persist(input.missionId, proposed.events, [
        { _tag: "suggestion", record: proposed.record },
      ]);
      return proposed.record;
    });

  const decideSuggestionCommand = (input: DecideSuggestionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const suggestion = yield* need("suggestion", input.suggestionId);
      const standing =
        suggestion.missionId === null
          ? null
          : (yield* standingIn(suggestion.missionId, provenance)).standing;
      const at = yield* now;
      const decided = yield* fromOutcome(
        decideSuggestion({
          suggestion,
          input,
          caller: standing?.caller ?? bareCaller(provenance),
          callerIsMaster: standing?.isMaster ?? false,
          now: at,
        }),
      );
      let record = decided.record;
      const events: ModelEvent[] = [...decided.events];
      const upserts: MissionStoreRecord[] = [];
      if (decided.apply !== null) {
        if (decided.apply.targetKind === "draft-note") {
          const applied = draftNoteFromSuggestion({
            id: DraftNoteId.make(yield* newId("draft-note")),
            after: decided.apply.after,
            target: decided.apply.target,
            provenance: decided.record.decidedBy ?? provenance,
            notes: yield* allDraftNotes(suggestion.missionId),
            now: at,
          });
          if (Result.isSuccess(applied)) {
            record = recordOutcome(record, `Saved draft note ${applied.success.record.id}.`);
            events.push(...applied.success.events);
            upserts.push({ _tag: "draft-note", record: applied.success.record });
          } else if (applied.failure.code === "conflict") {
            record = recordOutcome(record, "Already covered by an active draft note.");
          } else {
            return yield* applied.failure;
          }
        } else {
          const outcome = yield* appliers.apply(
            decided.apply,
            decided.record.decidedBy ?? provenance,
          );
          record = recordOutcome(record, outcome);
        }
      }
      yield* persist(suggestion.missionId, events, [{ _tag: "suggestion", record }, ...upserts]);
      return record;
    });

  const reopenSuggestionCommand = (input: ReopenSuggestionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const suggestion = yield* need("suggestion", input.suggestionId);
      const callerIsMaster =
        suggestion.missionId === null
          ? false
          : (yield* standingIn(suggestion.missionId, provenance)).standing.isMaster;
      const reopened = yield* fromOutcome(
        reopenSuggestion(suggestion, provenance, yield* now, callerIsMaster),
      );
      yield* persist(suggestion.missionId, reopened.events, [
        { _tag: "suggestion", record: reopened.record },
      ]);
      return reopened.record;
    });

  // -------------------------------------------------------------------------
  // Forks

  const forkOpening = (
    fork: MissionFork,
    question: string | undefined,
  ): {
    readonly text: string;
    readonly asOwner: boolean;
  } | null => {
    const asked = question?.trim() ?? "";
    switch (fork.kind) {
      case "dev-question":
        return {
          asOwner: false,
          text: [
            `[Mission dev question] ${asked.length > 0 ? asked : forkTitle(fork.kind, fork.origin)}`,
            "Answer from the mission's context without changing the mission.",
            "Put any reply to the dev through mission_draft (the owner approves it), then end with",
            `mission_fork_close for fork ${fork.id} and one line for the master.`,
          ].join("\n"),
        };
      case "owner-question":
      case "discuss":
        return asked.length > 0 ? { asOwner: true, text: asked } : null;
    }
  };

  const startForkCommand = (input: StartForkInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const { cast, standing } = yield* standingIn(input.missionId, provenance);
      const origin = input.origin;
      const open = openForkFor(cast.forks, input.missionId, input.kind, origin);
      if (open !== undefined) return { fork: open, delivered: false, note: null };
      if (provenance._tag === "agent" && !isParticipant(standing)) {
        return yield* fail(
          "forbidden",
          `This thread holds no role, lane or fork in mission ${input.missionId}.`,
        );
      }
      const masterThreadId = yield* fromOutcome(
        checkStartFork({
          missionId: input.missionId,
          kind: input.kind,
          origin,
          caller: standing.caller,
          masterThreadId: standing.masterThreadId,
        }),
      );
      const id = ForkId.make(yield* newId("fork"));
      const forkThreadId = yield* threads.fork({
        sourceThreadId: masterThreadId,
        title: forkTitle(input.kind, origin, input.question),
        key: id,
      });
      const opened = yield* fromOutcome(
        openFork({
          missionId: input.missionId,
          kind: input.kind,
          origin,
          caller: standing.caller,
          masterThreadId,
          id,
          forkThreadId,
          now: yield* now,
        }),
      );
      yield* persist(input.missionId, opened.events, [{ _tag: "fork", record: opened.record }]);
      const opening = forkOpening(opened.record, input.question);
      const delivered =
        opening === null
          ? false
          : yield* deliver({ threadId: forkThreadId, ...opening }, `fork:${id}:opening`);
      return { fork: opened.record, delivered, note: null };
    });

  const finishFork = (
    fork: MissionFork,
    closing: {
      readonly record: MissionFork;
      readonly events: ReadonlyArray<ModelEvent>;
      readonly delivery: MasterDelivery;
      readonly note: Note | null;
    },
    key: string,
  ) =>
    Effect.gen(function* () {
      yield* persist(fork.missionId, closing.events, [
        { _tag: "fork", record: closing.record },
        ...(closing.note === null ? [] : [{ _tag: "note" as const, record: closing.note }]),
      ]);
      const delivered = yield* deliver(closing.delivery, key);
      return { fork: closing.record, delivered, note: closing.note };
    });

  const closeForkCommand = (input: CloseForkInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const fork = yield* need("fork", input.forkId);
      const { standing } = yield* standingIn(fork.missionId, provenance);
      const at = yield* now;
      const closing = yield* fromOutcome(
        closeFork({
          fork,
          summaryLine: input.summaryLine,
          commitsMission: input.commitsMission ?? false,
          caller: standing.caller,
          noteId: NoteId.make(yield* newId("note")),
          now: at,
        }),
      );
      return yield* finishFork(fork, closing, `fork:${fork.id}:closed:${at}`);
    });

  const updateForkCommand = (input: UpdateForkInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const fork = yield* need("fork", input.forkId);
      const at = yield* now;
      switch (input.action) {
        case "commits-mission": {
          const closing = yield* fromOutcome(
            markForkCommits({
              fork,
              provenance,
              noteId: NoteId.make(yield* newId("note")),
              now: at,
            }),
          );
          return yield* finishFork(fork, closing, `fork:${fork.id}:commits:${at}`);
        }
        case "archive": {
          const { standing } = yield* standingIn(fork.missionId, provenance);
          const mayArchive =
            isOwnerProvenance(provenance) ||
            standing.isMaster ||
            (provenance._tag === "agent" && provenance.threadId === fork.forkThreadId);
          if (!mayArchive) {
            return yield* fail(
              "forbidden",
              "The owner, the master or the fork itself archives a fork.",
            );
          }
          const archived = yield* fromOutcome(archiveFork(fork, provenance));
          yield* persist(fork.missionId, archived.events, [
            { _tag: "fork", record: archived.record },
          ]);
          return { fork: archived.record, delivered: false, note: null };
        }
        case "reopen": {
          const reopened = yield* fromOutcome(reopenFork(fork, provenance));
          yield* persist(fork.missionId, reopened.events, [
            { _tag: "fork", record: reopened.record },
          ]);
          return { fork: reopened.record, delivered: false, note: null };
        }
      }
    });

  // -------------------------------------------------------------------------
  // Notes and rooms

  const ackNoteCommand = (noteId: NoteId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const note = yield* need("note", noteId);
      const { standing } = yield* standingIn(note.missionId, provenance);
      const resolved = standing.caller.provenance;
      const actor: MissionActor | null = isOwnerProvenance(resolved)
        ? { _tag: "owner" }
        : standing.isMaster && resolved._tag === "agent" && resolved.roleId !== null
          ? { _tag: "role", roleId: resolved.roleId }
          : null;
      if (actor === null) {
        return yield* fail("forbidden", "Lanes read notes; the master and the owner ack them.");
      }
      if (note.ackedBy.some((held) => sameActor(held, actor))) {
        return yield* fail("conflict", `Note ${note.id} is already acked.`);
      }
      const record: Note = { ...note, ackedBy: [...note.ackedBy, actor] };
      yield* persist(
        note.missionId,
        [
          {
            kind: "note.acked",
            actor,
            provenance: standing.caller.provenance,
            summary: clipSummary(`Acked: ${note.summary}`),
            subject: { kind: "note", id: note.id, label: note.type },
            payload: null,
          },
        ],
        [{ _tag: "note", record }],
      );
      return record;
    });

  const postCommand = (input: PostMessageInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const { standing } = yield* standingIn(input.missionId, provenance);
      if (provenance._tag === "agent" && !isParticipant(standing)) {
        return yield* fail(
          "forbidden",
          `This thread holds no role, lane or fork in mission ${input.missionId}.`,
        );
      }
      return yield* rooms.post(input, standing.caller.provenance);
    });

  // -------------------------------------------------------------------------
  // Reads

  const desk = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* need("mission", missionId);
      const asks = yield* store.list("ask", { missionId, status: ["open"] });
      const lanes = yield* store.list("lane", { missionId });
      const calls = yield* store.list("call", { missionId });
      const result: MissionDesk = {
        mission,
        openAsks: asks,
        held: heldRecords(asks),
        pendingDrafts: yield* store.list("draft", {
          missionId,
          status: ["pending", "rewrite-requested"],
        }),
        openSuggestions: yield* store.list("suggestion", { missionId, status: ["open"] }),
        openForks: yield* store.list("fork", { missionId, status: ["open"] }),
        directionCheck: directionCheck(calls, yield* store.ownerLastLookedAt(missionId)),
        lanes: lanes.map(({ id, name, status, statusReason }) => ({
          id,
          name,
          status,
          statusReason,
        })),
        latestSeq: yield* store.latestSeq(missionId),
      };
      return result;
    });

  const digest = (missionId: MissionId, since: string) =>
    Effect.gen(function* () {
      yield* need("mission", missionId);
      const recent = yield* store.recentEvents(missionId, 500);
      return recent.filter((event) => event.at > since).toReversed();
    });

  const draftGuide = (input: DraftGuideInput) =>
    Effect.gen(function* () {
      const address = {
        missionId: input.missionId,
        channel: input.channel,
        audience: input.audience,
      };
      const notes = notesFor(address, yield* allDraftNotes(input.missionId));
      const drafts = yield* store.list("draft", {
        missionId: input.missionId,
        status: ["approved", "sent"],
      });
      return { notes, examples: draftExamples(address, drafts) };
    });

  return AsksService.of({
    missions: () => store.list("mission"),
    desk,
    digest,
    events: (missionId, afterSeq, limit) => store.eventsSince(missionId, afterSeq, limit),
    asks: (filter) => listWith("ask", filter),
    ask: (askId) => need("ask", askId),
    calls: (missionId) => store.list("call", { missionId }),
    directionCheck: (missionId, since) =>
      store.list("call", { missionId }).pipe(Effect.map((calls) => directionCheck(calls, since))),
    drafts: (filter) => listWith("draft", filter),
    draftGuide,
    draftNotes: (missionId) => allDraftNotes(missionId),
    suggestions: (filter) => listWith("suggestion", filter),
    suggestionStats: () => store.list("suggestion").pipe(Effect.map(suggestionStats)),
    forks: (filter) => listWith("fork", filter),
    notes: (missionId) => store.list("note", { missionId }),
    standing: (missionId, provenance) =>
      standingIn(missionId, provenance).pipe(Effect.map(({ standing }) => standing)),
    openAsk: (raw, provenance) => serialized(openAskCommand(raw, provenance)),
    answerAsk: (input, provenance) =>
      serialized(answerAskCommand(input, provenance)).pipe(
        Effect.tap((result) => signalResolved(result.ask, result.released)),
      ),
    withdrawAsk: (input, provenance) =>
      serialized(withdrawAskCommand(input, provenance)).pipe(
        Effect.tap((result) =>
          isOwnerProvenance(provenance) ? signalResolved(result.ask, result.released) : Effect.void,
        ),
      ),
    reopenAsk: (input, provenance) => serialized(reopenAskCommand(input, provenance)),
    makeCall: (input, provenance) => serialized(makeCallCommand(input, provenance)),
    reactToCall: (input, provenance) => serialized(reactToCallCommand(input, provenance)),
    submitDraft: (input, provenance) => serialized(submitDraftCommand(input, provenance)),
    reviseDraft: (input, provenance) => serialized(reviseDraftCommand(input, provenance)),
    decideDraft: (input, provenance) => serialized(decideDraftCommand(input, provenance)),
    reopenDraft: (input, provenance) => serialized(reopenDraftCommand(input, provenance)),
    saveDraftNote: (input, provenance) => serialized(saveDraftNoteCommand(input, provenance)),
    proposeSuggestion: (input, provenance) =>
      serialized(proposeSuggestionCommand(input, provenance)),
    decideSuggestion: (input, provenance) => serialized(decideSuggestionCommand(input, provenance)),
    reopenSuggestion: (input, provenance) => serialized(reopenSuggestionCommand(input, provenance)),
    startFork: (input, provenance) => serialized(startForkCommand(input, provenance)),
    closeFork: (input, provenance) => serialized(closeForkCommand(input, provenance)),
    updateFork: (input, provenance) => serialized(updateForkCommand(input, provenance)),
    ackNote: (noteId, provenance) => serialized(ackNoteCommand(noteId, provenance)),
    post: postCommand,
  });
});

export const layer = Layer.effect(AsksService, make);

/**
 * The service with this server's ports: iMessage lookups against the bridge
 * and Moni's chat, forks and deliveries through thread management, a direct
 * queued line to the asker until the router's wakes merge, and typed seams
 * for rooms (router) and suggestion targets owned by other tracks.
 */
export const layerLive = layer.pipe(
  Layer.provideMerge(
    // ardud missions: router (AsksRooms comes from the router in missions/layer.ts)
    Layer.mergeAll(Inbound.layer, Ports.signalsDeliver, Ports.appliersPending).pipe(
      Layer.provideMerge(Ports.threadsLayer),
    ),
  ),
);
