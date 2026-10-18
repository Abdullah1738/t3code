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
  type Knock,
  type MarkReadInput,
  type MessageBodyInput,
  type MissionActor,
  type MissionMessage,
  type MissionMessageBody,
  type MissionMutationResult,
  type MissionProvenance,
  type PostMessageInput,
  type ReadPosition,
  type Room,
  type RoomPage,
  type RoomPageInput,
  type SetMissionMemberInput,
  type SubscribeRoomInput,
  type Subscription,
  type WorkItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { clipSummary } from "../asks/shared.ts";
import { castOf } from "../core/master.ts";
import { actorOf } from "../core/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import {
  actorsOfThread,
  broadcastAudience,
  itemWatchers,
  labelOf,
  masterRoleOf,
  masterThreadsOf,
  recordMembership,
  threadsOfActor,
  type RouterCast,
} from "./cast.ts";
import type { SendGuardOutcome, SendGuardRequest } from "./guardHook.ts";
import { contentHashOf, sha256 } from "./hash.ts";
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
  type Member,
  type MemberKind,
  type SendSender,
} from "./model.ts";
import { RouterThreads } from "./ports.ts";
import { RouterStore, type RecipientRow } from "./RouterStore.ts";

/** One unread message waiting for a thread, as `mission_inbox` shows it. */
export interface InboxEntry {
  readonly roomTitle: string;
  readonly message: MissionMessage;
  readonly body: string | null;
}

export interface AgentInbox {
  readonly threadId: ThreadId;
  readonly unread: number;
  readonly entries: ReadonlyArray<InboxEntry>;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const INBOX_MAX = 30;
const LIVE_MISSIONS = ["active", "paused", "draining"];
const MEMBER_RANK: Record<MemberKind, number> = { master: 0, created: 1, attached: 2, service: 3 };

const fail = (code: MissionError["code"], detail: string) => new MissionError({ code, detail });
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

/** The thread an agent provenance speaks for; null for everyone else. */
const actingThread = (provenance: MissionProvenance): ThreadId | null =>
  provenance._tag === "agent" ? provenance.threadId : null;

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
    /** Ring, fold or hold a thread's doorbell for its unread deliveries. */
    readonly poke: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /** A run on the thread ended: clear its outstanding wake and look again. */
    readonly settled: (threadId: ThreadId) => Effect.Effect<void, MissionError>;
    /**
     * Posts for a trusted server component that resolved the speaker itself
     * (the coord shim). Same rules as `post` after that: dense seqs, key
     * idempotency, in-mission recipients, the doorbell.
     */
    readonly relay: (
      request: RelayRequest,
    ) => Effect.Effect<{ readonly message: MissionMessage; readonly fresh: boolean }, MissionError>;
  }
