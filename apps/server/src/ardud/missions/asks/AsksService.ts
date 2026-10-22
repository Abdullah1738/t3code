import {
  AskId,
  CallId,
  DraftId,
  DraftNoteId,
  approverOf,
  isOwnerProvenance,
  MissionError,
  MissionId,
  NoteId,
  SuggestionId,
  type AnnotateDraftInput,
  type AnswerAskInput,
  type Ask,
  type Call,
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
  type MissionLink,
  type MissionMessage,
  type MissionProvenance,
  type MissionRecordRef,
  type Note,
  type OpenSystemDraftInput,
  type OwnerCondition,
  type PostMessageInput,
  type ReactToCallInput,
  type RecordDraftSentInput,
  type ReopenAskInput,
  type ReopenDraftInput,
  type ReopenSuggestionInput,
  type RouteDraftInput,
  type SaveDraftNoteInput,
  type SetDraftNoteActiveInput,
  type Suggestion,
  type SuggestionAuthor,
  type SuggestionStats,
  type MissionMasterInbox,
  type SystemDraftDecision,
  // ardud missions: finish-a
  type CommentInboxItemInput,
  type InboxComment,
  type InboxItemKind,
  type InboxItemRef,
  type InboxMark,
  type MissionInboxMarks,
  type SnoozeInboxItemInput,
  type UnsnoozeInboxItemInput,
  type WithdrawAskInput,
  type WithdrawDraftInput,
  RoomId,
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
import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import { castOf as readWholeCast, isMasterAnywhere } from "../core/master.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreKind, MissionStoreRecord } from "../store/recordIndex.ts";
import {
  answerAsk,
  askRef,
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
  draftDecisionNotice,
  draftExamples,
  draftRef,
  draftWriter,
  type DraftAbout,
  type DraftExample,
  notesFor,
  openSystemDraft,
  pullRequestKeyOf,
  recordDraftSent,
  reopenDraft,
  reportDraftSent,
  reviseDraft,
  routeDraft,
  routeDraftApprover,
  saveDraftNote,
  sendBackForComments,
  currentComments,
  submitDraft,
  systemDraftDecision,
  withdrawDraft,
} from "./draftModel.ts";
import { heldLane, heldRecords, heldWorkItem, type HeldRecord } from "./holds.ts";
import {
  attachComments,
  commentLines,
  commentsOn,
  decisionNoteOf,
  emptyMark,
  itemLabel,
  liveSnooze,
  markIdOf,
  stampOf,
  withComment,
  type WithComments,
} from "./inboxMarks.ts";
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
  callerActsAs,
  clipSummary,
  dedupeRefs,
  type MissionCaller,
  type MissionEventDraft as ModelEvent,
  type Outcome,
  refuse,
  sameActor,
} from "./shared.ts";
import {
  defaultAsker,
  isParticipant,
  masterThreadsIn,
  standingOf,
  type MissionCast,
  type Standing,
} from "./standing.ts";
import {
  acceptorFor,
  decideSuggestion,
  proposeSuggestion,
  recordOutcome,
  missionSuggestionStats,
  reopenSuggestion,
  suggestionStats,
  type SuggestionApplication,
} from "./suggestionModel.ts";

/**
 * The asks track over core's mission store: owner asks and their holds,
 * the master's calls and the owner's reactions, drafts with notes and edit
 * learning, and suggestions from every author.
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

export interface MissionDesk {
  readonly mission: Mission;
  readonly openAsks: ReadonlyArray<Ask>;
  /** Records waiting on an ask, and the line they show. Nothing else waits. */
  readonly held: ReadonlyArray<HeldRecord>;
  readonly pendingDrafts: ReadonlyArray<Draft>;
  readonly openSuggestions: ReadonlyArray<Suggestion>;
  readonly directionCheck: ReadonlyArray<DirectionCheckItem>;
  readonly lanes: ReadonlyArray<Pick<Lane, "id" | "name" | "status" | "statusReason">>;
  readonly latestSeq: number;
  /** ardud missions: finish-a - the owner's comments and holding snoozes on inbox items. */
  readonly marks: ReadonlyArray<InboxMark>;
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
    /** Per mission, source and target kind, with applied counts (null: every mission). */
    readonly missionSuggestionStats: (
      missionId: MissionId | null,
    ) => Fx<ReadonlyArray<SuggestionStats>>;
    /** What waits on the master instead of the owner (null: every mission). */
    readonly masterInbox: (missionId: MissionId | null) => Fx<MissionMasterInbox>;
    /** ardud missions: finish-a - comments and holding snoozes (null: every mission). */
    readonly inboxMarks: (missionId: MissionId | null) => Fx<MissionInboxMarks>;
    /** The records with the owner's comments on each (only those that have any). */
    readonly withComments: <
      R extends { readonly id: string; readonly missionId: MissionId | null },
    >(
      kind: InboxItemKind,
      records: ReadonlyArray<R>,
    ) => Fx<ReadonlyArray<WithComments<R>>>;
    readonly notes: (missionId: MissionId) => Fx<ReadonlyArray<Note>>;
    /** Who the caller is in a mission: its roles, lanes and whether it is the master. */
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
    /** The master takes back a waiting draft, whoever decides it, with a note the owner sees. */
    readonly withdrawDraft: (input: WithdrawDraftInput, provenance: MissionProvenance) => Fx<Draft>;
    /** The writer (or master) posted a thread draft's approved text: it is sent, once. */
    readonly recordDraftSent: (
      input: RecordDraftSentInput,
      provenance: MissionProvenance,
    ) => Fx<Draft>;
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
    // Notes and rooms
    readonly ackNote: (noteId: NoteId, provenance: MissionProvenance) => Fx<Note>;
    readonly post: (input: PostMessageInput, provenance: MissionProvenance) => Fx<MissionMessage>;
    // ardud missions: finish-a - the owner's own marks on inbox items; none decides anything
    readonly commentInboxItem: (
      input: CommentInboxItemInput,
      provenance: MissionProvenance,
    ) => Fx<InboxMark>;
    readonly snoozeInboxItem: (
      input: SnoozeInboxItemInput,
      provenance: MissionProvenance,
    ) => Fx<InboxMark>;
    readonly unsnoozeInboxItem: (
      input: UnsnoozeInboxItemInput,
      provenance: MissionProvenance,
    ) => Fx<InboxMark>;
  }
