import {
  KnockId,
  isOwnerProvenance,
  MissionError,
  MissionId,
  MissionMessageId,
  RoomId,
  SubscriptionId,
  ThreadId,
  type CoordEventRef,
  type DecideKnockInput,
  type InboxComment, // ardud missions: r22 comments
  type Knock,
  type MarkReadInput,
  type MessageBodyInput,
  type MissionActor,
  type MissionAttention,
  type MissionAttentionInput,
  type MissionMessage,
  type MissionMemberPrincipal,
  type MissionMessageBody,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type MissionRoomActivity,
  type MissionRoomActivityInput,
  type OpenOwnerRequestInput,
  type OwnerCondition,
  type OwnerRequest,
  type OwnerRequests,
  type OwnerRequestsInput,
  type PostMessageInput,
  type ReadPosition,
  type ReopenOwnerRequestInput,
  type ReplyOwnerRequestInput,
  type Room,
  type RoomPage,
  type RoomPageInput,
  type RoomTuning,
  type RoomTuningInput,
  type SetMissionMemberInput,
  type SettleOwnerRequestInput,
  type SubscribeRoomInput,
  type Subscription,
  type TuneRoomInput,
  type UpdateRoomInput,
  type WorkItem,
  type CreateRoomInput, // ardud missions: router
  type RespondMissionApprovalInput, // ardud missions: permissions
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { clipSummary } from "../asks/shared.ts";
import {
  commentLines,
  commentsOn,
  decisionNoteOf,
  markIdOf,
  withComment,
} from "../asks/inboxMarks.ts"; // ardud missions: r22 comments
import { actorOf } from "../core/provenance.ts";
import type { GuardPrincipal } from "../guard/principal.ts";
import * as MissionStore from "../store/MissionStore.ts";
import {
  actorsOfThread,
  broadcastAudience,
  heldBy,
  itemWatchers,
  labelOf,
  leadTiersOf,
  masterRoleOf,
  masterThreadsOf,
  readCast,
  recordMembership,
  threadsOfActor,
  type RouterCast,
} from "./cast.ts";
import { roomActivity } from "./activity.ts";
import { LEAD_QUESTION_PRODUCER, leadQuestionKey, leadQuestionText } from "./leadQuestions.ts";
import { LEAD_APPROVAL_PRODUCER, leadApprovalKey, leadApprovalText } from "./leadApprovals.ts";
import type { SendCheckRequest, SendGuardOutcome, SendGuardRequest } from "./guardHook.ts";
import { postContentHash, sha256 } from "./hash.ts";
import {
  actorKey,
  decideSend,
  defaultWakeOn,
  doorbellAction,
  noiseFor,
  NOISE_WINDOW_MS,
  receiptFor,
  receiptRecipients,
  sameActor,
  senderLabel,
  wakeLine,
  wakeRequestId,
  wakeTargets,
  type GuardDecision,
  type Member,
  type MemberKind,
  type SendSender,
} from "./model.ts";
import { RouterThreads, type ThreadFacts } from "./ports.ts";
import {
  REMIND_AFTER_MS,
  REMIND_GAP_MS,
  reminderDue,
  reminderLine,
  reminderRequestId,
} from "./reminders.ts";
import { RequestImages, requestImagesRegistry } from "./requestImages.ts";
import { makeOwnerRequests, readsRequestWords, type RequestCommit } from "./requests.ts";
import { requestIdOfRoom } from "./requestsModel.ts";
import { RouterStore, type DeliveryRow, type RecipientRow } from "./RouterStore.ts";

/** One unread message waiting for a thread, as `mission_inbox` shows it. */
export interface InboxEntry {
  readonly roomTitle: string;
  readonly message: MissionMessage;
  readonly body: string | null;
  /** On an owner request's newest entry: the request's whole conversation. */
  readonly requestContext?: string;
}

export interface AgentInbox {
  readonly threadId: ThreadId;
  readonly unread: number;
  readonly entries: ReadonlyArray<InboxEntry>;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const INBOX_MAX = 30;
/** Owner requests whose whole conversation one wake carries. */
const WAKE_REQUESTS_MAX = 3;
const ATTENTION_MAX = 200;
const LIVE_MISSIONS: ReadonlySet<string> = new Set(["active", "paused", "draining"]);
const MEMBER_RANK: Record<MemberKind, number> = { master: 0, created: 1, attached: 2, service: 3 };

const fail = (code: MissionError["code"], detail: string) => new MissionError({ code, detail });
const KNOCK_COMMENTS = { _tag: "system", component: "knocks" } as const;
// ardud missions: r22 comments (forwards whose send failed are retried this long after the decision)
const KNOCK_DELIVERY = KNOCK_COMMENTS;
const REDELIVER_WINDOW_DAYS = 7;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Standard rooms a post may create on first use: control, release, arch, per sub-mission, per work item. */
const ROOM_MARK = ":room:";

const standardRoom = (missionId: MissionId, roomId: RoomId) => {
  const prefix = `${missionId}${ROOM_MARK}`;
  if (!roomId.startsWith(prefix)) return null;
  const rest = roomId.slice(prefix.length);
  if (rest === "control") return { kind: "control", title: "Control" } as const;
  if (rest === "release") return { kind: "release", title: "Release" } as const;
  if (rest === "arch") return { kind: "arch", title: "Architecture" } as const;
  if (rest.startsWith("sub:")) return { kind: "sub-mission", id: rest.slice(4) } as const;
  if (rest.startsWith("item:")) return { kind: "work-item", id: rest.slice(5) } as const;
  return null;
};

export const controlRoomId = (missionId: MissionId) => RoomId.make(`${missionId}:room:control`);

/** The member-table key for a coord actor the `coord` component may act as. */
export const coordMemberPrincipal = (actor: string) => `coord:${actor}`;

const memberRowOf = (
  principal: MissionMemberPrincipal,
): { readonly principal: string; readonly label: string | null; readonly kind: MemberKind } => {
  switch (principal._tag) {
    case "thread":
      return { principal: `thread:${principal.threadId}`, label: null, kind: "attached" };
    case "session":
      return {
        principal: `session:${principal.sessionId}`,
        label: principal.label,
        kind: "service",
      };
    case "coord":
      return {
        principal: coordMemberPrincipal(principal.actor),
        label: principal.actor,
        kind: "service",
      };
  }
};

/**
 * A thread made by the owner or by this mission's current master is the
 * master's own. After a master handoff the old master thread is no longer a
 * member, so neither are the threads it forked; the new master enrols any it
 * keeps.
 */
const sponsoredBy = (cast: RouterCast, creator: GuardPrincipal | null): boolean =>
  creator !== null &&
  (creator._tag === "owner" ||
    (creator._tag === "thread" && masterThreadsOf(cast).includes(creator.threadId)));

/** The thread an agent provenance speaks for; null for everyone else. */
const actingThread = (provenance: MissionProvenance): ThreadId | null =>
  provenance._tag === "agent" ? provenance.threadId : null;

export type ThreadReadiness = "idle" | "busy" | "gone";

/** A system producer's notice for one thread (see `MissionRouter.notify`). */
export interface SystemNotice {
  readonly threadId: ThreadId;
  readonly text: string;
  /** Stable per notice: a retry with the same key is delivered once. */
  readonly key: string;
  /** The producing component, e.g. `stream-recovery`; the post's author. */
  readonly producer: string;
  /**
   * Queue the text straight onto the thread, member or not, so it lands after
   * the running turn instead of waiting in a room for a doorbell.
   */
  readonly queue?: boolean;
}

export type SystemNoticeOutcome =
  | {
      readonly _tag: "posted";
      readonly missionId: MissionId;
      readonly roomId: RoomId;
      readonly messageId: MissionMessageId;
      readonly seq: number;
    }
  | { readonly _tag: "sent" };

/**
 * A post from a trusted server component that already resolved who is
 * speaking (the coord shim). Not reachable from MCP or WS.
 */
export interface RelayRequest {
  readonly input: PostMessageInput;
  readonly provenance: MissionProvenance;
  readonly author: MissionActor;
  readonly authorThread: ThreadId | null;
  readonly coord?: CoordEventRef;
  /** Written in the message's own transaction (the master feed's cursor): both land or neither. */
  readonly alongside?: Effect.Effect<void, MissionError>;
}

/** Provenance for a guarded sender, from the transport context only. */
const senderProvenance = (from: SendSender): MissionProvenance => {
  switch (from._tag) {
    case "owner":
      return from.provenance;
    case "thread":
      return { _tag: "agent", threadId: from.threadId, roleId: null };
    case "session":
      return { _tag: "system", component: `control-api:${from.subject}` };
    case "mcp-client":
      return { _tag: "system", component: `mcp-client:${from.label}` };
    case "schedule":
      return { _tag: "system", component: `schedule:${from.scheduledTaskId}` };
  }
};

/** What a knock records as its sender when the sender is not a thread. */
const knockSender = (
  from: SendSender,
): { readonly id: ThreadId; readonly kind: Knock["senderKind"] } => {
  switch (from._tag) {
    case "thread":
      return { id: from.threadId, kind: "thread" };
    case "session":
      return { id: ThreadId.make(`control-api:${from.subject}`), kind: "session" };
    case "mcp-client":
      return { id: ThreadId.make(`mcp-client:${from.label}`), kind: "mcp-client" };
    case "schedule":
      return { id: ThreadId.make(`schedule:${from.scheduledTaskId}`), kind: "schedule" };
    case "owner":
      return { id: ThreadId.make("owner"), kind: undefined };
  }
};

/**
 * Rooms, messages, read positions, doorbells and the send guard for every
 * mission. Posts and reads come from the WS/MCP transports with provenance
 * the transport derived; nothing here trusts a caller-supplied identity.
 */
export class MissionRouter extends Context.Service<
  MissionRouter,
  {
    readonly rooms: (
      missionId: MissionId,
      provenance: MissionProvenance,
    ) => Effect.Effect<ReadonlyArray<Room>, MissionError>;
    readonly roomPage: (
      input: RoomPageInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<RoomPage, MissionError>;
    readonly messageBody: (
      input: MessageBodyInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionMessageBody, MissionError>;
    readonly post: (
      input: PostMessageInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionMessage, MissionError>;
    /** Read position = ack. Moves forward only. */
    readonly markRead: (
      input: MarkReadInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<ReadPosition, MissionError>;
    readonly subscribe: (
      input: SubscribeRoomInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<Subscription, MissionError>;
    /** Attach a thread or register a service session (owner or master). */
    readonly setMember: (
      input: SetMissionMemberInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionMutationResult, MissionError>;
    readonly decideKnock: (
      input: DecideKnockInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<Knock, MissionError>;
    /**
     * Pending knocks the caller may decide: all of them for the owner, and for
     * the master only those not addressed to a master thread.
     */
    readonly knocks: (
      missionId: MissionId,
      provenance: MissionProvenance,
    ) => Effect.Effect<ReadonlyArray<Knock>, MissionError>;
    /** Unread messages delivered to a thread, oldest first, bounded. */
    readonly inbox: (threadId: ThreadId) => Effect.Effect<AgentInbox, MissionError>;
    /** The send guard. Every path into a thread calls this through guardHook. */
    readonly guard: (request: SendGuardRequest) => Effect.Effect<SendGuardOutcome, MissionError>;
    /** The guard's decision without acting on it: nothing is posted, knocked or logged. */
    readonly checkSend: (request: SendCheckRequest) => Effect.Effect<GuardDecision, MissionError>;
    /** Ring, fold or hold a thread's doorbell for its unread deliveries. */
    readonly poke: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /** A run on the thread ended: clear its outstanding wake and look again. */
    readonly settled: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /**
     * Whether a thread can take a notice now: `gone` when it no longer exists
     * or is archived, `idle` when no turn is running, else `busy` (also when
     * it cannot be read).
     */
    readonly readiness: (threadId: ThreadId) => Effect.Effect<ThreadReadiness>;
    /**
     * Delivers a system producer's notice (recovery's continuation notices).
     * A mission member gets it as a control-room request addressed to it,
     * posted as the producer, and its doorbell rings when it is free. Any
     * other thread, or any notice sent with `queue`, gets the text queued
     * directly. `key` makes retries land once: a retry takes the first
     * attempt's path, whatever the thread's membership is by then. A gone
     * thread fails `not-found`.
     */
    readonly notify: (notice: SystemNotice) => Effect.Effect<SystemNoticeOutcome, MissionError>;
    // --- routing additions ---
    /**
     * A role or lane thread asked a question: tells its nearest live leads
     * (see `leadTiersOf`) through `notify`, once per lead. Returns the leads
     * told; empty when the thread has no lead (the master, a thread outside
     * every mission) or the question is no longer pending.
     */
    readonly questionRaised: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<ReadonlyArray<ThreadId>, MissionError>;
    // --- end routing additions ---
    // --- permissions additions ---
    /**
     * A role or lane thread asked for permission (a command, a file write, an
     * MCP elicitation...): tells its nearest live leads, like `questionRaised`.
     */
    readonly approvalRaised: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<ReadonlyArray<ThreadId>, MissionError>;
    /**
     * A lead answers a pending permission request of a thread it leads (any
     * lead tier, the master included), or of a thread a lane or role thread
     * delegated (that thread first, then its leads). Anyone else, or the asking thread
     * itself, is refused `forbidden`; a request no longer pending is
     * `not-found`. Logged as an allowed `send.guarded` with reason `lead`.
     */
    readonly approvalRespond: (
      input: RespondMissionApprovalInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly requestId: string;
        readonly decision: RespondMissionApprovalInput["decision"];
      },
      MissionError
    >;
    // --- end permissions additions ---
    // --- r22 fixes ---
    /**
     * Whether a thread's questions and permission requests go to a lead
     * (`questionRaised`, `approvalRaised`): a lane or role thread, or a thread
     * one of them delegated. The Telegram bridge reads it to leave those to
     * the leads instead of alerting the owner.
     */
    readonly leadRouted: (threadId: ThreadId) => Effect.Effect<boolean, MissionError>;
    // --- end r22 fixes ---
    /**
     * Posts for a trusted server component that resolved the speaker itself
     * (the coord shim). Same rules as `post` after that: dense seqs, key
     * idempotency, in-mission recipients, the doorbell.
     */
    readonly relay: (
      request: RelayRequest,
    ) => Effect.Effect<{ readonly message: MissionMessage; readonly fresh: boolean }, MissionError>;
    /** A room's mute flag and subscriptions, for any reader of the mission. */
    readonly roomTuning: (
      input: RoomTuningInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<RoomTuning, MissionError>;
    /** Owner or master: mute a room and set wake rules for its subscribers, as one event. */
    readonly tuneRoom: (
      input: TuneRoomInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<RoomTuning, MissionError>;
    // --- finish-b ---
    /** Owner or master: rename a room, move it to another sub-mission, or remove and restore it. */
    readonly updateRoom: (
      input: UpdateRoomInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<Room, MissionError>;
    // --- end finish-b ---
    // --- router: createRoom ---
    /** Owner or master: open a room under `<missionId>:room:<slug>`, or return the one already there. */
    readonly createRoom: (
      input: CreateRoomInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<Room, MissionError>;
    // --- end router: createRoom ---
    /**
     * One reminder for each idle thread holding deliveries unread for over 30
     * minutes, at most one per thread per 30 minutes; a delivery is reminded
     * once. Returns how many threads were reminded.
     */
    readonly remind: Effect.Effect<number>;
    /**
     * Sends forwarded knocks whose delivery has not landed (a crash or refused
     * send after the decision committed), with the saved text and keys.
     * Returns how many were delivered.
     */
    readonly redeliverForwards: Effect.Effect<number>;
    /**
     * Holds wakes and reminders after a restart, so recovery can scan before
     * router traffic starts lanes. Pokes are remembered and replayed on
     * release. Only the first call holds; later calls do nothing.
     */
    readonly holdDoorbells: Effect.Effect<void>;
    /** Ends the boot hold and pokes every thread that asked meanwhile. Idempotent. */
    readonly releaseDoorbells: Effect.Effect<void>;
    /** Owner or master: deliveries still unread after their one reminder. */
    readonly attention: (
      input: MissionAttentionInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionAttention, MissionError>;
    /**
     * The owner's requests. Words only for the owner, the master and the
     * iMessage bridge; `ownerSession` marks an owner-paired desk read.
     */
    readonly ownerRequests: (
      input: OwnerRequestsInput,
      provenance: MissionProvenance,
      ownerSession?: boolean,
    ) => Effect.Effect<OwnerRequests, MissionError>;
    /** The owner asks the master, or the master opens one quoting the owner. */
    readonly openRequest: (
      input: OpenOwnerRequestInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<OwnerRequest, MissionError>;
    readonly replyRequest: (
      input: ReplyOwnerRequestInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<OwnerRequest, MissionError>;
    readonly settleRequest: (
      input: SettleOwnerRequestInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<OwnerRequest, MissionError>;
    readonly reopenRequest: (
      input: ReopenOwnerRequestInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<OwnerRequest, MissionError>;
    // --- fix-p3 ---
    /** The board's day line and since-tally, counted from room messages. */
    readonly roomActivity: (
      input: MissionRoomActivityInput,
      provenance: MissionProvenance,
    ) => Effect.Effect<MissionRoomActivity, MissionError>;
    // --- end fix-p3 ---
    /** Discuss: the owner's condition is in his request about the record. */
    readonly verifyOwnerCondition: (input: {
      readonly subject: MissionRecordRef;
      readonly condition: OwnerCondition;
    }) => Effect.Effect<void, MissionError>;
    /** Discuss: the record is decided, so the conversation about it settles. */
    readonly settleRequestsFor: (input: {
      readonly subject: MissionRecordRef;
      readonly note: string | null;
    }) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/router/MissionRouter") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const rooms = yield* RouterStore;
  const threads = yield* RouterThreads;
  const images = yield* RequestImages;
  const postLock = yield* Semaphore.make(1);
  const bellLock = yield* Semaphore.make(1);
  // Boot hold (recovery): see holdDoorbells. Read and released under bellLock.
  let bootHold: "open" | "holding" | "released" = "open";
  const heldPokes = new Set<ThreadId>();

  const loadCast = (missionId: MissionId): Effect.Effect<RouterCast, MissionError> =>
    readCast(store, missionId);

  const loadRoom = (roomId: RoomId) =>
    Effect.gen(function* () {
      const room = yield* rooms.room(roomId);
      if (room === null) return yield* fail("not-found", `No room ${roomId}.`);
      return room;
    });

  // ---------------------------------------------------------------------------
  // Membership

  const explicitMembers = (threadId: ThreadId) => rooms.membersByPrincipal(`thread:${threadId}`);

  /**
   * Every live mission that could count the thread as a member: missions
   * whose records name it (role bindings, lanes) and missions holding
   * an explicit member row for it. Both lookups are complete indexed reads
   * keyed by the thread, never a capped list of missions. A record naming a
   * mission that is not there fails the lookup: the thread may well belong to
   * it, so the guard refuses rather than treat the thread as an outsider. A
   * mission that loads and is archived is skipped, as before.
   */
  const candidateCasts = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ids = new Set<MissionId>(yield* store.missionsOfThread(threadId));
      for (const row of yield* explicitMembers(threadId)) ids.add(row.missionId);
      const casts: RouterCast[] = [];
      for (const id of [...ids].toSorted()) {
        const cast = yield* loadCast(id);
        if (cast.mission === null) {
          return yield* fail(
            "conflict",
            `Thread ${threadId} is recorded in mission ${id}, which cannot be found.`,
          );
        }
        if (LIVE_MISSIONS.has(cast.mission.status)) casts.push(cast);
      }
      return casts;
    });

  /** Which missions a membership lookup considers for a thread. */
  type CastScope = (threadId: ThreadId) => Effect.Effect<ReadonlyArray<RouterCast>, MissionError>;
  const within =
    (cast: RouterCast): CastScope =>
    () =>
      Effect.succeed([cast]);
  const everywhere: CastScope = candidateCasts;
  const elsewhere =
    (missionId: MissionId): CastScope =>
    (threadId) =>
      candidateCasts(threadId).pipe(
        Effect.map((casts) => casts.filter((cast) => cast.missionId !== missionId)),
      );

  const pickMember = (candidates: ReadonlyArray<Member>): Member | null =>
    [...candidates].sort((a, b) => MEMBER_RANK[a.kind] - MEMBER_RANK[b.kind])[0] ?? null;

  const directMembership = (casts: ReadonlyArray<RouterCast>, threadId: ThreadId) =>
    Effect.gen(function* () {
      const candidates: Member[] = [];
      for (const cast of casts) {
        const kind = recordMembership(cast, threadId);
        if (kind !== null) candidates.push({ missionId: cast.missionId, threadId, kind });
      }
      for (const row of yield* explicitMembers(threadId)) {
        if (casts.some((cast) => cast.missionId === row.missionId)) {
          candidates.push({ missionId: row.missionId, threadId, kind: row.kind });
        }
      }
      return pickMember(candidates);
    });

  /**
   * Direct membership, or `created` when the thread descends from the master
   * or one of its threads and its recorded creator is the owner or that
   * mission's master. Lineage alone proves nothing: a lane forking itself, a
   * subagent child or a legacy fork with no recorded creator is not the
   * master's own (the master can still enrol it with `mission_set_member`).
   * A thread whose lineage cannot be read fails the lookup rather than
   * counting as an outsider, so the guard fails closed.
   */
  const membershipIn = (scope: CastScope, threadId: ThreadId) =>
    Effect.gen(function* () {
      const direct = yield* directMembership(yield* scope(threadId), threadId);
      if (direct !== null) return direct;
      const facts = yield* threads.facts(threadId);
      if (facts === null) return null;
      let creator: GuardPrincipal | null | undefined;
      for (const ancestor of [facts.parentThreadId, facts.rootThreadId]) {
        if (ancestor === null || ancestor === threadId) continue;
        const ancestorCasts = yield* scope(ancestor);
        const parent = yield* directMembership(ancestorCasts, ancestor);
        if (parent === null || (parent.kind !== "master" && parent.kind !== "created")) continue;
        if (creator === undefined) creator = yield* threads.creator(threadId);
        const cast = ancestorCasts.find((each) => each.missionId === parent.missionId);
        if (cast !== undefined && sponsoredBy(cast, creator)) {
          return { missionId: parent.missionId, threadId, kind: "created" } satisfies Member;
        }
      }
      return null;
    });

  /** Agents may read and post only in missions they belong to. */
  const requireReader = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (provenance._tag === "import") {
        return yield* fail("provenance-invalid", "Imports do not read or post through the router.");
      }
      if (provenance._tag !== "agent") return;
      const member = yield* membershipIn(within(yield* loadCast(missionId)), provenance.threadId);
      if (member === null) {
        return yield* fail(
          "forbidden",
          `Thread ${provenance.threadId} is not a member of mission ${missionId}.`,
        );
      }
    });

  const isMaster = (cast: RouterCast, provenance: MissionProvenance) =>
    provenance._tag === "agent" && masterThreadsOf(cast).includes(provenance.threadId);

  /** A room's reader; an owner request's room is the owner's and the master's alone. */
  const requireRoomReader = (room: Room, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      yield* requireReader(room.missionId, provenance);
      if (room.kind !== "owner-request" || provenance._tag !== "agent") return;
      if (!isMaster(yield* loadCast(room.missionId), provenance)) {
        return yield* fail(
          "forbidden",
          "Owner requests are between the owner and the mission's master.",
        );
      }
    });

  /** A request room's words: the owner, the master and the iMessage bridge read them. */
  const requireWordsReader = (room: Room, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      yield* requireRoomReader(room, provenance);
      if (room.kind !== "owner-request" || provenance._tag === "agent") return;
      if (!readsRequestWords(provenance)) {
        return yield* fail("forbidden", "Only the owner and the master read an owner request.");
      }
    });

  /** Request rooms have no subscribers or tuning: the owner's words always reach the master. */
  const refuseRequestRoom = (room: Room) =>
    room.kind === "owner-request"
      ? Effect.fail(fail("invalid", "An owner request's room takes no subscriptions or tuning."))
      : Effect.void;

  /**
   * Every actor a message, subscription or forward names must belong to the
   * mission: threads are members, roles and lanes exist in it. Owner, people
   * and system components have no thread, so nothing reaches past the mission.
   */
  const requireInMission = (cast: RouterCast, actors: ReadonlyArray<MissionActor>) =>
    Effect.forEach(
      actors,
      (actor) =>
        Effect.gen(function* () {
          switch (actor._tag) {
            case "thread": {
              if ((yield* membershipIn(within(cast), actor.threadId)) === null) {
                return yield* fail(
                  "forbidden",
                  `Thread ${actor.threadId} is not a member of mission ${cast.missionId}.`,
                );
              }
              return;
            }
            case "role":
              if (!cast.roles.some((role) => role.id === actor.roleId)) {
                return yield* fail("not-found", `No role ${actor.roleId} in ${cast.missionId}.`);
              }
              return;
            case "lane":
              if (!cast.lanes.some((lane) => lane.id === actor.laneId)) {
                return yield* fail("not-found", `No lane ${actor.laneId} in ${cast.missionId}.`);
              }
              return;
            default:
              return;
          }
        }),
      { discard: true },
    );

  // ---------------------------------------------------------------------------
  // Rooms

  const ensureRoom = (missionId: MissionId, roomId: RoomId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const existing = yield* rooms.room(roomId);
      if (existing !== null) {
        if (existing.missionId !== missionId) {
          return yield* fail("invalid", `Room ${roomId} is not in mission ${missionId}.`);
        }
        return existing;
      }
      const standard = standardRoom(missionId, roomId);
      if (standard === null) return yield* fail("not-found", `No room ${roomId}.`);
      let title: string;
      let subMissionId: Room["subMissionId"] = null;
      let workItemId: Room["workItemId"] = null;
      if (standard.kind === "sub-mission") {
        const sub = Option.getOrNull(yield* store.get("sub-mission", standard.id));
        if (sub === null || sub.missionId !== missionId) {
          return yield* fail("not-found", `No sub-mission ${standard.id} in ${missionId}.`);
        }
        title = sub.title;
        subMissionId = sub.id;
      } else if (standard.kind === "work-item") {
        const item = Option.getOrNull(yield* store.get("work-item", standard.id));
        if (item === null || item.missionId !== missionId) {
          return yield* fail("not-found", `No work item ${standard.id} in ${missionId}.`);
        }
        title = item.title;
        subMissionId = item.subMissionId;
        workItemId = item.id;
      } else {
        title = standard.title;
      }
      const room: Room = {
        id: roomId,
        missionId,
        subMissionId,
        kind: standard.kind,
        title,
        workItemId,
        archived: false,
        lastSeq: 0,
        lastMessageAt: null,
        noise: null,
        createdAt: yield* nowIso,
      };
      yield* store.commit({
        event: {
          missionId,
          kind: "room.created",
          actor: actorOf(provenance),
          provenance,
          summary: `Room ${title} opened`,
          subject: { kind: "room", id: roomId, label: title },
        },
        alongside: rooms.putRoom(room),
      });
      return room;
    });

  // ---------------------------------------------------------------------------
  // Posting

  interface PostPlan {
    readonly input: PostMessageInput;
    readonly provenance: MissionProvenance;
    readonly author: MissionActor;
    /** The thread speaking when the provenance is not that agent's (the coord shim). */
    readonly authorThread?: ThreadId | null;
    /** Coord fields of a post that came through the coord shim. */
    readonly coord?: CoordEventRef;
    /** Written in the message's transaction; skipped when the key already posted. */
    readonly alongside?: Effect.Effect<void, MissionError>;
    /** A room that is not a standard one, written with this message (an owner request's). */
    readonly newRoom?: Room;
    /** An owner request's event and record, committed instead of `message.posted`. */
    readonly asRequest?: (message: MissionMessage, at: string) => RequestCommit;
  }

  /** Writes one message after the caller's checks. Serialized so seqs stay dense per mission. */
  const postChecked = ({
    input,
    provenance,
    author,
    authorThread,
    coord,
    alongside,
    newRoom,
    asRequest,
  }: PostPlan) =>
    postLock.withPermit(
      Effect.gen(function* () {
        const room =
          newRoom === undefined
            ? yield* ensureRoom(input.missionId, input.roomId, provenance)
            : ((yield* rooms.room(newRoom.id)) ?? newRoom);
        if (room.kind === "owner-request" && asRequest === undefined) {
          return yield* fail(
            "forbidden",
            "Owner request rooms take messages through the request tools (mission_request_reply).",
          );
        }
        if (room.archived) return yield* fail("conflict", `Room ${room.title} is archived.`);
        const isCorrection = input.isCorrection ?? false;
        const body = input.body ?? null;
        const contentHash = postContentHash(input);
        const key = input.key ?? null;
        if (key !== null) {
          const prior = yield* rooms.messageByKey(input.missionId, key);
          if (prior !== null) {
            // Coord posts compare coord's own hash, the one its CLI sent.
            const same =
              coord === undefined
                ? prior.contentHash === contentHash
                : prior.message.coord !== undefined &&
                  prior.message.coord.bodyHash === coord.bodyHash;
            if (same) {
              return {
                message: prior.message,
                fresh: false,
                deliveries: [] as ReadonlyArray<ThreadId>,
              };
            }
            return yield* fail(
              "conflict",
              `Key ${key} was already used for a different message (#${prior.message.seq}).`,
            );
          }
        }
        const cast = yield* loadCast(input.missionId);
        yield* requireInMission(cast, input.to ?? []);
        const item: WorkItem | null =
          input.workItemId === undefined
            ? null
            : Option.getOrNull(yield* store.get("work-item", input.workItemId));
        if (
          input.workItemId !== undefined &&
          (item === null || item.missionId !== input.missionId)
        ) {
          return yield* fail(
            "not-found",
            `No work item ${input.workItemId} in ${input.missionId}.`,
          );
        }
        const subscriptions = yield* rooms.subscriptions(room.id);
        let to: ReadonlyArray<MissionActor> = input.to ?? [];
        if (to.length === 0 && isCorrection) {
          const masterRole = masterRoleOf(cast);
          if (masterRole === null) return yield* fail("not-found", "This mission has no master.");
          to = [{ _tag: "role", roleId: masterRole.id }];
        }
        if (
          to.length === 0 &&
          input.kind === "control" &&
          !subscriptions.some((sub) => sub.mode !== "mute")
        ) {
          to = broadcastAudience(cast);
        }
        const seq = (yield* rooms.lastMessageSeq(input.missionId)) + 1;
        const at = yield* nowIso;
        const shaped = { kind: input.kind, to: [...to], author };
        const recipients = receiptRecipients(shaped, subscriptions).map((actor) => ({
          actor,
          label: labelOf(cast, actor),
        }));
        const message: MissionMessage = {
          id: MissionMessageId.make(`${input.missionId}:msg:${seq}`),
          missionId: input.missionId,
          roomId: room.id,
          seq,
          kind: input.kind,
          author,
          provenance,
          to: [...to],
          summary: input.summary,
          hasBody: body !== null && body.length > 0,
          key,
          workItemId: input.workItemId ?? null,
          links: [...(input.links ?? [])],
          receipt: input.kind === "control" ? receiptFor(seq, recipients, () => 0) : null,
          isCorrection,
          createdAt: at,
          ...(coord === undefined ? {} : { coord }),
        };
        const speaker = authorThread ?? actingThread(provenance);
        // A muted room wakes only the actors a message names itself.
        const silent =
          (yield* rooms.tuning(room.id))?.muted === true &&
          (input.to ?? []).length === 0 &&
          !isCorrection;
        const deliveries = silent
          ? ([] as ReadonlyArray<ThreadId>)
          : yield* deliveryThreads(cast, message, subscriptions, item, speaker);
        // The owner's request words never reach coord's ledger.
        const ledger =
          room.kind === "owner-request"
            ? []
            : ledgerFor(cast, message, subscriptions, speaker).map((row) =>
                silent ? { ...row, status: "skipped" as const } : row,
              );
        const asked = asRequest?.(message, at);
        yield* store.commit({
          event:
            asked === undefined
              ? {
                  missionId: input.missionId,
                  kind: "message.posted",
                  actor: author,
                  provenance,
                  summary: clipSummary(`${input.kind} in ${room.title}: ${input.summary}`),
                  subject: { kind: "message", id: message.id, label: `#${seq}` },
                  payload: { roomId: room.id, seq, deliveries: deliveries.length },
                  at,
                }
              : {
                  missionId: input.missionId,
                  kind: asked.kind,
                  actor: author,
                  provenance,
                  summary: clipSummary(asked.summary),
                  subject: asked.subject,
                  payload: {
                    ...asked.payload,
                    roomId: room.id,
                    seq,
                    deliveries: deliveries.length,
                  },
                  at,
                },
          ...(asked === undefined ? {} : { upserts: asked.upserts }),
          alongside: Effect.all(
            [
              rooms.putRoom({ ...room, lastSeq: seq, lastMessageAt: at }),
              rooms.insertMessage({ message, body, contentHash, deliveries, recipients: ledger }),
              ...(alongside === undefined ? [] : [alongside]),
            ],
            { discard: true },
          ),
        });
        return { message, fresh: true, deliveries };
      }),
    );

  /**
   * Threads a message wakes. The master's thread wakes only for what is
   * addressed to it or comes from the owner; the author never wakes itself.
   * Only the mission's own members get a delivery, so a stale subscription
   * or a thread that has left cannot carry a message out of the mission.
   */
  const deliveryThreads = (
    cast: RouterCast,
    message: MissionMessage,
    subscriptions: ReadonlyArray<Subscription>,
    item: WorkItem | null,
    authorThread: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      const targets = wakeTargets(message, {
        subscriptions,
        itemWatchers: itemWatchers(cast, item),
      });
      const masters = new Set(masterThreadsOf(cast));
      const fromOwner = message.author._tag === "owner";
      const out = new Set<ThreadId>();
      for (const actor of targets) {
        const addressed = message.to.some((each) => sameActor(each, actor));
        for (const threadId of threadsOfActor(cast, actor)) {
          if (threadId === authorThread || out.has(threadId)) continue;
          if (masters.has(threadId) && !fromOwner && !addressed) continue;
          const member = yield* membershipIn(within(cast), threadId).pipe(
            Effect.catchTags({ MissionError: () => Effect.succeed(null) }),
          );
          if (member === null) continue;
          out.add(threadId);
        }
      }
      return [...out] as ReadonlyArray<ThreadId>;
    });

  /**
   * Coord's delivery ledger for a message: the addressed actors, or else every
   * subscriber of the room, minus the owner and the author. `pending` when it
   * should reach a thread (addressed, or a wake subscription), else `skipped`,
   * the way coord.db marked them.
   */
  const ledgerFor = (
    cast: RouterCast,
    message: MissionMessage,
    subscriptions: ReadonlyArray<Subscription>,
    speaker: ThreadId | null,
  ): ReadonlyArray<RecipientRow> => {
    const candidates =
      message.to.length > 0
        ? message.to.map((actor) => ({ actor, wake: true }))
        : subscriptions.map((sub) => ({ actor: sub.subscriber, wake: sub.mode === "wake" }));
    const out = new Map<string, RecipientRow>();
    for (const { actor, wake } of candidates) {
      if (actor._tag === "owner" || sameActor(actor, message.author)) continue;
      const threads = threadsOfActor(cast, actor);
      // The speaking thread's own role or lane is the author too.
      if (speaker !== null && threads.includes(speaker)) continue;
      const key = actorKey(actor);
      if (out.has(key)) continue;
      const pending = wake && threads.length > 0;
      out.set(key, { key, status: pending ? "pending" : "skipped", ackedAt: null });
    }
    return [...out.values()];
  };

  const afterPost = (
    speaker: ThreadId | null,
    deliveries: ReadonlyArray<ThreadId>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Posting during a wake counts as acting on it.
      if (speaker !== null) yield* rooms.markActed(speaker);
      yield* Effect.forEach(
        deliveries,
        (threadId) =>
          poke(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("missions router: doorbell failed", { threadId, cause }),
            ),
          ),
        { discard: true },
      );
    });

  const requests = yield* makeOwnerRequests({
    store,
    rooms,
    loadCast,
    post: postChecked,
    afterPost,
    storeImages: images.store,
  });

  const post = (input: PostMessageInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const mission = Option.getOrNull(yield* store.get("mission", input.missionId));
      if (mission === null) return yield* fail("not-found", `No mission ${input.missionId}.`);
      if (mission.status === "archived") {
        return yield* fail("conflict", `Mission ${mission.title} is archived.`);
      }
      const owner = isOwnerProvenance(provenance);
      if (input.isCorrection === true && !owner) {
        return yield* fail("forbidden", "Only the owner posts corrections to the master.");
      }
      yield* requireReader(input.missionId, provenance);
      const result = yield* postChecked({ input, provenance, author: actorOf(provenance) });
      if (result.fresh) yield* afterPost(actingThread(provenance), result.deliveries);
      return result.message;
    });

  const relay = (request: RelayRequest) =>
    Effect.gen(function* () {
      const mission = Option.getOrNull(yield* store.get("mission", request.input.missionId));
      if (mission === null) {
        return yield* fail("not-found", `No mission ${request.input.missionId}.`);
      }
      if (mission.status === "archived") {
        return yield* fail("conflict", `Mission ${mission.title} is archived.`);
      }
      const result = yield* postChecked(request);
      if (result.fresh) yield* afterPost(request.authorThread, result.deliveries);
      return { message: result.message, fresh: result.fresh };
    });

  // ---------------------------------------------------------------------------
  // Reading

  const roomPage = (input: RoomPageInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* loadRoom(input.roomId);
      yield* requireWordsReader(room, provenance);
      const limit = Math.min(input.limit ?? PAGE_DEFAULT, PAGE_MAX);
      const page = yield* rooms.roomMessages(room.id, input.beforeSeq ?? null, limit);
      const subscriptions = yield* rooms.subscriptions(room.id);
      const positions = yield* rooms.readPositions(room.id);
      const readSeq = new Map(
        positions.map((position) => [actorKey(position.reader), position.seq]),
      );
      const readSeqOf = (actor: MissionActor) => readSeq.get(actorKey(actor)) ?? 0;
      const cast = yield* loadCast(room.missionId);
      const receiptsTo = new Map(
        page.messages.map((message) => [
          message.id,
          message.kind === "control" ? receiptRecipients(message, subscriptions) : [],
        ]),
      );
      const { names, members } = yield* whoIsIn(cast, room.id, subscriptions, [
        ...page.messages.flatMap((message) => [message.author, ...message.to]),
        ...[...receiptsTo.values()].flat(),
      ]);
      const messages = page.messages.map((message) =>
        message.kind !== "control"
          ? message
          : {
              ...message,
              receipt: receiptFor(
                message.seq,
                (receiptsTo.get(message.id) ?? []).map((actor) => ({
                  actor,
                  label: names[actorKey(actor)] ?? labelOf(cast, actor),
                })),
                readSeqOf,
              ),
            },
      );
      const now = yield* DateTime.now;
      const since = DateTime.formatIso(DateTime.subtract(now, { milliseconds: NOISE_WINDOW_MS }));
      const noise = noiseFor({
        now: DateTime.toEpochMillis(now),
        roomCreatedAt: Date.parse(room.createdAt),
        kinds: yield* rooms.roomKindsSince(room.id, since),
        wastedWakes: yield* rooms.wastedWakesSince(room.id, since),
      });
      return {
        room: { ...room, noise },
        messages,
        subscriptions,
        ownerReadSeq: readSeqOf({ _tag: "owner" }),
        hasOlder: page.hasOlder,
        names,
        members,
      } satisfies RoomPage;
    });

  /**
   * A room's members (subscribers, writers and addressees, a thread folded
   * into the lane or role it holds) and a name for every actor on the page.
   * A thread holding nothing goes by its title; nobody goes by a raw id.
   */
  const whoIsIn = (
    cast: RouterCast,
    roomId: RoomId,
    subscriptions: ReadonlyArray<Subscription>,
    onPage: ReadonlyArray<MissionActor>,
  ) =>
    Effect.gen(function* () {
      const fold = (actor: MissionActor) =>
        actor._tag === "thread" ? (heldBy(cast, actor.threadId) ?? actor) : actor;
      const members = new Map<string, MissionActor>();
      for (const actor of [
        ...subscriptions.map((subscription) => subscription.subscriber),
        ...(yield* rooms.roomActors(roomId)),
      ]) {
        if (actor._tag === "owner" || actor._tag === "system") continue;
        members.set(actorKey(fold(actor)), fold(actor));
      }
      const names: Record<string, string> = {};
      for (const actor of [
        ...members.values(),
        ...subscriptions.map((subscription) => subscription.subscriber),
        ...onPage,
      ]) {
        const key = actorKey(actor);
        if (actor._tag === "owner" || names[key] !== undefined) continue;
        names[key] =
          actor._tag === "thread" && heldBy(cast, actor.threadId) === null
            ? yield* threads.facts(actor.threadId).pipe(
                Effect.map((facts) => facts?.title ?? "a thread"),
                Effect.orElseSucceed(() => "a thread"),
              )
            : labelOf(cast, actor);
      }
      return { names, members: [...members.values()] };
    });

  const messageBody = (input: MessageBodyInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const message = yield* rooms.messageById(input.messageId);
      if (message === null) return yield* fail("not-found", `No message ${input.messageId}.`);
      yield* requireWordsReader(yield* loadRoom(message.roomId), provenance);
      const body = yield* rooms.messageBody(message.id);
      return { messageId: message.id, body: body ?? "" } satisfies MissionMessageBody;
    });

  /** The actors a reader acks for: the owner, a system component, or a thread with its roles and lanes. */
  const readersOf = (
    cast: RouterCast,
    provenance: MissionProvenance,
  ): ReadonlyArray<MissionActor> =>
    provenance._tag === "agent" ? actorsOfThread(cast, provenance.threadId) : [actorOf(provenance)];

  const markRead = (input: MarkReadInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* loadRoom(input.roomId);
      yield* requireRoomReader(room, provenance);
      const cast = yield* loadCast(room.missionId);
      const seq = Math.min(input.seq, room.lastSeq);
      const updatedAt = yield* nowIso;
      const stored = yield* Effect.forEach(readersOf(cast, provenance), (reader) =>
        rooms.advanceRead({ roomId: room.id, reader, seq, updatedAt }, actorKey(reader)),
      );
      if (provenance._tag === "agent") {
        yield* rooms.readDeliveries(provenance.threadId, room.id, seq);
      }
      // Reading a room in Robob acks it in coord's terms too.
      yield* rooms.ackRecipients({
        missionId: room.missionId,
        keys: readersOf(cast, provenance).map(actorKey),
        at: updatedAt,
        scope: { _tag: "room", roomId: room.id, upToSeq: seq },
      });
      // The owner reading a request to its end has seen the master's answer.
      yield* requests.seen(room.id, seq, provenance);
      return stored[0] ?? { roomId: room.id, reader: actorOf(provenance), seq, updatedAt };
    });

  /** An existing room, or a standard one opened on first use. */
  const openRoom = (roomId: RoomId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const existing = yield* rooms.room(roomId);
      if (existing !== null) {
        yield* requireRoomReader(existing, provenance);
        return existing;
      }
      const at = roomId.indexOf(ROOM_MARK);
      if (at <= 0) return yield* fail("not-found", `No room ${roomId}.`);
      const missionId = MissionId.make(roomId.slice(0, at));
      yield* requireReader(missionId, provenance);
      return yield* postLock.withPermit(ensureRoom(missionId, roomId, provenance));
    });

  const subscribe = (input: SubscribeRoomInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* openRoom(input.roomId, provenance);
      yield* refuseRequestRoom(room);
      const cast = yield* loadCast(room.missionId);
      if (
        provenance._tag === "agent" &&
        !isMaster(cast, provenance) &&
        !actorsOfThread(cast, provenance.threadId).some((actor) =>
          sameActor(actor, input.subscriber),
        )
      ) {
        return yield* fail(
          "forbidden",
          "Agents subscribe only themselves (the master may subscribe anyone).",
        );
      }
      yield* requireInMission(cast, [input.subscriber]);
      const key = actorKey(input.subscriber);
      const existing = (yield* rooms.subscriptions(room.id)).find(
        (sub) => actorKey(sub.subscriber) === key,
      );
      const subscription: Subscription = {
        id: existing?.id ?? SubscriptionId.make(`${room.id}:sub:${key}`),
        roomId: room.id,
        subscriber: input.subscriber,
        mode: input.mode,
        wakeOn: [...(input.wakeOn ?? defaultWakeOn(input.mode))],
        createdAt: existing?.createdAt ?? (yield* nowIso),
      };
      yield* store.commit({
        event: {
          missionId: room.missionId,
          kind: "subscription.changed",
          actor: actorOf(provenance),
          provenance,
          summary: `${labelOf(cast, input.subscriber)} ${input.mode} in ${room.title}`,
          subject: { kind: "room", id: room.id, label: room.title },
          payload: { subscriber: input.subscriber, mode: input.mode, wakeOn: subscription.wakeOn },
        },
        alongside: rooms.upsertSubscription(subscription, key),
      });
      return subscription;
    });

  const tuningOf = (room: Room) =>
    Effect.gen(function* () {
      const row = yield* rooms.tuning(room.id);
      return {
        roomId: room.id,
        missionId: room.missionId,
        muted: row?.muted ?? false,
        subscriptions: [...(yield* rooms.subscriptions(room.id))],
        updatedAt: row?.updatedAt ?? null,
      } satisfies RoomTuning;
    });

  const roomTuning = (input: RoomTuningInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* loadRoom(input.roomId);
      yield* requireRoomReader(room, provenance);
      return yield* tuningOf(room);
    });

  const tuneRoom = (input: TuneRoomInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* openRoom(input.roomId, provenance);
      yield* refuseRequestRoom(room);
      const cast = yield* loadCast(room.missionId);
      if (!isOwnerProvenance(provenance) && !isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master tunes a room.");
      }
      const rules = input.rules ?? [];
      if (input.muted === undefined && rules.length === 0) {
        return yield* fail("invalid", "Say whether the room is muted, or give at least one rule.");
      }
      const keys = rules.map((rule) => actorKey(rule.subscriber));
      if (new Set(keys).size !== keys.length) {
        return yield* fail("invalid", "Give each subscriber one rule.");
      }
      if (rules.some((rule) => rule.subscriber._tag === "owner")) {
        return yield* fail("invalid", "The owner is not a room subscriber.");
      }
      yield* requireInMission(
        cast,
        rules.map((rule) => rule.subscriber),
      );
      const at = yield* nowIso;
      const existing = yield* rooms.subscriptions(room.id);
      const subscriptions = rules.map((rule, index): Subscription => {
        const key = keys[index]!;
        const prior = existing.find((sub) => actorKey(sub.subscriber) === key);
        return {
          id: prior?.id ?? SubscriptionId.make(`${room.id}:sub:${key}`),
          roomId: room.id,
          subscriber: rule.subscriber,
          mode: rule.mode,
          wakeOn: [...(rule.wakeOn ?? defaultWakeOn(rule.mode))],
          createdAt: prior?.createdAt ?? at,
        };
      });
      const muted = input.muted ?? (yield* rooms.tuning(room.id))?.muted ?? false;
      const parts = [
        ...(input.muted === undefined ? [] : [muted ? "muted" : "unmuted"]),
        ...(rules.length === 0
          ? []
          : [`${rules.length} wake rule${rules.length === 1 ? "" : "s"}`]),
      ];
      yield* store.commit({
        event: {
          missionId: room.missionId,
          kind: "room.tuned",
          actor: actorOf(provenance),
          provenance,
          summary: clipSummary(`${room.title} tuned: ${parts.join(", ")}`),
          subject: { kind: "room", id: room.id, label: room.title },
          payload: {
            muted,
            rules: subscriptions.map(({ subscriber, mode, wakeOn }) => ({
              subscriber,
              mode,
              wakeOn,
            })),
          },
          at,
        },
        alongside: Effect.all(
          [
            rooms.putTuning({ roomId: room.id, missionId: room.missionId, muted, updatedAt: at }),
            ...subscriptions.map((sub, index) => rooms.upsertSubscription(sub, keys[index]!)),
          ],
          { discard: true },
        ),
      });
      return yield* tuningOf(room);
    });

  // --- finish-b ---
  const updateRoom = (input: UpdateRoomInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const room = yield* openRoom(input.roomId, provenance);
      yield* refuseRequestRoom(room);
      const cast = yield* loadCast(room.missionId);
      if (!isOwnerProvenance(provenance) && !isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master changes a room.");
      }
      if (input.archived === true && room.id === controlRoomId(room.missionId)) {
        return yield* fail("conflict", "The control room carries nudges and broadcasts; it stays.");
      }
      if (input.subMissionId !== undefined && input.subMissionId !== null) {
        const sub = Option.getOrNull(yield* store.get("sub-mission", input.subMissionId));
        if (sub === null || sub.missionId !== room.missionId) {
          return yield* fail(
            "not-found",
            `No sub-mission ${input.subMissionId} in ${room.missionId}.`,
          );
        }
      }
      const next: Room = {
        ...room,
        title: input.title ?? room.title,
        subMissionId: input.subMissionId === undefined ? room.subMissionId : input.subMissionId,
        archived: input.archived ?? room.archived,
      };
      const fields = (["title", "subMissionId"] as const).filter(
        (field) => next[field] !== room[field],
      );
      const archiving = next.archived !== room.archived;
      if (fields.length === 0 && !archiving) {
        return yield* fail("invalid", `Room ${room.title} already looks like that.`);
      }
      const kind = archiving ? (next.archived ? "room.archived" : "room.restored") : "room.updated";
      const summary = archiving
        ? `${room.title} ${next.archived ? "removed" : "restored"}`
        : next.title !== room.title
          ? `${room.title} renamed to ${next.title}`
          : `${next.title} moved`;
      yield* store.commit({
        event: {
          missionId: room.missionId,
          kind,
          actor: actorOf(provenance),
          provenance,
          summary: clipSummary(summary),
          subject: { kind: "room", id: room.id, label: next.title },
          payload: {
            fields: archiving ? ["archived", ...fields] : fields,
            before: { title: room.title, subMissionId: room.subMissionId, archived: room.archived },
            after: { title: next.title, subMissionId: next.subMissionId, archived: next.archived },
          },
          at: yield* nowIso,
        },
        alongside: rooms.putRoom(next),
      });
      return next;
    });
  // --- end finish-b ---

  // --- router: createRoom ---
  const createRoom = (input: CreateRoomInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* loadCast(input.missionId);
      if (cast.mission === null) return yield* fail("not-found", `No mission ${input.missionId}.`);
      if (!isOwnerProvenance(provenance) && !isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master opens a room.");
      }
      const roomId = RoomId.make(`${input.missionId}${ROOM_MARK}${input.slug}`);
      const subMissionId = input.subMissionId ?? null;
      if (subMissionId !== null) {
        const sub = Option.getOrNull(yield* store.get("sub-mission", subMissionId));
        if (sub === null || sub.missionId !== input.missionId) {
          return yield* fail("not-found", `No sub-mission ${subMissionId} in ${input.missionId}.`);
        }
      }
      return yield* postLock.withPermit(
        Effect.gen(function* () {
          const existing = yield* rooms.room(roomId);
          if (existing !== null) return existing;
          // Control, release and arch keep their standard kind and title.
          if (standardRoom(input.missionId, roomId) !== null) {
            return yield* ensureRoom(input.missionId, roomId, provenance);
          }
          const room: Room = {
            id: roomId,
            missionId: input.missionId,
            subMissionId,
            kind: "custom",
            title: input.title,
            workItemId: null,
            archived: false,
            lastSeq: 0,
            lastMessageAt: null,
            noise: null,
            createdAt: yield* nowIso,
          };
          yield* store.commit({
            event: {
              missionId: input.missionId,
              kind: "room.created",
              actor: actorOf(provenance),
              provenance,
              summary: clipSummary(`Room ${input.title} opened`),
              subject: { kind: "room", id: roomId, label: input.title },
            },
            alongside: rooms.putRoom(room),
          });
          return room;
        }),
      );
    });
  // --- end router: createRoom ---

  const setMember = (input: SetMissionMemberInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* loadCast(input.missionId);
      if (cast.mission === null) return yield* fail("not-found", `No mission ${input.missionId}.`);
      const owner = isOwnerProvenance(provenance);
      // ardud missions: coord. The coord import enrols the actors coord.db
      // binds to threads. It may only add coord members, never remove one or
      // attach a thread or session.
      const importEnrol =
        provenance._tag === "import" && input.member && input.principal._tag === "coord";
      if (!owner && !importEnrol && !isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master changes members.");
      }
      if (!owner && input.member && input.principal._tag === "thread") {
        // Attaching would let this mission post into the thread, so a master
        // may not pull in a thread that already belongs to another mission.
        const other = yield* membershipIn(elsewhere(input.missionId), input.principal.threadId);
        if (other !== null) {
          return yield* fail(
            "forbidden",
            `Thread ${input.principal.threadId} belongs to mission ${other.missionId}; only the owner can attach it here.`,
          );
        }
      }
      const { principal, label, kind } = memberRowOf(input.principal);
      // A removed actor stays out until the owner or master puts it back: the
      // import and the actor itself cannot undo the removal.
      const selfAdd =
        provenance._tag === "agent" &&
        input.principal._tag === "thread" &&
        input.principal.threadId === provenance.threadId;
      if (
        input.member &&
        !owner &&
        (provenance._tag === "import" || selfAdd) &&
        (yield* store.lastMemberChange(input.missionId, principal)) === false
      ) {
        return yield* fail(
          "forbidden",
          `${principal} was removed from this mission; only the owner or the master can add it back.`,
        );
      }
      const at = yield* nowIso;
      const result = yield* store.commit({
        event: {
          missionId: input.missionId,
          kind: "member.changed",
          actor: actorOf(provenance),
          provenance,
          summary: `${input.member ? "Added" : "Removed"} ${kind} member ${input.principal._tag === "session" ? label : principal}`,
          subject:
            input.principal._tag === "thread"
              ? { kind: "thread", id: input.principal.threadId }
              : { kind: "mission", id: input.missionId, label: label ?? principal },
          payload: { principal, kind, member: input.member },
          at,
        },
        alongside: input.member
          ? rooms.putMember({ missionId: input.missionId, principal, kind, label }, at)
          : Effect.asVoid(rooms.removeMember(input.missionId, principal)),
      });
      return {
        seq: result.seq,
        ref: result.event.subject ?? { kind: "mission", id: input.missionId },
      };
    });

  // ---------------------------------------------------------------------------
  // Knocks

  /** The member threads a forward reaches, checked before anything is decided. */
  const forwardTargets = Effect.fn("MissionRouter.forwardTargets")(function* (
    cast: RouterCast,
    forwardedTo: MissionActor,
  ) {
    // A knock is forwarded inside its own mission only: the internal send
    // skips the guard, so it must never reach another mission's thread.
    yield* requireInMission(cast, [forwardedTo]);
    const targets = threadsOfActor(cast, forwardedTo);
    if (targets.length === 0) {
      return yield* fail("invalid", `${labelOf(cast, forwardedTo)} has no thread to receive it.`);
    }
    for (const threadId of targets) {
      if ((yield* membershipIn(within(cast), threadId)) === null) {
        return yield* fail(
          "forbidden",
          `Thread ${threadId} is not a member of mission ${cast.missionId}.`,
        );
      }
    }
    return targets;
  });

  /** What a forward sends to each target, fixed when its decision commits. */
  const forwardDelivery = (
    knock: Knock,
    text: string,
    targets: ReadonlyArray<ThreadId>,
    comments: ReadonlyArray<InboxComment>,
    owner: boolean,
  ): NonNullable<Knock["delivery"]> => {
    const line = `[Forwarded by ${owner ? "the owner" : "the master"} from ${knock.fromTitle}] ${text}`;
    return {
      status: "pending",
      text:
        comments.length === 0
          ? line
          : `${line}\n\nThe owner's comments:\n${commentLines(comments)}`,
      threadIds: [...targets],
      asOwner: owner,
      sentAt: null,
    };
  };

  /**
   * Sends a committed forward from its saved delivery, then records it sent.
   * The key names the decision, so the decide call again and the sweep both
   * land it once, and nothing that went out belongs to a decision that never
   * saved. A target that left the mission since keeps it undelivered.
   */
  const deliverForward = Effect.fn("MissionRouter.deliverForward")(function* (knock: Knock) {
    const delivery = knock.delivery;
    if (delivery === undefined || delivery.status === "sent") return knock;
    const cast = yield* loadCast(knock.missionId);
    for (const threadId of delivery.threadIds) {
      if ((yield* membershipIn(within(cast), threadId)) === null) {
        return yield* fail(
          "forbidden",
          `Knock ${knock.id} is forwarded but thread ${threadId} is no longer in mission ${knock.missionId}.`,
        );
      }
    }
    yield* Effect.forEach(
      delivery.threadIds,
      (threadId) =>
        threads.send({
          threadId,
          text: delivery.text,
          key: `knock:${knock.id}:forward:${threadId}:${knock.decidedAt ?? ""}`,
          asOwner: delivery.asOwner,
        }),
      { discard: true },
    ).pipe(
      Effect.mapError((error) =>
        fail(
          error.code,
          `Knock ${knock.id} is forwarded but did not reach every thread yet (${error.detail}). It is sent again on its own.`,
        ),
      ),
    );
    const sent: Knock = {
      ...knock,
      delivery: { ...delivery, status: "sent", sentAt: yield* nowIso },
    };
    yield* store.commit({
      event: {
        missionId: knock.missionId,
        kind: "knock.delivered",
        actor: actorOf(KNOCK_DELIVERY),
        provenance: KNOCK_DELIVERY,
        summary: clipSummary(`Delivered the forwarded knock from ${knock.fromTitle}`),
        subject: { kind: "knock", id: knock.id },
        payload: { threadIds: delivery.threadIds },
      },
      upserts: [{ _tag: "knock", record: sent }],
    });
    return sent;
  });

  const decideKnock = (input: DecideKnockInput, provenance: MissionProvenance) =>
    // The owner's note joins the knock's comments, which comments write under this lock too.
    store.withItemLock(
      markIdOf({ kind: "knock", id: input.knockId }),
      Effect.gen(function* () {
        const knock = Option.getOrNull(yield* store.get("knock", input.knockId));
        if (knock === null) return yield* fail("not-found", `No knock ${input.knockId}.`);
        const resending = knock.status === "forwarded" && input.action === "forward";
        if (knock.status !== "pending" && !resending) {
          return yield* fail("conflict", `Knock ${knock.id} was already ${knock.status}.`);
        }
        const cast = yield* loadCast(knock.missionId);
        const owner = isOwnerProvenance(provenance);
        const toMaster =
          knock.targetThreadId !== undefined &&
          masterThreadsOf(cast).includes(knock.targetThreadId);
        if (!owner && !(isMaster(cast, provenance) && !toMaster)) {
          return yield* fail(
            "forbidden",
            toMaster
              ? "Only the owner decides knocks addressed to the master."
              : "Only the owner or the mission's master decides knocks.",
          );
        }
        if (resending) {
          // Its decision committed but the delivery has not landed: send the saved
          // delivery again. Asking for a different forward is a new decision.
          const note = yield* decisionNoteOf(input.note, provenance);
          const comments = yield* commentsOn(store, { kind: "knock", id: knock.id });
          const same =
            (input.editedText === undefined || input.editedText === knock.forwardedText) &&
            (input.forwardTo === undefined ||
              (knock.forwardedTo !== null && sameActor(input.forwardTo, knock.forwardedTo))) &&
            (note === null || comments.some((comment) => comment.body === note));
          if (!same || knock.forwardedTo === null) {
            return yield* fail("conflict", `Knock ${knock.id} was already forwarded.`);
          }
          if (comments.length > 0)
            yield* tellMasterOfKnockComments(cast, knock, comments, provenance);
          return yield* deliverForward(knock);
        }
        // The owner's note is a comment on the knock, saved with the decision; the
        // forward carries every comment he left so the receiver acts on them.
        const decidedAt = yield* nowIso;
        const subject = { kind: "knock" as const, id: knock.id };
        const note = yield* decisionNoteOf(input.note, provenance);
        const mark =
          note === null
            ? null
            : withComment(
                yield* store.get("inbox-mark", markIdOf(subject)),
                subject,
                knock.missionId,
                {
                  id: `comment-${sha256(`${knock.id}:${decidedAt}`).slice(0, 32)}`,
                  body: note,
                  at: decidedAt,
                },
              );
        const comments = mark?.comments ?? (yield* commentsOn(store, subject));
        const text = input.editedText ?? knock.body;
        let forwardedTo: MissionActor | null = null;
        let targets: ReadonlyArray<ThreadId> = [];
        if (input.action === "forward") {
          forwardedTo =
            input.forwardTo ??
            (knock.targetThreadId === undefined
              ? null
              : { _tag: "thread", threadId: knock.targetThreadId });
          if (forwardedTo === null) {
            return yield* fail("invalid", "Say who to forward this knock to.");
          }
          targets = yield* forwardTargets(cast, forwardedTo);
        }
        const decided: Knock = {
          ...knock,
          status: input.action === "forward" ? "forwarded" : "dropped",
          forwardedText: input.action === "forward" ? text : null,
          forwardedTo,
          decidedAt,
          // The delivery commits with the decision, so a crash or a refused send
          // leaves it pending for the next decide call or the sweep.
          ...(input.action === "forward"
            ? { delivery: forwardDelivery(knock, text, targets, comments, owner) }
            : {}),
        };
        yield* store.commit({
          event: {
            missionId: knock.missionId,
            kind: "knock.decided",
            actor: actorOf(provenance),
            provenance,
            summary: clipSummary(
              `${input.action === "forward" ? "Forwarded" : "Dropped"} knock from ${knock.fromTitle}: ${knock.summary}`,
            ),
            subject: { kind: "knock", id: knock.id },
            payload: {
              action: input.action,
              edited: input.editedText !== undefined,
              ...(mark === null ? {} : { commentId: mark.comments.at(-1)?.id ?? null }),
            },
          },
          upserts: [
            { _tag: "knock", record: decided },
            ...(mark === null ? [] : [{ _tag: "inbox-mark" as const, record: mark }]),
          ],
        });
        // Delivery only follows a committed decision, so a receiver never acts on
        // a note the knock's history lacks.
        if (comments.length > 0)
          yield* tellMasterOfKnockComments(cast, decided, comments, provenance);
        return yield* deliverForward(decided);
      }),
    );

  /**
   * Sends every forward whose delivery is still pending, each under its knock's
   * lock so a decide call resending it at the same time lands it once.
   */
  const redeliverForwards = Effect.gen(function* () {
    if (bootHold === "holding") return 0;
    const since = DateTime.subtract(yield* DateTime.now, { days: REDELIVER_WINDOW_DAYS });
    const forwarded = yield* store.list("knock", {
      status: ["forwarded"],
      updatedSince: DateTime.formatIso(since),
      order: "oldest",
      deliveryPending: true,
    });
    let delivered = 0;
    for (const { id } of forwarded) {
      const sent = yield* store
        .withItemLock(
          markIdOf({ kind: "knock", id }),
          Effect.gen(function* () {
            const knock = Option.getOrNull(yield* store.get("knock", id));
            if (knock?.status !== "forwarded" || knock.delivery?.status !== "pending") return false;
            yield* deliverForward(knock);
            return true;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: forwarded knock still undelivered", {
              knockId: id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (sent) delivered += 1;
    }
    return delivered;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("missions router: forward redelivery failed", { cause }).pipe(Effect.as(0)),
    ),
  );

  /** The master hears the owner's comments on a knock he decided, once. */
  const tellMasterOfKnockComments = Effect.fn("MissionRouter.tellMasterOfKnockComments")(
    function* (
      cast: RouterCast,
      knock: Knock,
      comments: ReadonlyArray<InboxComment>,
      provenance: MissionProvenance,
    ) {
      const master = masterRoleOf(cast);
      if (master === null || isMaster(cast, provenance)) return;
      // A knock addressed to the master is the owner's alone until he forwards
      // it; a drop must not leak its summary or his comments to the master.
      const addressedToMaster =
        knock.targetThreadId !== undefined && masterThreadsOf(cast).includes(knock.targetThreadId);
      if (addressedToMaster && knock.status !== "forwarded") return;
      const target = knock.forwardedTo;
      const forwardedToMaster =
        (target?._tag === "role" && target.roleId === master.id) ||
        (target?._tag === "thread" && masterThreadsOf(cast).includes(target.threadId));
      if (forwardedToMaster) return;
      const how =
        knock.status === "forwarded" && knock.forwardedTo !== null
          ? `forwarded to ${labelOf(cast, knock.forwardedTo)}`
          : knock.status;
      yield* relay({
        input: {
          missionId: knock.missionId,
          roomId: controlRoomId(knock.missionId),
          kind: "decision",
          summary: clipSummary(`The owner's comments on the knock from ${knock.fromTitle}`),
          body: `Knock from ${knock.fromTitle} (${knock.summary}) was ${how}.\n\nThe owner's comments:\n${commentLines(comments)}`,
          to: [{ _tag: "role", roleId: master.id }],
          key: `knock:${knock.id}:${knock.status}:comments`,
        },
        provenance: KNOCK_COMMENTS,
        author: KNOCK_COMMENTS,
        authorThread: null,
      });
    },
    (effect, _cast, knock) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions router: knock comments did not reach the master", {
            knockId: knock.id,
            cause,
          }),
        ),
      ),
  );

  // ---------------------------------------------------------------------------
  // Send guard

  /** The guard's decision and the facts behind it. Reads only. */
  const decide = (request: SendCheckRequest) =>
    Effect.gen(function* () {
      // The owner passes whatever the membership, so a record that cannot be
      // read refuses everyone else but never locks the owner out.
      const target = yield* membershipIn(everywhere, request.targetThreadId).pipe(
        request.from._tag === "owner"
          ? Effect.catchTags({
              MissionError: (error) =>
                Effect.logWarning("missions guard: owner send past an unreadable membership", {
                  targetThreadId: request.targetThreadId,
                  detail: error.detail,
                }).pipe(Effect.as(null)),
            })
          : (effect) => effect,
      );
      if (target === null) {
        return { decision: { _tag: "not-member" } as GuardDecision, target: null };
      }
      const from = request.from;
      let sender: Member | null = null;
      if (from._tag === "thread") sender = yield* membershipIn(everywhere, from.threadId);
      if (from._tag === "session") {
        const rows = yield* rooms.membersByPrincipal(`session:${from.sessionId}`);
        const row = rows.find((each) => each.missionId === target.missionId) ?? rows[0];
        sender =
          row === undefined
            ? null
            : { missionId: row.missionId, threadId: request.targetThreadId, kind: row.kind };
      }
      // ardud missions: routing - a lead answers its lane's question directly.
      const leads =
        from._tag === "thread" &&
        request.path === "request-respond" &&
        sender?.missionId === target.missionId &&
        leadTiersOf(yield* loadCast(target.missionId), request.targetThreadId).some((tier) =>
          tier.includes(from.threadId),
        );
      const decision = decideSend({
        target,
        sender,
        from,
        targetThreadId: request.targetThreadId,
        leads,
      });
      return { decision, target };
    });

  const checkSend = (request: SendCheckRequest) =>
    decide(request).pipe(Effect.map(({ decision }) => decision));

  const guard = (request: SendGuardRequest) =>
    Effect.gen(function* () {
      const { decision, target } = yield* decide(request);
      if (target === null) return { _tag: "pass" } satisfies SendGuardOutcome;
      const from = request.from;
      const provenance = senderProvenance(from);
      const cast = yield* loadCast(target.missionId);
      const targetLabel =
        target.kind === "master"
          ? `the ${cast.mission?.title ?? target.missionId} master`
          : `thread ${request.targetThreadId}`;
      const logDecision = (outcome: string, extra: Record<string, unknown> = {}) =>
        store.appendEvent({
          missionId: target.missionId,
          kind: "send.guarded",
          actor: actorOf(provenance),
          provenance,
          summary: clipSummary(
            `${senderLabel(from)} -> ${targetLabel} via ${request.path}: ${outcome}`,
          ),
          subject: { kind: "thread", id: request.targetThreadId },
          payload: {
            path: request.path,
            outcome,
            reason: "reason" in decision ? decision.reason : null,
            ...extra,
          },
        });
      switch (decision._tag) {
        case "not-member":
          return { _tag: "pass" } satisfies SendGuardOutcome;
        case "allow":
          yield* logDecision("allowed");
          return { _tag: "pass" } satisfies SendGuardOutcome;
        case "route": {
          const roomId = controlRoomId(decision.missionId);
          const result = yield* postChecked({
            input: {
              missionId: decision.missionId,
              roomId,
              kind: "request",
              summary: clipSummary(request.text),
              body: request.text,
              to: [{ _tag: "thread", threadId: request.targetThreadId }],
              key: `guard:${sha256(request.requestKey)}`,
            },
            provenance,
            author: decision.author,
          });
          if (result.fresh) {
            yield* logDecision("routed", { messageId: result.message.id, seq: result.message.seq });
            yield* afterPost(actingThread(provenance), result.deliveries);
          }
          return {
            _tag: "routed",
            missionId: decision.missionId,
            roomId,
            messageId: result.message.id,
            seq: result.message.seq,
          } satisfies SendGuardOutcome;
        }
        case "knock": {
          const knockId = KnockId.make(`knock-${sha256(request.requestKey).slice(0, 32)}`);
          const prior = Option.getOrNull(yield* store.get("knock", knockId));
          if (prior !== null) {
            return {
              _tag: "knocked",
              missionId: prior.missionId,
              knockId,
            } satisfies SendGuardOutcome;
          }
          const sender = knockSender(from);
          const knock: Knock = {
            id: knockId,
            missionId: decision.missionId,
            fromThreadId: sender.id,
            fromTitle: senderLabel(from),
            path: request.path,
            summary: clipSummary(request.text),
            body: request.text,
            status: "pending",
            forwardedText: null,
            forwardedTo: null,
            decidedAt: null,
            createdAt: yield* nowIso,
            targetThreadId: request.targetThreadId,
            ...(sender.kind === undefined ? {} : { senderKind: sender.kind }),
          };
          yield* store.commit({
            event: {
              missionId: decision.missionId,
              kind: "knock.received",
              actor: actorOf(provenance),
              provenance,
              summary: clipSummary(
                `${senderLabel(from)} wants to tell ${targetLabel}: ${request.text}`,
              ),
              subject: { kind: "knock", id: knockId },
              payload: { path: request.path, reason: decision.reason },
            },
            upserts: [{ _tag: "knock", record: knock }],
          });
          return {
            _tag: "knocked",
            missionId: decision.missionId,
            knockId,
          } satisfies SendGuardOutcome;
        }
      }
    });

  // ---------------------------------------------------------------------------
  // Doorbell

  /**
   * A wake for an owner request carries the request's whole conversation, so
   * the master never has to ask the owner to say it again.
   */
  const withRequestContexts = (line: string, requestRooms: ReadonlyArray<RoomId>) =>
    Effect.gen(function* () {
      if (requestRooms.length === 0) return line;
      const shown = requestRooms.slice(0, WAKE_REQUESTS_MAX);
      const contexts: string[] = [];
      for (const roomId of shown) {
        const context = yield* requests.contextOf(roomId);
        if (context !== null) contexts.push(context);
      }
      const more = requestRooms.length - shown.length;
      const tail =
        more === 0
          ? []
          : [`${more} more owner request${more === 1 ? "" : "s"} wait; mission_inbox has them.`];
      return [line, ...contexts, ...tail].join("\n\n---\n\n");
    });

  const pokeUnlocked = (threadId: ThreadId): Effect.Effect<void, MissionError> =>
    Effect.gen(function* () {
      if (bootHold === "holding") {
        heldPokes.add(threadId);
        return;
      }
      const unread = yield* rooms.unreadDeliveries(threadId);
      if (unread.length === 0) return;
      let bell = yield* rooms.doorbell(threadId);
      const facts = yield* threads.facts(threadId);
      const activity = facts?.activity ?? "missing";
      // An outstanding wake on an idle thread means its run ended while no
      // settle reached us (a restart, a dropped event): clear it here.
      if (bell?.outstanding === true && activity === "idle") {
        yield* rooms.settle(threadId, yield* nowIso);
        bell = yield* rooms.doorbell(threadId);
      }
      const action = doorbellAction(
        { outstanding: bell?.outstanding ?? false, rungSeq: bell?.rungSeq ?? 0 },
        activity,
        unread.map((delivery) => ({ seq: delivery.seq, covered: delivery.wakeId !== null })),
      );
      if (action._tag === "none") return;
      if (action._tag === "fold") {
        if (bell?.wakeId) yield* rooms.coverDeliveries(threadId, bell.wakeId);
        return;
      }
      const newest = unread.reduce((a, b) => (b.seq > a.seq ? b : a));
      const titles = new Set<string>();
      const requestRooms: RoomId[] = [];
      for (const roomId of new Set(unread.map((delivery) => delivery.roomId))) {
        const room = yield* rooms.room(roomId);
        titles.add(room?.title ?? roomId);
        if (room?.kind === "owner-request") requestRooms.push(room.id);
      }
      const newestMessage = yield* rooms.messageById(newest.messageId);
      const wakeId = wakeRequestId(newest.missionId, threadId, action.upToSeq);
      const line = wakeLine({
        unread: action.unread,
        rooms: [...titles],
        newest:
          newestMessage === null
            ? `#${newest.seq}`
            : `#${newestMessage.seq} ${newestMessage.kind}: ${newestMessage.summary.slice(0, 120)}`,
      });
      yield* threads.send({
        threadId,
        text: yield* withRequestContexts(line, requestRooms),
        key: wakeId,
        asOwner: false,
      });
      yield* rooms.ring({
        threadId,
        missionId: newest.missionId,
        wakeId,
        upToSeq: action.upToSeq,
        at: yield* nowIso,
      });
    });

  const poke = (threadId: ThreadId): Effect.Effect<void, MissionError> =>
    bellLock.withPermit(pokeUnlocked(threadId));

  const settled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* rooms.settle(threadId, yield* nowIso);
      yield* poke(threadId);
    });

  // --- router additions: system delivery (recovery) ---
  const isGone = (facts: ThreadFacts | null) =>
    facts === null || facts.archived || facts.activity === "missing";

  const readiness = (threadId: ThreadId) =>
    threads.facts(threadId).pipe(
      Effect.map((facts): ThreadReadiness =>
        isGone(facts) ? "gone" : facts?.activity === "idle" ? "idle" : "busy",
      ),
      Effect.catchTags({ MissionError: () => Effect.succeed<ThreadReadiness>("busy") }),
    );

  const notify = (input: SystemNotice) =>
    Effect.gen(function* () {
      if (isGone(yield* threads.facts(input.threadId))) {
        return yield* fail("not-found", `Thread ${input.threadId} is gone.`);
      }
      // A retry takes the route the first attempt took, even if the thread
      // joined or left a mission since: the other route would send it twice.
      const route = yield* rooms.noticeRoute(input.key);
      // A queued notice skips the room: its doorbell only rings once the
      // thread is idle, which a busy thread may not be for hours.
      const member =
        route !== null
          ? route.missionId === null
            ? null
            : { missionId: route.missionId }
          : input.queue === true
            ? null
            : yield* membershipIn(everywhere, input.threadId);
      if (member === null) {
        if (route === null) {
          yield* rooms.recordNotice({
            key: input.key,
            threadId: input.threadId,
            missionId: null,
            at: yield* nowIso,
          });
        }
        yield* threads.send({
          threadId: input.threadId,
          text: input.text,
          key: `recovery:${input.key}`,
          asOwner: false,
        });
        return { _tag: "sent" } satisfies SystemNoticeOutcome;
      }
      const provenance: MissionProvenance = { _tag: "system", component: input.producer };
      const roomId = controlRoomId(member.missionId);
      const { message, fresh } = yield* relay({
        input: {
          missionId: member.missionId,
          roomId,
          kind: "request",
          summary: clipSummary(input.text),
          body: input.text,
          to: [{ _tag: "thread", threadId: input.threadId }],
          key: `recovery:${sha256(input.key).slice(0, 32)}`,
        },
        provenance,
        author: actorOf(provenance),
        authorThread: null,
        alongside: rooms.recordNotice({
          key: input.key,
          threadId: input.threadId,
          missionId: member.missionId,
          at: yield* nowIso,
        }),
      });
      // A retry finds the message already posted and rings nothing, so ring
      // here: a ring that failed last time gets another go. The doorbell only
      // rings for deliveries still unread, so this is a no-op otherwise.
      if (!fresh) {
        yield* poke(input.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: doorbell failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }
      return {
        _tag: "posted",
        missionId: member.missionId,
        roomId,
        messageId: message.id,
        seq: message.seq,
      } satisfies SystemNoticeOutcome;
    });

  const holdDoorbells = Effect.sync(() => {
    if (bootHold === "open") bootHold = "holding";
  });

  const releaseDoorbells = Effect.gen(function* () {
    const { was, held } = yield* bellLock.withPermit(
      Effect.sync(() => {
        const was = bootHold;
        bootHold = "released";
        const held = [...heldPokes];
        heldPokes.clear();
        return { was, held };
      }),
    );
    if (was !== "holding") return;
    yield* Effect.logInfo("missions router: boot hold released", { held: held.length });
    yield* Effect.forEach(
      held,
      (threadId) =>
        poke(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: doorbell failed", { threadId, cause }),
          ),
        ),
      { discard: true },
    );
  });
  // --- end router additions ---

  // --- routing additions ---
  // --- r22 fixes ---
  /**
   * The thread that delegated this one: its parent, when the parent is the
   * recorded creator (a subagent or fork it made). One level only. An owner
   * fork, or a thread with no recorded creator, has no delegator.
   */
  const delegatorOf = Effect.fn("MissionRouter.delegatorOf")(function* (threadId: ThreadId) {
    const facts = yield* threads.facts(threadId);
    const parent = facts?.parentThreadId ?? null;
    if (facts === null || parent === null || parent === threadId) return null;
    const creator = yield* threads.creator(threadId);
    if (creator?._tag !== "thread" || creator.threadId !== parent) return null;
    return { threadId: parent, childTitle: facts.title };
  });

  /** Who answers a thread's requests in one mission, nearest tier first. */
  interface LeadRoute {
    readonly cast: RouterCast;
    readonly tiers: ReadonlyArray<ReadonlyArray<ThreadId>>;
    /** What the asking thread is called in this mission. */
    readonly asker: string;
  }

  const DELEGATED_TITLE_MAX = 60;

  /**
   * A thread's lead routes: its own lead tiers where it has any. Otherwise a
   * thread delegated by a mission member other than the master goes to that
   * member first, then to the member's own leads. Only questions and
   * permission requests travel this way: the delegated thread gets no
   * membership and no send rights, so the guard still treats it as an
   * outsider. A master never climbs to its parent.
   */
  const leadRoutes = Effect.fn("MissionRouter.leadRoutes")(function* (threadId: ThreadId) {
    const own = yield* candidateCasts(threadId);
    const routes: LeadRoute[] = [];
    for (const cast of own) {
      const tiers = leadTiersOf(cast, threadId);
      if (tiers.length > 0) {
        routes.push({ cast, tiers, asker: labelOf(cast, { _tag: "thread", threadId }) });
      }
    }
    if (routes.length > 0) return routes;
    if (own.some((cast) => masterThreadsOf(cast).includes(threadId))) return routes;
    const delegator = yield* delegatorOf(threadId);
    if (delegator === null) return routes;
    // The child names itself, so quotes and invisible characters go: its title
    // must not read as words of the notice around it.
    const title = Array.from(
      delegator.childTitle
        .replace(/\s+/g, " ")
        .replace(/[\p{C}"“”`]/gu, "")
        .trim(),
    );
    const shown =
      title.length <= DELEGATED_TITLE_MAX
        ? title.join("")
        : `${title.slice(0, DELEGATED_TITLE_MAX - 1).join("")}…`;
    for (const cast of yield* candidateCasts(delegator.threadId)) {
      const kind = recordMembership(cast, delegator.threadId);
      if (kind === null || kind === "master") continue;
      const lane = labelOf(cast, { _tag: "thread", threadId: delegator.threadId });
      routes.push({
        cast,
        tiers: [[delegator.threadId], ...leadTiersOf(cast, delegator.threadId)],
        asker:
          shown.length > 0 ? `${lane}'s delegated thread "${shown}"` : `${lane}'s delegated thread`,
      });
    }
    return routes;
  });

  // Mirrors tellLeads, which only tries the first route: with every lead there
  // gone nobody is told, so the request stays the owner's.
  const leadRouted = Effect.fn("MissionRouter.leadRouted")(function* (threadId: ThreadId) {
    const [route] = yield* leadRoutes(threadId);
    if (route === undefined) return false;
    for (const lead of route.tiers.flat()) {
      if ((yield* readiness(lead)) !== "gone") return true;
    }
    return false;
  });
  // --- end r22 fixes ---

  /**
   * Tells a thread's nearest live lead tier about a request it is waiting on,
   * once per lead. `read` is null once the request is no longer pending.
   */
  const tellLeads = Effect.fn("MissionRouter.tellLeads")(function* <A>(
    input: { readonly threadId: ThreadId; readonly requestId: string },
    request: {
      readonly read: Effect.Effect<A | null, MissionError>;
      readonly text: (asker: string, pending: A) => string;
      readonly key: (lead: ThreadId) => string;
      readonly producer: string;
    },
  ) {
    for (const route of yield* leadRoutes(input.threadId)) {
      const pending = yield* request.read;
      if (pending === null) return [];
      for (const tier of route.tiers) {
        const live: ThreadId[] = [];
        for (const lead of tier) {
          if ((yield* readiness(lead)) !== "gone") live.push(lead);
        }
        if (live.length === 0) continue;
        const text = request.text(route.asker, pending);
        for (const lead of live) {
          yield* notify({
            threadId: lead,
            text,
            key: request.key(lead),
            producer: request.producer,
          });
        }
        return live;
      }
      return [];
    }
    return [];
  });

  const questionRaised = Effect.fn("MissionRouter.questionRaised")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
  }) {
    return yield* tellLeads(input, {
      read: threads.question(input),
      text: (asker, questions) =>
        leadQuestionText({
          asker,
          threadId: input.threadId,
          requestId: input.requestId,
          questions,
        }),
      key: (lead) => leadQuestionKey(input.threadId, input.requestId, lead),
      producer: LEAD_QUESTION_PRODUCER,
    });
  });
  // --- end routing additions ---

  // --- permissions additions ---
  const approvalRaised = Effect.fn("MissionRouter.approvalRaised")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
  }) {
    return yield* tellLeads(input, {
      read: threads.approval(input),
      text: (asker, approval) =>
        leadApprovalText({
          asker,
          threadId: input.threadId,
          requestId: input.requestId,
          approval,
        }),
      key: (lead) => leadApprovalKey(input.threadId, input.requestId, lead),
      producer: LEAD_APPROVAL_PRODUCER,
    });
  });

  const approvalRespond = Effect.fn("MissionRouter.approvalRespond")(function* (
    input: RespondMissionApprovalInput,
    provenance: MissionProvenance,
  ) {
    const caller = actingThread(provenance);
    if (caller === null) {
      return yield* fail("forbidden", "Only a lead's thread answers a lane's permission request.");
    }
    if (caller === input.threadId) {
      return yield* fail("forbidden", "A thread cannot answer its own permission request.");
    }
    const route = (yield* leadRoutes(input.threadId)).find((each) =>
      each.tiers.some((tier) => tier.includes(caller)),
    );
    if (route === undefined) {
      return yield* fail(
        "forbidden",
        `You do not lead thread ${input.threadId}, so its permission requests are not yours to answer.`,
      );
    }
    const approval = yield* threads.approval(input);
    if (approval === null) {
      return yield* fail(
        "not-found",
        `Thread ${input.threadId} has no pending permission request ${input.requestId}; it was answered or dismissed.`,
      );
    }
    if (
      approval.options !== null &&
      approval.options.length > 0 &&
      !approval.options.some((option) => option.decision === input.decision)
    ) {
      return yield* fail(
        "invalid",
        `This request does not offer ${input.decision}; it offers ${approval.options.map((option) => option.decision).join(", ")}.`,
      );
    }
    yield* threads.respondApproval({
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      // One answer per lead: a second lead's answer fails as no longer pending.
      key: `lead-approval-respond:${input.threadId}:${input.requestId}:${caller}`,
    });
    yield* store.appendEvent({
      missionId: route.cast.missionId,
      kind: "send.guarded",
      actor: actorOf(provenance),
      provenance,
      summary: clipSummary(
        `${labelOf(route.cast, { _tag: "thread", threadId: caller })} -> ${route.asker} via request-respond: ${input.decision} (${approval.requestKind})`,
      ),
      subject: { kind: "thread", id: input.threadId },
      payload: {
        path: "request-respond",
        outcome: "allowed",
        reason: "lead",
        requestId: input.requestId,
        requestKind: approval.requestKind,
        decision: input.decision,
      },
    });
    return { threadId: input.threadId, requestId: input.requestId, decision: input.decision };
  });
  // --- end permissions additions ---

  /** One thread's reminder, under the bell lock. True when it was sent. */
  const remindThread = (
    threadId: ThreadId,
    stale: ReadonlyArray<DeliveryRow>,
    gapCutoff: string,
  ): Effect.Effect<boolean, MissionError> =>
    Effect.gen(function* () {
      if (bootHold === "holding") return false;
      if (!reminderDue(yield* rooms.lastReminderAt(threadId), gapCutoff)) return false;
      const facts = yield* threads.facts(threadId);
      if (facts?.activity !== "idle") return false;
      // Idle with an outstanding wake: that run ended without a settle.
      if ((yield* rooms.doorbell(threadId))?.outstanding === true) {
        yield* rooms.settle(threadId, yield* nowIso);
      }
      const unread = yield* rooms.unreadDeliveries(threadId);
      const titles = new Set<string>();
      const requestRooms: RoomId[] = [];
      for (const roomId of new Set(unread.map((delivery) => delivery.roomId))) {
        const room = yield* rooms.room(roomId);
        titles.add(room?.title ?? roomId);
        if (room?.kind === "owner-request") requestRooms.push(room.id);
      }
      const oldest = stale.reduce((a, b) => (b.seq < a.seq ? b : a));
      const newest = unread.reduce((a, b) => (b.seq > a.seq ? b : a), oldest);
      const wakeId = reminderRequestId(newest.missionId, threadId, newest.seq);
      const line = reminderLine({
        unread: unread.length,
        rooms: [...titles],
        oldest: yield* rooms.messageById(oldest.messageId),
      });
      yield* threads.send({
        threadId,
        // A reminder about an owner request carries the conversation, like the wake.
        text: yield* withRequestContexts(line, requestRooms),
        key: wakeId,
        asOwner: false,
      });
      const at = yield* nowIso;
      yield* rooms.ring({
        threadId,
        missionId: newest.missionId,
        wakeId,
        upToSeq: newest.seq,
        at,
      });
      yield* rooms.markReminded(stale, at);
      return true;
    });

  const remind = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const ago = (ms: number) => DateTime.formatIso(DateTime.subtract(now, { milliseconds: ms }));
    const stale = yield* rooms.staleDeliveries(ago(REMIND_AFTER_MS));
    const byThread = new Map<ThreadId, DeliveryRow[]>();
    for (const delivery of stale) {
      const list = byThread.get(delivery.threadId) ?? [];
      list.push(delivery);
      byThread.set(delivery.threadId, list);
    }
    let reminded = 0;
    for (const [threadId, rows] of byThread) {
      const sent = yield* bellLock
        .withPermit(remindThread(threadId, rows, ago(REMIND_GAP_MS)))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: reminder failed", { threadId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (sent) reminded += 1;
    }
    return reminded;
  });

  const attention = (input: MissionAttentionInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* loadCast(input.missionId);
      if (!isOwnerProvenance(provenance) && !isMaster(cast, provenance)) {
        return yield* fail(
          "forbidden",
          "Only the owner or the mission's master reads the attention view.",
        );
      }
      const rows = yield* rooms.attention(input.missionId, ATTENTION_MAX);
      return {
        missionId: input.missionId,
        entries: rows.map((row) => ({ ...row })),
      } satisfies MissionAttention;
    });

  const knocks = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const pending = yield* store.list("knock", { missionId, status: ["pending"] });
      if (isOwnerProvenance(provenance)) return pending;
      const cast = yield* loadCast(missionId);
      if (!isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master reads knocks.");
      }
      const masters = masterThreadsOf(cast);
      return pending.filter(
        (knock) => knock.targetThreadId === undefined || !masters.includes(knock.targetThreadId),
      );
    });

  const inbox = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const unread = yield* rooms.unreadDeliveries(threadId);
      const entries: InboxEntry[] = [];
      for (const delivery of unread.slice(0, INBOX_MAX)) {
        const message = yield* rooms.messageById(delivery.messageId);
        if (message === null) continue;
        const room = yield* rooms.room(delivery.roomId);
        const body = message.hasBody ? yield* rooms.messageBody(message.id) : null;
        entries.push({ roomTitle: room?.title ?? delivery.roomId, message, body });
      }
      // The newest entry of each owner request carries its whole conversation.
      const newestOfRoom = new Map<RoomId, number>();
      entries.forEach((entry, index) => {
        if (requestIdOfRoom(entry.message.roomId) !== null) {
          newestOfRoom.set(entry.message.roomId, index);
        }
      });
      for (const [roomId, index] of newestOfRoom) {
        const requestContext = yield* requests.contextOf(roomId);
        if (requestContext !== null) entries[index] = { ...entries[index]!, requestContext };
      }
      return { threadId, unread: unread.length, entries } satisfies AgentInbox;
    });

  return MissionRouter.of({
    // Owner request rooms live in the requests section, not the room list.
    rooms: (missionId, provenance) =>
      requireReader(missionId, provenance).pipe(
        Effect.andThen(Effect.all([rooms.rooms(missionId), rooms.roomCounts(missionId)])),
        // The counts ride along so a list never has to count from one page.
        Effect.map(([all, counts]) =>
          all
            .filter((room) => room.kind !== "owner-request")
            .map((room) => {
              const count = counts.get(room.id);
              return {
                ...room,
                messageCount: count?.total ?? 0,
                unreadForOwner: count?.unreadForOwner ?? 0,
              };
            }),
        ),
      ),
    roomPage,
    messageBody,
    post,
    markRead,
    subscribe,
    setMember,
    decideKnock,
    knocks,
    inbox,
    guard,
    checkSend,
    poke,
    settled,
    readiness,
    notify,
    questionRaised,
    approvalRaised,
    approvalRespond,
    leadRouted, // ardud missions: r22 fixes
    relay,
    roomTuning,
    tuneRoom,
    updateRoom,
    createRoom, // ardud missions: router
    remind,
    redeliverForwards, // ardud missions: r22 comments
    holdDoorbells, // ardud missions: recovery
    releaseDoorbells, // ardud missions: recovery
    attention,
    ownerRequests: requests.list,
    openRequest: requests.open,
    replyRequest: requests.reply,
    settleRequest: requests.settle,
    reopenRequest: requests.reopen,
    // --- fix-p3 ---
    roomActivity: (input, provenance) =>
      requireReader(input.missionId, provenance).pipe(
        Effect.andThen(() =>
          Effect.all([
            loadCast(input.missionId),
            rooms.messagesSince(input.missionId, input.dayStart),
            rooms.messageTallySince(input.missionId, input.since ?? input.dayStart),
          ]),
        ),
        Effect.map(([cast, day, tally]) =>
          roomActivity({
            dayStart: input.dayStart,
            day,
            tally,
            master: { roleId: masterRoleOf(cast)?.id ?? null, threadIds: masterThreadsOf(cast) },
          }),
        ),
      ),
    // --- end fix-p3 ---
    verifyOwnerCondition: requests.verifyCondition,
    settleRequestsFor: requests.settleFor,
  });
});

/** The router, and the request images port it uses for the views track to fill. */
export const layer = Layer.effect(MissionRouter, make).pipe(
  Layer.provideMerge(requestImagesRegistry),
);