>()("t3/ardud/missions/router/MissionRouter") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const rooms = yield* RouterStore;
  const threads = yield* RouterThreads;
  const postLock = yield* Semaphore.make(1);
  const bellLock = yield* Semaphore.make(1);

  const loadCast = (missionId: MissionId): Effect.Effect<RouterCast, MissionError> =>
    castOf(store, missionId);

  const loadRoom = (roomId: RoomId) =>
    Effect.gen(function* () {
      const room = yield* rooms.room(roomId);
      if (room === null) return yield* fail("not-found", `No room ${roomId}.`);
      return room;
    });

  // ---------------------------------------------------------------------------
  // Membership

  const explicitMembers = (threadId: ThreadId) => rooms.membersByPrincipal(`thread:${threadId}`);

  const liveCasts = Effect.gen(function* () {
    const missions = yield* store.list("mission", { status: LIVE_MISSIONS });
    return yield* Effect.forEach(missions, (mission) => loadCast(mission.id));
  });

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
   * Direct membership, or `created` when the thread's parent or root is the
   * master or one of its threads. A thread whose lineage cannot be read fails
   * the lookup rather than counting as an outsider, so the guard fails closed.
   */
  const membershipIn = (casts: ReadonlyArray<RouterCast>, threadId: ThreadId) =>
    Effect.gen(function* () {
      const direct = yield* directMembership(casts, threadId);
      if (direct !== null) return direct;
      const facts = yield* threads.facts(threadId);
      if (facts === null) return null;
      for (const ancestor of [facts.parentThreadId, facts.rootThreadId]) {
        if (ancestor === null || ancestor === threadId) continue;
        const parent = yield* directMembership(casts, ancestor);
        if (parent !== null && (parent.kind === "master" || parent.kind === "created")) {
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
      const member = yield* membershipIn([yield* loadCast(missionId)], provenance.threadId);
      if (member === null) {
        return yield* fail(
          "forbidden",
          `Thread ${provenance.threadId} is not a member of mission ${missionId}.`,
        );
      }
    });

  const isMaster = (cast: RouterCast, provenance: MissionProvenance) =>
    provenance._tag === "agent" && masterThreadsOf(cast).includes(provenance.threadId);

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
              if ((yield* membershipIn([cast], actor.threadId)) === null) {
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
  }

  /** Writes one message after the caller's checks. Serialized so seqs stay dense per mission. */
  const postChecked = ({ input, provenance, author, authorThread, coord }: PostPlan) =>
    postLock.withPermit(
      Effect.gen(function* () {
        const room = yield* ensureRoom(input.missionId, input.roomId, provenance);
        if (room.archived) return yield* fail("conflict", `Room ${room.title} is archived.`);
        const isCorrection = input.isCorrection ?? false;
        const body = input.body ?? null;
        const contentHash = contentHashOf({
          roomId: input.roomId,
          kind: input.kind,
          summary: input.summary,
          body,
          to: input.to ?? [],
          workItemId: input.workItemId ?? null,
          links: input.links ?? [],
          isCorrection,
        });
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
        const deliveries = yield* deliveryThreads(cast, message, subscriptions, item, speaker);
        const ledger = ledgerFor(cast, message, subscriptions, speaker);
        yield* store.commit({
          event: {
            missionId: input.missionId,
            kind: "message.posted",
            actor: author,
            provenance,
            summary: clipSummary(`${input.kind} in ${room.title}: ${input.summary}`),
            subject: { kind: "message", id: message.id, label: `#${seq}` },
            payload: { roomId: room.id, seq, deliveries: deliveries.length },
            at,
          },
          alongside: Effect.all(
            [
              rooms.putRoom({ ...room, lastSeq: seq, lastMessageAt: at }),
              rooms.insertMessage({ message, body, contentHash, deliveries, recipients: ledger }),
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
          const member = yield* membershipIn([cast], threadId).pipe(
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
      yield* requireReader(room.missionId, provenance);
      const limit = Math.min(input.limit ?? PAGE_DEFAULT, PAGE_MAX);
      const page = yield* rooms.roomMessages(room.id, input.beforeSeq ?? null, limit);
      const subscriptions = yield* rooms.subscriptions(room.id);
      const positions = yield* rooms.readPositions(room.id);
      const readSeq = new Map(
        positions.map((position) => [actorKey(position.reader), position.seq]),
      );
      const readSeqOf = (actor: MissionActor) => readSeq.get(actorKey(actor)) ?? 0;
      const cast = yield* loadCast(room.missionId);
      const messages = page.messages.map((message) =>
        message.kind !== "control"
          ? message
          : {
              ...message,
              receipt: receiptFor(
                message.seq,
                receiptRecipients(message, subscriptions).map((actor) => ({
                  actor,
                  label: labelOf(cast, actor),
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
      } satisfies RoomPage;
    });

  const messageBody = (input: MessageBodyInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const message = yield* rooms.messageById(input.messageId);
      if (message === null) return yield* fail("not-found", `No message ${input.messageId}.`);
      yield* requireReader(message.missionId, provenance);
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
      yield* requireReader(room.missionId, provenance);
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
      return stored[0] ?? { roomId: room.id, reader: actorOf(provenance), seq, updatedAt };
    });

  /** An existing room, or a standard one opened on first use. */
  const openRoom = (roomId: RoomId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const existing = yield* rooms.room(roomId);
      if (existing !== null) {
        yield* requireReader(existing.missionId, provenance);
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

  const setMember = (input: SetMissionMemberInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* loadCast(input.missionId);
      if (cast.mission === null) return yield* fail("not-found", `No mission ${input.missionId}.`);
      const owner = isOwnerProvenance(provenance);
      if (!owner && !isMaster(cast, provenance)) {
        return yield* fail("forbidden", "Only the owner or the mission's master changes members.");
      }
      if (!owner && input.member && input.principal._tag === "thread") {
        // Attaching would let this mission post into the thread, so a master
        // may not pull in a thread that already belongs to another mission.
        const others = (yield* liveCasts).filter((each) => each.missionId !== input.missionId);
        const elsewhere = yield* membershipIn(others, input.principal.threadId);
        if (elsewhere !== null) {
          return yield* fail(
            "forbidden",
            `Thread ${input.principal.threadId} belongs to mission ${elsewhere.missionId}; only the owner can attach it here.`,
          );
        }
      }
      const principal =
        input.principal._tag === "thread"
          ? `thread:${input.principal.threadId}`
          : `session:${input.principal.sessionId}`;
      const label = input.principal._tag === "thread" ? null : input.principal.label;
      const kind: MemberKind = input.principal._tag === "thread" ? "attached" : "service";
      const at = yield* nowIso;
      const result = yield* store.commit({
        event: {
          missionId: input.missionId,
          kind: "member.changed",
          actor: actorOf(provenance),
          provenance,
          summary: `${input.member ? "Added" : "Removed"} ${kind} member ${label ?? principal}`,
          subject:
            input.principal._tag === "thread"
              ? { kind: "thread", id: input.principal.threadId }
              : { kind: "mission", id: input.missionId, label: input.principal.label },
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

  const decideKnock = (input: DecideKnockInput, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const knock = Option.getOrNull(yield* store.get("knock", input.knockId));
      if (knock === null) return yield* fail("not-found", `No knock ${input.knockId}.`);
      if (knock.status !== "pending") {
        return yield* fail("conflict", `Knock ${knock.id} was already ${knock.status}.`);
      }
      const cast = yield* loadCast(knock.missionId);
      const owner = isOwnerProvenance(provenance);
      const toMaster =
        knock.targetThreadId !== undefined && masterThreadsOf(cast).includes(knock.targetThreadId);
      if (!owner && !(isMaster(cast, provenance) && !toMaster)) {
        return yield* fail(
          "forbidden",
          toMaster
            ? "Only the owner decides knocks addressed to the master."
            : "Only the owner or the mission's master decides knocks.",
        );
      }
      const text = input.editedText ?? knock.body;
      let forwardedTo: MissionActor | null = null;
      if (input.action === "forward") {
        forwardedTo =
          input.forwardTo ??
          (knock.targetThreadId === undefined
            ? null
            : { _tag: "thread", threadId: knock.targetThreadId });
        if (forwardedTo === null) {
          return yield* fail("invalid", "Say who to forward this knock to.");
        }
        // A knock is forwarded inside its own mission only: the internal send
        // below skips the guard, so it must never reach another mission's thread.
        yield* requireInMission(cast, [forwardedTo]);
        const targets = threadsOfActor(cast, forwardedTo);
        if (targets.length === 0) {
          return yield* fail(
            "invalid",
            `${labelOf(cast, forwardedTo)} has no thread to receive it.`,
          );
        }
        for (const threadId of targets) {
          if ((yield* membershipIn([cast], threadId)) === null) {
            return yield* fail(
              "forbidden",
              `Thread ${threadId} is not a member of mission ${cast.missionId}.`,
            );
          }
        }
        yield* Effect.forEach(
          targets,
          (threadId) =>
            threads.send({
              threadId,
              text: `[Forwarded by ${owner ? "the owner" : "the master"} from ${knock.fromTitle}] ${text}`,
              key: `knock:${knock.id}:forward:${threadId}`,
              asOwner: owner,
            }),
          { discard: true },
        );
      }
      const decided: Knock = {
        ...knock,
        status: input.action === "forward" ? "forwarded" : "dropped",
        forwardedText: input.action === "forward" ? text : null,
        forwardedTo,
        decidedAt: yield* nowIso,
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
          payload: { action: input.action, edited: input.editedText !== undefined },
        },
        upserts: [{ _tag: "knock", record: decided }],
      });
      return decided;
    });

  // ---------------------------------------------------------------------------
  // Send guard

  const guard = (request: SendGuardRequest) =>
    Effect.gen(function* () {
      const casts = yield* liveCasts;
      const target = yield* membershipIn(casts, request.targetThreadId);
      if (target === null) return { _tag: "pass" } satisfies SendGuardOutcome;
      const from = request.from;
      let sender: Member | null = null;
      if (from._tag === "thread") sender = yield* membershipIn(casts, from.threadId);
      if (from._tag === "session") {
        const rows = yield* rooms.membersByPrincipal(`session:${from.sessionId}`);
        const row = rows.find((each) => each.missionId === target.missionId) ?? rows[0];
        sender =
          row === undefined
            ? null
            : { missionId: row.missionId, threadId: request.targetThreadId, kind: row.kind };
      }
      const decision = decideSend({ target, sender, from, targetThreadId: request.targetThreadId });
      const provenance = senderProvenance(from);
      const cast = casts.find((each) => each.missionId === target.missionId);
      const targetLabel =
        target.kind === "master"
          ? `the ${cast?.mission?.title ?? target.missionId} master`
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

  const pokeUnlocked = (threadId: ThreadId): Effect.Effect<void, MissionError> =>
    Effect.gen(function* () {
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
      for (const roomId of new Set(unread.map((delivery) => delivery.roomId))) {
        const room = yield* rooms.room(roomId);
        titles.add(room?.title ?? roomId);
      }
      const newestMessage = yield* rooms.messageById(newest.messageId);
      const wakeId = wakeRequestId(newest.missionId, threadId, action.upToSeq);
      yield* threads.send({
        threadId,
        text: wakeLine({
          unread: action.unread,
          rooms: [...titles],
          newest:
            newestMessage === null
              ? `#${newest.seq}`
              : `#${newestMessage.seq} ${newestMessage.kind}: ${newestMessage.summary.slice(0, 120)}`,
        }),
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
      return { threadId, unread: unread.length, entries } satisfies AgentInbox;
    });

  return MissionRouter.of({
    rooms: (missionId, provenance) =>
      requireReader(missionId, provenance).pipe(Effect.andThen(rooms.rooms(missionId))),
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
    poke,
    settled,
    relay,
  });
});

export const layer = Layer.effect(MissionRouter, make);