>()("t3/ardud/missions/asks/AsksService") {}

const fromOutcome = <A>(outcome: Outcome<A>): Fx<A> => Effect.fromResult(outcome);

const MASTER_INBOX_LIST_LIMIT = 50;

const newestOf = <T extends { readonly createdAt: string }>(items: ReadonlyArray<T>) =>
  items
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MASTER_INBOX_LIST_LIMIT);

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

/** Who speaks when asks itself posts into a room. */
const ASKS_SYSTEM: MissionProvenance = { _tag: "system", component: "asks" };

/** A notice's lead line followed by the owner's comments on the item. */
const commentsBody = (lead: string, comments: ReadonlyArray<InboxComment>): string =>
  [lead, "", "The owner's comments:", commentLines(comments)].join("\n");

/** The line the owner reads in his conversation about an ask once it is answered. */
const answeredNote = (ask: Ask): string => {
  const answer = ask.answer;
  const option =
    answer?.optionId == null ? undefined : ask.options.find((o) => o.id === answer.optionId);
  const said = [option?.label, answer?.text].filter((part) => part && part.length > 0).join(" - ");
  const how = answer?.onOwnerCondition == null ? "Answered" : "Answered on your condition";
  return `${how}: ${said}`;
};

const DRAFT_DECIDED: Partial<Record<Draft["status"], string>> = {
  approved: "Draft approved",
  dropped: "Draft dropped",
  "rewrite-requested": "Draft sent back for a rewrite",
};

const decidedNote = (draft: Draft): string =>
  `${DRAFT_DECIDED[draft.status] ?? `Draft ${draft.status}`}${(draft.onOwnerCondition ?? null) === null ? "" : " on your condition"}.`;

const NO_OWNER_CONDITIONS: OwnerConditions["Service"] = {
  verify: () =>
    fail("forbidden", "Owner conditions are not available on this server; the owner decides."),
  settleFor: () => Effect.void,
};

