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
  type AnnotateDraftInput,
  type AnswerAskInput,
  type Ask,
  type Call,
  type CloseForkInput,
  type CloseStaleDraftInput,
  type ReportDraftSentInput,
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
  type MissionLink,
  type MissionMessage,
  type MissionProvenance,
  type MissionRecordRef,
  type Note,
  type OpenSystemDraftInput,
  type PostMessageInput,
  type ReactToCallInput,
  type ReopenAskInput,
  type ReopenDraftInput,
  type ReopenSuggestionInput,
  type RouteDraftInput,
  type SaveDraftNoteInput,
  type SetDraftNoteActiveInput,
  type StartForkInput,
  type Suggestion,
  type SuggestionAuthor,
  type SuggestionStats,
  type SystemDraftDecision,
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

import { cleanAnnotation } from "../core/approvals.ts";
import { isMasterAnywhere } from "../core/master.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreKind, MissionStoreRecord } from "../store/recordIndex.ts";
import {
  answerAsk,
  askEpochOf,
  askReopened,
  openAsk,
  rejectAskDefaults,
  reopenAsk,
  supersedeAsk,
  withdrawAsk,
} from "./askModel.ts";
import { directionCheck, makeCall, reactToCall } from "./callModel.ts";
import { draftNoteFromSuggestion, learnFromEdits } from "./draftLearning.ts";
import {
  annotateDraft,
  annotationOf,
  closeStaleDraft,
  decideDraft,
  draftExamples,
  type DraftAbout,
  type DraftExample,
  epochOf,
  notesFor,
  openSystemDraft,
  pullRequestKeyOf,
  reopenDraft,
  reportDraftSent,
  reviseDraft,
  revisionOf,
  routeDraft,
  routeDraftApprover,
  saveDraftNote,
  submitDraft,
  systemDraftDecision,
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
import { answerCheck, draftDecisionCheck, type ReplyCheck, verifyInbound } from "./provenance.ts";
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
  acceptorFor,
  decideSuggestion,
  proposeSuggestion,
  recordOutcome,
  reopenSuggestion,
  suggestionStats,
  type SuggestionApplication,
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

export interface ProposeOptions {
  /**
   * A stable id for authors that may propose the same thing twice (the
   * editor replays its plan). An existing suggestion with this id is returned
   * as it is.
   */
  readonly id?: SuggestionId | undefined;
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
    /** Owner or master hands one pending draft to the other approver, with a reason. */
    readonly routeDraft: (input: RouteDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    readonly saveDraftNote: (
      input: SaveDraftNoteInput,
      provenance: MissionProvenance,
    ) => Fx<DraftNote>;
    readonly setDraftNoteActive: (
      input: SetDraftNoteActiveInput,
      provenance: MissionProvenance,
    ) => Fx<DraftNote>;
    /** Owner or master sets a waiting draft's summary and flag chips. */
    readonly annotateDraft: (input: AnnotateDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    /** A system (crw) opens a draft for one exact head, closing its older ones for the target. */
    readonly openSystemDraft: (
      input: OpenSystemDraftInput,
      provenance: MissionProvenance,
    ) => Fx<Draft>;
    readonly closeStaleDraft: (
      input: CloseStaleDraftInput,
      provenance: MissionProvenance,
    ) => Fx<Draft>;
    /** The decision a system may act on for one draft at one head. */
    readonly systemDraftDecision: (
      input: { readonly draftId: DraftId; readonly head: string; readonly requestedBy: string },
      provenance: MissionProvenance,
    ) => Fx<SystemDraftDecision>;
    /** The requesting system reports it posted (or failed to post) the approved text. */
    readonly reportDraftSent: (
      input: ReportDraftSentInput,
      provenance: MissionProvenance,
    ) => Fx<Draft>;
    // Suggestions
    readonly proposeSuggestion: (
      input: ProposeSuggestionInput,
      provenance: MissionProvenance,
      options?: ProposeOptions,
    ) => Fx<Suggestion>;
    readonly decideSuggestion: (
      input: DecideSuggestionInput,
      provenance: MissionProvenance,
    ) => Fx<Suggestion>;
    readonly reopenSuggestion: (
      input: ReopenSuggestionInput,
      provenance: MissionProvenance,
    ) => Fx<Suggestion>;
    /** Startup: applies accepted suggestions the last process left without an outcome. */
    readonly applyPendingSuggestions: Fx<ReadonlyArray<Suggestion>>;
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
  const appliers = yield* Ports.SuggestionApplierRegistry;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  /**
   * Suggestions whose applier runs in this process. Claimed under the asks
   * lock with the decision, so the startup sweep never runs one twice.
   */
  const applying = new Set<string>();

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
    readonly check: ReplyCheck;
    readonly notBefore: string;
    readonly skewMs?: number;
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
          check: command.check,
          notBefore: command.notBefore,
          ...(command.skewMs === undefined ? {} : { skewMs: command.skewMs }),
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
      // The reply must carry the exact answer: the option he picked and nothing turning it around.
      const voice = yield* ownerVoice({
        provenance,
        inboundId: input.inboundId,
        check: answerCheck({ options: ask.options, optionId: input.optionId, text: input.text }),
        // After a reopen nothing said before the new epoch counts, not even within clock skew.
        notBefore: askEpochOf(ask),
        ...(askReopened(ask) ? { skewMs: 0 } : {}),
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

  /**
   * What a writer's draft is about. The work item and sub-mission must be the mission's; the
   * sub-mission defaults to the work item's, then to the writer's lane's.
   */
  /**
   * The lanes a lane-bound caller may name a draft after, or null when it may
   * name any: the owner, the master, its forks and mission-wide roles.
   */
  const ownLanes = (cast: MissionCast, standing: Standing): ReadonlySet<string> | null => {
    if (standing.caller.provenance._tag !== "agent" || standing.isMaster) return null;
    if (standing.forks.length > 0 || standing.roles.some((role) => role.laneId === null)) {
      return null;
    }
    const laneIds = new Set<string>(standing.lanes.map((lane) => lane.id));
    for (const role of standing.roles) if (role.laneId !== null) laneIds.add(role.laneId);
    return new Set<string>(
      cast.lanes.filter((lane) => laneIds.has(lane.id)).map((lane) => lane.id),
    );
  };

  const draftAbout = (input: SubmitDraftInput, cast: MissionCast, standing: Standing) =>
    Effect.gen(function* () {
      const item =
        input.workItemId === undefined
          ? null
          : Option.getOrNull(yield* store.get("work-item", input.workItemId));
      if (input.workItemId !== undefined && item?.missionId !== input.missionId) {
        return yield* fail(
          "not-found",
          `No work item ${input.workItemId} in mission ${input.missionId}.`,
        );
      }
      // What a draft is about picks its route, so a lane names only its own work.
      const lanes = ownLanes(cast, standing);
      if (lanes !== null && item !== null && (item.laneId === null || !lanes.has(item.laneId))) {
        return yield* fail(
          "forbidden",
          `Work item ${item.id} is not in a lane this thread works; name only your own lane's work.`,
        );
      }
      if (input.subMissionId !== undefined) {
        const named = Option.getOrNull(yield* store.get("sub-mission", input.subMissionId));
        if (named?.missionId !== input.missionId) {
          return yield* fail(
            "not-found",
            `No sub-mission ${input.subMissionId} in mission ${input.missionId}.`,
          );
        }
        if (item?.subMissionId != null && item.subMissionId !== input.subMissionId) {
          return yield* fail(
            "invalid",
            `Work item ${item.id} is in sub-mission ${item.subMissionId}, not ${input.subMissionId}.`,
          );
        }
        const laneWork =
          lanes === null ||
          item?.subMissionId === input.subMissionId ||
          cast.lanes.some((lane) => lanes.has(lane.id) && lane.subMissionId === input.subMissionId);
        if (!laneWork) {
          return yield* fail(
            "forbidden",
            `Sub-mission ${input.subMissionId} holds none of this thread's lanes; name only your own lane's work.`,
          );
        }
      }
      const about: DraftAbout = {
        subMissionId:
          input.subMissionId ?? item?.subMissionId ?? standing.lanes[0]?.subMissionId ?? null,
        workItemId: item?.id ?? null,
      };
      return about;
    });

  /** A system draft is about the work item that owns its pull request, when exactly one does. */
  const systemDraftAbout = (missionId: MissionId, target: MissionLink) =>
    Effect.gen(function* () {
      const key = pullRequestKeyOf(target);
      if (key === null) return { subMissionId: null, workItemId: null } satisfies DraftAbout;
      const owners = (yield* store.list("work-item", { missionId })).filter(
        (item) =>
          item.pullRequest !== null &&
          item.pullRequest.number === key.number &&
          item.pullRequest.repository.toLowerCase() === key.repository.toLowerCase(),
      );
      const [only] = owners;
      return owners.length === 1 && only !== undefined
        ? ({ subMissionId: only.subMissionId, workItemId: only.id } satisfies DraftAbout)
        : ({ subMissionId: null, workItemId: null } satisfies DraftAbout);
    });

  const submitDraftCommand = (input: SubmitDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const { cast, standing } = yield* standingIn(input.missionId, provenance);
      if (provenance._tag === "agent" && !isParticipant(standing)) {
        return yield* fail(
          "forbidden",
          `This thread holds no role, lane or fork in mission ${input.missionId}.`,
        );
      }
      const writer = standing.roles.find((role) => role.kind === "writer") ?? null;
      // The role the text comes from: the writer role when held, else the role it speaks as.
      const speaking = standing.caller.provenance;
      const drafting =
        writer ??
        (speaking._tag === "agent"
          ? (standing.roles.find((role) => role.id === speaking.roleId) ?? null)
          : null);
      if (drafting !== null && !drafting.writesPublicText) {
        return yield* fail(
          "forbidden",
          `Role ${drafting.name} does not write public text (the master's switch); hand the text to a writer role and let it draft.`,
        );
      }
      const binding =
        drafting === null || speaking._tag !== "agent"
          ? undefined
          : cast.bindings.find(
              (candidate) =>
                candidate.roleId === drafting.id &&
                candidate.endedAt === null &&
                candidate.threadId === speaking.threadId,
            );
      const notes = yield* allDraftNotes(input.missionId);
      const about = yield* draftAbout(input, cast, standing);
      // A draft names one audience; routes match it as the person as well.
      const route = routeDraftApprover(cast.mission?.approvalRouting, input, about);
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
          route,
          writtenBy: { roleId: drafting?.id ?? null, model: binding?.observedModel ?? null },
          about,
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
      // The inbound must postdate the draft's current epoch. After a revision or reopen there
      // is no skew allowance: a reply to the earlier text or decision never counts.
      const voice = yield* ownerVoice({
        provenance,
        inboundId: input.inboundId,
        check: draftDecisionCheck(input),
        notBefore: epochOf(draft),
        ...(revisionOf(draft) > 0 ? { skewMs: 0 } : {}),
        what: "Deciding a draft",
      });
      // A master's decision is recorded under its role, never as the owner.
      const { standing } = yield* standingIn(draft.missionId, voice);
      const decided = yield* fromOutcome(
        decideDraft({
          draft,
          input,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
          now: yield* now,
        }),
      );
      yield* persist(draft.missionId, decided.events, [{ _tag: "draft", record: decided.record }]);
      // Only the owner's own edits teach the house style.
      const suggestions =
        decided.edit === null || !isOwnerProvenance(voice) ? [] : yield* learnFrom(draft.missionId);
      return { draft: decided.record, suggestions };
    });

  const reopenDraftCommand = (input: ReopenDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const reopened = yield* fromOutcome(
        reopenDraft(draft, standing.caller.provenance, standing.isMaster, yield* now),
      );
      yield* persist(draft.missionId, reopened.events, [
        { _tag: "draft", record: reopened.record },
      ]);
      return reopened.record;
    });

  const routeDraftCommand = (input: RouteDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const routed = yield* fromOutcome(
        routeDraft({
          draft,
          approver: input.approver,
          reason: input.reason,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
        }),
      );
      if (routed.events.length === 0) return routed.record;
      yield* persist(draft.missionId, routed.events, [{ _tag: "draft", record: routed.record }]);
      return routed.record;
    });

  /**
   * The owner anywhere; a master for its mission's notes, or for global ones from any mission.
   * In a mission the writer is recorded as its role, not the bare thread.
   */
  const draftNoteWriter = (missionId: MissionId | null, provenance: MissionProvenance) =>
    missionId === null
      ? Effect.map(isMasterAnywhere(store, provenance), (isMaster) => ({ isMaster, provenance }))
      : Effect.map(standingIn(missionId, provenance), ({ standing }) => ({
          isMaster: standing.isMaster,
          provenance: standing.caller.provenance,
        }));

  const saveDraftNoteCommand = (input: SaveDraftNoteInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const existing = input.noteId === undefined ? null : yield* need("draft-note", input.noteId);
      // A note stays where it was written; the writer's standing is checked there.
      if (existing !== null && existing.missionId !== input.missionId) {
        return yield* fail(
          "invalid",
          `Draft note ${existing.id} belongs to ${existing.missionId ?? "every mission"}; save a new note instead of moving it.`,
        );
      }
      if (input.missionId !== null) yield* need("mission", input.missionId);
      const writer = yield* draftNoteWriter(input.missionId, provenance);
      const saved = yield* fromOutcome(
        saveDraftNote({
          id: input.noteId ?? DraftNoteId.make(yield* newId("draft-note")),
          existing,
          missionId: input.missionId,
          scope: input.scope,
          text: input.text,
          active: input.active ?? existing?.active ?? true,
          // `source` is where the note started; `writtenBy` names who last changed it.
          source: existing?.source ?? (isOwnerProvenance(writer.provenance) ? "owner" : "master"),
          provenance: writer.provenance,
          callerIsMaster: writer.isMaster,
          notes: yield* allDraftNotes(input.missionId),
          now: yield* now,
        }),
      );
      yield* persist(saved.record.missionId, saved.events, [
        { _tag: "draft-note", record: saved.record },
      ]);
      return saved.record;
    });

  const setDraftNoteActiveCommand = (
    input: SetDraftNoteActiveInput,
    provenance: MissionProvenance,
  ) =>
    Effect.gen(function* () {
      const note = yield* need("draft-note", input.draftNoteId);
      if (note.active === input.active) return note;
      return yield* saveDraftNoteCommand(
        {
          noteId: note.id,
          missionId: note.missionId,
          scope: note.scope,
          text: note.text,
          active: input.active,
        },
        provenance,
      );
    });

  const annotateDraftCommand = (input: AnnotateDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const annotation = yield* cleanAnnotation(annotationOf(draft), input);
      const annotated = yield* fromOutcome(
        annotateDraft({
          draft,
          annotation,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
        }),
      );
      if (annotated.events.length === 0) return annotated.record;
      yield* persist(draft.missionId, annotated.events, [
        { _tag: "draft", record: annotated.record },
      ]);
      return annotated.record;
    });

  const openSystemDraftCommand = (input: OpenSystemDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const mission = yield* need("mission", input.missionId);
      const current = Option.getOrNull(yield* store.get("draft", input.draftId));
      const annotation = yield* cleanAnnotation({ summary: null, flags: [] }, input);
      const about = yield* systemDraftAbout(input.missionId, input.target);
      const opened = yield* fromOutcome(
        openSystemDraft({
          input,
          annotation,
          provenance,
          current,
          existing: yield* store.list("draft", {
            missionId: input.missionId,
            status: ["pending", "rewrite-requested"],
          }),
          route: routeDraftApprover(mission.approvalRouting, input, about),
          about,
          notes: yield* allDraftNotes(input.missionId),
          now: yield* now,
        }),
      );
      if (opened.events.length === 0) return opened.record;
      yield* persist(input.missionId, opened.events, [
        { _tag: "draft", record: opened.record },
        ...opened.closed.map((record) => ({ _tag: "draft" as const, record })),
      ]);
      return opened.record;
    });

  const closeStaleDraftCommand = (input: CloseStaleDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const closed = yield* fromOutcome(
        closeStaleDraft({
          draft,
          requestedBy: input.requestedBy,
          reason: input.reason,
          provenance,
          now: yield* now,
        }),
      );
      if (closed.events.length === 0) return closed.record;
      yield* persist(draft.missionId, closed.events, [{ _tag: "draft", record: closed.record }]);
      return closed.record;
    });

  const systemDraftDecisionRead = (
    input: { readonly draftId: DraftId; readonly head: string; readonly requestedBy: string },
    provenance: MissionProvenance,
  ) =>
    Effect.gen(function* () {
      if (!(provenance._tag === "system" && provenance.component === input.requestedBy)) {
        return yield* fail("forbidden", `Only ${input.requestedBy} reads its own drafts.`);
      }
      const draft = yield* need("draft", input.draftId);
      if (draft.requestedBy !== input.requestedBy) {
        return yield* fail(
          "forbidden",
          `Draft ${draft.id} was not opened by ${input.requestedBy}.`,
        );
      }
      return systemDraftDecision(draft, input.head);
    });

  const reportDraftSentCommand = (input: ReportDraftSentInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const reported = yield* fromOutcome(
        reportDraftSent({ draft, input, provenance, now: yield* now }),
      );
      if (reported.events.length === 0) return reported.record;
      yield* persist(draft.missionId, reported.events, [
        { _tag: "draft", record: reported.record },
      ]);
      return reported.record;
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

  const proposeSuggestionCommand = (
    input: ProposeSuggestionInput,
    provenance: MissionProvenance,
    options?: ProposeOptions,
  ) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) {
        return yield* fail(
          "forbidden",
          "The owner changes things directly; suggestions come from agents.",
        );
      }
      const inMission =
        input.missionId === null ? null : yield* standingIn(input.missionId, provenance);
      const standing = inMission?.standing ?? null;
      const author = suggestionAuthor(standing, provenance);
      if (author === null) {
        return yield* fail(
          "forbidden",
          "Suggestions come from the master, the scribe, the editor, the governor or code checks.",
        );
      }
      const target = input.target ?? null;
      const acceptor = acceptorFor({
        targetKind: input.targetKind,
        target,
        author,
        requested: input.acceptor,
        masterRoleId:
          inMission?.cast.mission?.masterRoleId ??
          inMission?.cast.roles.find((role) => role.kind === "master")?.id ??
          null,
      });
      if (options?.id !== undefined && Option.isSome(yield* store.get("suggestion", options.id))) {
        return yield* need("suggestion", options.id);
      }
      const proposed = yield* fromOutcome(
        proposeSuggestion({
          id: options?.id ?? SuggestionId.make(yield* newId("suggestion")),
          proposal: {
            missionId: input.missionId,
            targetKind: input.targetKind,
            target,
            title: input.title,
            before: input.before ?? null,
            after: input.after,
            diffText: input.diffText,
            why: input.why,
            evidence: input.evidence,
            acceptor,
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

  /** The caller's standing for a suggestion: a mission's master, or any master for a global one. */
  const suggestionStanding = (suggestion: Suggestion, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (suggestion.missionId !== null) {
        const { standing } = yield* standingIn(suggestion.missionId, provenance);
        return { caller: standing.caller, isMaster: standing.isMaster };
      }
      return {
        caller: bareCaller(provenance),
        isMaster: !isOwnerProvenance(provenance) && (yield* isMasterAnywhere(store, provenance)),
      };
    });

  interface PendingApplication {
    readonly record: Suggestion;
    readonly application: SuggestionApplication | null;
    readonly decisionId: MissionEvent["id"];
    readonly decider: MissionProvenance;
  }

  /**
   * Commits the decision. Draft notes are asks' own records and save in the
   * same commit; other kinds come back for their track's applier.
   */
  const decideSuggestionStep = (input: DecideSuggestionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const suggestion = yield* need("suggestion", input.suggestionId);
      const { caller, isMaster } = yield* suggestionStanding(suggestion, provenance);
      const at = yield* now;
      const decided = yield* fromOutcome(
        decideSuggestion({ suggestion, input, caller, callerIsMaster: isMaster, now: at }),
      );
      const decider = decided.record.decidedBy ?? provenance;
      let record = decided.record;
      const events: ModelEvent[] = [...decided.events];
      const upserts: MissionStoreRecord[] = [];
      let application: SuggestionApplication | null = decided.apply;
      if (application !== null && application.targetKind === "draft-note") {
        const applied = draftNoteFromSuggestion({
          id: DraftNoteId.make(yield* newId("draft-note")),
          after: application.after,
          target: application.target,
          suggestionMissionId: suggestion.missionId,
          provenance: decider,
          callerIsMaster: isMaster,
          notes: yield* allDraftNotes(suggestion.missionId),
          now: at,
        });
        application = null;
        if (Result.isSuccess(applied)) {
          record = recordOutcome(record, `Saved draft note ${applied.success.record.id}.`);
          events.push(...applied.success.events);
          upserts.push({ _tag: "draft-note", record: applied.success.record });
        } else if (applied.failure.code === "conflict") {
          record = recordOutcome(record, "Already covered by an active draft note.");
        } else {
          record = recordOutcome(record, `Not applied: ${applied.failure.detail}`);
        }
      }
      const committed = yield* persist(suggestion.missionId, events, [
        { _tag: "suggestion", record },
        ...upserts,
      ]);
      const pending: PendingApplication = {
        record,
        application,
        decisionId: committed.id,
        decider,
      };
      if (application !== null) applying.add(record.id);
      return pending;
    });

  /** Records what the applier did, as an event following the decision. */
  const recordApplied = (pending: PendingApplication, outcome: string, applied: boolean) =>
    Effect.gen(function* () {
      const current = yield* need("suggestion", pending.record.id);
      const record = recordOutcome(current, outcome);
      yield* store.commit({
        event: {
          missionId: record.missionId ?? GLOBAL_TIMELINE,
          kind: "suggestion.applied",
          actor: { _tag: "system", component: "asks" },
          provenance: pending.decider,
          summary: clipSummary(`${applied ? "Applied" : "Not applied"}: ${record.title}`),
          subject: { kind: "suggestion", id: record.id, label: record.title },
          causedBy: pending.decisionId,
          payload: { outcome, applied, targetKind: record.targetKind },
        },
        upserts: [{ _tag: "suggestion", record }],
      });
      return record;
    });

  /**
   * Decide, then apply outside the asks lock (appliers run other tracks'
   * services, which may call back into asks). Every event the applier's
   * service commits follows from the decision event, whose subject is the
   * suggestion. An applier refusal is an outcome, not a failed decision.
   *
   * Once the decision commits, applying and recording run to the end even if
   * the caller goes away, and a crash in the applier is recorded too, so an
   * accepted suggestion never sits without an outcome.
   */
  const decideSuggestionCommand = (input: DecideSuggestionInput, provenance: MissionProvenance) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const pending = yield* serialized(decideSuggestionStep(input, provenance));
        if (pending.application === null) return pending.record;
        return yield* applyDecided(pending, pending.application);
      }),
    );

  /** Runs a claimed decision's applier and records what it did. */
  const applyDecided = (pending: PendingApplication, application: SuggestionApplication) =>
    Effect.gen(function* () {
      const result = yield* appliers.apply(application, pending.decider).pipe(
        Effect.map((outcome) => ({ outcome, applied: outcome.startsWith("Applied") })),
        Effect.catch((error: MissionError) =>
          Effect.succeed({ outcome: `Not applied: ${error.detail}`, applied: false }),
        ),
        Effect.catchCause((cause) =>
          Effect.as(Effect.logWarning("missions: suggestion applier crashed", cause), {
            outcome: "Not applied: the applier failed unexpectedly.",
            applied: false,
          }),
        ),
        Effect.provideService(MissionStore.MissionCause, pending.decisionId),
      );
      return yield* serialized(recordApplied(pending, result.outcome, result.applied));
    }).pipe(Effect.ensuring(Effect.sync(() => applying.delete(pending.record.id))));

  /**
   * The latest decision event of each listed suggestion on a timeline, and
   * whether anything the applier committed already follows from it.
   */
  const decisionTrail = (timeline: MissionId, ids: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const trail = new Map<string, { decision: MissionEvent; followed: boolean }>();
      const byDecision = new Map<string, string>();
      let afterSeq = 0;
      for (;;) {
        const page = yield* store.eventsSince(timeline, afterSeq, 500);
        for (const event of page) {
          if (
            event.kind === "suggestion.decided" &&
            event.subject?.kind === "suggestion" &&
            ids.has(event.subject.id)
          ) {
            trail.set(event.subject.id, { decision: event, followed: false });
            byDecision.set(event.id, event.subject.id);
          } else if (event.causedBy !== null) {
            const id = byDecision.get(event.causedBy);
            const entry = id === undefined ? undefined : trail.get(id);
            if (entry !== undefined && entry.decision.id === event.causedBy) entry.followed = true;
          }
        }
        const last = page.at(-1);
        if (last === undefined || page.length < 500) return trail;
        afterSeq = last.seq;
      }
    });

  /**
   * After a restart: accepted suggestions that never got an outcome because
   * the server stopped between the decision and its applier. One whose
   * applier already committed something is not run twice; the outcome says
   * so. The rest apply now, caused by their decision like a live accept.
   */
  const applyPendingSuggestionsCommand = Effect.gen(function* () {
    const claimed = yield* serialized(
      Effect.gen(function* () {
        const accepted = yield* store.list("suggestion", { status: ["accepted", "edited"] });
        const waiting = accepted.filter(
          (suggestion) =>
            suggestion.outcome === null &&
            suggestion.targetKind !== "draft-note" &&
            !applying.has(suggestion.id),
        );
        const timelines = new Map<MissionId, Suggestion[]>();
        for (const suggestion of waiting) {
          const timeline = suggestion.missionId ?? GLOBAL_TIMELINE;
          timelines.set(timeline, [...(timelines.get(timeline) ?? []), suggestion]);
        }
        const found: Array<{ pending: PendingApplication; followed: boolean }> = [];
        for (const [timeline, suggestions] of timelines) {
          const trail = yield* decisionTrail(
            timeline,
            new Set(suggestions.map((suggestion) => suggestion.id)),
          );
          for (const record of suggestions) {
            const entry = trail.get(record.id);
            if (entry === undefined) {
              yield* Effect.logWarning(
                `missions: accepted suggestion ${record.id} has no decision event; left unapplied`,
              );
              continue;
            }
            applying.add(record.id);
            found.push({
              pending: {
                record,
                application: {
                  suggestion: record,
                  targetKind: record.targetKind,
                  target: record.target,
                  after: record.after,
                },
                decisionId: entry.decision.id,
                decider: record.decidedBy ?? entry.decision.provenance,
              },
              followed: entry.followed,
            });
          }
        }
        return found;
      }),
    );
    return yield* Effect.forEach(claimed, ({ pending, followed }) =>
      followed || pending.application === null
        ? serialized(
            recordApplied(
              pending,
              "Applied before a restart: its changes follow the decision on the timeline, but the server stopped before recording the outcome.",
              true,
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => applying.delete(pending.record.id))))
        : applyDecided(pending, pending.application),
    );
  });

  const reopenSuggestionCommand = (input: ReopenSuggestionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const suggestion = yield* need("suggestion", input.suggestionId);
      const { caller, isMaster } = yield* suggestionStanding(suggestion, provenance);
      const reopened = yield* fromOutcome(
        reopenSuggestion(suggestion, caller.provenance, yield* now, isMaster),
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
    provenance: MissionProvenance,
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
        // Only the owner's own words reach the fork as the owner.
        return asked.length > 0 ? { asOwner: isOwnerProvenance(provenance), text: asked } : null;
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
          callerIsMaster: standing.isMaster,
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
          callerIsMaster: standing.isMaster,
          id,
          forkThreadId,
          question: input.question,
          now: yield* now,
        }),
      );
      yield* persist(input.missionId, opened.events, [{ _tag: "fork", record: opened.record }]);
      const opening = forkOpening(opened.record, input.question, provenance);
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
      const { standing } = yield* standingIn(fork.missionId, provenance);
      switch (input.action) {
        case "commits-mission": {
          const closing = yield* fromOutcome(
            markForkCommits({
              fork,
              provenance: standing.caller.provenance,
              callerIsMaster: standing.isMaster,
              noteId: NoteId.make(yield* newId("note")),
              now: at,
            }),
          );
          return yield* finishFork(fork, closing, `fork:${fork.id}:commits:${at}`);
        }
        case "archive": {
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
          const reopened = yield* fromOutcome(
            reopenFork(fork, standing.caller.provenance, standing.isMaster),
          );
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
    routeDraft: (input, provenance) => serialized(routeDraftCommand(input, provenance)),
    saveDraftNote: (input, provenance) => serialized(saveDraftNoteCommand(input, provenance)),
    setDraftNoteActive: (input, provenance) =>
      serialized(setDraftNoteActiveCommand(input, provenance)),
    annotateDraft: (input, provenance) => serialized(annotateDraftCommand(input, provenance)),
    openSystemDraft: (input, provenance) => serialized(openSystemDraftCommand(input, provenance)),
    closeStaleDraft: (input, provenance) => serialized(closeStaleDraftCommand(input, provenance)),
    reportDraftSent: (input, provenance) => serialized(reportDraftSentCommand(input, provenance)),
    systemDraftDecision: systemDraftDecisionRead,
    proposeSuggestion: (input, provenance, options) =>
      serialized(proposeSuggestionCommand(input, provenance, options)),
    // Serializes its own steps: the applier runs outside the lock.
    decideSuggestion: decideSuggestionCommand,
    reopenSuggestion: (input, provenance) => serialized(reopenSuggestionCommand(input, provenance)),
    applyPendingSuggestions: Effect.uninterruptible(applyPendingSuggestionsCommand),
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
 * and Moni's chat, forks and deliveries through thread management, and typed
 * seams for rooms and answer signals (router's doorbell). Suggestion appliers register into the registry from
 * the tracks that own them (see wiring.ts).
 */
export const layerLive = layer.pipe(
  Layer.provideMerge(
    // ardud missions: router (AsksRooms and AsksSignals come from the router in missions/layer.ts)
    Layer.mergeAll(Inbound.layer, Ports.applierRegistry).pipe(
      Layer.provideMerge(Ports.threadsLayer),
    ),
  ),
);
