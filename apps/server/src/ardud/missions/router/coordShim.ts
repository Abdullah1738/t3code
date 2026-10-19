import {
  RoomId,
  WorkItemId,
  type CoordEventRef,
  type MissionId,
  type MissionActor,
  type MissionError,
  type MissionMessageKind,
  type MissionProvenance,
  type PostMessageInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  coordActorFor,
  coordBodyText,
  listSummary,
  parseCoordBodyText,
} from "../import/coordIds.ts";
import { workLinks } from "../import/mapping.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { actorsOfThread, masterRoleOf, readCast, threadsOfActor, type RouterCast } from "./cast.ts";
import { coordMemberPrincipal, MissionRouter } from "./MissionRouter.ts";
import { actorKey } from "./model.ts";
import { RouterStore, type RecipientEntry } from "./RouterStore.ts";

/**
 * Server side of coord's forward mode (`coord messaging robob`): coord's CLI,
 * its pump and crw keep calling `coord post|inbox|ack`, and coord forwards
 * those here, so the messages live in Robob's rooms and ring Robob's
 * doorbell. Replies use coord's own shapes and refusal codes (see
 * `integrations/coord/lib/forward.mjs` and `test/fake-missions.mjs`), so
 * nothing on coord's side can tell the difference.
 *
 * Only the `coord` component credential reaches the shim, and it speaks only
 * for the coord actors the owner or the mission's master enrolled to it
 * (`mission_set_member` with a `coord` principal). The actor named in `as`
 * picks one of those; it never grants anything by itself.
 */

/** The component credential coord's forward mode authenticates as. */
export const COORD_COMPONENT = "coord";
export const COORD_SHIM_COMPONENT = "coord-shim";
const SHIM_PROVENANCE: MissionProvenance = { _tag: "system", component: COORD_SHIM_COMPONENT };
const INBOX_LIMIT_MAX = 1000;
const DEFERRED_RE = /^DF-\d+$/;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A refusal in coord's terms: `{ ok: false, error: { code, message, ...extra } }`. */
export class CoordRefusal extends Data.TaggedError("CoordRefusal")<{
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}> {}

const refuse = (
  code: string,
  message: string,
  status = 400,
  extra?: Readonly<Record<string, unknown>>,
) => Effect.fail(new CoordRefusal({ code, message, status, ...(extra ? { extra } : {}) }));

/** What `coord post` forwards. Every field is always present on the wire. */
export interface CoordPostInput {
  readonly mission: MissionId;
  readonly channel: string;
  readonly as: string;
  readonly kind: MissionMessageKind;
  readonly key: string;
  readonly hash: string;
  readonly summary: string;
  readonly to: ReadonlyArray<string> | null;
  readonly work: string | null;
  readonly env: string | null;
  readonly rev: string | null;
  readonly authority: string | null;
  readonly body: unknown;
  readonly replyTo: number | null;
}

export type CoordPostReply =
  | { readonly seq: number; readonly recipients: ReadonlyArray<string> }
  | { readonly seq: number; readonly duplicate: true };

export interface CoordInboxInput {
  readonly mission: MissionId;
  readonly as: string;
  readonly unacked: boolean;
  readonly after: number;
  readonly limit: number;
}

/** One `coord inbox` row: coord's event columns plus the reader's delivery. */
export interface CoordEventRow {
  readonly seq: number;
  readonly event_key: string;
  readonly body_hash: string | null;
  readonly channel_id: string;
  readonly kind: string;
  readonly sender: string;
  readonly work_id: string | null;
  readonly environment: string | null;
  readonly expected_revision: string | null;
  readonly authority_ref: string | null;
  readonly summary: string;
  readonly body_json: unknown;
  readonly reply_to: number | null;
  readonly created_at: number;
  readonly delivery: "pending" | "skipped" | "acked";
  readonly acked_at: number | null;
}

export interface CoordAckInput {
  readonly mission: MissionId;
  readonly as: string;
  readonly refs: ReadonlyArray<string>;
}

export type CoordAckEntry =
  | { readonly seq: number }
  | { readonly seq: number; readonly already: true };