const replaceById = <R extends { readonly id: string }>(
  records: ReadonlyArray<R>,
  ...next: ReadonlyArray<R>
): R[] => {
  const ids = new Set(next.map((record) => record.id));
  return [...records.filter((record) => !ids.has(record.id)), ...next];
};

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const signals = yield* Ports.AsksSignals;
  const rooms = yield* Ports.AsksRooms;
  const appliers = yield* Ports.SuggestionApplierRegistry;
  const crypto = yield* Crypto.Crypto;
  // ardud missions: asks (discuss) - the router provides it; without it nothing verifies.
  const conditions = Option.getOrElse(
    yield* Effect.serviceOption(OwnerConditions),
    () => NO_OWNER_CONDITIONS,
  );
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

  // ardud missions: core - the whole cast, never a capped page of it
  const castOf = (missionId: MissionId) => readWholeCast(store, missionId);

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
   * A note the owner gives with a decision is a comment on the item, saved in
   * the decision's own commit. Returns every comment on the item (the note
   * last) for the decision's notices; a note from anyone else is refused.
   */
  const decisionComments = Effect.fn("AsksService.decisionComments")(function* (input: {
    readonly subject: InboxItemRef;
    readonly missionId: MissionId | null;
    readonly label: string;
    readonly note: string | undefined;
    readonly provenance: MissionProvenance;
    readonly at: string;
  }) {
    const body = yield* decisionNoteOf(input.note, input.provenance);
    const existing = yield* store.get("inbox-mark", markIdOf(input.subject));
    if (body === null) {
      return {
        comments: Option.match(existing, {
          onNone: (): ReadonlyArray<InboxComment> => [],
          onSome: (mark) => mark.comments,
        }),
        events: [] as ReadonlyArray<ModelEvent>,
        upserts: [] as ReadonlyArray<MissionStoreRecord>,
      };
    }
    const comment: InboxComment = { id: yield* newId("comment"), body, at: input.at };
    const record = withComment(existing, input.subject, input.missionId, comment);
    return {
      comments: record.comments,
      events: [
        markEvent(
          "inbox.commented",
          input.subject,
          clipSummary(input.label),
          `Comment: ${body}`,
          input.provenance,
          { commentId: comment.id, withDecision: true },
        ),
      ] as ReadonlyArray<ModelEvent>,
      upserts: [{ _tag: "inbox-mark", record }] as ReadonlyArray<MissionStoreRecord>,
    };
  });

  /**
   * One post to whoever acts on an item and the mission's master, carrying the
   * owner's comments. The master is skipped when it made the decision itself;
   * `notTo` drops anyone already told in another notice. A failure is logged.
   */
  const tellOfComments = Effect.fn("AsksService.tellOfComments")(
    function* (input: {
      readonly missionId: MissionId | null;
      readonly kind: "decision" | "request";
      readonly summary: string;
      readonly body: string;
      readonly key: string;
      readonly decidedBy: MissionProvenance | null;
      readonly to?: ReadonlyArray<MissionActor>;
      readonly notTo?: ReadonlyArray<MissionActor>;
      /** A knock to the master is the owner's alone until he forwards it. */
      readonly ownerOnly?: boolean;
    }) {
      const missionId = input.missionId;
      if (missionId === null) return;
      const cast = yield* castOf(missionId);
      const masterRoleId =
        cast.mission?.masterRoleId ?? cast.roles.find((role) => role.kind === "master")?.id ?? null;
      const decider = input.decidedBy;
      const skipMaster =
        input.ownerOnly === true ||
        (decider !== null &&
          decider._tag === "agent" &&
          masterRoleId !== null &&
          decider.roleId === masterRoleId);
      const recipients: MissionActor[] = [];
      const add = (actor: MissionActor) => {
        // Only members with a thread read the control room.
        if (actor._tag !== "role" && actor._tag !== "lane" && actor._tag !== "thread") return;
        if (recipients.some((held) => sameActor(held, actor))) return;
        if ((input.notTo ?? []).some((skip) => sameActor(skip, actor))) return;
        recipients.push(actor);
      };
      for (const actor of input.to ?? []) add(actor);
      if (masterRoleId !== null && !skipMaster) add({ _tag: "role", roleId: masterRoleId });
      if (recipients.length === 0) return;
      yield* rooms.post(
        {
          missionId,
          roomId: RoomId.make(`${missionId}:room:control`),
          kind: input.kind,
          summary: clipSummary(input.summary),
          body: input.body,
          to: recipients,
          key: input.key,
        },
        ASKS_SYSTEM,
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The owner's comments did not reach whoever acts", {
            key: input.key,
            cause,
          }),
        ),
      ),
  );

  /**
   * Owner provenance for a decision: the app session as is, or an iMessage the
   * transport already redeemed through the guard's inbound ledger (only the
   * iMessage bridge and the mission CLI may). An inbound id from anyone else is
   * refused here, before anything is looked up, so no adapter (MCP tools,
   * agents, other components) lifts one into the owner's word.
   */
  const ownerVoice = (command: {
    readonly provenance: MissionProvenance;
    readonly inboundId: string | undefined;
    readonly what: string;
  }): Fx<MissionProvenance> => {
    if (isOwnerProvenance(command.provenance) || command.inboundId === undefined) {
      return Effect.succeed(command.provenance);
    }
    return fromOutcome(
      refuse(
        "forbidden",
        `${command.what} by iMessage goes through the iMessage bridge or the mission CLI; this caller cannot redeem inbound ${command.inboundId}.`,
      ),
    );
  };

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

  const signalResolved = (
    ask: Ask,
    released: ReadonlyArray<MissionRecordRef>,
    comments: ReadonlyArray<InboxComment> = [],
  ) => signals.askResolved({ ask, released, ...(comments.length === 0 ? {} : { comments }) });

  /** The asker hears the comments with the answer; the master hears them here. */
  const tellOfAskComments = (result: {
    readonly ask: Ask;
    readonly comments: ReadonlyArray<InboxComment>;
    readonly decidedBy: MissionProvenance;
  }) =>
    result.comments.length === 0
      ? Effect.void
      : tellOfComments({
          missionId: result.ask.missionId,
          kind: "decision",
          summary: `The owner's comments on ask ${result.ask.question}`,
          body: commentsBody(answeredNote(result.ask), result.comments),
          key: `ask:${result.ask.id}:${result.ask.status}:${result.ask.updatedAt}:comments`,
          decidedBy: result.decidedBy,
          notTo: [result.ask.askedBy],
        });

  /** A note with a call reaction goes to whoever made the call and the master. */
  const tellOfCallNote = (call: Call, input: ReactToCallInput) => {
    const note = input.note?.trim() ?? "";
    if (note === "") return Effect.void;
    return Effect.flatMap(now, (at) =>
      tellOfComments({
        missionId: call.missionId,
        kind: "decision",
        summary: `The owner's note on call ${call.title}`,
        body: [
          `Call ${call.id}: ${call.title}. Reaction: ${call.ownerReaction ?? "cleared"}.`,
          "",
          "The owner's note:",
          `- ${note}`,
        ].join("\n"),
        key: `call:${call.id}:${call.ownerReaction ?? "none"}:${at}`,
        decidedBy: null,
        to: [call.decidedBy],
      }),
    );
  };

  const allDraftNotes = (missionId: MissionId | null) =>
    Effect.gen(function* () {
      const global = yield* store.list("draft-note", { missionId: null });
      const scoped = missionId === null ? [] : yield* store.list("draft-note", { missionId });
      return [...global, ...scoped];
    });

  const listWith = <K extends "ask" | "draft" | "suggestion">(kind: K, filter: ListFilter) =>
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
      let superseded: Ask | null = null;
      if (supersedes !== undefined) {
        const previous = asks.find((ask) => ask.id === supersedes);
        if (previous === undefined) return yield* fail("not-found", `No ask ${supersedes}.`);
        const result = yield* fromOutcome(
          supersedeAsk({ ask: previous, replacement: command, callerIsMaster: standing.isMaster }),
        );
        opened = result.replacement.record;
        superseded = result.superseded.record;
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
      return { opened, superseded };
    });

  const answerAskCommand = (input: AnswerAskInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const ask = yield* need("ask", input.askId);
      const voice = yield* ownerVoice({
        provenance,
        inboundId: input.inboundId,
        what: "Answering an ask",
      });
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const resolution = yield* fromOutcome(
        answerAsk({ ask, input, provenance: voice, asks, now: at }),
      );
      const noted = yield* decisionComments({
        subject: { kind: "ask", id: ask.id },
        missionId: ask.missionId,
        label: ask.question,
        note: input.note,
        provenance: voice,
        at,
      });
      const after = replaceById(asks, resolution.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(
        ask.missionId,
        [...resolution.events, ...noted.events],
        [{ _tag: "ask", record: resolution.record }, ...holds, ...noted.upserts],
      );
      return {
        ask: resolution.record,
        released: resolution.released,
        comments: noted.comments,
        decidedBy: voice,
      };
    });

  const withdrawAskCommand = (input: WithdrawAskInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const ask = yield* need("ask", input.askId);
      const { standing } = yield* standingIn(ask.missionId, provenance);
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const resolution = yield* fromOutcome(
        withdrawAsk({
          ask,
          caller: standing.caller,
          reason: input.reason,
          asks,
          callerIsMaster: standing.isMaster,
          now: at,
        }),
      );
      const after = replaceById(asks, resolution.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(ask.missionId, resolution.events, [
        { _tag: "ask", record: resolution.record },
        ...holds,
      ]);
      return {
        result: { ask: resolution.record, released: resolution.released },
        // The asker hears about it unless it withdrew the ask itself.
        tellAsker: !callerActsAs(standing.caller, ask.askedBy),
      };
    });

  /**
   * Discuss: the master answers an ask on a condition the owner stated in his
   * request about it. There is no owner voice to check; the router verifies the
   * quote against the owner's own words in that request instead.
   */
  const answerAskOnConditionCommand = (
    input: AnswerAskInput,
    condition: OwnerCondition,
    provenance: MissionProvenance,
  ) =>
    Effect.gen(function* () {
      if (input.inboundId !== undefined) {
        return yield* fail(
          "invalid",
          "An answer comes from the owner's message or on his condition, not both.",
        );
      }
      const ask = yield* need("ask", input.askId);
      const { standing } = yield* standingIn(ask.missionId, provenance);
      const asks = yield* store.list("ask", { missionId: ask.missionId });
      const at = yield* now;
      const resolution = yield* fromOutcome(
        answerAsk({
          ask,
          input,
          // Recorded under the master's role, never as the owner.
          provenance: standing.caller.provenance,
          asks,
          onOwnerCondition: condition,
          callerIsMaster: standing.isMaster,
          now: at,
        }),
      );
      yield* conditions.verify({ subject: askRef(ask), condition });
      const noted = yield* decisionComments({
        subject: { kind: "ask", id: ask.id },
        missionId: ask.missionId,
        label: ask.question,
        note: input.note,
        provenance: standing.caller.provenance,
        at,
      });
      const after = replaceById(asks, resolution.record);
      const holds = yield* syncHolds(ask.missionId, ask.blocks, after, at);
      yield* persist(
        ask.missionId,
        [...resolution.events, ...noted.events],
        [{ _tag: "ask", record: resolution.record }, ...holds, ...noted.upserts],
      );
      return {
        ask: resolution.record,
        released: resolution.released,
        comments: noted.comments,
        decidedBy: standing.caller.provenance,
      };
    });

  /** The conversation about a record closes with it; a failure there never undoes the decision. */
  const settleDiscussion = (subject: MissionRecordRef, note: string) =>
    conditions.settleFor({ subject, note }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Mission discussion did not settle", {
          subject: `${subject.kind}:${subject.id}`,
          detail: error.detail,
        }),
      ),
    );

  /**
   * One knock to the thread that wrote a decided draft, in the mission's
   * control room through the router: the decision, the approved text, any
   * note and every comment the owner left on it. Nobody is told when the
   * writer decided it itself; a failure is logged and never undoes the
   * decision. With comments the master hears them too.
   */
  const tellWriter = Effect.fn("AsksService.tellWriter")(
    function* (draft: Draft, allComments: ReadonlyArray<InboxComment>) {
      const writer = draftWriter(draft);
      const comments = currentComments(draft, allComments);
      const notice = draftDecisionNotice(draft, comments);
      if (notice === null) return;
      const decider = draft.decidedBy;
      const writerDecided =
        writer !== null &&
        decider !== null &&
        decider._tag === "agent" &&
        writer._tag === "role" &&
        decider.roleId === writer.roleId;
      if (writer !== null && !writerDecided) {
        yield* rooms.post(
          {
            missionId: draft.missionId,
            roomId: RoomId.make(`${draft.missionId}:room:control`),
            kind: "decision",
            summary: notice.summary,
            body: notice.body,
            to: [writer],
            key: `draft:${draft.id}:${draft.status}:${draft.revision ?? 0}`,
          },
          ASKS_SYSTEM,
        );
      }
      if (comments.length === 0) return;
      const label = clipSummary(itemLabel("draft", draft));
      const lead =
        (draft.requestedBy ?? null) !== null && draft.status === "rewrite-requested"
          ? `${decidedNote(draft)} ${draft.requestedBy} rewrites it with his comments before anything is posted.`
          : decidedNote(draft);
      yield* tellOfComments({
        missionId: draft.missionId,
        kind: "decision",
        summary: `The owner's comments on draft ${label}`,
        body: commentsBody(`Draft ${draft.id}: ${lead}`, comments),
        key: `draft:${draft.id}:${draft.status}:${draft.revision ?? 0}:comments`,
        decidedBy: decider,
        notTo: writer === null ? [] : [writer],
      });
    },
    (effect, draft) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Draft decision did not reach its writer", {
            draftId: draft.id,
            cause,
          }),
        ),
      ),
  );

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
   * name any: the owner, the master and mission-wide roles.
   */
  const ownLanes = (cast: MissionCast, standing: Standing): ReadonlySet<string> | null => {
    if (standing.caller.provenance._tag !== "agent" || standing.isMaster) return null;
    if (standing.roles.some((role) => role.laneId === null)) {
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
          `This thread holds no role or lane in mission ${input.missionId}.`,
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
          ...(input.view === undefined ? {} : { view: input.view }),
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
          callerIsMaster: standing.isMaster,
          notes: yield* allDraftNotes(draft.missionId),
          ...(input.view === undefined ? {} : { view: input.view }),
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
        what: "Deciding a draft",
      });
      // A master's decision is recorded under its role, never as the owner.
      const { standing } = yield* standingIn(draft.missionId, voice);
      const at = yield* now;
      const noted = yield* decisionComments({
        subject: { kind: "draft", id: draft.id },
        missionId: draft.missionId,
        label: itemLabel("draft", draft),
        note: input.note,
        provenance: voice,
        at,
      });
      const decided = yield* fromOutcome(
        decideDraft({
          draft,
          input,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
          comments: noted.comments,
          now: at,
        }),
      );
      yield* persist(
        draft.missionId,
        [...decided.events, ...noted.events],
        [{ _tag: "draft", record: decided.record }, ...noted.upserts],
      );
      // Only the owner's own edits teach the house style.
      const suggestions =
        decided.edit === null || !isOwnerProvenance(voice) ? [] : yield* learnFrom(draft.missionId);
      return { draft: decided.record, suggestions, comments: noted.comments };
    });

  /**
   * Discuss: the master decides an owner-routed draft on a condition the owner
   * stated in his request about it; the router verifies the quote.
   */
  const decideDraftOnConditionCommand = (
    input: DecideDraftInput,
    condition: OwnerCondition,
    provenance: MissionProvenance,
  ) =>
    Effect.gen(function* () {
      if (input.inboundId !== undefined) {
        return yield* fail(
          "invalid",
          "A decision comes from the owner's message or on his condition, not both.",
        );
      }
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const at = yield* now;
      const noted = yield* decisionComments({
        subject: { kind: "draft", id: draft.id },
        missionId: draft.missionId,
        label: itemLabel("draft", draft),
        note: input.note,
        provenance: standing.caller.provenance,
        at,
      });
      const decided = yield* fromOutcome(
        decideDraft({
          draft,
          input,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
          onOwnerCondition: condition,
          comments: noted.comments,
          now: at,
        }),
      );
      yield* conditions.verify({ subject: draftRef(draft), condition });
      yield* persist(draft.missionId, decided.events, [{ _tag: "draft", record: decided.record }]);
      // Only the owner's own edits teach the house style.
      return { draft: decided.record, suggestions: [], comments: noted.comments };
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

  const withdrawDraftCommand = (input: WithdrawDraftInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const withdrawn = yield* fromOutcome(
        withdrawDraft({
          draft,
          provenance: standing.caller.provenance,
          callerIsMaster: standing.isMaster,
          note: input.note,
          now: yield* now,
        }),
      );
      yield* persist(draft.missionId, withdrawn.events, [
        { _tag: "draft", record: withdrawn.record },
      ]);
      return withdrawn.record;
    });

  const recordDraftSentCommand = (input: RecordDraftSentInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const draft = yield* need("draft", input.draftId);
      const { standing } = yield* standingIn(draft.missionId, provenance);
      const comments = yield* commentsOn(store, { kind: "draft", id: draft.id });
      const sent = yield* fromOutcome(
        recordDraftSent({
          draft,
          caller: standing.caller,
          callerIsMaster: standing.isMaster,
          link: input.link ?? null,
          now: yield* now,
          ...(input.text === undefined ? {} : { text: input.text }),
          comments,
        }),
      );
      if (sent.events.length === 0) return sent.record;
      yield* persist(draft.missionId, sent.events, [{ _tag: "draft", record: sent.record }]);
      return sent.record;
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
      return systemDraftDecision(
        draft,
        input.head,
        yield* commentsOn(store, { kind: "draft", id: draft.id }),
      );
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
            ...(input.view === undefined ? {} : { view: input.view }),
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
    readonly comments: ReadonlyArray<InboxComment>;
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
      const noted = yield* decisionComments({
        subject: { kind: "suggestion", id: suggestion.id },
        missionId: suggestion.missionId,
        label: suggestion.title,
        note: input.note,
        provenance,
        at,
      });
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
      const committed = yield* persist(
        suggestion.missionId,
        [...events, ...noted.events],
        [{ _tag: "suggestion", record }, ...upserts, ...noted.upserts],
      );
      const pending: PendingApplication = {
        record,
        application,
        decisionId: committed.id,
        decider,
        comments: noted.comments,
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
        yield* tellOfSuggestionComments(pending);
        if (pending.application === null) return pending.record;
        return yield* applyDecided(pending, pending.application);
      }),
    );

  /** The master applies the change an accepted suggestion asks for, so it hears his comments. */
  const tellOfSuggestionComments = (pending: PendingApplication) =>
    pending.comments.length === 0
      ? Effect.void
      : tellOfComments({
          missionId: pending.record.missionId,
          kind: "decision",
          summary: `The owner's comments on suggestion ${pending.record.title}`,
          body: commentsBody(
            `Suggestion ${pending.record.id} is ${pending.record.status}.`,
            pending.comments,
          ),
          key: `suggestion:${pending.record.id}:${pending.record.status}:comments`,
          decidedBy: pending.decider,
        });

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

  // After a restart, an accepted suggestion with no outcome stopped between
  // its decision and its applier. What the sweep may do depends on the kind.
  const APPLIED_BEFORE_RESTART =
    "Applied before a restart: its change follows the decision on the timeline, but the server stopped before recording the outcome.";
  const PARTLY_BEFORE_RESTART =
    "Applied before a restart, possibly in part: the server stopped before recording the outcome. Check it, and suggest anything missing again.";
  const TOO_OLD_AFTER_RESTART =
    "Not applied: the server stopped before applying it, and the decision is more than a day old. Suggest it again if it still holds.";
  const RESTART_SWEEP_MAX_AGE_MS = 24 * 60 * 60_000;

  /**
   * Accepting these makes something once: a new rule, a lane split or a lane
   * merge, so running one twice does it twice. Every other applier sets
   * values, and running it again finishes what a crash cut short.
   */
  const runsOnce = (record: Suggestion): boolean => {
    if (record.targetKind === "rule") return record.target?.kind !== "rule";
    if (record.targetKind !== "lane") return false;
    const after = record.after;
    return (
      typeof after === "object" && after !== null && ("split" in after || "mergeInto" in after)
    );
  };

  /** Every event on a timeline, oldest first, a page at a time. */
  const eachEvent = (timeline: MissionId, visit: (event: MissionEvent) => void) =>
    Effect.gen(function* () {
      let afterSeq = 0;
      for (;;) {
        const page = yield* store.eventsSince(timeline, afterSeq, 500);
        for (const event of page) visit(event);
        const last = page.at(-1);
        if (last === undefined || page.length < 500) return;
        afterSeq = last.seq;
      }
    });

  /** The mission a lane change lands on, which a global suggestion doesn't name. */
  const laneMissionOf = (record: Suggestion) =>
    record.targetKind === "lane" && record.target?.kind === "lane"
      ? store
          .get("lane", record.target.id)
          .pipe(Effect.map((lane) => (Option.isSome(lane) ? lane.value.missionId : null)))
      : Effect.succeed(null);

  /**
   * Startup sweep. Claims the waiting suggestions under the asks lock, then
   * reads the timelines and applies outside it, so a live decision never
   * waits on the scan and a failed scan releases its claims.
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
        for (const suggestion of waiting) applying.add(suggestion.id);
        return waiting;
      }),
    );
    return yield* sweepClaimed(claimed).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const suggestion of claimed) applying.delete(suggestion.id);
        }),
      ),
    );
  });

  /**
   * A one-shot change counts as done when anything follows its decision,
   * on the suggestion's timeline or the lane's mission. A value-setting
   * change runs again. A decision more than a day old is not applied late.
   */
  const sweepClaimed = (claimed: ReadonlyArray<Suggestion>) =>
    Effect.gen(function* () {
      const timelineOf = (suggestion: Suggestion) => suggestion.missionId ?? GLOBAL_TIMELINE;
      const decisions = new Map<string, MissionEvent>();
      const decisionIds = new Set<string>();
      const followed = new Set<string>();
      const trace = (event: MissionEvent) => {
        if (event.causedBy !== null && decisionIds.has(event.causedBy)) {
          followed.add(event.causedBy);
        }
      };
      const own = new Map<MissionId, Set<string>>();
      for (const suggestion of claimed) {
        const ids = own.get(timelineOf(suggestion)) ?? new Set<string>();
        own.set(timelineOf(suggestion), ids.add(suggestion.id));
      }
      for (const [timeline, ids] of own) {
        yield* eachEvent(timeline, (event) => {
          if (
            event.kind === "suggestion.decided" &&
            event.subject?.kind === "suggestion" &&
            ids.has(event.subject.id)
          ) {
            decisions.set(event.subject.id, event);
            decisionIds.add(event.id);
          } else trace(event);
        });
      }
      const elsewhere = new Set<MissionId>();
      for (const suggestion of claimed) {
        const decision = decisions.get(suggestion.id);
        if (decision === undefined || followed.has(decision.id) || !runsOnce(suggestion)) continue;
        const landing = yield* laneMissionOf(suggestion);
        if (landing !== null && landing !== timelineOf(suggestion)) elsewhere.add(landing);
      }
      for (const timeline of elsewhere) yield* eachEvent(timeline, trace);

      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const swept: Suggestion[] = [];
      for (const record of claimed) {
        const decision = decisions.get(record.id);
        if (decision === undefined) {
          yield* Effect.logWarning(
            `missions: accepted suggestion ${record.id} has no decision event; left unapplied`,
          );
          continue;
        }
        const application: SuggestionApplication = {
          suggestion: record,
          targetKind: record.targetKind,
          target: record.target,
          after: record.after,
        };
        const pending: PendingApplication = {
          record,
          application,
          decisionId: decision.id,
          decider: record.decidedBy ?? decision.provenance,
          // The restart sweep only finishes the applier; the notice went with the decision.
          comments: [],
        };
        const done = followed.has(decision.id);
        const tooOld =
          nowMs - Date.parse(record.decidedAt ?? decision.at) > RESTART_SWEEP_MAX_AGE_MS;
        const settled =
          done && runsOnce(record)
            ? { outcome: APPLIED_BEFORE_RESTART, applied: true }
            : tooOld
              ? done
                ? { outcome: PARTLY_BEFORE_RESTART, applied: true }
                : { outcome: TOO_OLD_AFTER_RESTART, applied: false }
              : null;
        swept.push(
          settled === null
            ? yield* applyDecided(pending, application)
            : yield* serialized(recordApplied(pending, settled.outcome, settled.applied)),
        );
      }
      return swept;
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
          `This thread holds no role or lane in mission ${input.missionId}.`,
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
        directionCheck: directionCheck(calls, yield* store.ownerLastLookedAt(missionId)),
        lanes: lanes.map(({ id, name, status, statusReason }) => ({
          id,
          name,
          status,
          statusReason,
        })),
        latestSeq: yield* store.latestSeq(missionId),
        marks: (yield* inboxMarks(missionId)).marks,
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

  const masterInbox = (missionId: MissionId | null): Fx<MissionMasterInbox> =>
    Effect.gen(function* () {
      if (missionId !== null) yield* need("mission", missionId);
      const revision = yield* store.revision;
      const every = <K extends "draft" | "approval" | "suggestion">(
        kind: K,
        status: ReadonlyArray<string>,
      ) =>
        missionId === null
          ? store.listAll(kind, status)
          : store.listAllInMission(kind, missionId, status);
      const onMaster = <T extends Pick<Draft, "approver">>(items: ReadonlyArray<T>) =>
        items.filter((item) => approverOf(item) === "master");
      const drafts = onMaster(yield* every("draft", ["pending"]));
      const approvals = onMaster(yield* every("approval", ["pending"]));
      const suggestions = (yield* every("suggestion", ["open"])).filter(
        (suggestion) => suggestion.acceptor === "master",
      );
      return {
        revision,
        counts: { approve: drafts.length + approvals.length, suggestions: suggestions.length },
        drafts: newestOf(drafts),
        approvals: newestOf(approvals),
        suggestions: newestOf(suggestions),
      };
    });

  // -------------------------------------------------------------------------
  // ardud missions: finish-a - comments and snoozes on inbox items

  const markedItem = (subject: InboxItemRef, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (!isOwnerProvenance(provenance)) {
        return yield* fail("forbidden", "Only the owner comments on or snoozes inbox items.");
      }
      const record = yield* need(subject.kind, subject.id);
      const missionId: MissionId | null = record.missionId;
      const label = clipSummary(itemLabel(subject.kind, record));
      const existing = yield* store.get("inbox-mark", markIdOf(subject));
      return { record, missionId, label, existing };
    });

  const markEvent = (
    kind: "inbox.commented" | "inbox.snoozed" | "inbox.unsnoozed",
    subject: InboxItemRef,
    label: string,
    summary: string,
    provenance: MissionProvenance,
    payload: unknown,
  ): ModelEvent => ({
    kind,
    actor: { _tag: "owner" },
    provenance,
    summary: clipSummary(summary),
    subject: { kind: subject.kind, id: subject.id, label },
    payload,
  });

  const commentInboxItemCommand = (input: CommentInboxItemInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const item = yield* markedItem(input.subject, provenance);
      const at = yield* now;
      const mark = Option.getOrElse(item.existing, () =>
        emptyMark(input.subject, item.missionId, at),
      );
      const comment = { id: yield* newId("comment"), body: input.body, at };
      const record: InboxMark = { ...mark, comments: [...mark.comments, comment], updatedAt: at };
      // A system posts an approved draft's text as given, so a comment on one
      // that hasn't gone out sends it back to apply the comments first.
      const sentBack =
        input.subject.kind === "draft"
          ? sendBackForComments({
              draft: yield* need("draft", input.subject.id),
              comments: record.comments,
              provenance,
              now: at,
            })
          : null;
      // The requester reads a decided approval's note, not the inbox mark, so
      // a comment after the decision goes on that note too.
      const approval =
        input.subject.kind === "approval" ? yield* need("approval", input.subject.id) : null;
      const noted =
        approval === null || approval.status === "pending" || approval.status === "stale-closed"
          ? null
          : {
              ...approval,
              decisionNote: [approval.decisionNote, input.body]
                .filter((line): line is string => typeof line === "string" && line.length > 0)
                .join("\n"),
            };
      yield* persist(
        item.missionId,
        [
          markEvent(
            "inbox.commented",
            input.subject,
            item.label,
            `Comment: ${input.body}`,
            provenance,
            { commentId: comment.id },
          ),
          ...(sentBack?.events ?? []),
        ],
        [
          { _tag: "inbox-mark", record },
          ...(sentBack === null ? [] : [{ _tag: "draft" as const, record: sentBack.record }]),
          ...(noted === null ? [] : [{ _tag: "approval" as const, record: noted }]),
        ],
      );
      return { record, item, comment };
    });

  /**
   * A comment reaches whoever acts on the item (a draft's writer, an ask's
   * asker, where a knock went) and the master, in one post. It decides
   * nothing and opens no discussion. A failure is logged and keeps the comment.
   */
  /** Who acts on an item now, and the line telling them where it stands. */
  const whoActsOn = Effect.fn("AsksService.whoActsOn")(function* (
    subject: InboxItemRef,
  ): Effect.fn.Return<
    {
      readonly to: ReadonlyArray<MissionActor>;
      readonly lead: string;
      readonly current: (comments: ReadonlyArray<InboxComment>) => ReadonlyArray<InboxComment>;
      readonly ownerOnly?: boolean;
    },
    MissionError
  > {
    const ref = `${subject.kind} ${subject.id}`;
    const all = (comments: ReadonlyArray<InboxComment>) => comments;
    switch (subject.kind) {
      case "draft": {
        const draft = yield* need("draft", subject.id);
        const writer = draftWriter(draft);
        return {
          to: writer === null ? [] : [writer],
          lead: draftCommentLead(draft),
          current: (comments) => currentComments(draft, comments),
        };
      }
      case "ask": {
        const ask = yield* need("ask", subject.id);
        return {
          to: [ask.askedBy],
          lead:
            ask.status === "open"
              ? `Ask ${ask.id} is waiting on his answer: ${ask.question}`
              : `Ask ${ask.id} is ${ask.status}: ${ask.question}`,
          current: all,
        };
      }
      case "knock": {
        const knock = yield* need("knock", subject.id);
        // A knock to the master stays hidden from it until the owner forwards
        // it, so the target is the original one, not where it went.
        const toMaster =
          knock.status !== "forwarded" &&
          knock.targetThreadId !== undefined &&
          masterThreadsIn(yield* castOf(knock.missionId)).includes(knock.targetThreadId);
        return {
          to: knock.forwardedTo === null ? [] : [knock.forwardedTo],
          lead: `Knock ${knock.id} from ${knock.fromTitle} is ${knock.status}.`,
          current: all,
          ownerOnly: toMaster,
        };
      }
      case "approval": {
        const approval = yield* need("approval", subject.id);
        const decided = approval.status === "approved" || approval.status === "rejected";
        return {
          to: [],
          lead:
            approval.status === "pending"
              ? `Approval ${approval.id} is waiting on his decision: ${approval.title}`
              : `Approval ${approval.id} is ${approval.status}: ${approval.title}.${decided ? ` ${approval.requestedBy} reads the comment in the decision note.` : ""}`,
          current: all,
        };
      }
      default:
        return { to: [], lead: `The owner commented on ${ref}.`, current: all };
    }
  });

  const tellOfComment = Effect.fn("AsksService.tellOfComment")(
    function* (subject: InboxItemRef, mark: InboxMark, label: string) {
      const comment = mark.comments.at(-1);
      if (comment === undefined) return;
      const actor = yield* whoActsOn(subject);
      yield* tellOfComments({
        missionId: mark.missionId,
        kind: "request",
        summary: `The owner commented on ${subject.kind} ${label}`,
        body: commentsBody(actor.lead, actor.current(mark.comments)),
        key: `comment:${markIdOf(subject)}:${comment.id}`,
        decidedBy: null,
        to: actor.to,
        ownerOnly: actor.ownerOnly === true,
      });
    },
    // The comment is saved already; a failed notice must not fail the call and
    // invite a retry that saves it twice.
    (effect, subject) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The owner's comment did not reach whoever acts", {
            subject: markIdOf(subject),
            cause,
          }),
        ),
      ),
  );

  const draftCommentLead = (draft: Draft): string => {
    const ref = `Draft ${draft.id}`;
    const system = draft.requestedBy ?? null;
    switch (draft.status) {
      case "approved":
        return `${ref} is approved and not sent yet. Apply the owner's comments before you post it, then record it with mission_draft_sent, passing the text you posted.`;
      case "rewrite-requested":
        return system === null
          ? `${ref} is back for a rewrite. Apply the owner's comments in the new text.`
          : `${ref} went back to ${system} to apply the owner's comments; nothing is posted until he approves the new text.`;
      case "pending":
        return `${ref} is waiting on a decision.`;
      case "sent":
        return `${ref} already went out; the owner commented after.`;
      default:
        return `${ref} is ${draft.status}.`;
    }
  };

  const snoozeInboxItemCommand = (input: SnoozeInboxItemInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const item = yield* markedItem(input.subject, provenance);
      const at = yield* now;
      if (input.until !== null && !(input.until > at)) {
        return yield* fail("invalid", "Snooze until a time still ahead.");
      }
      const mark = Option.getOrElse(item.existing, () =>
        emptyMark(input.subject, item.missionId, at),
      );
      const record: InboxMark = {
        ...mark,
        snooze: { at, until: input.until, stamp: stampOf(item.record) },
        updatedAt: at,
      };
      yield* persist(
        item.missionId,
        [
          markEvent(
            "inbox.snoozed",
            input.subject,
            item.label,
            `Snoozed: ${item.label}`,
            provenance,
            { until: input.until },
          ),
        ],
        [{ _tag: "inbox-mark", record }],
      );
      return record;
    });

  const unsnoozeInboxItemCommand = (input: UnsnoozeInboxItemInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const item = yield* markedItem(input.subject, provenance);
      const mark = Option.getOrNull(item.existing);
      if (mark === null || mark.snooze === null) {
        return yield* fail("conflict", `${markIdOf(input.subject)} is not snoozed.`);
      }
      const at = yield* now;
      const record: InboxMark = { ...mark, snooze: null, updatedAt: at };
      yield* persist(
        item.missionId,
        [
          markEvent(
            "inbox.unsnoozed",
            input.subject,
            item.label,
            `Unsnoozed: ${item.label}`,
            provenance,
            null,
          ),
        ],
        [{ _tag: "inbox-mark", record }],
      );
      return record;
    });

  const inboxMarks = (missionId: MissionId | null): Fx<MissionInboxMarks> =>
    Effect.gen(function* () {
      const stored =
        missionId === null
          ? yield* store.listAll("inbox-mark")
          : yield* store.listAllInMission("inbox-mark", missionId);
      const at = yield* now;
      const marks: Array<InboxMark> = [];
      for (const mark of stored) {
        const { snooze } = yield* liveSnooze(store, mark, at);
        if (snooze === null && mark.comments.length === 0) continue;
        marks.push(snooze === mark.snooze ? mark : { ...mark, snooze });
      }
      return { marks };
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
    suggestionStats: () => store.listAll("suggestion").pipe(Effect.map(suggestionStats)),
    missionSuggestionStats: (missionId) =>
      store
        .listAll("suggestion")
        .pipe(Effect.map((suggestions) => missionSuggestionStats(suggestions, missionId))),
    masterInbox,
    notes: (missionId) => store.list("note", { missionId }),
    standing: (missionId, provenance) =>
      standingIn(missionId, provenance).pipe(Effect.map(({ standing }) => standing)),
    openAsk: (raw, provenance) =>
      serialized(openAskCommand(raw, provenance)).pipe(
        // A discussion about the old ask ends with it; the owner sees the revised one.
        Effect.tap(({ opened, superseded }) =>
          superseded === null
            ? Effect.void
            : settleDiscussion(askRef(superseded), `Revised as ask ${opened.id}.`),
        ),
        Effect.map(({ opened }) => opened),
      ),
    answerAsk: (input, provenance) =>
      serialized(
        input.onOwnerCondition === undefined
          ? answerAskCommand(input, provenance)
          : answerAskOnConditionCommand(input, input.onOwnerCondition, provenance),
      ).pipe(
        Effect.tap((result) => signalResolved(result.ask, result.released, result.comments)),
        Effect.tap((result) => tellOfAskComments(result)),
        Effect.tap((result) => settleDiscussion(askRef(result.ask), answeredNote(result.ask))),
        Effect.map(({ ask, released }) => ({ ask, released })),
      ),
    withdrawAsk: (input, provenance) =>
      serialized(withdrawAskCommand(input, provenance)).pipe(
        Effect.tap(({ result, tellAsker }) =>
          tellAsker ? signalResolved(result.ask, result.released) : Effect.void,
        ),
        Effect.tap(({ result }) =>
          settleDiscussion(askRef(result.ask), `Ask withdrawn: ${input.reason}`),
        ),
        Effect.map(({ result }) => result),
      ),
    reopenAsk: (input, provenance) => serialized(reopenAskCommand(input, provenance)),
    makeCall: (input, provenance) => serialized(makeCallCommand(input, provenance)),
    reactToCall: (input, provenance) =>
      serialized(reactToCallCommand(input, provenance)).pipe(
        Effect.tap((call) => tellOfCallNote(call, input)),
      ),
    submitDraft: (input, provenance) => serialized(submitDraftCommand(input, provenance)),
    reviseDraft: (input, provenance) => serialized(reviseDraftCommand(input, provenance)),
    decideDraft: (input, provenance) =>
      serialized(
        input.onOwnerCondition === undefined
          ? decideDraftCommand(input, provenance)
          : decideDraftOnConditionCommand(input, input.onOwnerCondition, provenance),
      ).pipe(
        // A rewrite sends the draft back for another round; the discussion stays open.
        Effect.tap((result) =>
          result.draft.status === "rewrite-requested"
            ? Effect.void
            : settleDiscussion(draftRef(result.draft), decidedNote(result.draft)),
        ),
        Effect.tap((result) => tellWriter(result.draft, result.comments)),
        Effect.map(({ draft, suggestions }) => ({ draft, suggestions })),
      ),
    reopenDraft: (input, provenance) => serialized(reopenDraftCommand(input, provenance)),
    withdrawDraft: (input, provenance) =>
      serialized(withdrawDraftCommand(input, provenance)).pipe(
        Effect.tap((draft) => settleDiscussion(draftRef(draft), `Withdrawn: ${input.note}`)),
        Effect.tap((draft) => tellWriter(draft, [])),
      ),
    recordDraftSent: (input, provenance) => serialized(recordDraftSentCommand(input, provenance)),
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
    ackNote: (noteId, provenance) => serialized(ackNoteCommand(noteId, provenance)),
    post: postCommand,
    // ardud missions: finish-a
    inboxMarks,
    // ardud missions: r22 comments
    withComments: (kind, records) => attachComments(store, kind, records),
    commentInboxItem: (input, provenance) =>
      serialized(commentInboxItemCommand(input, provenance)).pipe(
        Effect.tap(({ record, item }) => tellOfComment(input.subject, record, item.label)),
        Effect.map(({ record }) => record),
      ),
    snoozeInboxItem: (input, provenance) => serialized(snoozeInboxItemCommand(input, provenance)),
    unsnoozeInboxItem: (input, provenance) =>
      serialized(unsnoozeInboxItemCommand(input, provenance)),
  });
});

export const layer = Layer.effect(AsksService, make);

/**
 * The service with this server's ports: iMessage lookups against the bridge
 * and Moni's chat. Rooms and answer signals come from the router
 * (missions/layer.ts); suggestion appliers register into the registry from the
 * tracks that own them (see wiring.ts).
 */
export const layerLive = layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Inbound.layer, Ports.applierRegistry)),
);