export class CoordShim extends Context.Service<
  CoordShim,
  {
    /** `component` is the caller's authenticated component, or null for any other credential. */
    readonly post: (
      component: string | null,
      input: CoordPostInput,
    ) => Effect.Effect<CoordPostReply, CoordRefusal | MissionError>;
    readonly inbox: (
      component: string | null,
      input: CoordInboxInput,
    ) => Effect.Effect<ReadonlyArray<CoordEventRow>, CoordRefusal | MissionError>;
    readonly ack: (
      component: string | null,
      input: CoordAckInput,
    ) => Effect.Effect<ReadonlyArray<CoordAckEntry>, CoordRefusal | MissionError>;
  }
>()("t3/ardud/missions/router/coordShim") {}

const unixSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const channelOf = (missionId: MissionId, roomId: RoomId) => {
  const prefix = `${missionId}:room:`;
  return roomId.startsWith(prefix) ? roomId.slice(prefix.length) : roomId;
};

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const rooms = yield* RouterStore;
  const router = yield* MissionRouter;

  const requireMission = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = Option.getOrNull(yield* store.get("mission", missionId));
      if (mission === null) return yield* refuse("not_found", `no mission ${missionId}`, 404);
      return mission;
    });

  /**
   * The caller must be the coord component, and the actor it names must be
   * enrolled to it in this mission. Checked before anything else is read, so
   * an unenrolled caller learns nothing about the mission's events.
   */
  const requireEnrolled = (component: string | null, missionId: MissionId, name: string) =>
    Effect.gen(function* () {
      if (component !== COORD_COMPONENT) {
        return yield* refuse("forbidden", "only the coord component credential uses the shim", 403);
      }
      yield* requireMission(missionId);
      const rows = yield* rooms.membersByPrincipal(coordMemberPrincipal(name));
      if (!rows.some((row) => row.missionId === missionId)) {
        return yield* refuse(
          "forbidden",
          `coord is not enrolled to act as ${name} in ${missionId}`,
          403,
        );
      }
    });

  /** System components the mission knows: those subscribed to one of its rooms. */
  const systemNames = (missionId: MissionId) =>
    Effect.gen(function* () {
      const names = new Set<string>();
      for (const room of yield* rooms.rooms(missionId)) {
        for (const sub of yield* rooms.subscriptions(room.id)) {
          if (sub.subscriber._tag === "system") names.add(sub.subscriber.component);
        }
      }
      return names;
    });

  /** The coord name a mission actor goes by. */
  const coordName = (cast: RouterCast, actor: MissionActor): string => {
    const master = masterRoleOf(cast);
    if (actor._tag === "role" && master !== null && actor.roleId === master.id) return "master";
    if (actor._tag === "thread") {
      // A native post by a thread reads as the role or lane it holds.
      for (const held of actorsOfThread(cast, actor.threadId)) {
        if (held._tag === "thread") continue;
        const name = coordName(cast, held);
        if (name !== actorKey(held)) return name;
      }
    }
    return coordActorFor(cast.missionId, actor) ?? actorKey(actor);
  };

  /** The mission actor a coord name speaks for, or null when the mission has none. */
  const actorNamed = (
    cast: RouterCast,
    systems: ReadonlySet<string>,
    name: string,
  ): MissionActor | null => {
    if (name === "master") {
      const master = masterRoleOf(cast);
      return master === null ? null : { _tag: "role", roleId: master.id };
    }
    const role = cast.roles.find(
      (each) => coordActorFor(cast.missionId, { _tag: "role", roleId: each.id }) === name,
    );
    if (role !== undefined) return { _tag: "role", roleId: role.id };
    const lane = cast.lanes.find(
      (each) => coordActorFor(cast.missionId, { _tag: "lane", laneId: each.id }) === name,
    );
    if (lane !== undefined) return { _tag: "lane", laneId: lane.id };
    if (systems.has(name)) return { _tag: "system", component: name };
    return null;
  };

  /** Every ledger key an actor reads under: itself and whatever its threads hold. */
  const readerKeys = (cast: RouterCast, actor: MissionActor) => {
    const keys = new Set([actorKey(actor)]);
    for (const threadId of threadsOfActor(cast, actor)) {
      for (const each of actorsOfThread(cast, threadId)) keys.add(actorKey(each));
    }
    return [...keys];
  };

  const reader = (component: string | null, missionId: MissionId, name: string) =>
    Effect.gen(function* () {
      yield* requireEnrolled(component, missionId, name);
      const cast = yield* readCast(store, missionId);
      const actor = actorNamed(cast, yield* systemNames(missionId), name);
      return { cast, actor };
    });

  const post = (component: string | null, input: CoordPostInput) =>
    Effect.gen(function* () {
      const missionId = input.mission;
      yield* requireEnrolled(component, missionId, input.as);
      const prior = yield* rooms.messageByKey(missionId, input.key);
      if (prior !== null) {
        // A replay is the same actor's same event; another actor's key is a conflict.
        if (
          prior.message.coord?.sender === input.as &&
          prior.message.coord.bodyHash === input.hash
        ) {
          return { seq: prior.message.seq, duplicate: true } as const;
        }
        return yield* refuse("conflict", `event ${input.key} exists with a different body`, 409, {
          status: 409,
          seq: prior.message.seq,
        });
      }

      const roomId = RoomId.make(`${missionId}:room:${input.channel}`);
      const room = yield* rooms.room(roomId);
      const standard = ["control", "release", "arch"].includes(input.channel);
      if ((room === null && !standard) || (room !== null && room.missionId !== missionId)) {
        return yield* refuse("not_found", `no channel ${input.channel}`, 404);
      }
      if (room?.archived === true) {
        return yield* refuse("channel_archived", `channel ${input.channel} is archived`);
      }

      const cast = yield* readCast(store, missionId);
      const systems = yield* systemNames(missionId);
      const author = actorNamed(cast, systems, input.as);
      if (author === null) return yield* refuse("unknown_actor", `no actor ${input.as}`);
      const authorThreads = threadsOfActor(cast, author);
      if (author._tag !== "system" && authorThreads.length === 0) {
        return yield* refuse("not_bound", `${input.as} has no bound thread in ${missionId}`);
      }

      const named = input.to === null ? null : input.to.filter((name) => name !== input.as);
      const to: Array<MissionActor> = [];
      for (const name of named ?? []) {
        const actor = actorNamed(cast, systems, name);
        if (actor === null) return yield* refuse("unknown_actor", `no actor ${name}`);
        if (!to.some((each) => actorKey(each) === actorKey(actor))) to.push(actor);
      }

      const deferred =
        input.work !== null && DEFERRED_RE.test(input.work)
          ? Option.getOrNull(yield* store.get("work-item", `${missionId}:deferred:${input.work}`))
          : null;
      const body = coordBodyText(
        input.summary,
        input.body === null || input.body === undefined ? null : encodeJson(input.body),
      );
      const message: PostMessageInput = {
        missionId,
        roomId,
        kind: input.kind,
        summary: listSummary(input.summary).text,
        ...(body === null ? {} : { body }),
        ...(named === null ? {} : { to }),
        key: input.key,
        ...(deferred === null ? {} : { workItemId: WorkItemId.make(deferred.id) }),
        links: workLinks(input.work),
      };
      const coord: CoordEventRef = {
        channel: input.channel,
        sender: input.as,
        bodyHash: input.hash,
        workId: input.work,
        environment: input.env,
        expectedRevision: input.rev,
        authorityRef: input.authority,
        replyTo: input.replyTo,
      };
      const result = yield* router.relay({
        input: message,
        provenance: SHIM_PROVENANCE,
        author,
        authorThread: authorThreads[0] ?? null,
        coord,
      });
      if (!result.fresh) return { seq: result.message.seq, duplicate: true } as const;

      const subscribers = (yield* rooms.subscriptions(roomId)).map((sub) =>
        coordName(cast, sub.subscriber),
      );
      const recipients =
        named ?? [...new Set(subscribers)].filter((name) => name !== input.as).toSorted();
      return { seq: result.message.seq, recipients };
    });

  const rowOf = (cast: RouterCast, entry: RecipientEntry): CoordEventRow => {
    const { message } = entry;
    const ref = message.coord;
    // Imported and shim posts keep coord's summary/body split in the body text.
    const text =
      ref === undefined
        ? { summary: message.summary, body: entry.body }
        : parseCoordBodyText(message.summary, entry.body);
    return {
      seq: message.seq,
      event_key: message.key ?? message.id,
      body_hash: ref?.bodyHash ?? null,
      channel_id: ref?.channel ?? channelOf(message.missionId, message.roomId),
      kind: message.kind,
      sender: ref?.sender ?? coordName(cast, message.author),
      work_id: ref?.workId ?? null,
      environment: ref?.environment ?? null,
      expected_revision: ref?.expectedRevision ?? null,
      authority_ref: ref?.authorityRef ?? null,
      summary: text.summary,
      body_json: text.body,
      reply_to: ref?.replyTo ?? null,
      created_at: unixSeconds(message.createdAt),
      delivery: entry.delivery,
      acked_at: entry.ackedAt === null ? null : unixSeconds(entry.ackedAt),
    };
  };

  const inbox = (component: string | null, input: CoordInboxInput) =>
    Effect.gen(function* () {
      const { cast, actor } = yield* reader(component, input.mission, input.as);
      // coord answers an unknown reader with an empty inbox.
      if (actor === null) return [];
      const entries = yield* rooms.recipientInbox({
        missionId: input.mission,
        keys: readerKeys(cast, actor),
        after: input.after,
        unackedOnly: input.unacked,
        limit: Math.max(1, Math.min(input.limit, INBOX_LIMIT_MAX)),
      });
      return entries.map((entry) => rowOf(cast, entry));
    });

  const ack = (component: string | null, input: CoordAckInput) =>
    Effect.gen(function* () {
      const missionId = input.mission;
      const { cast, actor } = yield* reader(component, missionId, input.as);
      const keys = actor === null ? [] : readerKeys(cast, actor);
      // Every ref must resolve and be addressed to the reader before any is acked.
      const targets: Array<{
        readonly seq: number;
        readonly roomId: RoomId;
        readonly acked: boolean;
      }> = [];
      for (const ref of input.refs) {
        const message = /^\d+$/.test(ref)
          ? yield* rooms.messageBySeq(missionId, Number(ref))
          : ((yield* rooms.messageByKey(missionId, ref))?.message ?? null);
        if (message === null) return yield* refuse("not_found", `no event ${ref}`, 404);
        // An owner request is never coord's to ack, even with an old ledger row.
        const rows =
          (yield* rooms.room(message.roomId))?.kind === "owner-request"
            ? []
            : yield* rooms.recipientsOf(missionId, message.seq, keys);
        if (rows.length === 0) {
          return yield* refuse("not_addressed", `event ${ref} was not addressed to ${input.as}`);
        }
        targets.push({
          seq: message.seq,
          roomId: message.roomId,
          acked: rows.every((row) => row.ackedAt !== null),
        });
      }

      const at = DateTime.formatIso(yield* DateTime.now);
      const threads: ReadonlyArray<ThreadId> = actor === null ? [] : threadsOfActor(cast, actor);
      const done = new Set<number>();
      const out: Array<CoordAckEntry> = [];
      for (const target of targets) {
        if (target.acked || done.has(target.seq)) {
          out.push({ seq: target.seq, already: true });
          continue;
        }
        yield* rooms.ackRecipients({
          missionId,
          keys,
          at,
          scope: { _tag: "seq", seq: target.seq },
        });
        for (const threadId of threads) yield* rooms.readDelivery(threadId, missionId, target.seq);
        done.add(target.seq);
        out.push({ seq: target.seq });
      }

      // Robob read positions follow the acks: read up to the first gap.
      const readers = new Map<string, MissionActor>();
      if (actor !== null) readers.set(actorKey(actor), actor);
      for (const threadId of threads) {
        for (const each of actorsOfThread(cast, threadId)) readers.set(actorKey(each), each);
      }
      for (const roomId of new Set(targets.map((target) => target.roomId))) {
        const room = yield* rooms.room(roomId);
        if (room === null) continue;
        const gap = yield* rooms.firstUnacked(missionId, roomId, keys);
        const seq = gap === null ? room.lastSeq : gap - 1;
        if (seq <= 0) continue;
        for (const [key, each] of readers) {
          yield* rooms.advanceRead({ roomId, reader: each, seq, updatedAt: at }, key);
        }
      }
      return out;
    });

  return CoordShim.of({ post, inbox, ack });
});

export const layer = Layer.effect(CoordShim, make);
